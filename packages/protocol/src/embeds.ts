/**
 * Showing a reference as a card — SPEC §13.6.2 (OPT-16).
 *
 * `["embed", <value>, "compact" | "detailed" | "none"]` says how the author
 * wants one reference in a message drawn: as a card under the message, and how
 * much of it. `<value>` is what an `a` or `q` would carry for the same thing —
 * an address or a 64-hex event id. The values are a density, not a widget
 * name: `compact` is §7.5's closed `row` and `detailed` its closed `card`, so
 * a richer card can come later without changing the wire.
 *
 * A reference with no `embed` draws by where it sits: its chip in a sentence,
 * its row alone on its line ({@link isOnlyReferenceLine}). A reader never adds
 * a card; the default card is the writer's ({@link defaultCardOf}). An `embed`
 * for a value overrides any default, which is why `none` exists: it is the
 * author saying "no card" in an edit that replaces the set (§6.8).
 *
 * Like `part` (§13.6.1), the tags are only half the answer. A card is drawn
 * only while the body — as edited — still names its value, and there is no
 * `a`/`q` match: an edit carries no index tags (§6.8), and a value first named
 * in an edit can still carry a card (Miky, 2026-10-13, OPT-16 kickoff).
 * {@link cardsIn} applies that rule; {@link embedsOf} reads the tags alone.
 *
 * why: https://github.com/estiva-app/estiva-docs/blob/main/decisions/where-a-link-sits-decides-how-it-draws.md
 */
import { addrToNaddr, bech32Decode, convertBits, decodeNevent, encodeNevent, naddrToAddr } from './nip19.js'
import type { PartPointer } from './anchors.js'
import type { RenderBlock, RenderInline } from './render.js'

export const EMBED_TAG = 'embed'

/** How much of a referenced object a card shows, or `none` for no card. */
export type EmbedLayout = 'compact' | 'detailed' | 'none'

/** One `embed` tag, read. */
export interface Embed {
  /** An address (`kind:pubkey:d`) or a 64-hex event id, lowercase hex. */
  value: string
  layout: EmbedLayout
  /**
   * The layout as its tag wrote it, when this reader does not know it (and
   * draws it as `compact`). An edit carries it as written ({@link embedTagsOf}),
   * so a density added later is not rewritten by an older writer.
   */
  written?: string
}

/** The `embed` tag for one reference. */
export function embedTag(value: string, layout: EmbedLayout): string[] {
  return [EMBED_TAG, value, layout]
}

/**
 * A whole `embed` set as tags, as a send or an edit writes it: each value
 * normalised as {@link embedsOf} reads it, the first entry per value kept, and
 * a layout this writer does not know carried as it was written (`written`).
 * Throws on a value that is neither an address nor an event id, or on a
 * layout that is neither known nor carried, rather than write a tag readers skip.
 */
export function embedTagsOf(set: readonly Embed[]): string[][] {
  const seen = new Set<string>()
  return set.flatMap((e) => {
    const value = normalise(e.value)
    if (!value) throw new Error(`not an address or event id: ${e.value}`)
    if (e.layout !== 'compact' && e.layout !== 'detailed' && e.layout !== 'none') throw new Error(`not an embed layout: ${String(e.layout)}`)
    if (seen.has(value)) return []
    seen.add(value)
    return [[EMBED_TAG, value, (e.layout === 'compact' && e.written) || e.layout]]
  })
}

// `partsOf`'s shape: an empty `d` is a valid address (NIP-01).
const ADDRESS = /^\d+:[0-9a-f]{64}:/
const EVENT_ID = /^[0-9a-f]{64}$/

/**
 * The `embed` tags on one event, one per value, in tag order.
 *
 * The first tag for a value wins. A layout this reader does not know draws as
 * `compact` rather than nothing: the author asked for a card, and the smallest
 * one is the safe reading of a density added after this reader was written. A
 * value that is neither an address nor an event id is skipped.
 *
 * **This is the tags only**, of one event. For a message, fold its edits first
 * (`foldEmbeds` in `@estiva-app/conversation`), then ask {@link cardsIn} which
 * of them the body still names.
 */
export function embedsOf(event: { tags: readonly (readonly string[])[] }): Embed[] {
  const out: Embed[] = []
  const seen = new Set<string>()
  for (const tag of event.tags) {
    if (tag[0] !== EMBED_TAG || !tag[1]) continue
    const value = normalise(tag[1])
    if (!value || seen.has(value)) continue
    seen.add(value)
    const layout = layoutOf(tag[2])
    out.push(tag[2] && tag[2] !== layout ? { value, layout, written: tag[2] } : { value, layout })
  }
  return out
}

function layoutOf(raw: string | undefined): EmbedLayout {
  return raw === 'detailed' || raw === 'none' ? raw : 'compact'
}

function normalise(value: string): string | undefined {
  if (EVENT_ID.test(value.toLowerCase())) return value.toLowerCase()
  if (!ADDRESS.test(value)) return undefined
  // The kind and pubkey are hex and compared as such; the `d` is the author's and kept as written.
  const [kind, pubkey, ...d] = value.split(':')
  return `${kind}:${pubkey.toLowerCase()}:${d.join(':')}`
}

/**
 * What an app link names, as the reader resolved it by §7.7 — the host and the
 * `<type>` segment against a published `urls` pattern, then the one author who
 * holds that `d` — or undefined. Never a match on the link's trailing
 * identifier alone: that resolves any site's URL as somebody's object, and puts
 * a real issue's card under a link that does not open it (§7.7).
 */
export type LinkResolver = (url: string) => string | undefined

const TRAILING = new Set(['.', ',', ';', ':', '!', '?', ')', ']'])

/** A URL run without the sentence's trailing punctuation; stripped by a loop, which stays linear on a hostile run of dots. */
function trimUrl(url: string): string {
  let end = url.length
  while (end > 0 && TRAILING.has(url[end - 1])) end--
  return url.slice(0, end)
}

/** A URL stuck to the end of a word (`seehttps://…`) is the word's, not a link. */
function stuckToWord(text: string, start: number): boolean {
  if (start === 0) return false
  // The code point before it, so a letter outside the BMP (a surrogate pair) counts too.
  const pair = start >= 2 && /[\uDC00-\uDFFF]/.test(text[start - 1]) && /[\uD800-\uDBFF]/.test(text[start - 2])
  const at = pair ? start - 2 : start - 1
  return /[\p{L}\p{N}]/u.test(String.fromCodePoint(text.codePointAt(at)!))
}

/**
 * The address or event id a `nostr:` reference names — what an `a`, `q` or
 * `embed` carries for it — or undefined for a person or something unreadable.
 */
export function valueOfReference(reference: string): string | undefined {
  const bare = reference.replace(/^nostr:/i, '').toLowerCase()
  try {
    if (bare.startsWith('naddr1')) return normalise(naddrToAddr(bare))
    if (bare.startsWith('nevent1')) return decodeNevent(bare).id.toLowerCase()
    if (bare.startsWith('note1')) {
      const { hrp, data } = bech32Decode(bare)
      if (hrp !== 'note') return undefined
      const hex = convertBits(data, 5, 8, false).map((b) => b.toString(16).padStart(2, '0')).join('')
      return EVENT_ID.test(hex) ? hex : undefined
    }
  } catch {
    return undefined
  }
  return undefined
}

/**
 * The cards a message asks for, in the order the body first names them.
 *
 * `embeds` is the message's folded set; `blocks` its folded body as a render
 * tree; `parts` its `part` pointers (§13.6.1). A value appears here only while
 * the body names it — by a `nostr:` reference, or by an app link that
 * `resolveLink` resolves to it (§7.7) — and only when no `part` names the
 * same address, because the live block already stands for that object. Text in
 * a code span names nothing (§13.1). Without `resolveLink` a link names nothing:
 * resolving one needs the manifests and the relay, which this package does not hold.
 *
 * `none` entries are kept: they draw no card, but they still override any
 * default a reader has for that value. Filter them out to get the cards to draw.
 */
export function cardsIn(embeds: readonly Embed[], blocks: readonly RenderBlock[], parts: readonly PartPointer[] = [], resolveLink?: LinkResolver): Embed[] {
  if (embeds.length === 0) return []
  const byValue = new Map(embeds.map((e) => [e.value, e]))
  const withPart = new Set(parts.map((p) => normalise(p.address)).filter((v): v is string => !!v))
  return valuesIn(blocks, resolveLink).flatMap((value) => {
    const embed = withPart.has(value) ? undefined : byValue.get(value)
    return embed ? [embed] : []
  })
}

/**
 * Every address and event id a message's body names, once each, in the order
 * it first names them: by a `nostr:` reference, or by an app link that
 * `resolveLink` resolves (§7.7). A person names no value. Text in a code span
 * names nothing (§13.1). What {@link cardsIn} and {@link defaultCardOf} count.
 */
export function valuesIn(blocks: readonly RenderBlock[], resolveLink?: LinkResolver): string[] {
  const out: string[] = []
  const seen = new Set<string>()
  const take = (value: string | undefined) => {
    if (!value || seen.has(value)) return
    seen.add(value)
    out.push(value)
  }
  const resolve = (url: string) => resolveLink && take(normalise(resolveLink(url) ?? ''))
  // Run by run, by the rules {@link linksAsReferences} turns links by, so a URL names a value exactly where it draws as a reference.
  const walk = (bs: readonly RenderBlock[]) => {
    for (const block of bs) {
      if (block.type !== 'codeBlock') {
        for (const run of block.inline ?? []) {
          if (run.reference) take(valueOfReference(run.reference))
          else if (run.marks.includes('code')) continue
          else if (run.href !== undefined) {
            if (run.text === run.href) resolve(run.href)
          } else for (const { url } of urlRunsIn(run.text)) resolve(url)
        }
      }
      if (block.children) walk(block.children)
    }
  }
  walk(blocks)
  return out
}

/**
 * A block's lines: its inline runs split at each `\n`, the line break both
 * content models use (§13.2). A run that holds a break is cut in two, marks
 * kept; a reference never holds one.
 */
export function linesOf(block: Pick<RenderBlock, 'inline'>): RenderInline[][] {
  const lines: RenderInline[][] = [[]]
  for (const run of block.inline ?? []) {
    const pieces = run.reference ? [run.text] : run.text.split('\n')
    pieces.forEach((text, i) => {
      if (i > 0) lines.push([])
      if (text) lines[lines.length - 1].push(pieces.length === 1 ? run : { ...run, text })
    })
  }
  return lines
}

const LONE_URL = /^https?:\/\/[^\s<>"'`]+$/
const PERSON = /^nostr:(npub1|nprofile1)/i

/**
 * What a line of a message is only, by §13.2, or undefined when it is a
 * sentence: the `nostr:` reference, or the bare URL, that §13.6.2 draws in its
 * place. `block` is the block the line is in: only a paragraph's and a list
 * item's lines count, never a quote's, a heading's or code's.
 *
 * Whitespace around it is trimmed. Anything else makes it a sentence: other
 * words or punctuation (trailing `.` included), a second reference, a marker
 * around it, a code span, or `[words](url)`. A person (`npub`, `nprofile`)
 * alone on a line stays a chip, so it is not returned. A Folder stays a chip
 * too, but whether a URL names one is known only once it resolves: the reader
 * checks the value ({@link isFolderValue}). A URL returned here still has to
 * resolve by §7.7; one that resolves to nothing, or to something the reader
 * cannot read, stays the URL as written.
 */
export function isOnlyReferenceLine(line: readonly RenderInline[], block: Pick<RenderBlock, 'type'>): string | undefined {
  if (block.type !== 'paragraph' && block.type !== 'listItem') return undefined
  const runs = line.filter((run) => run.reference || run.text.trim() !== '')
  if (runs.length !== 1 || runs[0].marks.length > 0 || runs[0].href !== undefined) return undefined
  const [run] = runs
  if (run.reference) return PERSON.test(run.reference) ? undefined : run.reference
  const text = run.text.trim()
  return LONE_URL.test(text) && trimUrl(text) === text ? text : undefined
}

/** A Folder's address (`39000:…`): alone on its line it stays a chip, and it never takes the default card (§13.6.2). */
export function isFolderValue(value: string): boolean {
  return value.startsWith('39000:')
}

/**
 * What one line of a message draws (§13.2, §13.6.2):
 * - `sentence` — its runs as they are, each reference its chip;
 * - `row` — the line is only a reference to `value`, drawn as its row;
 * - `nothing` — the same, but `value` has a card or a part under the message,
 *   which stands for it (C26);
 * - `url` — a lone URL that names nothing (no app claims it, or the answer has
 *   not come back), drawn as the URL as written;
 * - `unreadable` — a lone `nostr:` reference that names no address or event
 *   id, drawn as the unreadable row.
 */
export type LineDraw =
  | { draw: 'sentence' }
  | { draw: 'row' | 'nothing'; value: string; url?: string }
  | { draw: 'url'; url: string }
  | { draw: 'unreadable'; reference: string }

/**
 * How a reader draws one of a message's lines ({@link linesOf}) in `block`:
 * {@link isOnlyReferenceLine}, then the value it names, then whether a card
 * stands for it. `cards` is {@link cardsIn}'s answer (its `none` entries draw
 * no card), `parts` the message's `part` pointers. A Folder alone on its line
 * stays a chip, so its line is a sentence. Whether the reader can read a
 * `row`'s object is its own business. One it cannot read draws the unreadable
 * row when the line is a `nostr:` reference; when the line is a URL (`url` is
 * set) it stays the URL as written, never an empty row (§13.6.2).
 */
export function lineDrawOf(
  line: readonly RenderInline[],
  block: Pick<RenderBlock, 'type'>,
  context: { cards?: readonly Embed[]; parts?: readonly PartPointer[]; resolveLink?: LinkResolver } = {},
): LineDraw {
  const only = isOnlyReferenceLine(line, block)
  if (!only) return { draw: 'sentence' }
  const isReference = /^nostr:/i.test(only)
  const value = isReference ? valueOfReference(only) : normalise(context.resolveLink?.(only) ?? '')
  if (!value) return isReference ? { draw: 'unreadable', reference: only } : { draw: 'url', url: only }
  if (isFolderValue(value)) return { draw: 'sentence' }
  const carded =
    (context.cards ?? []).some((e) => e.value === value && e.layout !== 'none') ||
    (context.parts ?? []).some((p) => normalise(p.address) === value)
  return { draw: carded ? 'nothing' : 'row', value, ...(isReference ? {} : { url: only }) }
}

/**
 * The value a writer gives the default card, `["embed", V, "detailed"]`, as
 * it sends or edits a message (§13.6.2), or undefined.
 *
 * `values` is what the body names, resolved ({@link valuesIn}), and `parts`
 * its `part` pointers. A file counts, except a Folder and `here`, the object
 * whose conversation the message is in (Miky, 2026-10-16: the issue a
 * message is about plus one other file gives the other its card); a part's
 * file counts too. A message (an event id) does not. When exactly one file
 * counts, it gets the card, unless a part names it (the part wins, and draws
 * under the message already).
 *
 * On an edit, pass the values the previous folded body named as `previous`:
 * the default is only for a file the edit names first, so a card its author
 * removed with ✕, which left no tag before sending or `none` after, does not
 * come back while the link stays. A link taken out and put back is named
 * first again and gets its card, whichever ✕ removed it (Miky, 2026-10-16).
 * The edit then carries the whole folded set with this one set to `detailed`
 * ({@link withCard}).
 */
export function defaultCardOf(
  values: readonly string[],
  parts: readonly PartPointer[] = [],
  options: { here?: string; previous?: readonly string[] } = {},
): string | undefined {
  const here = normalise(options.here ?? '')
  const withPart = new Set(parts.map((p) => normalise(p.address)).filter((v): v is string => !!v))
  const isFile = (v: string | undefined): v is string => !!v && ADDRESS.test(v) && !isFolderValue(v) && v !== here
  const files = new Set([...values.map(normalise), ...withPart].filter(isFile))
  if (files.size !== 1) return undefined
  const [file] = files
  if (withPart.has(file)) return undefined
  if (options.previous?.some((v) => normalise(v) === file)) return undefined
  return file
}

/**
 * A folded `embed` set with `value` set to `layout`, the rest kept as they
 * are: what an edit carries, since a set replaces (§13.6.2). ✕ on a sent card
 * is `withCard(set, V, 'none')`; adding an edit's default card is
 * `withCard(set, V, 'detailed')`.
 */
export function withCard(set: readonly Embed[], value: string, layout: EmbedLayout): Embed[] {
  const v = normalise(value)
  if (!v) throw new Error(`not an address or event id: ${value}`)
  const out = set.filter((e) => e.value !== v)
  const at = set.findIndex((e) => e.value === v)
  out.splice(at === -1 ? out.length : at, 0, { value: v, layout })
  return out
}

/**
 * The `nostr:` reference an app link names, by what `resolveLink` answered for
 * it (§7.7), or undefined: nothing claims it, the answer has not come back, or
 * the address is one no naddr can hold (a `d` over 255 bytes), which stays a
 * link rather than taking the text down with it. What an editor's URL chip
 * draws as (`@estiva-app/ui/editor`'s `LinkChips`).
 */
export function referenceOfLink(url: string, resolveLink: LinkResolver): string | undefined {
  const value = normalise(resolveLink(url) ?? '')
  if (!value) return undefined
  try {
    return `nostr:${EVENT_ID.test(value) ? encodeNevent({ id: value, relays: [] }) : addrToNaddr(value)}`
  } catch {
    return undefined
  }
}

/**
 * The app links an editor may turn into chips in one text, where each sits:
 * bare http(s) URLs, trailing punctuation left to the sentence. A
 * `[words](https://…)` is the marker format's link on words and is skipped, as
 * {@link linksAsReferences} skips it.
 */
export function urlRunsIn(text: string): { url: string; from: number; to: number }[] {
  if (!text.includes('://')) return []
  const out: { url: string; from: number; to: number }[] = []
  for (const m of text.matchAll(LINK_OR_URL)) {
    if (m[1] || stuckToWord(text, m.index)) continue
    const start = m.index
    if (text.slice(Math.max(0, start - 2), start) === '](' || text[start - 1] === '[') continue
    const url = trimUrl(m[0])
    out.push({ url, from: start, to: start + url.length })
  }
  return out
}

/**
 * One pass over a run: a link on words, `[words](https://…)` as the marker
 * format writes it (group 1 — its URL is the target of words the author chose),
 * or a bare URL (group 2). The same alternation the ui package's `RichText`
 * draws links by, so what is skipped here is what it draws as a link. Alone,
 * the first alternative is quadratic on a run of `[a](https://x` with no space
 * or `)`; the bare-URL alternative after it swallows the rest, so this stays
 * linear (OPT-18's security review).
 */
const LINK_OR_URL = /(\[[^[\]\n]+\]\((?:https?:\/\/|mailto:)[^\s)]+\))|(https?:\/\/[^\s<>"'`]+)/g

/**
 * A message's tree with each bare app link turned into the reference it names,
 * so a reader draws it as a reference to that object (SPEC §13.6.2, OPT-18):
 * its chip in a sentence, its row alone on its line.
 *
 * A link some app
 * claims (§7.7) is a reference written as a URL — the form a message has when
 * it was written before the composer turned pasted links into chips, or by a
 * client that does not. Without this, the two would read differently for no
 * reason the reader can see.
 *
 * Left alone: a link on words (the author chose the words, and they stay a
 * link; its card is the author's `embed`), a URL in code (§13.1: literal), and
 * a link `resolveLink` does not answer — no app claims it, or the answer has
 * not come back yet — which stays a link. The run keeps the URL as its text,
 * so a reader that draws references as text shows what was written.
 *
 * A block document's too, since 0.33.0 (§13.3): a description's URL reads as
 * its chip as a message's does. There a run whose text is its own `link` mark's
 * `href` is that URL, and keeps the card its writer chose (`embed`); a link on
 * other words stays a link.
 */
export function linksAsReferences(blocks: readonly RenderBlock[], resolveLink: LinkResolver): RenderBlock[] {
  const referenceOf = (url: string) => referenceOfLink(url, resolveLink)
  const split = (run: RenderInline): RenderInline[] => {
    if (run.href !== undefined) {
      // A block document's link: the URL as its own words is the URL, and takes its card along.
      const reference = !run.reference && run.text === run.href && !run.marks.includes('code') ? referenceOf(run.href) : undefined
      if (!reference) return [run]
      const { href: _href, ...rest } = run
      return [{ ...rest, reference }]
    }
    if (run.reference || run.marks.includes('code') || !run.text.includes('://')) return [run]
    const out: RenderInline[] = []
    let at = 0
    for (const m of run.text.matchAll(LINK_OR_URL)) {
      // A link on words: neither its target nor a URL in its words is taken.
      if (m[1] || stuckToWord(run.text, m.index)) continue
      const start = m.index
      // A link on words whose words carry a mark arrives split across runs: its target follows `](`, and a URL as its words follows `[`.
      if (run.text.slice(Math.max(0, start - 2), start) === '](' || run.text[start - 1] === '[') continue
      const url = trimUrl(m[0])
      const reference = referenceOf(url)
      if (!reference) continue
      if (start > at) out.push({ ...run, text: run.text.slice(at, start) })
      out.push({ text: url, marks: run.marks, reference })
      at = start + url.length
    }
    if (at === 0) return [run]
    if (at < run.text.length) out.push({ ...run, text: run.text.slice(at) })
    return out
  }
  // A block with nothing to turn is returned as it was, so a body without app links costs no copies.
  const walk = (bs: readonly RenderBlock[]): RenderBlock[] =>
    bs.map((block) => {
      if (block.type === 'codeBlock') return block
      const inline = block.inline?.flatMap(split)
      const children = block.children && walk(block.children)
      const unchanged = <T,>(next: readonly T[] | undefined, was: readonly T[] | undefined) =>
        !next || (next.length === was?.length && next.every((x, i) => x === was[i]))
      const same = unchanged(inline, block.inline) && unchanged(children, block.children)
      return same ? block : { ...block, ...(inline ? { inline } : {}), ...(children ? { children } : {}) }
    })
  return walk(blocks)
}

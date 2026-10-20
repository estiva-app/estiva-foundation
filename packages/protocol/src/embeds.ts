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
 * why: https://github.com/estiva-app/estiva-docs/blob/main/decisions/a-link-on-words-counts-toward-the-card.md
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
 *
 * A link to one block (`#block-<id>`, §13.6.1) resolves to the object the block
 * is in: it reads as that file's chip, and its `part`, when the message carries
 * one, draws the block and keeps the file's card off ({@link cardsIn},
 * {@link defaultCardOf}, {@link lineDrawOf}).
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
 * `resolveLink` resolves to it (§7.7), bare or as a link on words' target —
 * and only when no `part` names the
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
 * `resolveLink` resolves (§7.7), written bare or as the target of a link on
 * words. A link on words keeps its words where it draws, but names its file;
 * a URL in its words names nothing. A person names no value. Text in a code
 * span names nothing (§13.1). What {@link cardsIn} and {@link defaultCardOf} count.
 *
 * why: https://github.com/estiva-app/estiva-docs/blob/main/decisions/a-link-on-words-counts-toward-the-card.md
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
  // A bare URL names a value exactly where {@link linksAsReferences} draws it as a reference;
  // a link on words names its target, never a URL in its words. Each is taken where it starts.
  const walk = (bs: readonly RenderBlock[]) => {
    for (const block of bs) {
      if (block.type !== 'codeBlock') {
        const runs = block.inline ?? []
        const links = linksOnWordsIn(runs)
        const named: { at: number; reference?: string; url?: string }[] = []
        // `links` is in text order and its spans do not overlap, so two cursors keep this linear.
        let inWords = 0
        let byTarget = 0
        let at = 0
        for (const run of runs) {
          const end = at + run.text.length
          if (run.reference) named.push({ at, reference: run.reference })
          else if (run.href !== undefined) named.push({ at, url: run.href })
          else if (!run.marks.includes('code')) {
            for (const { url, from } of urlRunsIn(run.text)) {
              const pos = at + from
              while (inWords < links.length && links[inWords].wordsEnd <= pos) inWords++
              const link = links[inWords]
              if (!link || pos < link.from) named.push({ at: pos, url })
            }
            while (byTarget < links.length && links[byTarget].target < at) byTarget++
            for (; byTarget < links.length && links[byTarget].target < end; byTarget++) {
              const link = links[byTarget]
              // Only a target written whole in this run, `)` included, is the URL a reader draws.
              if (link.target + link.url.length + 1 <= end) named.push({ at: link.from, url: link.url })
            }
          }
          at = end
        }
        named.sort((a, b) => a.at - b.at)
        for (const n of named) n.reference ? take(valueOfReference(n.reference)) : resolve(n.url!)
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
 * around it, a code span, or a link on words (`[words](url)`, or a block
 * document's `link` mark whose text is not its `href`). A `link` mark whose
 * text is exactly its `href` is the bare URL (§13.3). A person (`npub`, `nprofile`)
 * alone on a line stays a chip, so it is not returned. A Folder stays a chip
 * too, but whether a URL names one is known only once it resolves: the reader
 * checks the value ({@link isFolderValue}). A URL returned here still has to
 * resolve by §7.7; one that resolves to nothing, or to something the reader
 * cannot read, stays the URL as written.
 */
export function isOnlyReferenceLine(line: readonly RenderInline[], block: Pick<RenderBlock, 'type'>): string | undefined {
  if (block.type !== 'paragraph' && block.type !== 'listItem') return undefined
  const runs = line.filter((run) => run.reference || run.text.trim() !== '')
  if (runs.length !== 1 || runs[0].marks.length > 0) return undefined
  const [run] = runs
  if (run.reference) return PERSON.test(run.reference) ? undefined : run.reference
  // A link mark bounds its URL, so nothing around it is trimmed off as punctuation.
  if (run.href !== undefined) return run.text === run.href && LONE_URL.test(run.href) ? run.href : undefined
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
 * What one line of a block document draws (§13.3, "A reference's card"): a
 * message's {@link LineDraw} but `nothing` (a document has no card under it), or
 * - `card` — the line is only a link to the file `value`, and its writer chose
 *   its card (`embed` `detailed` on the link's mark): the card, in the row's place.
 */
export type DocumentLineDraw = Exclude<LineDraw, { draw: 'nothing' }> | { draw: 'card'; value: string; url?: string }

/**
 * How a reader draws one line ({@link linesOf}) of a block document's `block`.
 * The line rule is the message's ({@link lineDrawOf}), with no card under the
 * document, so `nothing` never comes back. Only a paragraph's and a list item's
 * lines can be a link alone, a checklist item's included (a list item on the
 * wire); a heading, a quote, a callout (a quote with a tone) and a paragraph in
 * a table cell are sentences. Where `block` sits is the caller's to say
 * (`inTableCell`), because the tree holds a cell as a block this package does
 * not name: {@link documentLineDraws} walks a whole document and says it.
 *
 * Anything else on the mark — no `embed`, `compact`, `none`, a value this
 * reader does not know or one that is not a string — draws the row, and in a
 * sentence every value draws the chip only. A link on
 * words (a `link` mark whose text is not its `href`) is a sentence: its words,
 * a link, and its `embed` draws nothing. Read the tree through
 * {@link linksAsReferences} first, or pass `resolveLink`, so an app URL draws
 * as what it names.
 *
 * why: https://github.com/estiva-app/estiva-docs/blob/main/decisions/a-link-on-words-counts-toward-the-card.md
 * why: https://github.com/estiva-app/estiva-docs/blob/main/decisions/a-lone-links-chip-menu-offers-row-or-card.md
 */
export function documentLineDrawOf(
  line: readonly RenderInline[],
  block: Pick<RenderBlock, 'type'> & { inTableCell?: boolean },
  context: { resolveLink?: LinkResolver } = {},
): DocumentLineDraw {
  if (block.inTableCell) return { draw: 'sentence' }
  const drawn = lineDrawOf(line, block, { resolveLink: context.resolveLink })
  if (drawn.draw !== 'row' && drawn.draw !== 'nothing') return drawn
  // The line is one run: the link, its `embed` read off its mark by `cardLayout`.
  const only = line.find((run) => run.reference || run.text.trim() !== '')
  return { ...drawn, draw: only?.embed === 'detailed' ? 'card' : 'row' }
}

/**
 * Every line of a block document as a reader draws it ({@link documentLineDrawOf}),
 * per block of `blocks`, keyed by the block object itself — pass the tree you
 * draw, after {@link linksAsReferences} if you use it.
 *
 * Only a top-level paragraph and a list's items keep the line rule. Inside
 * anything else — a table's cells, a quote or a block this reader does not
 * know that holds blocks — every line is a sentence, so no reader has to
 * remember where it is.
 */
export function documentLineDraws(
  blocks: readonly RenderBlock[],
  context: { resolveLink?: LinkResolver } = {},
): Map<RenderBlock, DocumentLineDraw[]> {
  const out = new Map<RenderBlock, DocumentLineDraw[]>()
  // `inside`: under a block that is not a list, where every line is a sentence.
  const walk = (bs: readonly RenderBlock[], inside: boolean) => {
    for (const block of bs) {
      if (block.inline) out.set(block, linesOf(block).map((line) => documentLineDrawOf(line, { type: block.type, inTableCell: inside }, context)))
      if (block.children) walk(block.children, inside || (block.type !== 'bulletList' && block.type !== 'orderedList'))
    }
  }
  walk(blocks, false)
  return out
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
 * Each link on words in a block of marker text, `[words](https://…)`, found
 * over the block's runs joined, so one whose words carry a mark (split across
 * runs) is found too. Offsets are into that joined text: `from` the `[`,
 * `wordsEnd` the `]`, `target` where the URL starts (SPEC §13.6.2).
 */
function linksOnWordsIn(runs: readonly RenderInline[]): { from: number; wordsEnd: number; target: number; url: string }[] {
  const text = runs.map((r) => r.text).join('')
  if (!text.includes('](')) return []
  const out: { from: number; wordsEnd: number; target: number; url: string }[] = []
  for (const m of text.matchAll(LINK_OR_URL)) {
    if (!m[1]) continue
    const close = m[1].indexOf('](')
    out.push({ from: m.index, wordsEnd: m.index + close, target: m.index + close + 2, url: m[1].slice(close + 2, -1) })
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

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
 * A reference with no `embed` is drawn by the reader's default (a chip, §13.1).
 * An `embed` for a value overrides that default, which is why `none` exists:
 * it is the author saying "no card" in an edit that replaces the set (§6.8).
 *
 * Like `part` (§13.6.1), the tags are only half the answer. A card is drawn
 * only while the body — as edited — still names its value, and there is no
 * `a`/`q` match: an edit carries no index tags (§6.8), and a value first named
 * in an edit can still carry a card (Miky, 2026-10-13, OPT-16 kickoff).
 * {@link cardsIn} applies that rule; {@link embedsOf} reads the tags alone.
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
}

/** The `embed` tag for one reference. */
export function embedTag(value: string, layout: EmbedLayout): string[] {
  return [EMBED_TAG, value, layout]
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
    out.push({ value, layout: layoutOf(tag[2]) })
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

/** The http(s) links in a text. Trailing punctuation is the sentence's, not the link's; stripped by a loop, which stays linear on a hostile run of dots. */
function urlsIn(text: string): string[] {
  return (text.match(/https?:\/\/[^\s<>"'`]+/g) ?? []).map((url) => {
    let end = url.length
    while (end > 0 && TRAILING.has(url[end - 1])) end--
    return url.slice(0, end)
  })
}

/** The address or event id a `nostr:` reference names, or undefined for a person or something unreadable. */
function valueOfReference(reference: string): string | undefined {
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
  const out: Embed[] = []
  const seen = new Set<string>()
  const take = (value: string | undefined) => {
    if (!value || seen.has(value) || withPart.has(value)) return
    const embed = byValue.get(value)
    if (!embed) return
    seen.add(value)
    out.push(embed)
  }
  // Adjacent plain runs are read as one text, so a link a mark splits in two is still one link.
  const scan = (text: string) => {
    if (!resolveLink || !text.includes('://')) return
    for (const url of urlsIn(text)) {
      const value = resolveLink(url)
      if (value) take(normalise(value))
    }
  }
  const walk = (bs: readonly RenderBlock[]) => {
    for (const block of bs) {
      if (block.type !== 'codeBlock') {
        let text = ''
        for (const run of block.inline ?? []) {
          if (run.reference || run.marks.includes('code')) {
            scan(text)
            text = ''
            if (run.reference) take(valueOfReference(run.reference))
          } else text += run.text
        }
        scan(text)
      }
      if (block.children) walk(block.children)
    }
  }
  walk(blocks)
  return out
}

/** A link on words, `[words](https://…)`, as the marker format writes it — its URL is the target of words the author chose. */
const LINK_ON_WORDS = /\[[^[\]\n]+\]\((?:https?:\/\/|mailto:)[^\s)]+\)/g

/**
 * A message's tree with each bare app link turned into the reference it names,
 * so a reader draws it as that object's chip (SPEC §13.6.2, OPT-18).
 *
 * A reference reads as a chip wherever it sits (§13.1), and a link some app
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
 * Messages only: a description is a block document, whose links are not this
 * function's business (§13.3).
 */
export function linksAsReferences(blocks: readonly RenderBlock[], resolveLink: LinkResolver): RenderBlock[] {
  const referenceOf = (url: string): string | undefined => {
    const value = normalise(resolveLink(url) ?? '')
    if (!value) return undefined
    return `nostr:${EVENT_ID.test(value) ? encodeNevent({ id: value, relays: [] }) : addrToNaddr(value)}`
  }
  const split = (run: RenderInline): RenderInline[] => {
    if (run.reference || run.marks.includes('code') || !run.text.includes('://')) return [run]
    // The spans a link on words covers, so neither its target nor a URL in its words is taken.
    const covered: [number, number][] = []
    for (const m of run.text.matchAll(LINK_ON_WORDS)) covered.push([m.index, m.index + m[0].length])
    const out: RenderInline[] = []
    let at = 0
    for (const m of run.text.matchAll(/https?:\/\/[^\s<>"'`]+/g)) {
      const start = m.index
      if (covered.some(([s, e]) => start >= s && start < e)) continue
      // A link on words whose words carry a mark arrives split across runs: its target follows `](`.
      if (run.text.slice(Math.max(0, start - 2), start) === '](') continue
      const [url] = urlsIn(m[0])
      const reference = url ? referenceOf(url) : undefined
      if (!reference) continue
      if (start > at) out.push({ ...run, text: run.text.slice(at, start) })
      out.push({ text: url, marks: run.marks, reference })
      at = start + url.length
    }
    if (at === 0) return [run]
    if (at < run.text.length) out.push({ ...run, text: run.text.slice(at) })
    return out
  }
  const walk = (bs: readonly RenderBlock[]): RenderBlock[] =>
    bs.map((block) => {
      if (block.type === 'codeBlock') return block
      const inline = block.inline?.flatMap(split)
      const children = block.children && walk(block.children)
      return { ...block, ...(inline ? { inline } : {}), ...(children ? { children } : {}) }
    })
  return walk(blocks)
}

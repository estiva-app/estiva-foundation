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
import { bech32Decode, convertBits, decodeNevent, naddrToAddr } from './nip19.js'
import type { PartPointer } from './anchors.js'
import type { RenderBlock } from './render.js'

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
 * Whether an app link names this address, read the way Peek and Ship read a
 * pasted block link for a `part` (§13.6.1) — offline, with no manifest: its path ends in the address's `d`
 * (§7.2 puts the identity last, `…/<slug>-<d>`), and that `d` is long enough to
 * be one. A `d` comes from somebody's tag, so a short one would otherwise match
 * half the links in a body.
 */
export function urlNamesAddress(url: string, address: string): boolean {
  const d = address.split(':').slice(2).join(':')
  if (d.length < 8) return false
  const path = url.split(/[?#]/)[0].replace(/\/+$/, '')
  return path.endsWith(`-${d}`) || path.endsWith(`/${d}`)
}

/** The http(s) links in a run of text. Trailing punctuation is the sentence's, not the link's. */
function urlsIn(text: string): string[] {
  return (text.match(/https?:\/\/[^\s<>"'`]+/g) ?? []).map((url) => url.replace(/[.,;:!?)\]]+$/, ''))
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
 * the body names it — by a `nostr:` reference, or for an address by an app
 * link whose path ends in its `d` (§7.7) — and only when no `part` names the
 * same address, because the live block already stands for that object. Text in
 * a code span names nothing (§13.1).
 *
 * `none` entries are kept: they draw no card, but they still override the
 * reader's own default for that value (until milestone 2, Ship and Peek draw a
 * reference alone on its line as its card; an `embed` replaces that). Filter
 * them out to get the cards to draw.
 */
export function cardsIn(embeds: readonly Embed[], blocks: readonly RenderBlock[], parts: readonly PartPointer[] = []): Embed[] {
  if (embeds.length === 0) return []
  const byValue = new Map(embeds.map((e) => [e.value, e]))
  const addresses = embeds.filter((e) => ADDRESS.test(e.value)).map((e) => e.value)
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
    for (const url of urlsIn(text)) for (const a of addresses) if (urlNamesAddress(url, a)) take(a)
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

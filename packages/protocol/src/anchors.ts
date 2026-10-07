/**
 * A comment anchored to one block — SPEC §13.6, and RFC 0.4 §6's answer.
 *
 * The address says which object; a `block` tag says which part of it. That much
 * is two lines. **The reason this is a module rather than two lines is the
 * unhappy path**: an anchor outlives the thing it points at, and the ways it
 * stops resolving are not the same as each other.
 *
 * §13.6 requires a reader to distinguish four outcomes, and the one that
 * matters is `detached` versus `unanchored`. They render identically if you let
 * them and they mean opposite things — one is a remark about the object, the
 * other a remark about a paragraph somebody has since deleted. A reader that
 * collapses them silently converts the second into the first, and nothing
 * reports it.
 *
 * So {@link resolveBlockAnchor} returns which of the four it is, rather than a
 * block or `undefined`. A caller that wants to be careless has to work at it.
 */
import { type Block, type BlockDocument, findBlock, parseBlockDocument } from './blocks.js'
import type { ContentFormat } from './render.js'

/** The tag SPEC §13.6 defines. */
export const BLOCK_ANCHOR_TAG = 'block'

/**
 * What an anchor resolved to.
 *
 * A discriminated union on purpose: the four states are not degrees of success,
 * and a caller that treats "no anchor" and "the block is gone" as one thing has
 * the defect §13.6 is about.
 */
export type BlockAnchor =
  /** The comment carries no `block` tag. It is about the whole object. */
  | { state: 'unanchored' }
  /** The tag names a block that is present. */
  | { state: 'resolved'; id: string; block: Block }
  /**
   * The body is not a block document, so it has no parts to point at.
   *
   * Marker text has no addressable sub-unit (§13.1), so this is permanent for
   * that body rather than a failure — it is what two content models means.
   */
  | { state: 'unaddressable'; id: string }
  /** The tag names a block that is no longer in the document. */
  | { state: 'detached'; id: string }

/**
 * The block id a comment anchors to, or `undefined` when it anchors to none.
 *
 * Only a `kind:1111` anchors (§13.6): its `A` says which object the block is
 * in. A `kind:9` has no `A`, so a `block` tag on one names a part of nothing in
 * particular, and a reader that resolved it against the page it happened to be
 * drawn on would report a confident "deleted" about the wrong document. Pass
 * the event's kind and that case is refused; a message pointing at a block of
 * another object says so with a `part` tag instead ({@link partsOf}).
 */
export function blockAnchorOf(event: { kind?: number; tags: string[][] }): string | undefined {
  if (event.kind !== undefined && event.kind !== 1111) return undefined
  const id = event.tags.find((t) => t[0] === BLOCK_ANCHOR_TAG)?.[1]
  return id === undefined || id === '' ? undefined : id
}

/**
 * Which of §13.6's four states an anchor is in, against the body as it is now.
 *
 * `format` comes from the event carrying the *body* — `contentFormatOf` — and
 * never from inspecting `value` (§13.4). Passing `'blocks'` for a body that
 * does not parse yields `unaddressable` rather than throwing: a mis-tagged body
 * has no parts either, and a reader that throws renders nothing at all.
 */
export function resolveBlockAnchor(
  id: string | undefined,
  value: string,
  format: ContentFormat,
): BlockAnchor {
  if (id === undefined || id === '') return { state: 'unanchored' }
  if (format !== 'blocks') return { state: 'unaddressable', id }
  let document: BlockDocument
  try {
    document = parseBlockDocument(value)
  } catch {
    return { state: 'unaddressable', id }
  }
  const block = findBlock(document, id)
  return block ? { state: 'resolved', id, block } : { state: 'detached', id }
}

/**
 * A message pointing at one block of another object — SPEC §13.6.1 (COM-2).
 *
 * `["part", <address>, <block id>]`, beside the `a` for the same address and a
 * body that names it. The same `(object, block)` pair as an anchor, but a
 * different relation: an anchor is what a comment is *about* (like a reply's
 * `e`), a part is what a message *shows* (like a `q`). They are separate tags
 * so that one comment can be both anchored and pointing, and so that a reader
 * which knows neither draws an ordinary reference to the object.
 *
 * Index 3 is left free for an extent (a section, a range), which is not built.
 */
export const PART_TAG = 'part'

/** One `part` tag, read. */
export interface PartPointer {
  /** `kind:pubkey:d` — the object the block is in. */
  address: string
  /** §13.3's block id within that object's body. */
  block: string
}

/** The `part` tag for one block of one object. */
export function partTag(address: string, block: string): string[] {
  return [PART_TAG, address, block]
}

/**
 * The blocks a message points at, one per address, in tag order.
 *
 * The first tag for an address wins: a message shows one block of a given
 * object, and a second tag for it would be a second card nobody can tell
 * apart from the first by its reference in the text.
 *
 * **This is the tags only.** A reader draws a part only while the body still
 * names its address — by `nostr:naddr…` or an app URL (§7.7) — because an edit
 * carries no `part` (§6.8) and a person who removed the reference meant the
 * card to go too. Which addresses the body names is the reader's own
 * reference set; this function does not guess it.
 */
export function partsOf(event: { tags: string[][] }): PartPointer[] {
  const out: PartPointer[] = []
  const seen = new Set<string>()
  for (const tag of event.tags) {
    if (tag[0] !== PART_TAG) continue
    const [, address, block] = tag
    if (!address || !block || !isAddress(address) || !BLOCK_ID.test(block) || seen.has(address)) continue
    seen.add(address)
    out.push({ address, block })
  }
  return out
}

/**
 * The block ids a part may name. §13.3 fixes no grammar (`newBlockId` writes 12
 * hex; SPEC's examples say `b1`), but a part's id arrives from a stranger's tag
 * or a pasted URL and ends up in a fragment and, in an app, a selector — so a
 * reader takes only ids that are safe in both and drops the rest.
 */
const BLOCK_ID = /^[A-Za-z0-9_-]{1,64}$/

/** `kind:pubkey:d` with a numeric kind and a 64-hex pubkey. */
function isAddress(value: string): boolean {
  return /^\d+:[0-9a-f]{64}:/.test(value)
}

/**
 * What a part resolved to. Five states, and like {@link BlockAnchor} none of
 * them is a degree of another:
 *
 * - `resolved` — the block is there; draw it.
 * - `unaddressable` — the object's body is not a block document, so it has no
 *   parts. Permanent for that body, and nothing was deleted.
 * - `detached` — the object is readable and the block is gone from it.
 * - `deleted` — the whole object was deleted: its author's `kind:5` names it.
 * - `unreadable` — nothing came back and no deletion did either. **Not
 *   "exists but forbidden"**: an address that never existed reads exactly the
 *   same, and saying more would confirm a hidden object to anyone holding its
 *   address. A reader says it is not available to them, and shows no title and
 *   no text.
 *
 * `deleted` and `unreadable` must not render alike. That is the rule this
 * union is shaped to make hard to break.
 */
export type Part =
  | { state: 'resolved'; block: Block }
  | { state: 'unaddressable' }
  | { state: 'detached' }
  | { state: 'deleted' }
  | { state: 'unreadable' }

/**
 * What a reader holds for the object a part points at: its body, or the reason
 * it has none — from {@link absenceOf}.
 */
export type PartSource = { value: string; format: ContentFormat } | 'deleted' | 'unreadable'

/** Which of the five states a part is in, against its object as it is now. */
export function resolvePart(block: string, source: PartSource): Part {
  if (source === 'deleted' || source === 'unreadable') return { state: source }
  const anchor = resolveBlockAnchor(block, source.value, source.format)
  if (anchor.state === 'resolved') return { state: 'resolved', block: anchor.block }
  if (anchor.state === 'detached') return { state: 'detached' }
  return { state: 'unaddressable' }
}

/**
 * Why a read by address came back empty: `deleted` when the relay holds a
 * deletion of it by address (a `kind:5` with that `a`), else `unreadable`.
 *
 * `deletions` is what `{kinds: [5], "#a": [address]}` returned. A deletion
 * counts when either holds:
 *
 * - **its signer is the address's author** — NIP-09, true on any relay; or
 * - **it is the shape the relay checked**: no `e` tag, and the address is its
 *   *first* `a`. Buzz accepts that shape from the author or the author's owner
 *   (SPEC §6.5), and ownership is visible only to the relay — most objects here
 *   are written by an agent and deleted by the person who owns it.
 *
 * Anything else is unchecked. Buzz validates only the `e` targets when there
 * are any, and only the first `a` when there are none, yet stores every tag; a
 * member could otherwise add somebody's address as a second `a` and make their
 * hidden object read "deleted" to everyone who cannot see it.
 */
export function absenceOf(
  address: string,
  deletions: readonly { kind: number; pubkey: string; tags: string[][] }[],
): 'deleted' | 'unreadable' {
  const author = address.split(':')[1]
  const deleted = deletions.some((event) => {
    if (event.kind !== 5) return false
    if (event.pubkey === author) return event.tags.some((t) => t[0] === 'a' && t[1] === address)
    if (event.tags.some((t) => t[0] === 'e')) return false
    return event.tags.find((t) => t[0] === 'a')?.[1] === address
  })
  return deleted ? 'deleted' : 'unreadable'
}

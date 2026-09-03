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

/** The block id a comment anchors to, or `undefined` when it anchors to none. */
export function blockAnchorOf(event: { tags: string[][] }): string | undefined {
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

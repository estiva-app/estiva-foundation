/**
 * Writing a comment and a reply — SPEC §6.4 — and which controls to offer
 * on a message, §6.5.
 *
 * Chat, an edit, a reaction and a deletion are `@estiva-app/protocol`'s
 * `buildMessage`, `buildEdit`, `buildReaction` and `buildDeletion`, which are
 * byte-pinned there (a reaction also names its target's author, which upstream
 * Buzz does not write: SPEC §6.6). What is conversation-specific is the
 * NIP-22 pair below, whose shape the SPEC decided rather than Buzz.
 */
import { fileIdFormOf, fileIdOf, imetaTag, toNostrSeconds, type Imeta, type NostrTag, type UnsignedEvent } from '@estiva-app/protocol'
import { FOLDER_ID, KIND_COMMENT } from './kinds.js'

/**
 * A `kind:1111` is channel-scoped when it carries an `h` and **global when it
 * does not**, and the relay accepts both — so a comment without one is stored
 * world-readable however private its object. Refused here, loudly.
 */
function assertFolder(folder: string): void {
  if (!FOLDER_ID.test(folder)) throw new Error(`not a team id (lowercase UUID v4): ${JSON.stringify(folder)}`)
}

/** `<kind>:<pubkey>:<d>` → the `K` and `P` it already carries. */
function kindAndAuthor(address: string): [string, string] {
  const [kind, author] = address.split(':')
  if (!kind || !author) throw new Error(`not an address: ${JSON.stringify(address)}`)
  return [kind, author]
}

/**
 * A top-level comment on an object. Tag order: `A`, `K`, `P`, `[O, K]`, `a`,
 * `k`, `[o, k]`, `p`, `[block]`, `h`, `ts`, `[imeta…]`, then `tags`.
 *
 * The bracketed pairs name the file by its id and its type once the relay
 * keeps that type in order (§6.4, "A comment in both forms"): the first `K`
 * and `k` stay the address's kind, for a reader that takes the first.
 *
 * Uppercase and lowercase name the same object, as NIP-22 says for a
 * top-level comment. `K` and `P` come from the address, so a caller cannot
 * state a kind that contradicts its own `A`. `block` is SPEC §13.6: which part
 * of the object, when the author was looking at one. `tags` is for what the
 * body earns — {@link referenceTagsFor} and {@link mentionTagsFor} — and
 * nothing else: an `a` there that the body does not name breaks §6.4.
 */
export function buildComment(
  pubkey: string,
  createdAtMs: number,
  args: {
    about: string
    folder: string
    body: string
    blockId?: string
    files?: readonly Imeta[]
    tags?: readonly NostrTag[]
    /** The types the relay keeps in order (`RelayFileReads.inOrder`): a file of one is named by its id too. */
    inOrder?: readonly string[]
  },
): UnsignedEvent {
  assertFolder(args.folder)
  const [kind, author] = kindAndAuthor(args.about)
  const byId = fileIdFormOf(args.inOrder ?? [], args.about)
  return {
    pubkey,
    created_at: toNostrSeconds(createdAtMs),
    kind: KIND_COMMENT,
    tags: [
      ['A', args.about],
      ['K', kind],
      ['P', author],
      ...(byId ? [['O', byId.id], ['K', byId.type]] : []),
      ['a', args.about],
      ['k', kind],
      ...(byId ? [['o', byId.id], ['k', byId.type]] : []),
      ['p', author],
      ...(args.blockId ? [['block', args.blockId]] : []),
      ['h', args.folder],
      ['ts', String(Math.floor(createdAtMs))],
      ...(args.files ?? []).map(imetaTag),
      ...(args.tags ?? []),
    ],
    content: args.body,
  }
}

/** The top-level comment a reply answers. */
export interface CommentRef {
  /** Its event id. */
  id: string
  /** The object its thread is about: its `A`. */
  anchor: string
  /**
   * Its author. Undefined when the comment is outside the read; the reply
   * then carries no `p`, because a wrong one notifies the wrong person.
   */
  author?: string
  /**
   * Where on its object the comment is: its own `block` and `quote` tags
   * ({@link placeOf}). The reply copies them, so its thread keeps its place
   * once the comment is deleted (§13.6). Absent when the comment is on the
   * whole object or outside the read.
   */
  place?: readonly NostrTag[]
}

/** The tags that say where on its object a comment is (§13.6): `block` and `quote`. */
const PLACE_TAGS = new Set(['block', 'quote'])

/**
 * A comment's place, as its event carries it: its `block` and `quote` tags,
 * verbatim, for {@link CommentRef.place}. Empty when it is on the whole object.
 *
 * why: https://github.com/estiva-app/estiva-docs/blob/main/decisions/a-reply-on-a-page-keeps-its-threads-place.md
 */
export function placeOf(comment: { tags: readonly NostrTag[] }): NostrTag[] {
  // One of each, the first, as every reader reads it: a stranger's extra tags are not copied under the replier's key.
  return [...PLACE_TAGS].map((name) => comment.tags.find((t) => t[0] === name)).filter((t): t is NostrTag => !!t)
}

/**
 * A reply to a comment — §6.4 *Replies*, C16. Tag order: `A`, `K`, `P`,
 * `[O, K]`, `e`, `k`, `[p]`, `[block, quote]`, `h`, `ts`, `[imeta…]`, then `tags`.
 *
 * **Flat, one level deep**: `e` names the thread's top-level comment, never
 * another reply. **No lowercase `a`** for the object: NIP-22 reads it as the
 * parent, so it would claim the reply is itself a top-level comment. The reply
 * is found by `#e` on the comment. **Its comment's place, copied** (§13.6):
 * the `block` and `quote` tags of `comment.place` as written, and no other
 * tag from it.
 *
 * why: https://github.com/estiva-app/estiva-docs/blob/main/decisions/a-reply-on-a-page-keeps-its-threads-place.md
 */
export function buildReply(
  pubkey: string,
  createdAtMs: number,
  args: {
    comment: CommentRef
    folder: string
    body: string
    files?: readonly Imeta[]
    tags?: readonly NostrTag[]
    /** As {@link buildComment}'s: the reply names its file by its id as its comment does. */
    inOrder?: readonly string[]
  },
): UnsignedEvent {
  assertFolder(args.folder)
  const [kind, author] = kindAndAuthor(args.comment.anchor)
  const byId = fileIdFormOf(args.inOrder ?? [], args.comment.anchor)
  // Its own file is its `A`/`O`, never a link: not by address, and not by id in an `o` or a `part`.
  const ownId = fileIdOf(args.comment.anchor)
  const earned = (args.tags ?? []).filter(
    (t) =>
      !(t[0] === 'a' && t[1] === args.comment.anchor) &&
      !((t[0] === 'o' || t[0] === 'part') && ownId !== undefined && t[1] === ownId) &&
      !PLACE_TAGS.has(t[0]),
  )
  return {
    pubkey,
    created_at: toNostrSeconds(createdAtMs),
    kind: KIND_COMMENT,
    tags: [
      ['A', args.comment.anchor],
      ['K', kind],
      ['P', author],
      ...(byId ? [['O', byId.id], ['K', byId.type]] : []),
      ['e', args.comment.id],
      ['k', String(KIND_COMMENT)],
      ...(args.comment.author ? [['p', args.comment.author]] : []),
      ...(args.comment.place ? placeOf({ tags: args.comment.place }).map((t) => [...t]) : []),
      ['h', args.folder],
      ['ts', String(Math.floor(createdAtMs))],
      ...(args.files ?? []).map(imetaTag),
      ...earned,
    ],
    content: args.body,
  }
}

/**
 * Whether to offer Edit and Delete on a message — §6.5, decided 2026-10-06
 * (SHI-29, C14). Offered only on the viewer's own message: not on another
 * person's, and not on an agent's, whose NIP-OA owner the relay accepts but
 * no app can identify — offering it to everyone showed every other viewer a
 * control the relay refuses. An unknown viewer is offered nothing.
 *
 * why: https://github.com/estiva-app/estiva-docs/blob/main/decisions/edit-and-delete-are-offered-only-on-your-own-message.md
 */
export function offersEditAndDelete(args: { viewer: string | null | undefined; author: string }): boolean {
  return !!args.viewer && args.viewer === args.author
}

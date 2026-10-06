/**
 * Writing a comment and a reply — SPEC §6.4 — and which controls to offer
 * on a message, §6.5.
 *
 * Chat, an edit, a reaction and a deletion are `@estiva-app/protocol`'s
 * `buildMessage`, `buildEdit`, `buildReaction` and `buildDeletion`, which are
 * already Buzz-shaped and byte-pinned. What is conversation-specific is the
 * NIP-22 pair below, whose shape the SPEC decided rather than Buzz.
 */
import { imetaTag, toNostrSeconds, type Imeta, type NostrTag, type UnsignedEvent } from '@estiva-app/protocol'
import { FOLDER_ID, KIND_COMMENT } from './kinds.js'

/**
 * A `kind:1111` is channel-scoped when it carries an `h` and **global when it
 * does not**, and the relay accepts both — so a comment without one is stored
 * world-readable however private its object. Refused here, loudly.
 */
function assertFolder(folder: string): void {
  if (!FOLDER_ID.test(folder)) throw new Error(`not a Folder id (lowercase UUID v4): ${JSON.stringify(folder)}`)
}

/** `<kind>:<pubkey>:<d>` → the `K` and `P` it already carries. */
function kindAndAuthor(address: string): [string, string] {
  const [kind, author] = address.split(':')
  if (!kind || !author) throw new Error(`not an address: ${JSON.stringify(address)}`)
  return [kind, author]
}

/**
 * A top-level comment on an object. Tag order: `A`, `K`, `P`, `a`, `k`, `p`,
 * `[block]`, `h`, `ts`, `[imeta…]`, then `tags`.
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
  args: { about: string; folder: string; body: string; blockId?: string; files?: readonly Imeta[]; tags?: readonly NostrTag[] },
): UnsignedEvent {
  assertFolder(args.folder)
  const [kind, author] = kindAndAuthor(args.about)
  return {
    pubkey,
    created_at: toNostrSeconds(createdAtMs),
    kind: KIND_COMMENT,
    tags: [
      ['A', args.about],
      ['K', kind],
      ['P', author],
      ['a', args.about],
      ['k', kind],
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
}

/**
 * A reply to a comment — §6.4 *Replies*, C16. Tag order: `A`, `K`, `P`, `e`,
 * `k`, `[p]`, `h`, `ts`, `[imeta…]`, then `tags`.
 *
 * **Flat, one level deep**: `e` names the thread's top-level comment, never
 * another reply. **No lowercase `a`** for the object: NIP-22 reads it as the
 * parent, so it would claim the reply is itself a top-level comment. The reply
 * is found by `#e` on the comment.
 */
export function buildReply(
  pubkey: string,
  createdAtMs: number,
  args: { comment: CommentRef; folder: string; body: string; files?: readonly Imeta[]; tags?: readonly NostrTag[] },
): UnsignedEvent {
  assertFolder(args.folder)
  const [kind, author] = kindAndAuthor(args.comment.anchor)
  const earned = (args.tags ?? []).filter((t) => !(t[0] === 'a' && t[1] === args.comment.anchor))
  return {
    pubkey,
    created_at: toNostrSeconds(createdAtMs),
    kind: KIND_COMMENT,
    tags: [
      ['A', args.comment.anchor],
      ['K', kind],
      ['P', author],
      ['e', args.comment.id],
      ['k', String(KIND_COMMENT)],
      ...(args.comment.author ? [['p', args.comment.author]] : []),
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
 */
export function offersEditAndDelete(args: { viewer: string | null | undefined; author: string }): boolean {
  return !!args.viewer && args.viewer === args.author
}

/**
 * One shape for a message, a reply and a thread — SPEC §6.3–§6.8 and §6.4's
 * "Resolving a thread", folded once for every app (ONE-2).
 *
 * Peek, Ship and Leaf each read a conversation into their own shape until
 * now, and they disagreed: on which resolve counts, on what a deleted
 * comment's thread shows, and on whether a reaction is known by its person's
 * key or name. {@link foldThreads} is the one answer. It draws nothing — the
 * kit in `@estiva-app/ui` takes words and nodes, and this sits below it.
 *
 * why: https://github.com/estiva-app/estiva-docs/blob/main/decisions/a-conversation-is-one-shared-thing-and-only-its-colours-are-the-apps.md
 */
import {
  BLOCK_ANCHOR_TAG,
  imetaOf,
  partsOf,
  quoteOf,
  readRunIds,
  type Embed,
  type Imeta,
  type PartPointer,
  type Quote,
  type SignedEvent,
} from '@estiva-app/protocol'
import { editsByTarget, foldEdits, foldEmbeds } from './edits.js'
import { isConversationKind, isEventId, KIND_COMMENT, KIND_DELETION, KIND_REACTION } from './kinds.js'
import { orderingMs } from './order.js'
import { groupReactions, reactionEventsOf, type Reaction } from './reactions.js'
import { resolutionOf, resolutionsByTarget, type Resolution } from './resolution.js'
import { groupThreads } from './threads.js'

/** One message — a top-level comment, a channel message or a reply — as it stands after its edits. */
export interface Message {
  id: string
  kind: number
  /** Who wrote it, by key. */
  author: string
  /** Its `h`: the Folder it was filed in. */
  folder?: string
  /** When it was written, epoch milliseconds (§6.3: the trusted `ts`, else `created_at` × 1000). */
  at: number
  /** The text to show: the latest edit's, else its own (§6.8). */
  body: string
  /** Whether an edit changed the body — what a reader MUST mark (§6.8). */
  edited: boolean
  /** When the body last changed, epoch milliseconds. Absent unless `edited`. */
  editedAt?: number
  /** Its files: the latest edit's `imeta` set, else its own (§6.8, C15). */
  files: Imeta[]
  /** The cards its writer carried (`embed`, §13.6.2), after edits (C20). Which of them the body still names is the drawer's (`cardsIn`). */
  cards: Embed[]
  /** The blocks drawn live under it (`part`, §13.6.1). An edit carries none, so these are the message's own. */
  parts: PartPointer[]
  /** What its words link: its `a` and `q` values, or the latest edit's when it was edited, since an edit is the whole new message (§6.4, §6.8). */
  links: string[]
  /**
   * What a comment on part of a document is about (§13.6): the run of blocks
   * in its `block` tag, and the words in its `quote` when it quotes some. An
   * edit never moves it.
   */
  anchor?: { blocks: string[]; quote?: Quote }
  /** Its reactions by emoji, each reactor by key (§6.6). */
  reactions: Reaction[]
  /** The event itself, for what this shape does not carry. */
  event: SignedEvent
}

/**
 * The thread's top-level message, in one of §6.5's three states:
 * - `present` — returned, and not deleted;
 * - `deleted` — its author's `kind:5` came back: drawn as "This comment was
 *   deleted", its replies under it;
 * - `missing` — only its replies were read. Drawn as their thread, never as
 *   deleted: it may only be outside the read.
 */
export type RootState = 'present' | 'deleted' | 'missing'

/** A thread: a top-level message, its replies, and its state. */
export interface Thread {
  /** The top-level message's id, whether or not it was returned. */
  id: string
  state: RootState
  /** The top-level message, when `present`. */
  root?: Message
  /** Its replies, oldest first by §6.3; a deleted reply is left out. */
  replies: Message[]
  /** The thread's Folder: its top-level message's `h`, else its replies'. */
  folder?: string
  /** The resolve or reopen that counts (§6.4, C51); absent when none does. `resolution.action` is the state. */
  resolution?: Resolution
  /**
   * Whether Resolve or Reopen may be offered, as far as the thread can say:
   * only on a top-level message that is `present`. Whether the reader may
   * write in its Folder, and whether its file is archived, is the app's to add.
   */
  resolvable: boolean
}

const values = (event: Pick<SignedEvent, 'tags'>, name: string) =>
  event.tags.filter((t) => t[0] === name && typeof t[1] === 'string' && t[1] !== '').map((t) => t[1])

/**
 * What its author took back: the ids a `kind:5` names by `e`, kept only for
 * the event it names when its signer wrote that event (§6.5). A `kind:5` for
 * an event the read does not hold is kept by its signer, for a top-level
 * message known only from its replies.
 */
function deletionsOf(events: readonly SignedEvent[]): Map<string, Set<string>> {
  const by = new Map<string, Set<string>>()
  for (const event of events) {
    if (event.kind !== KIND_DELETION) continue
    for (const id of values(event, 'e')) {
      if (!isEventId(id)) continue
      const key = id.toLowerCase()
      if (!by.has(key)) by.set(key, new Set())
      by.get(key)!.add(event.pubkey)
    }
  }
  return by
}

/**
 * Fold a conversation into its threads (§6.3–§6.8).
 *
 * `events` is everything read for it: its `kind:9` or `kind:1111` messages,
 * and the `kind:40003` edits, `kind:7` reactions, `kind:5` deletions and
 * `kind:9101` resolutions read by `#e` on them. Duplicates are read once.
 * `viewer` marks the viewer's own reactions (`Reaction.mine`).
 *
 * Threads come oldest first by their top-level message, or by their first
 * reply when it was not returned. A reply to a reply is filed under the
 * thread's top-level message (§6.4).
 */
export function foldThreads(events: readonly SignedEvent[], options: { viewer?: string } = {}): Thread[] {
  const unique = [...new Map(events.map((e) => [e.id, e])).values()]
  const deletions = deletionsOf(unique)
  const deletedBy = (id: string, author: string | undefined) => author !== undefined && deletions.get(id.toLowerCase())?.has(author) === true
  /*
    A top-level message the read did not return is known deleted only by its
    author's `kind:5`, and its author only from its replies: a reply's
    lowercase `p` names the comment's author (§6.4). Every `kind:1111` reply
    must name the deletion's signer, so one reply's tags cannot speak for a
    thread others answered; a channel `kind:9` names no author, and stays
    `missing`.
  */
  /** A comment the read did not return is in the Folder most of its replies were filed in, or none on a tie (§6.5). */
  const replyFolderOf = (answers: readonly SignedEvent[]): string | undefined => {
    const count = new Map<string, number>()
    for (const r of answers) {
      const h = values(r, 'h')[0]
      if (h) count.set(h, (count.get(h) ?? 0) + 1)
    }
    const ranked = [...count].sort((a, b) => b[1] - a[1])
    return ranked.length > 0 && (ranked.length === 1 || ranked[0][1] > ranked[1][1]) ? ranked[0][0] : undefined
  }
  const deletedUnseen = (id: string, answers: readonly SignedEvent[]) => {
    const comments = answers.filter((r) => r.kind === KIND_COMMENT)
    const signers = deletions.get(id.toLowerCase())
    if (!signers || comments.length === 0) return false
    return [...signers].some((signer) => comments.every((r) => r.tags.some((t) => t[0] === 'p' && t[1] === signer)))
  }

  const messages = unique.filter((e) => isConversationKind(e.kind))
  const edits = foldEdits(unique)
  const edited = editsByTarget(unique)
  const cardsOf = foldEmbeds(unique)
  // A taken-back reaction leaves before the one-per-person fold, so the same person's later one counts.
  const reactions = groupReactions(
    reactionEventsOf(unique.filter((e) => e.kind !== KIND_REACTION || !deletedBy(e.id, e.pubkey))),
    options.viewer,
  )
  const resolutions = resolutionsByTarget(unique)

  const messageOf = (event: SignedEvent): Message => {
    const id = event.id.toLowerCase()
    const fold = edits[id]
    // An edit is the whole new message (§6.8): what its words link is the latest edit's `a` and `q`.
    const linkSource = edited.get(id)?.at(-1) ?? event
    const blockTag = event.tags.find((t) => t[0] === BLOCK_ANCHOR_TAG)
    const blocks = blockTag ? readRunIds(blockTag.slice(1)) : undefined
    const quote = blocks ? quoteOf(event) : undefined
    const folder = values(event, 'h')[0]
    return {
      id,
      kind: event.kind,
      author: event.pubkey,
      ...(folder ? { folder } : {}),
      at: orderingMs(event),
      body: fold?.body ?? event.content,
      edited: fold?.edited ?? false,
      ...(fold?.editedAt !== undefined ? { editedAt: fold.editedAt } : {}),
      files: fold ? fold.attachments : imetaOf(event),
      cards: cardsOf[id] ?? [],
      parts: partsOf(event),
      links: [...new Set([...values(linkSource, 'a'), ...values(linkSource, 'q')])],
      ...(blocks && event.kind === KIND_COMMENT ? { anchor: { blocks, ...(quote ? { quote } : {}) } } : {}),
      reactions: reactions[id] ?? [],
      event,
    }
  }

  const { roots, replies, missingRoots } = groupThreads(messages)
  const threads: Thread[] = []
  const thread = (id: string, root: SignedEvent | undefined): Thread => {
    const all = replies[id] ?? []
    const kept = all.filter((r) => !deletedBy(r.id, r.pubkey)).map(messageOf)
    const folder = root ? values(root, 'h')[0] : replyFolderOf(all)
    // Not returned, only the replies filed in the thread's Folder speak for its comment: one filed elsewhere neither deletes nor clears.
    const speaking = root ? all : all.filter((r) => values(r, 'h')[0] === folder)
    const state: RootState = (root ? deletedBy(id, root.pubkey) : folder !== undefined && deletedUnseen(id, speaking)) ? 'deleted' : root ? 'present' : 'missing'
    const resolution = resolutionOf(resolutions[id.toLowerCase()] ?? [], { folder, replies: kept.map((r) => r.id) })
    return {
      id: id.toLowerCase(),
      state,
      ...(state === 'present' && root ? { root: messageOf(root) } : {}),
      replies: kept,
      ...(folder ? { folder } : {}),
      ...(resolution ? { resolution } : {}),
      resolvable: state === 'present',
    }
  }
  for (const root of roots) threads.push(thread(root.id, root))
  for (const id of missingRoots) threads.push(thread(id, undefined))
  // A thread whose top-level message is gone and has no reply left has nothing to draw.
  const drawn = threads.filter((t) => t.root || t.replies.length > 0)
  const firstAt = (t: Thread) => t.root?.at ?? t.replies[0].at
  return drawn.sort((a, b) => firstAt(a) - firstAt(b) || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))
}

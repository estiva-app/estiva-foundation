/**
 * What is unread — SPEC §11.8 *What membership changes about unread*, judged
 * against §11.3's effective marker.
 *
 * A message in a stream is unread for `P` when all of these hold:
 *
 * 1. `P` is a member and has not muted the stream, or its content mentions `P`;
 * 2. `P` did not write it;
 * 3. its `created_at` is at or after the second `P` became a member;
 * 4. it is newer than `P`'s effective marker.
 *
 * For a file, membership is {@link membershipOf}'s fold, and condition 3 is
 * what settles a file with no marker (§11.6): unread from joining, not from
 * the start of a horizon. A channel's general stream takes its membership
 * from the roster, which carries no join time — so `since` is undefined and
 * what counts without a marker is the app's `floor`.
 *
 * An app lights nothing for a stream it has no screen for (§11.8); that is
 * the caller's to decide by not asking.
 */
import type { SignedEvent } from '@estiva-app/protocol'
import { effectiveReadAt, threadContext } from './readState.js'
import { peopleNamedInBody } from './strength.js'
import { groupThreads } from './threads.js'

type Message = Pick<SignedEvent, 'id' | 'pubkey' | 'kind' | 'created_at' | 'tags' | 'content'>

/** Who is judging one stream, and on what terms. */
export interface StreamJudge {
  /** The stream's context (§11.1): the file's address, or the channel uuid for its general stream. */
  stream: string
  /** The person reading. */
  me: string
  /** Whether `me` is a member — {@link membershipOf} for a file, the roster for a channel. */
  member: boolean
  /** Unix seconds `me` became a member; undefined for a channel, where the roster has no join time. */
  since?: number
  /** Whether `me` muted the stream (`estiva:muted:v1`). A mention still counts. */
  muted?: boolean
  /**
   * For a stream with no marker, the earliest `created_at` that counts — the
   * app's choice for a channel (§11.6). A file member does not need it: `since`
   * already bounds it. Undefined counts everything.
   */
  floor?: number
}

/**
 * The unread messages of one stream, oldest first per thread. `messages` is
 * the stream's own (see {@link streamOf} for a file); a reply is judged
 * against `thread:<root>` as well as the stream (§11.3).
 *
 * A dot is `unreadIn(…).length > 0`; a divider goes above the first unread
 * message of each thread.
 */
export function unreadIn<E extends Message>(messages: readonly E[], merged: Readonly<Record<string, number>>, judge: StreamJudge): E[] {
  const { roots, replies } = groupThreads(messages)
  const out: E[] = []
  const consider = (message: E, root: string | undefined) => {
    if (isUnread(message, root, merged, judge)) out.push(message)
  }
  for (const root of roots) {
    consider(root, undefined)
    for (const reply of replies[root.id] ?? []) consider(reply, root.id)
  }
  const held = new Set(roots.map((r) => r.id))
  for (const [root, list] of Object.entries(replies)) {
    if (held.has(root)) continue
    for (const reply of list) consider(reply, root)
  }
  return out
}

/** Whether one message is unread: §11.8's four conditions. `root` is its thread's root id when it is a reply. */
export function isUnread(message: Message, root: string | undefined, merged: Readonly<Record<string, number>>, judge: StreamJudge): boolean {
  if (message.pubkey === judge.me) return false
  const mentioned = peopleNamedInBody(message.content).has(judge.me)
  if (!mentioned && (!judge.member || judge.muted)) return false
  if (judge.since !== undefined && message.created_at < judge.since) return false
  const thread = root === undefined ? undefined : threadContext(root)
  const marker = thread === undefined ? merged[judge.stream] : effectiveReadAt(merged, thread, judge.stream)
  if (marker !== undefined) return message.created_at > marker
  if (judge.since !== undefined) return true
  return judge.floor === undefined || message.created_at >= judge.floor
}

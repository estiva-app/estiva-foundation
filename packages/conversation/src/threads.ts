/**
 * Threading — SPEC §6.4 *Replies*.
 *
 * Two reply shapes, one per kind, and they do not mix:
 *
 * - **A reply to a comment is a flat `kind:1111`.** Uppercase `A`/`K`/`P` are
 *   the object; lowercase `e`/`k`/`p` name the thread's top-level comment,
 *   never another reply. A reader that meets a reply to a reply anyway SHOULD
 *   walk its parents to the top-level comment rather than drop it.
 * - **A reply in a channel stays a `kind:9`**, threaded by Buzz's
 *   `thread_tags`: `['e', <root>, '', 'reply']` for a direct reply, and a
 *   `root`/`reply` pair for a nested one. A reader files a nested one under
 *   its `root`-marked `e`, which names the thread, rather than dropping it
 *   because its parent is not a root.
 */
import type { SignedEvent } from '@estiva-app/protocol'
import { KIND_COMMENT } from './kinds.js'
import { byOrder } from './order.js'

type Tagged = Pick<SignedEvent, 'kind' | 'tags'>

/** The `e` tags that can thread: a NIP-10 `mention`-marked one quotes an event and answers nothing. */
const es = (event: Pick<SignedEvent, 'tags'>) =>
  event.tags.filter((t) => t[0] === 'e' && typeof t[1] === 'string' && t[1] !== '' && t[3] !== 'mention')

/**
 * The event this one answers, or null when it is a root.
 *
 * - `kind:1111`: the lowercase `e` that is not its `E` — the parent comment.
 *   A top-level comment on an event root carries `E` and `e` naming the same
 *   event, and is a root.
 * - `kind:9` (and any other kind): the thread — the `root`-marked `e`, else
 *   the `reply`-marked one, else the first unmarked `e` when there is only one,
 *   else the first of several (NIP-10's positional form).
 */
export function parentOf(event: Tagged): string | null {
  const tags = es(event)
  if (tags.length === 0) return null
  if (event.kind === KIND_COMMENT) {
    const root = event.tags.find((t) => t[0] === 'E')?.[1]
    return tags.find((t) => t[1] !== root)?.[1] ?? null
  }
  const marked = (marker: string) => tags.find((t) => t[3] === marker)?.[1]
  return marked('root') ?? marked('reply') ?? tags[0][1]
}

/** A conversation's events, threaded. */
export interface Threaded<E extends Tagged & Pick<SignedEvent, 'id' | 'created_at'>> {
  /** The roots present in the read, oldest first. */
  roots: E[]
  /**
   * Every reply per thread, keyed by the thread's root id, oldest first. A
   * reply to a reply is filed under the thread's root, not its parent. A root
   * with no replies is absent, not `[]`.
   */
  replies: Record<string, E[]>
  /**
   * Thread roots that replies point at but the read does not hold — deleted,
   * or outside the read. Their replies are in `replies` under that id; what to
   * draw in the root's place is the app's (Peek draws "This comment was
   * deleted", PER-24).
   */
  missingRoots: string[]
}

/**
 * Thread a conversation: every root, and every reply filed under its thread's
 * root by walking parents (§6.4). Duplicate ids are read once; order is
 * §6.3's.
 */
export function groupThreads<E extends Tagged & Pick<SignedEvent, 'id' | 'created_at'>>(events: readonly E[]): Threaded<E> {
  const byId = new Map<string, E>()
  for (const event of events) if (!byId.has(event.id)) byId.set(event.id, event)

  const rootOf = (event: E): string => {
    const visited = new Set<string>([event.id])
    let parent = parentOf(event)
    while (parent !== null) {
      const next = byId.get(parent)
      if (!next || visited.has(parent)) return parent
      visited.add(parent)
      const up = parentOf(next)
      if (up === null) return parent
      parent = up
    }
    return event.id
  }

  const roots: E[] = []
  const replies: Record<string, E[]> = {}
  const missing = new Set<string>()
  for (const event of byId.values()) {
    const root = rootOf(event)
    if (root === event.id) {
      roots.push(event)
      continue
    }
    ;(replies[root] ??= []).push(event)
    if (!byId.has(root)) missing.add(root)
  }
  roots.sort(byOrder)
  for (const list of Object.values(replies)) list.sort(byOrder)
  return { roots, replies, missingRoots: [...missing] }
}

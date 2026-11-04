/**
 * Resolving a thread — SPEC §6.4, "Resolving a thread" (ONE-2), and C51.
 *
 * A `kind:9101` with `t=resolution` resolves or reopens the thread of the
 * top-level message its first unmarked `e` names. Anyone who may write in that
 * message's Folder may write one, and **the newest counts, in §6.3's order**
 * (`byOrder`): `ts` when trusted, then `created_at`, then the higher id.
 * A reader ignores one whose `h` is not its target's Folder, one about a reply
 * (never walked to its root), and drops a `support` outside the thread.
 *
 * why: https://github.com/estiva-app/estiva-docs/blob/main/decisions/anyone-who-may-comment-resolves-or-reopens-a-thread-and-the-newest-counts.md
 */
import type { SignedEvent } from '@estiva-app/protocol'
import { isEventId, KIND_ASSERTION } from './kinds.js'
import { orderingMs } from './order.js'

/** A `kind:9101` resolution assertion on a message (PEEK-128, SPEC §6.4). */
export interface Resolution {
  id: string
  action: 'resolved' | 'reopened'
  by: string
  /** `created_at`, seconds. */
  at: number
  /** Where it sorts, epoch milliseconds: the trusted `ts`, else `at` × 1000 (§6.3). */
  orderMs: number
  /** Its `h`: the Folder it was filed in, which must be its target's. */
  folder?: string
  /** The assertion's free text, when it carried one. */
  message?: string
  /** The reply that carried the resolution, when the writer named one. */
  supportingEventId?: string
}

const tagValue = (event: Pick<SignedEvent, 'tags'>, name: string) => event.tags.find((t) => t[0] === name)?.[1]

/**
 * The message a `kind:9101` is about: its **first unmarked `e`**, lowercased.
 * Not the first one a reader happens to hold — a resolve listing a stranger
 * first and a thread second is about the stranger.
 */
export function resolutionTargetOf(event: Pick<SignedEvent, 'tags'>): string | undefined {
  const tag = event.tags.find((t) => t[0] === 'e' && !t[3])
  return tag && isEventId(tag[1]) ? tag[1].toLowerCase() : undefined
}

/** The event read as a {@link Resolution} with its target, or undefined when it is not one. */
export function resolutionOfEvent(event: SignedEvent): { target: string; resolution: Resolution } | undefined {
  if (event.kind !== KIND_ASSERTION || tagValue(event, 't') !== 'resolution') return undefined
  const action = tagValue(event, 'action')
  if (action !== 'resolved' && action !== 'reopened') return undefined
  const target = resolutionTargetOf(event)
  if (!target) return undefined
  const support = event.tags.find((t) => t[0] === 'e' && t[3] === 'support')?.[1]
  const folder = tagValue(event, 'h')
  return {
    target,
    resolution: {
      id: event.id,
      action,
      by: event.pubkey,
      at: event.created_at,
      orderMs: orderingMs(event),
      ...(folder ? { folder } : {}),
      ...(event.content ? { message: event.content } : {}),
      ...(isEventId(support) ? { supportingEventId: support.toLowerCase() } : {}),
    },
  }
}

/** Oldest first by §6.3: `ts` when trusted, then `created_at`, then the lower id. */
export const byResolutionOrder = (a: Resolution, b: Resolution): number =>
  a.orderMs - b.orderMs || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0)

/**
 * A thread's state: the newest of `resolutions` that counts, or undefined when
 * none does (never resolved, or only ones a reader ignores).
 *
 * `resolutions` are those whose target is the thread's **top-level** message;
 * one about a reply is never passed here. `folder` is that message's Folder
 * (for a top-level message the read did not return, its replies'), and
 * `replies` the thread's reply ids: a `support` naming anything else is
 * dropped and the resolve stands.
 */
export function resolutionOf(
  resolutions: readonly Resolution[],
  thread: { folder: string | undefined; replies: readonly string[] },
): Resolution | undefined {
  if (!thread.folder) return undefined
  const newest = resolutions
    .filter((r) => r.folder === thread.folder)
    .sort(byResolutionOrder)
    .at(-1)
  if (!newest?.supportingEventId) return newest
  const replies = new Set(thread.replies.map((id) => id.toLowerCase()))
  if (replies.has(newest.supportingEventId)) return newest
  const { supportingEventId: _dropped, ...kept } = newest
  return kept
}

/** Every resolution in `events`, by target id, oldest first (§6.3). */
export function resolutionsByTarget(events: readonly SignedEvent[]): Record<string, Resolution[]> {
  const out: Record<string, Resolution[]> = {}
  const seen = new Set<string>()
  for (const event of events) {
    if (seen.has(event.id)) continue
    seen.add(event.id)
    const read = resolutionOfEvent(event)
    if (read) (out[read.target] ??= []).push(read.resolution)
  }
  for (const list of Object.values(out)) list.sort(byResolutionOrder)
  return out
}

/**
 * The one ordering — SPEC §6.3, with §6.2's `ts` rule.
 *
 * Ordering, most significant first: `ts` (when trusted), then `created_at`,
 * then event `id`. Edits (§6.8) fold by it on purpose, because a second
 * ordering rule in the same protocol is a second thing to get wrong.
 *
 * **`ts` is trusted only when `floor(ts / 1000) == created_at`, exactly**
 * (§6.2, clarified 2026-09-29, CON-5). Peek's edit fold and interop's change
 * and edit folds accepted ±1 s; that lets a `ts` claim the neighbouring second,
 * which is the one thing the rule exists to prevent. Every writer floors, and
 * all 3,470 events carrying `ts` on production agreed exactly, so the strict
 * reading changes no fold that exists.
 */
import type { SignedEvent } from '@estiva-app/protocol'

type Ordered = Pick<SignedEvent, 'id' | 'created_at' | 'tags'>

/** The event's `ts` in epoch milliseconds when §6.2 lets a reader trust it, else undefined. */
export function trustedTs(event: Pick<SignedEvent, 'created_at' | 'tags'>): number | undefined {
  const value = event.tags.find((t) => t[0] === 'ts')?.[1]
  if (value === undefined || !/^\d+$/.test(value)) return undefined
  const ms = Number(value)
  return Number.isSafeInteger(ms) && Math.floor(ms / 1000) === event.created_at ? ms : undefined
}

/** Epoch milliseconds to order by: the trusted `ts`, else `created_at` as milliseconds. */
export function orderingMs(event: Pick<SignedEvent, 'created_at' | 'tags'>): number {
  return trustedTs(event) ?? event.created_at * 1000
}

/** Oldest first by §6.3: `ts` when trusted, then `created_at`, then the lower id. */
export function byOrder(a: Ordered, b: Ordered): number {
  const at = orderingMs(a)
  const bt = orderingMs(b)
  if (at !== bt) return at - bt
  return a.id < b.id ? -1 : a.id > b.id ? 1 : 0
}

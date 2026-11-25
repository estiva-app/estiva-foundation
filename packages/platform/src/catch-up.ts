/**
 * Bring a question up to date from the copy on the device with NIP-77 (THE-5).
 *
 * The copy tells the relay what it holds for each filter; the relay answers
 * with what the copy is missing and what it holds that the person may no longer
 * read or that is gone; only the missing events are fetched, by id. The copy
 * then holds what asking again would have returned, and the caller gets that
 * answer, as if it had asked. Nothing the copy holds is ever uploaded.
 *
 * Asking again stays, and is chosen per filter: for a relay that does not speak
 * NIP-77 or refuses, for a filter the copy cannot judge (`search`), for a small
 * one where two round trips cost more than the answer, and for a windowed one
 * (`limit`) whose window moved further than the catch-up saves.
 *
 * A file list (`"fields": "newest"`, SPEC §6.13) is caught up the same way,
 * from the ids of its last answer the copy remembers.
 *
 * why: https://github.com/estiva-app/estiva-docs/blob/main/decisions/a-copy-on-the-device-catches-up-with-nip-77.md
 * why: https://github.com/estiva-app/estiva-docs/blob/main/decisions/a-file-list-catches-up-with-nip-77-too.md
 */
import type { ReconcileOutcome, SignedEvent } from '@estiva-app/protocol'
import type { EventSnapshot, SnapshotFilter } from './event-snapshot.js'

/** What a catch-up needs of the relay. Peek's `LiveRelay` and its read path provide it. */
export interface CatchUpRelay {
  /** Whether the relay speaks NIP-77: `77` in its NIP-11 `supported_nips` ({@link relaySpeaksNip77}). */
  speaksNip77(): boolean | Promise<boolean>
  reconcile(filter: SnapshotFilter, held: readonly { id: string; created_at: number }[]): Promise<ReconcileOutcome>
  /** A plain read to its end (EOSE): the fallback, and how missing ids are fetched. */
  query(filters: SnapshotFilter[]): Promise<SignedEvent[]>
}

export interface CatchUpOptions {
  /** Below this many held events a filter is asked again: one round trip beats two. */
  smallestHeld?: number
  /** Ids per `ids` filter when fetching what is missing. */
  idsPerFilter?: number
  /** Filters per fetch: the relay's NIP-11 `max_filters`. */
  filtersPerQuery?: number
  /** How many times a question the relay calls too big is split by time before it is asked again. */
  maxSplits?: number
  now?: () => number
}

export interface CatchUpResult {
  /** The answer to the filters, as the relay would have given it, newest first. */
  events: SignedEvent[]
  /** Filters caught up with NIP-77, and asked again. */
  reconciled: number
  asked: number
  /**
   * Events fetched because the copy lacked them, and held ones dropped as gone. Both
   * were applied to the copy, even for a windowed filter that was then asked again too.
   */
  fetched: number
  dropped: number
}

/**
 * A placeholder until THE-6 sets it from the speed kit's reopen leg: below about
 * 16 held events negentropy's first message is the id list itself, so a catch-up
 * saves no bytes and costs a second round trip.
 */
export const CATCH_UP_SMALLEST_HELD = 16
const IDS_PER_FILTER = 500
const FILTERS_PER_QUERY = 10
const MAX_SPLITS = 6

/** Whether a relay's NIP-11 document lists NIP-77. */
export function relaySpeaksNip77(info: unknown): boolean {
  const nips = (info as { supported_nips?: unknown } | null)?.supported_nips
  return Array.isArray(nips) && nips.some((nip) => Number(nip) === 77)
}

/** Newest first, then by id: the order a relay answers in. */
function byRelayOrder(a: SignedEvent, b: SignedEvent): number {
  return b.created_at - a.created_at || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0)
}

function withoutLimit(filter: SnapshotFilter): SnapshotFilter {
  const { limit: _limit, ...rest } = filter
  return rest
}

type Reconciled = { need: string[]; have: string[] } | null

/**
 * Reconcile `filter` against what the copy holds in it. A relay that calls it
 * too big gets it in two halves by time, each reconciled on its own.
 */
async function reconcileSplitting(
  relay: CatchUpRelay,
  filter: SnapshotFilter,
  held: SignedEvent[],
  splits: number,
  now: number,
): Promise<Reconciled> {
  const outcome = await relay.reconcile(
    filter,
    held.map((event) => ({ id: event.id, created_at: event.created_at })),
  )
  if (outcome.ok) return { need: outcome.need, have: outcome.have }
  if (outcome.reason !== 'blocked' || splits <= 0) return null
  const from = typeof filter.since === 'number' ? filter.since : 0
  // Past the newest held event too: one dated ahead of this clock must stay in the newer half's set.
  const newest = held.reduce((most, event) => Math.max(most, event.created_at), 0)
  const to = typeof filter.until === 'number' ? filter.until : Math.max(now, newest)
  if (to - from < 2) return null
  const middle = Math.floor((from + to) / 2)
  const older = { ...filter, since: from, until: middle }
  const newer = { ...filter, since: middle + 1, until: to }
  const [a, b] = await Promise.all([
    reconcileSplitting(relay, older, held.filter((e) => e.created_at <= middle), splits - 1, now),
    reconcileSplitting(relay, newer, held.filter((e) => e.created_at > middle), splits - 1, now),
  ])
  if (!a || !b) return null
  return { need: [...a.need, ...b.need], have: [...a.have, ...b.have] }
}

async function fetchByIds(relay: CatchUpRelay, ids: string[], options: Required<Pick<CatchUpOptions, 'idsPerFilter' | 'filtersPerQuery'>>) {
  const filters: SnapshotFilter[] = []
  for (let i = 0; i < ids.length; i += options.idsPerFilter) filters.push({ ids: ids.slice(i, i + options.idsPerFilter) })
  const batches: Promise<SignedEvent[]>[] = []
  for (let i = 0; i < filters.length; i += options.filtersPerQuery) {
    batches.push(relay.query(filters.slice(i, i + options.filtersPerQuery)))
  }
  const wanted = new Set(ids)
  return (await Promise.all(batches)).flat().filter((event) => wanted.has(event.id))
}

/**
 * Catch `filters` up from `snapshot`, asking `relay` only for what changed.
 * The snapshot is left holding the answer; the answer is returned as well.
 * Rejects only when the fallback read itself does.
 */
export async function catchUp(
  snapshot: EventSnapshot,
  filters: SnapshotFilter[],
  relay: CatchUpRelay,
  options: CatchUpOptions = {},
): Promise<CatchUpResult> {
  const smallestHeld = options.smallestHeld ?? CATCH_UP_SMALLEST_HELD
  const fetchOptions = {
    idsPerFilter: options.idsPerFilter ?? IDS_PER_FILTER,
    filtersPerQuery: options.filtersPerQuery ?? FILTERS_PER_QUERY,
  }
  const maxSplits = options.maxSplits ?? MAX_SPLITS
  const now = Math.floor((options.now ?? Date.now)() / 1000)

  await snapshot.ready
  // A relay whose information document cannot be read is asked plainly, as one without NIP-77.
  const speaks = filters.length > 0 && (await Promise.resolve().then(() => relay.speaksNip77()).catch(() => false))
  const result: CatchUpResult = { events: [], reconciled: 0, asked: 0, fetched: 0, dropped: 0 }
  const out = new Map<string, SignedEvent>()
  const askAgain: SnapshotFilter[] = []

  await Promise.all(
    filters.map(async (asked) => {
      // A list read (`fields`) is held as its last answer, and only when its `limit` cannot cut it; it is
      // never windowed, nor split by time, since its `since` and `until` pick first records and a change goes
      // with its file (THE-9). A relay that refuses it, or calls it too big, is asked plainly.
      const list = asked.fields !== undefined
      const heldOf = (filter: SnapshotFilter) => snapshot.held(list ? filter : withoutLimit(filter))
      const all = speaks ? heldOf(asked) : null
      if (!all || all.length < smallestHeld) {
        askAgain.push(asked)
        return
      }
      // A windowed question is reconciled from the oldest event of the window the copy holds.
      const limit = !list && typeof asked.limit === 'number' ? asked.limit : undefined
      let reconciled = withoutLimit(asked)
      let held = all
      if (limit !== undefined && all.length >= limit) {
        const floor = [...all].sort(byRelayOrder)[limit - 1].created_at
        const since = typeof asked.since === 'number' ? Math.max(asked.since, floor) : floor
        reconciled = { ...reconciled, since }
        held = all.filter((event) => event.created_at >= since)
      }

      const diff = await reconcileSplitting(relay, reconciled, held, list ? 0 : maxSplits, now)
      // The window moved past what it holds: asking again is the smaller read.
      if (!diff || (limit !== undefined && diff.need.length > limit)) {
        askAgain.push(asked)
        return
      }
      const fetched = await fetchByIds(relay, diff.need, fetchOptions)
      snapshot.caughtUp(asked, reconciled, fetched, diff.have)
      result.fetched += fetched.length
      result.dropped += diff.have.length
      // Only what the relay just compared counts: an older event the copy still holds below the window was never
      // checked, and may be deleted or out of reach now (THE-6 /land).
      const windowed = limit !== undefined && reconciled.since !== asked.since
      const since = windowed ? (reconciled.since as number) : -Infinity
      const current = (heldOf(asked) ?? [])
        .filter((event) => event.created_at >= since)
        .sort(byRelayOrder)
      // Gone events left the window short and the copy cannot say what was older: ask instead.
      if (windowed && current.length < limit) {
        askAgain.push(asked)
        return
      }
      result.reconciled += 1
      for (const event of limit !== undefined ? current.slice(0, limit) : current) out.set(event.id, event)
    }),
  )

  if (askAgain.length) {
    const answer = await relay.query(askAgain)
    snapshot.absorb(askAgain, answer)
    result.asked = askAgain.length
    for (const event of answer) out.set(event.id, event)
  }
  result.events = [...out.values()].sort(byRelayOrder)
  return result
}

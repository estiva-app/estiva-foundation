/**
 * One read a tab holds on to, and reads again when it fails (FOL-5).
 *
 * Came from Peek's `useFolders` (FOL-42), which Ship needed word for word.
 * Ship's read the Folder listing once and turned a failure into an empty list
 * for the rest of the session: on production one refused read dropped every
 * project out of its team until a reload. Peek had already paid for that
 * lesson — a refused read left a project's channel unplaced and its team's dot
 * dark — and fixed it with three rules, which are the whole of this object:
 *
 * 1. **A failure is read again**, on a backoff from `firstRetryMs` doubling to
 *    `maxRetryMs`, until one succeeds. A quota refusal waits the relay's own
 *    stated time instead ({@link retryHintMs}), never less than
 *    {@link MIN_BACKOFF_MS}. A failure the caller says will answer the same
 *    way (`retryable`) is not retried.
 * 2. **A failure never replaces a good answer.** The last value stays; the
 *    failure is reported only while there is nothing else to show.
 * 3. **Held past the component that asked.** Every page mounts its own
 *    sidebar; one of these per tab means a page change draws the answer the
 *    tab already has rather than a skeleton (Peek's SID-2).
 *
 * No React, no relay: the app hands in the read and wraps the object in its
 * own hook — `useSyncExternalStore(read.subscribe, read.snapshot)` — so the
 * package stays framework-free (ADR 0002 §10), as `createRefreshScheduler` is.
 */
import { MIN_BACKOFF_MS, isRateLimited, retryHintMs } from './refresh.js'

/** The first wait before reading a failed read again. Peek's `FOLDERS_RETRY_FIRST_MS`. */
export const RETRY_FIRST_MS = 5_000
/** The longest wait between re-reads while a read keeps failing. */
export const RETRY_MAX_MS = 60_000

/** Declared here because this package compiles with neither the DOM nor the Node lib. */
export interface RetryTimers {
  setTimeout(run: () => void, ms: number): unknown
  clearTimeout(handle: unknown): void
}

const host = globalThis as unknown as RetryTimers

export interface RetryingReadOptions {
  /**
   * Whether this failure could answer differently next time. Default: every
   * failure is. A caller that can tell a refusal (`not_a_member`, `refused`)
   * from an outage says so, and the refusal is not asked again.
   */
  retryable?: (error: unknown) => boolean
  firstRetryMs?: number
  maxRetryMs?: number
  /**
   * How long an answer is fresh enough that {@link RetryingRead.ensure} does
   * not ask again. Default: for ever — read once per tab, which is what a
   * navigation listing wants; {@link RetryingRead.reload} always asks.
   */
  freshMs?: number
  now?: () => number
  /** Looked up on every call when absent, so a test's fake timers apply. */
  timers?: RetryTimers
}

/** Replaced, never mutated: a stable snapshot for `useSyncExternalStore` between changes. */
export interface RetryingReadSnapshot<T> {
  /** The last answer, once any read has succeeded. */
  value?: T
  /** Why the last read failed — only while there is no value to keep. */
  error?: unknown
  /** A re-read is scheduled: a failure shown now is not the final word. */
  retrying: boolean
}

export interface RetryingRead<T> {
  snapshot(): RetryingReadSnapshot<T>
  subscribe(listener: () => void): () => void
  /**
   * Read, unless an answer fresher than `freshMs` is held, a read is in
   * flight, or a retry is already scheduled. What a mount calls.
   *
   * Retries run only while something is subscribed: the last unsubscribe
   * cancels a scheduled one, and the next `ensure` reads in its place.
   */
  ensure(load: () => Promise<T>): Promise<void>
  /** Read now, whatever is held; a scheduled retry is replaced by this read. */
  reload(load: () => Promise<T>): Promise<void>
  /** Cancel a scheduled retry. The held answer stays. */
  dispose(): void
  /**
   * Forget everything held — for a new viewer, or between test cases. A read
   * in flight across it neither writes its answer nor schedules a retry.
   */
  clear(): void
}

/** The wait before the next attempt, after `failures` consecutive retryable failures. */
export function retryDelayMs(failures: number, error: unknown, first = RETRY_FIRST_MS, max = RETRY_MAX_MS): number {
  const text = error instanceof Error ? error.message : String(error)
  if (isRateLimited(text)) {
    const hint = retryHintMs(text)
    if (hint !== undefined) return Math.max(MIN_BACKOFF_MS, hint)
  }
  return Math.min(first * 2 ** Math.max(0, failures - 1), max)
}

export function createRetryingRead<T>(options: RetryingReadOptions = {}): RetryingRead<T> {
  const retryable = options.retryable ?? (() => true)
  const first = options.firstRetryMs ?? RETRY_FIRST_MS
  const max = options.maxRetryMs ?? RETRY_MAX_MS
  const freshMs = options.freshMs ?? Number.POSITIVE_INFINITY
  // Taken when the object is made, as Peek's listing cache did: freshness is
  // wall-clock, and a test's fake `Date` must not make a held answer look
  // fresh (or stale) to the next test. Pass `now` to control it.
  const now = options.now ?? Date.now
  const timers = () => options.timers ?? host

  let snapshot: RetryingReadSnapshot<T> = { retrying: false }
  let answeredAt = 0
  let failures = 0
  let inflight: Promise<void> | undefined
  let timer: unknown
  const listeners = new Set<() => void>()

  const set = (next: RetryingReadSnapshot<T>) => {
    snapshot = next
    for (const listener of [...listeners]) listener()
  }
  const cancel = () => {
    if (timer === undefined) return
    timers().clearTimeout(timer)
    timer = undefined
  }

  /* Bumped by `clear`, so a read in flight across it cannot write the old
     answer back or schedule a retry for it. */
  let generation = 0

  const run = (load: () => Promise<T>): Promise<void> => {
    if (inflight) return inflight
    cancel()
    const started = generation
    inflight = (async () => {
      try {
        const value = await load()
        if (started !== generation) return
        failures = 0
        answeredAt = now()
        set({ value, retrying: false })
      } catch (error: unknown) {
        if (started !== generation) return
        const again = retryable(error)
        if (again) {
          failures += 1
          timer = timers().setTimeout(() => {
            timer = undefined
            void run(load)
          }, retryDelayMs(failures, error, first, max))
        }
        // A good answer outlives any failure after it.
        set(snapshot.value !== undefined ? { value: snapshot.value, retrying: again } : { error, retrying: again })
      } finally {
        if (started === generation) inflight = undefined
      }
    })()
    return inflight
  }

  return {
    snapshot: () => snapshot,
    subscribe(listener) {
      listeners.add(listener)
      return () => {
        listeners.delete(listener)
        // Nobody is looking: a retry would spend the relay's budget on an
        // answer no one draws. The snapshot still says a retry is due, and
        // the next `ensure` makes it.
        if (listeners.size === 0) cancel()
      }
    },
    ensure(load) {
      if (inflight) return inflight
      if (timer !== undefined) return Promise.resolve()
      if (snapshot.value !== undefined && now() - answeredAt < freshMs) return Promise.resolve()
      return run(load)
    },
    reload: run,
    dispose: cancel,
    clear() {
      generation += 1
      cancel()
      inflight = undefined
      failures = 0
      answeredAt = 0
      set({ retrying: false })
    },
  }
}

/**
 * When a tab re-reads, and when it must not (PER-13).
 *
 * Buzz meters `POST /query` at **300 a minute per pubkey** — a fixed 60-second
 * window, `human_api_calls_per_min`, applied once per HTTP call before the
 * filters are parsed (`enforce_http_admission`, `api/bridge.rs`). Not per app
 * and not per tab: two Peek tabs and a Ship tab signed in as one person share
 * one allowance, and the relay is the only participant that can see all three.
 *
 * Ship and Peek each grew half of the answer. Ship's `useRefresh` merged the two
 * events a tab switch raises and held off after a 429; Peek's
 * `useRefreshTriggers` did neither, so a tab switch fired every read twice, and
 * each refused read waited out its own hint and then retried at the same
 * instant as every other one. Measured on production on 2026-09-23: Miky's key
 * at 306 requests in one minute, single seconds of 40–58, and 33 refusals in
 * one second when a whole fan-out was sent into a pause already in force.
 *
 * ## Two objects, both handed to the app
 *
 * - {@link createRelayBudget} — how long the relay has asked this tab to wait.
 *   **The transport writes it** (it sees every 429) and everything that decides
 *   whether to read consults it. No reader has to know about quotas.
 * - {@link createRefreshScheduler} — one `visibilitychange` and one `focus`
 *   listener for the whole tab, fanning out to every subscriber, each of which
 *   still gets Ship's merge: two triggers inside `mergeMs` are one read.
 *
 * Neither is a module-level singleton (ADR 0002 §10 constraint 2): the app
 * builds one of each and keeps the binding, as it does the live-client holder.
 *
 * ## A person's own action is not paused
 *
 * Nothing here gates a read. The budget is advice the *cadence* honours —
 * scheduled refreshes skip while it is in force, and a retry waits it out — so
 * a read somebody asked for by clicking still goes out at once. Backing off a
 * poll costs freshness nobody asked for; backing off a click costs the thing
 * they just did.
 */

/**
 * The host's timers, declared here because this package compiles with neither
 * the DOM nor the Node lib. Looked up on every call, so a test's fake timers
 * apply to the defaults.
 */
const host = globalThis as unknown as {
  setTimeout(run: () => void, ms: number): unknown
  setInterval(run: () => void, ms: number): unknown
  clearInterval(handle: unknown): void
}

/** The relay's quota refusal, as opposed to any other failure. */
export function isRateLimited(text: string): boolean {
  const lower = text.toLowerCase()
  return lower.includes('rate-limited') || lower.includes('quota exceeded')
}

/**
 * The relay's own wait, in ms, or `undefined` if it did not state one.
 *
 * Buzz writes `rate-limited: quota exceeded; retry in 8s` (`api/bridge.rs`,
 * `connection.rs`). Parsed rather than assumed because the number is what is
 * left of the relay's *window*, not a fixed penalty — it shrinks as the minute
 * rolls on, so a flat wait either spends early or idles long.
 */
export function retryHintMs(reason: string): number | undefined {
  const found = /retry in (\d+)\s*s/i.exec(reason)
  if (!found) return undefined
  return Number(found[1]) * 1000
}

/** How long to wait when the relay refuses without saying for how long. */
export const DEFAULT_BACKOFF_MS = 30_000

/**
 * The floor under a stated wait. `retry in 0s` means the window has just rolled
 * over; the read that would go out now is the one that was refused, so it still
 * waits a moment rather than none.
 */
export const MIN_BACKOFF_MS = 1_000

/** What the budget needs of a `BroadcastChannel`. Declared here, see `online.ts`. */
export interface BudgetChannel {
  postMessage(message: unknown): void
  addEventListener(type: 'message', listener: (event: { data: unknown }) => void): void
  removeEventListener(type: 'message', listener: (event: { data: unknown }) => void): void
}

export interface RelayBudgetOptions {
  /** Default {@link DEFAULT_BACKOFF_MS}. */
  defaultBackoffMs?: number
  /**
   * Share pauses with the app's other tabs.
   *
   * Tabs of one origin signed in as one person spend one allowance, so a pause
   * one of them learns holds for all of them. Pass a `BroadcastChannel` — the
   * app names it — or leave it out. A tab of another app on another origin
   * cannot be reached this way and learns its own pause from its own refusal.
   */
  channel?: BudgetChannel
  now?: () => number
  sleep?: (ms: number) => Promise<void>
}

export interface RelayBudget {
  /**
   * Record a refusal from the relay's own words. Returns the pause in force
   * afterwards, in ms.
   *
   * Extends a pause but never shortens one: two reads refused in the same
   * second carry different remaining windows, and the second answer must not
   * cancel the first.
   */
  noteRateLimited(reason: string): number
  /** Milliseconds left to wait, or 0. */
  pausedForMs(): number
  /**
   * Resolves once no pause is in force — immediately if none is.
   *
   * Loops rather than sleeping once: a pause can be extended while somebody is
   * waiting on it, by this tab or another.
   */
  whenClear(): Promise<void>
  /** Test seam. Nothing in an app clears a pause early. */
  reset(): void
  /** Detach from the channel, if one was given. */
  close(): void
}

const CHANNEL_MESSAGE = 'estiva-relay-budget'

/** Whether a message on the shared channel is one of ours, and until when. */
function pausedUntilOf(data: unknown): number | undefined {
  if (typeof data !== 'object' || data === null) return undefined
  const message = data as { type?: unknown; until?: unknown }
  if (message.type !== CHANNEL_MESSAGE || typeof message.until !== 'number') return undefined
  return Number.isFinite(message.until) ? message.until : undefined
}

export function createRelayBudget(options: RelayBudgetOptions = {}): RelayBudget {
  const now = options.now ?? (() => Date.now())
  const sleep = options.sleep ?? ((ms: number) => new Promise<void>((done) => void host.setTimeout(done, ms)))
  const defaultBackoffMs = options.defaultBackoffMs ?? DEFAULT_BACKOFF_MS
  const channel = options.channel
  let pausedUntil = 0

  const extend = (until: number): boolean => {
    if (until <= pausedUntil) return false
    pausedUntil = until
    return true
  }
  const onMessage = (event: { data: unknown }) => {
    const until = pausedUntilOf(event.data)
    // Epoch ms, so another tab's clock is this tab's clock. Only extends: a
    // peer's shorter pause must not cancel a longer one learned here.
    if (until !== undefined) extend(until)
  }
  channel?.addEventListener('message', onMessage)

  const pausedForMs = () => Math.max(0, pausedUntil - now())

  return {
    noteRateLimited(reason) {
      const wait = Math.max(MIN_BACKOFF_MS, retryHintMs(reason) ?? defaultBackoffMs)
      const until = now() + wait
      if (extend(until)) {
        try {
          channel?.postMessage({ type: CHANNEL_MESSAGE, until })
        } catch {
          /* a closed channel only means the other tabs learn it themselves */
        }
      }
      return pausedForMs()
    },
    pausedForMs,
    async whenClear() {
      for (let wait = pausedForMs(); wait > 0; wait = pausedForMs()) await sleep(wait)
    },
    reset() {
      pausedUntil = 0
    },
    close() {
      channel?.removeEventListener('message', onMessage)
    },
  }
}

/** What the scheduler needs of `document`. */
export interface VisibilityTarget {
  readonly visibilityState: string
  addEventListener(type: 'visibilitychange', listener: () => void): void
  removeEventListener(type: 'visibilitychange', listener: () => void): void
}

/** What the scheduler needs of `window`. */
export interface FocusTarget {
  addEventListener(type: 'focus', listener: () => void): void
  removeEventListener(type: 'focus', listener: () => void): void
}

/** Timers, injected so a test can drive them. Handles are opaque. */
export interface SchedulerClock {
  now(): number
  setInterval(run: () => void, ms: number): unknown
  clearInterval(handle: unknown): void
}

/**
 * Two triggers inside this many ms are one read. Switching to a tab raises both
 * `visibilitychange` and `focus`, and one read is enough for it.
 */
export const DEFAULT_MERGE_MS = 1_000

export interface RefreshSchedulerOptions {
  document: VisibilityTarget
  window: FocusTarget
  /** Scheduled refreshes skip while this is paused. */
  budget?: Pick<RelayBudget, 'pausedForMs'>
  /** Default {@link DEFAULT_MERGE_MS}. */
  mergeMs?: number
  /** A subscriber's interval when it names none. Default 30 s. */
  intervalMs?: number
  clock?: SchedulerClock
}

export interface RefreshSubscription {
  /**
   * Whether the periodic refresh runs. Default `true`.
   *
   * A caller with live delivery turns it off while its socket is live and keeps
   * the focus and visibility triggers: a tab hidden for ten minutes may have had
   * its socket dropped by the browser, and a reconnect's backfill is not
   * instant, so re-reading when somebody looks is right either way.
   */
  interval?: boolean
  intervalMs?: number
}

export interface RefreshScheduler {
  /**
   * Re-run `refresh` on focus, on becoming visible, and every `intervalMs`
   * while visible. Never on subscribe — the caller owns its first read.
   * Every subscriber on one `intervalMs` shares one timer and wakes in the same
   * tick; the first scheduled refresh comes 0.5–1.5 intervals after subscribing.
   * Returns an unsubscribe; calling it twice is harmless.
   */
  subscribe(refresh: () => void | Promise<void>, options?: RefreshSubscription): () => void
}

const DEFAULT_INTERVAL_MS = 30_000

interface Subscriber {
  refresh: () => void | Promise<void>
  /** When this subscriber last ran. Merge and pause are judged per subscriber. */
  lastAt: number
  /** When it subscribed — its caller's own first read, which this never sees. */
  joinedAt: number
  /** The interval it ticks on, or `undefined` for focus and visibility only. */
  intervalMs: number | undefined
}

/** Every subscriber on one interval, and the one timer they share (PER-6). */
interface IntervalGroup {
  members: Set<Subscriber>
  timer: unknown
}

export function createRefreshScheduler(options: RefreshSchedulerOptions): RefreshScheduler {
  const { document, window, budget } = options
  const mergeMs = options.mergeMs ?? DEFAULT_MERGE_MS
  const defaultIntervalMs = options.intervalMs ?? DEFAULT_INTERVAL_MS
  const clock: SchedulerClock = options.clock ?? {
    // Read through at call time, not captured, so a test's fake timers apply.
    now: () => Date.now(),
    setInterval: (run, ms) => host.setInterval(run, ms),
    clearInterval: (handle) => host.clearInterval(handle),
  }
  const subscribers = new Set<Subscriber>()
  const groups = new Map<number, IntervalGroup>()
  let attached = false

  const visible = () => document.visibilityState === 'visible'

  const tick = (subscriber: Subscriber) => {
    const now = clock.now()
    if (now - subscriber.lastAt < mergeMs) return
    // The relay has refused on quota and said how long to wait. Skipping is the
    // whole backoff: `lastAt` is left alone, so the first trigger after the
    // pause runs at once rather than waiting out another interval — and nothing
    // is queued, so the pause does not end in a burst of everything it skipped.
    if (budget && budget.pausedForMs() > 0) return
    subscriber.lastAt = now
    try {
      // A rejected refresh is the caller's to report; it must not become an
      // unhandled rejection, and one caller throwing must not skip the rest.
      void Promise.resolve(subscriber.refresh()).catch(() => {})
    } catch {
      /* a subscriber's own problem */
    }
  }
  const fanOut = () => {
    for (const subscriber of [...subscribers]) tick(subscriber)
  }
  const onVisibility = () => {
    if (visible()) fanOut()
  }

  /*
    One timer per interval, not per subscriber (PER-6).

    0.3.0 gave each subscriber its own `setInterval`, started when it
    subscribed. Three views on one page, each on the same 10 s, therefore woke
    at three unrelated phases — a read every three seconds or so, none of them
    close enough to merge — and a page with a widget per section read "every
    couple of seconds" at an interval nobody had chosen. Sharing the timer
    puts every subscriber on an interval into the same wake-up.

    A subscriber that joined less than half an interval ago sits the tick out:
    its caller has just done its own first read, and a shared phase would
    otherwise re-read it moments later. So the first scheduled refresh comes
    between a half and one and a half intervals after subscribing, and every
    one after that on the shared beat.
  */
  const intervalTick = (group: IntervalGroup, intervalMs: number) => {
    // Checked at fire time rather than started and stopped on every
    // visibility change: a hidden tab has nothing on screen to be stale.
    if (!visible()) return
    const now = clock.now()
    for (const subscriber of [...group.members]) {
      if (now - subscriber.joinedAt < intervalMs / 2) continue
      tick(subscriber)
    }
  }
  const join = (subscriber: Subscriber, intervalMs: number) => {
    let group = groups.get(intervalMs)
    if (!group) {
      const created: IntervalGroup = { members: new Set(), timer: undefined }
      created.timer = clock.setInterval(() => intervalTick(created, intervalMs), intervalMs)
      groups.set(intervalMs, created)
      group = created
    }
    group.members.add(subscriber)
  }
  const leave = (subscriber: Subscriber) => {
    if (subscriber.intervalMs === undefined) return
    const group = groups.get(subscriber.intervalMs)
    if (!group) return
    group.members.delete(subscriber)
    if (group.members.size === 0) {
      clock.clearInterval(group.timer)
      groups.delete(subscriber.intervalMs)
    }
  }

  return {
    subscribe(refresh, { interval = true, intervalMs = defaultIntervalMs } = {}) {
      const subscriber: Subscriber = {
        refresh,
        lastAt: 0,
        joinedAt: clock.now(),
        intervalMs: interval ? intervalMs : undefined,
      }
      subscribers.add(subscriber)
      if (interval) join(subscriber, intervalMs)
      if (!attached) {
        // On first use and never at module scope, so importing registers
        // nothing — and one pair of listeners however many subscribe.
        document.addEventListener('visibilitychange', onVisibility)
        window.addEventListener('focus', fanOut)
        attached = true
      }
      return () => {
        if (!subscribers.delete(subscriber)) return
        leave(subscriber)
        if (subscribers.size === 0 && attached) {
          document.removeEventListener('visibilitychange', onVisibility)
          window.removeEventListener('focus', fanOut)
          attached = false
        }
      }
    },
  }
}

/**
 * How many reads a tab sends over its socket, and in what order (PEE-5).
 *
 * Came from Peek's `socketRead.ts` (OPT-2), where it paced every read through
 * one window: buzz meters 50 REQs per 5 s per pubkey, and a tab that sends more
 * is refused. Peek keeps 40 of them for reads and the live watches.
 *
 * Two lanes share the window:
 *
 * - **`click`** — what the person asked for. Newest asker first: the reads
 *   still waiting while someone clicks on are for what they have left, and the
 *   ones for what is on screen should not queue behind them — except that a
 *   read waiting past {@link STARVED_AFTER_MS} goes first, oldest of those
 *   first (newest-first alone starved the read that draws Peek's side tree
 *   through a whole minute of fast clicking). A click read waiting longer than
 *   its `spill.afterMs` may go over HTTP instead.
 * - **`ahead`** — what the app loads before it is asked for (Peek's loader from
 *   Desk). It takes only what a window leaves over: never while a click read is
 *   waiting, never past `perWindow - reserve`, so a click arriving finds room at
 *   once, and never over HTTP, whose meter Ship and every write share. In the
 *   order asked.
 *
 * No timers of its own and no DOM, as the rest of this package: the app hands
 * in the clock and the timers.
 */

/** Which lane a read waits in. */
export type ReadLane = 'click' | 'ahead'

/**
 * A read waiting longer than this goes ahead of newer ones. Newest-first alone
 * starved the read that draws Peek's side tree through a whole `--hammer`
 * minute: its topic links never came back.
 */
export const STARVED_AFTER_MS = 3_000

/** Declared here because this package compiles with neither the DOM nor the Node lib. */
export interface PacerTimers {
  setTimeout(run: () => void, ms: number): unknown
  clearTimeout(handle: unknown): void
}

export interface PacerOptions {
  /** Slots per window, the reads' and `others`' together. */
  perWindow: number
  windowMs: number
  /** Slots of each window the `ahead` lane leaves for clicks. Default a quarter of `perWindow`. */
  reserve?: number
  now?: () => number
  timers?: PacerTimers
  /** Metered frames sent outside the pacer since `floor`, oldest first (Peek's live watches). */
  others?: (floor: number) => number[]
}

export interface TakeOptions {
  lane?: ReadLane
  /**
   * For a `click` read: asked every `afterMs` while it waits whether HTTP may
   * take it instead. Ignored for `ahead`, which only ever waits.
   */
  spill?: { afterMs: number; allowed(): boolean }
}

export interface Pacer {
  /**
   * `n` slots at once (one read's REQs), or `'http'` when a click read waited
   * `spill.afterMs` and `spill.allowed()` said HTTP may take it. `n` must not
   * exceed the window — for `ahead`, the window less the reserve.
   */
  take(n: number, options?: TakeOptions): Promise<'socket' | 'http'>
  /** Reads waiting now, per lane. */
  waiting(): { click: number; ahead: number }
  /**
   * Move every `ahead` read still waiting into the `click` lane, as the oldest
   * there. For the moment the person acts: the app's caches hand a click the
   * read already in flight for the same thing, so a click on what the loader
   * had asked for would otherwise wait behind its own `ahead` read. They never
   * spill to HTTP; reads asked after this wait in their own lane as before.
   */
  promote(): void
}

const host = globalThis as unknown as PacerTimers

interface Waiter {
  n: number
  at: number
  resolve: (via: 'socket' | 'http') => void
  spillTimer: unknown
}

export function createPacer(options: PacerOptions): Pacer {
  const { perWindow, windowMs } = options
  const reserve = options.reserve ?? Math.floor(perWindow / 4)
  const now = options.now ?? (() => Date.now())
  const timers = options.timers ?? { setTimeout: (run, ms) => host.setTimeout(run, ms), clearTimeout: (h) => host.clearTimeout(h) }
  const others = options.others ?? (() => [])
  const sent: number[] = []
  const clicks: Waiter[] = []
  const ahead: Waiter[] = []
  let pumpTimer: unknown = null

  function grant(waiter: Waiter) {
    if (waiter.spillTimer !== null) timers.clearTimeout(waiter.spillTimer)
    const at = now()
    for (let i = 0; i < waiter.n; i++) sent.push(at)
    waiter.resolve('socket')
  }

  function pump() {
    if (pumpTimer !== null) timers.clearTimeout(pumpTimer)
    pumpTimer = null
    const floor = now() - windowMs
    while (sent.length > 0 && sent[0] <= floor) sent.shift()
    const outside = others(floor)
    const used = () => sent.length + outside.length
    while (clicks.length > 0) {
      const starved = clicks.findIndex((w) => now() - w.at >= STARVED_AFTER_MS)
      const index = starved === -1 ? clicks.length - 1 : starved
      if (used() + clicks[index].n > perWindow) break
      grant(clicks.splice(index, 1)[0])
    }
    while (clicks.length === 0 && ahead.length > 0 && used() + ahead[0].n <= perWindow - reserve) {
      grant(ahead.shift()!)
    }
    // Wake when the oldest counted frame leaves the window.
    const oldest = Math.min(sent[0] ?? Infinity, outside[0] ?? Infinity)
    if (clicks.length + ahead.length > 0 && oldest !== Infinity) {
      pumpTimer = timers.setTimeout(pump, Math.max(0, oldest + windowMs - now()))
    }
  }

  return {
    take(n, { lane = 'click', spill } = {}) {
      return new Promise((resolve) => {
        const waiter: Waiter = { n, at: now(), resolve, spillTimer: null }
        if (lane === 'ahead') {
          ahead.push(waiter)
          pump()
          return
        }
        // Asked again every `afterMs` while it waits: HTTP may have room later.
        const trySpill = () => {
          const i = clicks.indexOf(waiter)
          if (i === -1 || !spill) return
          if (!spill.allowed()) {
            waiter.spillTimer = timers.setTimeout(trySpill, spill.afterMs)
            return
          }
          clicks.splice(i, 1)
          resolve('http')
          // The window may now have room for an ahead read this one held back.
          pump()
        }
        if (spill) waiter.spillTimer = timers.setTimeout(trySpill, spill.afterMs)
        clicks.push(waiter)
        pump()
      })
    },
    waiting: () => ({ click: clicks.length, ahead: ahead.length }),
    promote() {
      if (ahead.length === 0) return
      // Oldest first in `clicks`: newest-first serves the click's own reads before these.
      clicks.unshift(...ahead.splice(0))
      pump()
    },
  }
}

export interface InFlight {
  /** Wait for a slot; call what it resolves to when the REQ has its answer. */
  acquire(lane?: ReadLane): Promise<() => void>
  /** REQs on the wire and waiting for a slot, per lane — for an app's diagnostics. */
  state(): { inFlight: { click: number; ahead: number }; waiting: { click: number; ahead: number } }
}

/**
 * At most `max` REQs answering at once, of which at most `aheadMax` are the
 * `ahead` lane's, so a click always has room on the wire too. A freed slot
 * goes to a waiting click first. Peek's limit is 4: buzz queues at most 1,000
 * frames to a connection and drops it after 15 sends in a row find the queue
 * full, which a busy tab and a few wide reads arriving together reached.
 */
export function createInFlight(max: number, aheadMax = Math.max(1, Math.floor(max / 2))): InFlight {
  let total = 0
  let aheadNow = 0
  const clicks: (() => void)[] = []
  const ahead: (() => void)[] = []

  function next() {
    if (total >= max) return
    const click = clicks.shift()
    if (click) return click()
    if (aheadNow < aheadMax) ahead.shift()?.()
  }

  return {
    acquire(lane = 'click') {
      return new Promise((resolve) => {
        const start = () => {
          total += 1
          if (lane === 'ahead') aheadNow += 1
          let released = false
          resolve(() => {
            if (released) return
            released = true
            total -= 1
            if (lane === 'ahead') aheadNow -= 1
            next()
          })
        }
        const free = total < max && (lane === 'click' ? clicks.length === 0 : aheadNow < aheadMax && clicks.length === 0 && ahead.length === 0)
        if (free) start()
        else (lane === 'ahead' ? ahead : clicks).push(start)
      })
    },
    state: () => ({
      inFlight: { click: total - aheadNow, ahead: aheadNow },
      waiting: { click: clicks.length, ahead: ahead.length },
    }),
  }
}

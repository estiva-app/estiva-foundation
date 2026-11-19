/**
 * Page-open timings: how long a person waited for a page to open, sent to
 * Estiva ID beside the error reports and on to Sentry.
 * why: https://github.com/estiva-app/estiva-docs/blob/main/decisions/page-open-timings-go-to-sentry-named-by-the-person-built-from-an-allowed-list.md
 *
 * A timing is built from a fixed list and nothing else: the app's version, the
 * kind of screen (the same route names error reports use), how the page was
 * opened, how long it took and how its end was found. Never an address, a
 * title, which file was opened, or any text. Estiva ID adds who sent it and
 * their browser, and rebuilds it from its own list.
 *
 * - **Start:** the page's own start for a new tab or a reload; the moment the
 *   app navigates for an open inside it (a click, back or forward).
 * - **Ready:** the moment the last loading placeholder outside the sidebar went
 *   (the speed kit's recorder reads the same selector), once none has come back
 *   for a short quiet spell.
 * - **No placeholder ever drawn:** sent marked `no-placeholder`, never as an
 *   instant open; it is counted apart.
 * - **Thrown away:** an open in a hidden tab or one hidden before it was ready,
 *   an open left for another before it was ready, a timing while signed out,
 *   and one that fails to send.
 *
 * Timings have their own per-tab allowance, apart from the error reporter's,
 * so a tab opening pages all day never crowds out a crash report.
 */
import type { FetchLike } from './error-reports.js'

/** How a page was opened: a page load that was not a reload, a reload, or a navigation inside the app. */
export type OpenHow = 'new-tab' | 'reload' | 'in-app'

/**
 * How the end of the wait was found: the last placeholder went; no placeholder
 * was ever drawn (the wait is when the page last changed); or one was still
 * there when the timer gave up (the wait is the ceiling).
 */
export type OpenReady = 'placeholder-gone' | 'no-placeholder' | 'gave-up'

/** The whole body sent to Estiva ID's `/timing`. */
export interface PageTimingBody {
  release: string
  screen: string
  how: OpenHow
  waitMs: number
  ready: OpenReady
}

/** A loading placeholder, as the speed kit's recorder finds one (peek-app `scripts/app-speed-recorder.js`). */
export const PLACEHOLDER_SELECTOR = '[class*=animate-pulse], [aria-busy=true], [class*=skeleton], [data-skeleton]'

/** The page, as far as timing an open goes. {@link browserPage} builds one from a window. */
export interface TimedPage {
  /** Milliseconds since the page's own start (`performance.now()`). */
  now(): number
  /** Whether nobody can see the tab. */
  hidden(): boolean
  /** Loading placeholders on the page, not counting the sidebar's. */
  placeholders(): number
  /** Calls back on every change to the page or to whether it is seen; returns the way to stop. */
  watch(onChange: () => void): () => void
  /** How this page load started. */
  loadHow(): 'new-tab' | 'reload'
}

export interface PageTimerTimers {
  set(run: () => void, ms: number): unknown
  clear(handle: unknown): void
}

export interface PageTimerOptions {
  /** Estiva ID's timing address, e.g. `https://id.estiva.app/timing`. */
  endpoint: string
  /** The app's version: the commit it was built from. */
  release: string
  /** The current access token, or nothing when signed out (then nothing is sent). */
  token: () => string | undefined | Promise<string | undefined>
  /** The current screen, as the error reporter names it. */
  screen: () => string
  /** Every screen the app names; anything else is sent as `<unknown>`. */
  screens: readonly string[]
  page: TimedPage
  /** At most this many timings per tab in an hour. Default 120. */
  maxPerHour?: number
  /** How long no placeholder may be back before the page counts as ready. Default 1000 ms. */
  quietMs?: number
  /** With no placeholder drawn by this long after the start, the open is sent as `no-placeholder`. Default 5000 ms. */
  noPlaceholderAfterMs?: number
  /** A placeholder still there this long after the start: sent as `gave-up`. Default 60000 ms. */
  giveUpAfterMs?: number
  /** Defaults to the global `fetch`. */
  fetch?: FetchLike
  /** Defaults to the global `setTimeout` and `clearTimeout`. */
  timers?: PageTimerTimers
}

export interface PageTimer {
  /** Time this page load (a new tab or a reload), from the page's own start. Call once, at boot. */
  loaded(): void
  /** Time an open inside the app, from now: call it as the app navigates. */
  opened(): void
  /** Stop watching; an open still running is thrown away. */
  stop(): void
  /** The bodies sent so far, newest last (for a probe). */
  readonly sent: readonly PageTimingBody[]
}

const HOUR_MS = 60 * 60_000

interface Open {
  how: OpenHow
  start: number
  sawPlaceholder: boolean
  /** When the placeholders last went, while none has come back. */
  goneAt: number | undefined
  /** When the page last changed. */
  changedAt: number
  timers: unknown[]
  quiet: unknown
}

export function createPageTimer(options: PageTimerOptions): PageTimer {
  const page = options.page
  const quietMs = options.quietMs ?? 1000
  const noPlaceholderAfterMs = options.noPlaceholderAfterMs ?? 5000
  const giveUpAfterMs = options.giveUpAfterMs ?? 60_000
  const maxPerHour = options.maxPerHour ?? 120
  const host = globalThis as unknown as {
    setTimeout(run: () => void, ms: number): unknown
    clearTimeout(handle: unknown): void
  }
  const timers: PageTimerTimers = options.timers ?? {
    set: (run, ms) => host.setTimeout(run, ms),
    clear: (handle) => host.clearTimeout(handle),
  }
  const send: FetchLike =
    options.fetch ?? ((url, init) => (globalThis as unknown as { fetch: FetchLike }).fetch(url, init))
  const sent: PageTimingBody[] = []
  const sentAt: number[] = []

  let open: Open | undefined
  let unwatch: (() => void) | undefined

  function end(): void {
    if (!open) return
    for (const handle of open.timers) timers.clear(handle)
    if (open.quiet !== undefined) timers.clear(open.quiet)
    open = undefined
    // Watched only while an open runs: a ready page's live updates cost nothing.
    unwatch?.()
    unwatch = undefined
  }

  function finish(ready: OpenReady, at: number): void {
    const done = open
    if (!done) return
    end()
    try {
      const now = page.now()
      while (sentAt.length && now - (sentAt[0] as number) > HOUR_MS) sentAt.shift()
      if (sentAt.length >= maxPerHour) return
      const screen = options.screen()
      const body: PageTimingBody = {
        release: options.release,
        screen: typeof screen === 'string' && options.screens.includes(screen) ? screen : '<unknown>',
        how: done.how,
        waitMs: Math.max(0, Math.round(at - done.start)),
        ready,
      }
      sentAt.push(now)
      deliver(body).catch(() => {
        // A timing that cannot be sent is dropped.
      })
    } catch {
      // Never break the page while timing it.
    }
  }

  async function deliver(body: PageTimingBody): Promise<void> {
    const token = await options.token()
    if (!token) return
    sent.push(body)
    await send(options.endpoint, {
      method: 'POST',
      keepalive: true,
      headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
      body: JSON.stringify(body),
    })
  }

  function check(): void {
    const current = open
    if (!current) return
    try {
      if (page.hidden()) return end()
      const now = page.now()
      current.changedAt = now
      if (page.placeholders() > 0) {
        current.sawPlaceholder = true
        current.goneAt = undefined
        if (current.quiet !== undefined) timers.clear(current.quiet)
        current.quiet = undefined
        return
      }
      if (!current.sawPlaceholder || current.goneAt !== undefined) return
      current.goneAt = now
      current.quiet = timers.set(() => {
        if (open === current && current.goneAt !== undefined) finish('placeholder-gone', current.goneAt)
      }, quietMs)
    } catch {
      end()
    }
  }

  function begin(how: OpenHow, start: number): void {
    try {
      const previous = open
      // An open left before any placeholder showed was a page drawn at once: sent as that.
      if (previous && !previous.sawPlaceholder) finish('no-placeholder', previous.changedAt)
      // One left while it was still loading has no end to report.
      else end()
      if (page.hidden()) return
      const now = page.now()
      const current: Open = {
        how,
        start,
        sawPlaceholder: false,
        goneAt: undefined,
        changedAt: now,
        timers: [],
        quiet: undefined,
      }
      open = current
      unwatch = page.watch(check)
      current.timers.push(
        timers.set(
          () => {
            if (open === current && !current.sawPlaceholder) finish('no-placeholder', current.changedAt)
          },
          Math.max(0, start + noPlaceholderAfterMs - now),
        ),
        timers.set(
          () => {
            if (open === current) finish('gave-up', start + giveUpAfterMs)
          },
          Math.max(0, start + giveUpAfterMs - now),
        ),
      )
      // An open inside the app is read from the page's first change on: the
      // page on screen at the navigation is still the one being left.
      if (how !== 'in-app') check()
    } catch {
      end()
    }
  }

  return {
    loaded() {
      try {
        begin(page.loadHow(), 0)
      } catch {
        // Never break the page while timing it.
      }
    },
    opened() {
      try {
        begin('in-app', page.now())
      } catch {
        // Never break the page while timing it.
      }
    },
    stop() {
      end()
    },
    sent,
  }
}

/** The parts of a browser window {@link browserPage} reads. */
export interface TimedWindow {
  document: {
    hidden: boolean
    body: { querySelectorAll(selector: string): ArrayLike<{ closest(selector: string): unknown }> } | null
    addEventListener(type: 'visibilitychange', listener: () => void): void
    removeEventListener(type: 'visibilitychange', listener: () => void): void
  }
  performance: { now(): number; getEntriesByType(type: 'navigation'): ArrayLike<object> }
  MutationObserver: new (callback: () => void) => {
    observe(target: unknown, options: { childList: boolean; subtree: boolean; attributes: boolean }): void
    disconnect(): void
  }
}

/** A real tab: placeholders outside `aside` and `nav`, every change to the document, and whether it is seen. */
export function browserPage(win: TimedWindow): TimedPage {
  return {
    now: () => win.performance.now(),
    hidden: () => win.document.hidden,
    placeholders() {
      const found = win.document.body?.querySelectorAll(PLACEHOLDER_SELECTOR)
      let count = 0
      for (let i = 0; i < (found?.length ?? 0); i++) if (!found?.[i]?.closest('aside, nav')) count++
      return count
    },
    watch(onChange) {
      const observer = new win.MutationObserver(onChange)
      observer.observe(win.document, { childList: true, subtree: true, attributes: true })
      win.document.addEventListener('visibilitychange', onChange)
      return () => {
        observer.disconnect()
        win.document.removeEventListener('visibilitychange', onChange)
      }
    },
    loadHow() {
      const entry = win.performance.getEntriesByType('navigation')[0] as { type?: unknown } | undefined
      return entry?.type === 'reload' ? 'reload' : 'new-tab'
    },
  }
}

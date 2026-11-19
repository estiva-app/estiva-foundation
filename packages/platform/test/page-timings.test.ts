/**
 * The page-open timer, read at the wire: every assertion is on the request
 * that would leave the browser (or on there being none), driven by a fake page
 * whose placeholders and clock the test moves by hand.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createPageTimer, type PageTimerOptions } from '../dist/index.js'

/** One turn of the event loop: the timer reads the token before it sends. */
const flush = () => new Promise<void>((resolve) => setImmediate(resolve))

function harness(overrides: Partial<PageTimerOptions> = {}, start: { how?: 'new-tab' | 'reload'; now?: number } = {}) {
  let now = start.now ?? 0
  let placeholders = 0
  let hidden = false
  let onChange: (() => void) | undefined
  let address = '/issues/plantedaddress-5a1c9e'
  const pending = new Map<number, { at: number; run: () => void }>()
  let nextHandle = 1
  const requests: Array<{ url: string; headers: Record<string, string>; body: string }> = []

  const timer = createPageTimer({
    endpoint: 'https://id.estiva.app/timing',
    release: 'ded93b9c',
    token: () => 'qa-1-token',
    screen: () => (address.startsWith('/issues/') ? 'issue' : address === '/issues' ? 'issues' : address),
    screens: ['issue', 'issues', 'project'],
    page: {
      now: () => now,
      hidden: () => hidden,
      placeholders: () => placeholders,
      watch(callback) {
        onChange = callback
        return () => {
          if (onChange === callback) onChange = undefined
        }
      },
      loadHow: () => start.how ?? 'new-tab',
    },
    timers: {
      set(run, ms) {
        const handle = nextHandle++
        pending.set(handle, { at: now + ms, run })
        return handle
      },
      clear(handle) {
        pending.delete(handle as number)
      },
    },
    fetch: async (url, init) => {
      requests.push({ url, headers: init.headers, body: init.body })
      return {}
    },
    ...overrides,
  })

  /** Move the clock, running each timer that falls due on the way. */
  function advance(ms: number) {
    const until = now + ms
    for (;;) {
      const due = [...pending.entries()].filter(([, t]) => t.at <= until).sort((a, b) => a[1].at - b[1].at)[0]
      if (!due) break
      pending.delete(due[0])
      now = Math.max(now, due[1].at)
      due[1].run()
    }
    now = until
  }

  return {
    timer,
    requests,
    bodies: () => requests.map((r) => JSON.parse(r.body)),
    advance,
    /** The page draws or clears placeholders now, as a DOM change. */
    placeholders(n: number) {
      placeholders = n
      onChange?.()
    },
    hide() {
      hidden = true
      onChange?.()
    },
    show() {
      hidden = false
    },
    go(to: string) {
      address = to
    },
    isWatching: () => onChange !== undefined,
  }
}

test('a new tab is timed from the page start to the moment the last placeholder went', async () => {
  const h = harness({}, { now: 300 })
  h.timer.loaded()
  h.advance(100)
  h.placeholders(3)
  h.advance(2000)
  h.placeholders(0) // at 2400
  h.advance(1000)
  await flush()
  assert.deepEqual(h.bodies(), [{ release: 'ded93b9c', screen: 'issue', how: 'new-tab', waitMs: 2400, ready: 'placeholder-gone' }])
  assert.equal(h.requests[0]?.url, 'https://id.estiva.app/timing')
  assert.equal(h.requests[0]?.headers.authorization, 'Bearer qa-1-token')
})

test('a reload says it was a reload', async () => {
  const h = harness({}, { how: 'reload' })
  h.timer.loaded()
  h.placeholders(1)
  h.advance(500)
  h.placeholders(0)
  h.advance(1000)
  await flush()
  assert.equal(h.bodies()[0]?.how, 'reload')
})

test('placeholders that come back inside the quiet spell are the same wait, ending when the last went', async () => {
  const h = harness()
  h.timer.opened()
  h.placeholders(2)
  h.advance(400)
  h.placeholders(0) // the header has drawn…
  h.advance(300)
  h.placeholders(5) // …and the list starts loading
  h.advance(900)
  h.placeholders(0) // at 1600
  h.advance(999)
  await flush()
  assert.equal(h.requests.length, 0, 'nothing sent before the quiet spell is over')
  h.advance(1)
  await flush()
  assert.deepEqual(h.bodies().map((b) => [b.how, b.waitMs, b.ready]), [['in-app', 1600, 'placeholder-gone']])
})

test('an open inside the app is timed from the navigation, not from the page start', async () => {
  const h = harness({}, { now: 50_000 })
  h.go('/issues')
  h.timer.opened()
  h.placeholders(1)
  h.advance(700)
  h.placeholders(0)
  h.advance(1000)
  await flush()
  assert.deepEqual(h.bodies(), [{ release: 'ded93b9c', screen: 'issues', how: 'in-app', waitMs: 700, ready: 'placeholder-gone' }])
})

test('an open where no placeholder was ever drawn is marked as such, not sent as instant', async () => {
  const h = harness()
  h.timer.opened()
  h.advance(5000)
  await flush()
  const [body] = h.bodies()
  assert.equal(body?.ready, 'no-placeholder')
})

test('leaving an open before any placeholder showed sends it as no-placeholder; leaving one still loading sends it as left, with the wait until then', async () => {
  const h = harness()
  h.timer.opened()
  h.advance(200)
  h.timer.opened() // left the first before any placeholder
  h.placeholders(2)
  h.advance(800)
  h.timer.opened() // left the second while it was loading
  h.placeholders(0)
  h.advance(5000)
  await flush()
  assert.deepEqual(h.bodies().map((b) => [b.ready, b.waitMs]), [
    ['no-placeholder', 0],
    ['left', 800],
    ['no-placeholder', 0],
  ])
})

test('an open left before any placeholder showed keeps its own screen, not the next page’s', async () => {
  const h = harness()
  h.go('/issues/plantedaddress-5a1c9e')
  h.timer.opened()
  h.placeholders(0) // the issue draws at once
  h.advance(200)
  h.go('/issues') // the app pushes the next address, then says so
  h.timer.opened()
  await flush()
  assert.deepEqual(h.bodies().map((b) => [b.screen, b.ready]), [['issue', 'no-placeholder']])
})

test('a page drawn at once keeps the moment it drew, whatever live updates follow', async () => {
  const h = harness()
  h.timer.opened()
  h.advance(50)
  h.placeholders(0) // drawn at 50
  h.advance(3000)
  h.placeholders(0) // a live comment arrives at 3,050
  h.advance(2000)
  await flush()
  assert.deepEqual(h.bodies().map((b) => [b.waitMs, b.ready]), [[50, 'no-placeholder']])
})

test('opens while signed out do not use up the hour’s allowance', async () => {
  let signedIn = false
  const h = harness({ maxPerHour: 2, token: () => (signedIn ? 'qa-1-token' : undefined) })
  const openOnce = () => {
    h.timer.opened()
    h.placeholders(1)
    h.advance(100)
    h.placeholders(0)
    h.advance(1000)
  }
  for (let i = 0; i < 3; i++) openOnce()
  await flush()
  signedIn = true
  openOnce()
  openOnce()
  await flush()
  assert.equal(h.requests.length, 2)
})

test('a page opened in a hidden tab sends no timing', async () => {
  const h = harness()
  h.hide()
  h.timer.loaded()
  h.show()
  h.placeholders(1)
  h.advance(400)
  h.placeholders(0)
  h.advance(60_000)
  await flush()
  assert.equal(h.requests.length, 0)
})

test('switching away from a tab still loading sends the open as left, with the wait until then', async () => {
  const h = harness()
  h.timer.loaded()
  h.placeholders(1)
  h.advance(400)
  h.hide()
  h.show()
  h.placeholders(0)
  h.advance(60_000)
  await flush()
  assert.deepEqual(h.bodies().map((b) => [b.ready, b.waitMs]), [['left', 400]])
})

test('leaving inside the quiet spell sends the open as ready when its placeholders went', async () => {
  const h = harness()
  h.timer.opened()
  h.placeholders(1)
  h.advance(300)
  h.placeholders(0) // ready at 300
  h.advance(500)
  h.timer.opened() // left before the quiet spell was over
  await flush()
  assert.deepEqual(h.bodies().map((b) => [b.ready, b.waitMs]), [['placeholder-gone', 300]])
})

test('a placeholder still there after a minute is sent as gave-up at the ceiling', async () => {
  const h = harness()
  h.timer.opened()
  h.placeholders(1)
  h.advance(60_000)
  await flush()
  assert.deepEqual(h.bodies().map((b) => [b.waitMs, b.ready]), [[60_000, 'gave-up']])
})

test('signed out, nothing is sent', async () => {
  const h = harness({ token: () => undefined })
  h.timer.opened()
  h.placeholders(1)
  h.advance(300)
  h.placeholders(0)
  h.advance(1000)
  await flush()
  assert.equal(h.requests.length, 0)
})

test('the body holds the listed fields only: no address, no title, a screen off the list is <unknown>', async () => {
  const h = harness()
  h.go('/projects/plantedtitle-board-offsite')
  h.timer.opened()
  h.placeholders(1)
  h.advance(300)
  h.placeholders(0)
  h.advance(1000)
  await flush()
  const raw = h.requests[0]?.body ?? ''
  assert.deepEqual(Object.keys(JSON.parse(raw)).sort(), ['how', 'ready', 'release', 'screen', 'waitMs'])
  assert.equal(JSON.parse(raw).screen, '<unknown>')
  assert.ok(!raw.includes('planted'), raw)
})

test('a tab sends at most its hourly allowance of timings, and more once the hour has passed', async () => {
  const h = harness({ maxPerHour: 3 })
  const openOnce = () => {
    h.timer.opened()
    h.placeholders(1)
    h.advance(100)
    h.placeholders(0)
    h.advance(1000)
  }
  for (let i = 0; i < 5; i++) openOnce()
  await flush()
  assert.equal(h.requests.length, 3)
  h.advance(60 * 60_000)
  openOnce()
  await flush()
  assert.equal(h.requests.length, 4)
})

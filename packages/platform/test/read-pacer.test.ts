/**
 * `createPacer`, `createInFlight` — Peek's socket pacing (OPT-2), with the
 * `ahead` lane its Desk loader reads on (PEE-5).
 *
 * A hand-held clock: `advance` runs every timer due in order, settling the
 * promises each one resolves before the next.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createInFlight, createPacer, type PacerTimers } from '../dist/index.js'

const PER_WINDOW = 40
const WINDOW_MS = 5_000

function fakeClock() {
  let at = 0
  let next = 0
  const pending = new Map<number, { run: () => void; due: number }>()
  const timers: PacerTimers = {
    setTimeout(run, ms) {
      pending.set(++next, { run, due: at + ms })
      return next
    },
    clearTimeout(handle) {
      pending.delete(handle as number)
    },
  }
  const settle = () => new Promise((resolve) => setImmediate(resolve))
  async function advance(ms: number) {
    const until = at + ms
    for (;;) {
      const due = [...pending].filter(([, t]) => t.due <= until).sort((a, b) => a[1].due - b[1].due)[0]
      if (!due) break
      pending.delete(due[0])
      at = due[1].due
      due[1].run()
      await settle()
    }
    at = until
    await settle()
  }
  return { now: () => at, timers, advance, settle }
}

function pacerOn(clock: ReturnType<typeof fakeClock>, extra: { reserve?: number; others?: (floor: number) => number[] } = {}) {
  return createPacer({ perWindow: PER_WINDOW, windowMs: WINDOW_MS, now: clock.now, timers: clock.timers, ...extra })
}

test(`hands out ${PER_WINDOW} slots per window and makes the next read wait for the oldest to age out`, async () => {
  const clock = fakeClock()
  const pacer = pacerOn(clock)
  assert.equal(await pacer.take(PER_WINDOW), 'socket')
  let granted = false
  void pacer.take(1).then(() => (granted = true))
  await clock.advance(WINDOW_MS - 1)
  assert.equal(granted, false)
  await clock.advance(1)
  assert.equal(granted, true)
})

test('serves the newest click first, so what is on screen does not queue behind what was left', async () => {
  const clock = fakeClock()
  const pacer = pacerOn(clock)
  await pacer.take(PER_WINDOW)
  await clock.advance(WINDOW_MS - 1_000)
  const order: string[] = []
  void pacer.take(PER_WINDOW).then(() => order.push('left'))
  void pacer.take(PER_WINDOW).then(() => order.push('on screen'))
  await clock.advance(1_000)
  assert.deepEqual(order, ['on screen'])
  await clock.advance(WINDOW_MS)
  assert.deepEqual(order, ['on screen', 'left'])
})

test('serves a click that has waited too long before newer ones, so none waits for ever', async () => {
  const clock = fakeClock()
  const pacer = pacerOn(clock)
  await pacer.take(PER_WINDOW)
  const order: string[] = []
  void pacer.take(PER_WINDOW).then(() => order.push('side tree'))
  // Someone keeps clicking: a newer full-window read arrives every window.
  for (let i = 0; i < 3; i++) {
    void pacer.take(PER_WINDOW).then(() => order.push(`click ${i}`))
    await clock.advance(WINDOW_MS)
  }
  assert.equal(order[0], 'side tree')
})

test('sends a click that waited past the spill time over HTTP when HTTP may take it, and keeps one waiting when not', async () => {
  const clock = fakeClock()
  const pacer = pacerOn(clock)
  await pacer.take(PER_WINDOW)
  const spilled = pacer.take(1, { spill: { afterMs: 1_000, allowed: () => true } })
  let room = false
  const later = pacer.take(1, { spill: { afterMs: 1_000, allowed: () => room } })
  await clock.advance(1_000)
  assert.equal(await spilled, 'http')
  room = true
  await clock.advance(1_000)
  assert.equal(await later, 'http')
})

test('counts the frames the live watches sent against the same window', async () => {
  const clock = fakeClock()
  const watches: number[] = []
  const pacer = pacerOn(clock, { others: (floor) => watches.filter((at) => at > floor) })
  for (let i = 0; i < 5; i++) watches.push(clock.now())
  let granted = false
  void pacer.take(PER_WINDOW - 4).then(() => (granted = true))
  await clock.advance(WINDOW_MS - 1)
  assert.equal(granted, false)
  await clock.advance(1)
  assert.equal(granted, true)
})

test('an ahead read takes only what the window leaves over, short of the reserve', async () => {
  const clock = fakeClock()
  const pacer = pacerOn(clock, { reserve: 10 })
  await pacer.take(25)
  let first = false
  let second = false
  void pacer.take(5, { lane: 'ahead' }).then(() => (first = true))
  void pacer.take(1, { lane: 'ahead' }).then(() => (second = true))
  await clock.settle()
  assert.equal(first, true, '25 + 5 is within 40 − 10')
  assert.equal(second, false, 'one more would reach into the reserve')
  // A click still has the reserve at once.
  assert.equal(await pacer.take(10), 'socket')
  await clock.advance(WINDOW_MS)
  assert.equal(second, true)
})

test('a click overtakes every ahead read waiting, and an ahead read goes over HTTP only when its spill allows', async () => {
  const clock = fakeClock()
  const pacer = pacerOn(clock, { reserve: 10 })
  await pacer.take(PER_WINDOW)
  const order: string[] = []
  const spill = { afterMs: 1_000, allowed: () => false }
  void pacer.take(20, { lane: 'ahead', spill }).then((via) => order.push(`ahead ${via}`))
  await clock.advance(2_000)
  void pacer.take(20, { spill }).then((via) => order.push(`click ${via}`))
  assert.deepEqual(pacer.waiting(), { click: 1, ahead: 1 })
  await clock.advance(WINDOW_MS - 2_000)
  assert.deepEqual(order, ['click socket'], 'the click went first, though the ahead read waited longer')
  await clock.advance(WINDOW_MS)
  assert.deepEqual(order, ['click socket', 'ahead socket'])
})

test('ahead reads are served in the order they were asked', async () => {
  const clock = fakeClock()
  const pacer = pacerOn(clock, { reserve: 10 })
  await pacer.take(PER_WINDOW)
  const order: string[] = []
  for (const label of ['Topics', 'Open work', 'Starred']) void pacer.take(10, { lane: 'ahead' }).then(() => order.push(label))
  await clock.advance(WINDOW_MS)
  assert.deepEqual(order, ['Topics', 'Open work', 'Starred'])
})

test('promote moves the waiting ahead reads into the click lane, behind the newest click', async () => {
  const clock = fakeClock()
  const pacer = pacerOn(clock, { reserve: 10 })
  await pacer.take(PER_WINDOW - 5)
  const order: string[] = []
  void pacer.take(5, { lane: 'ahead' }).then(() => order.push('Open work, loaded ahead'))
  await clock.settle()
  assert.equal(order.length, 0, 'the reserve holds it back')
  // The person clicks that topic: its cache hands the click the ahead read.
  pacer.promote()
  await clock.settle()
  assert.deepEqual(order, ['Open work, loaded ahead'], 'now a click read, it takes the reserve')
  assert.deepEqual(pacer.waiting(), { click: 0, ahead: 0 })
  // Asked after the promote, an ahead read waits in its own lane again.
  void pacer.take(1, { lane: 'ahead' }).then(() => order.push('later'))
  await clock.settle()
  assert.equal(order.length, 1)
})

test('a promoted read that waited long is not starved ahead of the click that promoted it', async () => {
  const clock = fakeClock()
  const pacer = pacerOn(clock, { reserve: 10 })
  await pacer.take(PER_WINDOW)
  const order: string[] = []
  void pacer.take(20, { lane: 'ahead' }).then(() => order.push('loaded ahead'))
  await clock.advance(4_000)
  pacer.promote()
  void pacer.take(20).then(() => order.push('the click'))
  await clock.advance(WINDOW_MS)
  assert.deepEqual(order, ['the click', 'loaded ahead'])
})

test('an ahead read spills to HTTP when its spill allows, in either lane', async () => {
  const clock = fakeClock()
  const pacer = pacerOn(clock, { reserve: 10 })
  await pacer.take(PER_WINDOW)
  const spill = { afterMs: 1_000, allowed: () => true }
  const waiting = pacer.take(1, { lane: 'ahead', spill })
  const promoted = pacer.take(1, { lane: 'ahead', spill: { afterMs: 1_500, allowed: () => true } })
  await clock.advance(1_000)
  assert.equal(await waiting, 'http')
  pacer.promote()
  await clock.advance(500)
  assert.equal(await promoted, 'http', 'moved into the click lane, it keeps its spill')
  assert.deepEqual(pacer.waiting(), { click: 0, ahead: 0 })
})

test('in flight: ahead holds at most its share, and a freed slot goes to a waiting click first', async () => {
  const clock = fakeClock()
  const slots = createInFlight(4, 2)
  const releases: (() => void)[] = []
  for (let i = 0; i < 3; i++) void slots.acquire('ahead').then((r) => releases.push(r))
  await clock.settle()
  assert.equal(releases.length, 2, 'the third ahead REQ waits: two is its share')
  const clickReleases: (() => void)[] = []
  for (let i = 0; i < 3; i++) void slots.acquire().then((r) => clickReleases.push(r))
  await clock.settle()
  assert.equal(clickReleases.length, 2, 'clicks fill the other two')
  releases[0]()
  await clock.settle()
  assert.equal(clickReleases.length, 3, 'the freed slot went to the waiting click')
  assert.equal(releases.length, 2)
  clickReleases[0]()
  await clock.settle()
  assert.equal(releases.length, 3, 'with no click waiting, the ahead REQ takes it')
})

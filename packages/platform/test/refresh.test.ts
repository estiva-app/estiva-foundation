/**
 * `createRefreshScheduler` and `createRelayBudget` (PER-13) — what a tab switch
 * costs, and what a 429 stops.
 *
 * Run against fakes for `document`, `window`, the clock and the channel, with no
 * DOM, for the same reason as `online.test.ts`: the environment is a parameter.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  DEFAULT_BACKOFF_MS,
  MIN_BACKOFF_MS,
  createRefreshScheduler,
  createRelayBudget,
  isRateLimited,
  retryHintMs,
  type BudgetChannel,
  type SchedulerClock,
} from '../dist/index.js'

const REFUSAL = 'rate-limited: quota exceeded; retry in 10s'

function fakeTab(startsVisible = true) {
  const handlers = new Map<string, Set<() => void>>()
  const add = (type: string, listener: () => void) => {
    const set = handlers.get(type) ?? new Set()
    set.add(listener)
    handlers.set(type, set)
  }
  const remove = (type: string, listener: () => void) => handlers.get(type)?.delete(listener)
  const document = {
    visibilityState: startsVisible ? 'visible' : 'hidden',
    addEventListener: add,
    removeEventListener: remove,
  }
  const window = { addEventListener: add, removeEventListener: remove }

  let now = 1_000_000
  let nextId = 1
  const timers = new Map<number, { run: () => void; ms: number; due: number }>()
  const clock: SchedulerClock = {
    now: () => now,
    setInterval(run, ms) {
      const id = nextId++
      timers.set(id, { run, ms, due: now + ms })
      return id
    },
    clearInterval(handle) {
      timers.delete(handle as number)
    },
  }
  const fire = (type: string) => {
    for (const listener of [...(handlers.get(type) ?? [])]) listener()
  }
  return {
    document,
    window,
    clock,
    /** Move time on, running every interval that falls due on the way. */
    advance(ms: number) {
      const end = now + ms
      for (;;) {
        const due = [...timers.values()].filter((t) => t.due <= end).sort((a, b) => a.due - b.due)[0]
        if (!due) break
        now = due.due
        due.due += due.ms
        due.run()
      }
      now = end
    },
    /** What switching to this tab raises: both events, back to back. */
    switchTo() {
      document.visibilityState = 'visible'
      fire('visibilitychange')
      fire('focus')
    },
    hide() {
      document.visibilityState = 'hidden'
      fire('visibilitychange')
    },
    focus: () => fire('focus'),
    listeners: (type: string) => handlers.get(type)?.size ?? 0,
    timers: () => timers.size,
  }
}

function counter() {
  let calls = 0
  return { refresh: () => void (calls += 1), calls: () => calls }
}

test('a tab switch is one read per subscriber, not two', () => {
  // Peek fired on both `visibilitychange` and `focus`, so every tab switch sent
  // every read twice — the doubled seconds in buzz's log.
  const tab = fakeTab(false)
  const scheduler = createRefreshScheduler({ document: tab.document, window: tab.window, clock: tab.clock })
  const a = counter()
  const b = counter()
  scheduler.subscribe(a.refresh)
  scheduler.subscribe(b.refresh)
  tab.switchTo()
  assert.equal(a.calls(), 1)
  assert.equal(b.calls(), 1)
})

test('two triggers further apart than the merge are two reads', () => {
  const tab = fakeTab()
  const scheduler = createRefreshScheduler({ document: tab.document, window: tab.window, clock: tab.clock })
  const a = counter()
  scheduler.subscribe(a.refresh, { interval: false })
  tab.focus()
  tab.advance(999)
  tab.focus()
  assert.equal(a.calls(), 1, 'inside the merge')
  tab.advance(1)
  tab.focus()
  assert.equal(a.calls(), 2)
})

test('the merge is per subscriber, so one mounted a moment ago still reads', () => {
  const tab = fakeTab()
  const scheduler = createRefreshScheduler({ document: tab.document, window: tab.window, clock: tab.clock })
  const early = counter()
  scheduler.subscribe(early.refresh, { interval: false })
  tab.focus()
  const late = counter()
  scheduler.subscribe(late.refresh, { interval: false })
  tab.focus()
  assert.equal(early.calls(), 1)
  assert.equal(late.calls(), 1)
})

test('never runs on subscribe — the caller owns its first read', () => {
  const tab = fakeTab()
  const scheduler = createRefreshScheduler({ document: tab.document, window: tab.window, clock: tab.clock })
  const a = counter()
  scheduler.subscribe(a.refresh)
  assert.equal(a.calls(), 0)
})

test('the interval runs while visible and never while hidden', () => {
  const tab = fakeTab()
  const scheduler = createRefreshScheduler({ document: tab.document, window: tab.window, clock: tab.clock })
  const a = counter()
  scheduler.subscribe(a.refresh, { intervalMs: 5_000 })
  tab.advance(15_000)
  assert.equal(a.calls(), 3)
  tab.hide()
  tab.advance(60_000)
  assert.equal(a.calls(), 3)
})

test('interval: false keeps focus and visibility, drops the timer', () => {
  const tab = fakeTab()
  const scheduler = createRefreshScheduler({ document: tab.document, window: tab.window, clock: tab.clock })
  const a = counter()
  scheduler.subscribe(a.refresh, { interval: false, intervalMs: 5_000 })
  assert.equal(tab.timers(), 0)
  tab.advance(60_000)
  assert.equal(a.calls(), 0)
  tab.focus()
  assert.equal(a.calls(), 1)
})

test('one pair of listeners however many subscribe, gone with the last', () => {
  const tab = fakeTab()
  const scheduler = createRefreshScheduler({ document: tab.document, window: tab.window, clock: tab.clock })
  assert.equal(tab.listeners('focus'), 0, 'nothing registered before anybody subscribes')
  const first = scheduler.subscribe(() => {})
  const second = scheduler.subscribe(() => {})
  assert.equal(tab.listeners('focus'), 1)
  assert.equal(tab.listeners('visibilitychange'), 1)
  first()
  first()
  assert.equal(tab.listeners('focus'), 1, 'one left, and unsubscribing twice is harmless')
  second()
  assert.equal(tab.listeners('focus'), 0)
  assert.equal(tab.listeners('visibilitychange'), 0)
  assert.equal(tab.timers(), 0)
})

test('a subscriber that throws or rejects does not stop the others', async () => {
  const tab = fakeTab()
  const scheduler = createRefreshScheduler({ document: tab.document, window: tab.window, clock: tab.clock })
  const a = counter()
  scheduler.subscribe(() => {
    throw new Error('mine')
  })
  scheduler.subscribe(() => Promise.reject(new Error('mine too')))
  scheduler.subscribe(a.refresh)
  tab.focus()
  await Promise.resolve()
  assert.equal(a.calls(), 1)
})

test('a pause skips every scheduled refresh, then the first trigger after it runs', () => {
  const tab = fakeTab()
  const budget = createRelayBudget({ now: tab.clock.now })
  const scheduler = createRefreshScheduler({ document: tab.document, window: tab.window, clock: tab.clock, budget })
  const a = counter()
  const b = counter()
  scheduler.subscribe(a.refresh, { intervalMs: 3_000 })
  scheduler.subscribe(b.refresh, { interval: false })
  budget.noteRateLimited(REFUSAL)
  tab.advance(9_000)
  tab.focus()
  assert.equal(a.calls(), 0, 'no interval tick inside the pause')
  assert.equal(b.calls(), 0, 'no focus read inside the pause')
  tab.advance(1_000)
  tab.focus()
  assert.equal(a.calls(), 1)
  assert.equal(b.calls(), 1)
})

test('the budget reads the relay\'s wait and falls back when there is none', () => {
  let now = 0
  const budget = createRelayBudget({ now: () => now })
  assert.equal(budget.noteRateLimited(REFUSAL), 10_000)
  now = 6_000
  assert.equal(budget.pausedForMs(), 4_000)
  now = 20_000
  assert.equal(budget.pausedForMs(), 0)
  assert.equal(budget.noteRateLimited('rate-limited: shared admission unavailable'), DEFAULT_BACKOFF_MS)
  budget.reset()
  assert.equal(budget.noteRateLimited('rate-limited: quota exceeded; retry in 0s'), MIN_BACKOFF_MS)
  const custom = createRelayBudget({ now: () => 0, defaultBackoffMs: 10_000 })
  assert.equal(custom.noteRateLimited('rate-limited'), 10_000)
})

test('a shorter refusal never shortens a pause', () => {
  const budget = createRelayBudget({ now: () => 0 })
  budget.noteRateLimited('rate-limited: quota exceeded; retry in 30s')
  assert.equal(budget.noteRateLimited('rate-limited: quota exceeded; retry in 2s'), 30_000)
})

test('whenClear waits out a pause, including one extended while waiting', async () => {
  let now = 0
  const slept: number[] = []
  const budget = createRelayBudget({
    now: () => now,
    sleep: async (ms) => {
      slept.push(ms)
      now += ms
      // Another read is refused while this one waits.
      if (slept.length === 1) budget.noteRateLimited('rate-limited: quota exceeded; retry in 5s')
    },
  })
  await budget.whenClear()
  assert.deepEqual(slept, [], 'no pause, no wait')
  budget.noteRateLimited(REFUSAL)
  await budget.whenClear()
  assert.deepEqual(slept, [10_000, 5_000])
  assert.equal(budget.pausedForMs(), 0)
})

function fakeChannelPair(): [BudgetChannel, BudgetChannel] {
  const listeners = [new Set<(event: { data: unknown }) => void>(), new Set<(event: { data: unknown }) => void>()]
  const end = (mine: number): BudgetChannel => ({
    // Like BroadcastChannel: every other end hears it, never the sender.
    postMessage: (data) => listeners[1 - mine].forEach((listener) => listener({ data })),
    addEventListener: (_type, listener) => void listeners[mine].add(listener),
    removeEventListener: (_type, listener) => void listeners[mine].delete(listener),
  })
  return [end(0), end(1)]
}

test('a pause one tab learns holds in the app\'s other tabs', () => {
  const [left, right] = fakeChannelPair()
  const first = createRelayBudget({ now: () => 0, channel: left })
  const second = createRelayBudget({ now: () => 0, channel: right })
  first.noteRateLimited(REFUSAL)
  assert.equal(second.pausedForMs(), 10_000)
  second.noteRateLimited('rate-limited: quota exceeded; retry in 3s')
  assert.equal(first.pausedForMs(), 10_000, 'a peer\'s shorter pause does not cancel a longer one')
  second.close()
  first.noteRateLimited('rate-limited: quota exceeded; retry in 40s')
  assert.equal(second.pausedForMs(), 10_000, 'a closed budget hears nothing more')
})

test('ignores anything else on the channel', () => {
  const [left, right] = fakeChannelPair()
  const budget = createRelayBudget({ now: () => 0, channel: right })
  left.postMessage('hello')
  left.postMessage({ type: 'estiva-relay-budget', until: 'soon' })
  left.postMessage({ type: 'something-else', until: 99_999 })
  assert.equal(budget.pausedForMs(), 0)
})

test('recognises the relay\'s refusal and its hint', () => {
  assert.equal(isRateLimited(REFUSAL), true)
  assert.equal(isRateLimited('Rate-Limited: Quota Exceeded'), true)
  assert.equal(isRateLimited('relay_membership_required'), false)
  assert.equal(retryHintMs(REFUSAL), 10_000)
  assert.equal(retryHintMs('rate-limited: shared admission unavailable'), undefined)
})

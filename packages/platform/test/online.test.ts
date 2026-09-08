/**
 * `browserOnlineSource` — the constraint-2 fix, and the reason it is testable.
 *
 * Peek reached for `window` inside the module that owned its relay, so this
 * behaviour could not run without a browser. Here the window is an argument,
 * and this file is the proof: it exercises the real implementation with no DOM
 * and no jsdom, which is ADR 0002 §10 constraint 3.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { assumeOnline, browserOnlineSource, type OnlineTarget } from '../dist/index.js'

function fakeWindow(startsOnline = true) {
  const handlers = new Map<string, Set<() => void>>()
  const target: OnlineTarget = {
    navigator: { onLine: startsOnline },
    addEventListener(type, listener) {
      const set = handlers.get(type) ?? new Set()
      set.add(listener)
      handlers.set(type, set)
    },
    removeEventListener(type, listener) {
      handlers.get(type)?.delete(listener)
    },
  }
  return {
    target,
    fire(type: 'online' | 'offline') {
      target.navigator.onLine = type === 'online'
      for (const listener of handlers.get(type) ?? []) listener()
    },
    count: (type: string) => handlers.get(type)?.size ?? 0,
  }
}

test('reports what the target currently believes', () => {
  const win = fakeWindow(false)
  assert.equal(browserOnlineSource(win.target).online(), false)
  win.target.navigator.onLine = true
  assert.equal(browserOnlineSource(win.target).online(), true)
})

test('registers nothing until somebody subscribes', () => {
  const win = fakeWindow()
  // Importing this package, or building a source, must not attach a listener —
  // that is the module-scope side effect the constraint forbids.
  browserOnlineSource(win.target)
  assert.equal(win.count('online'), 0)
  assert.equal(win.count('offline'), 0)
})

test('announces both directions', () => {
  const win = fakeWindow()
  const seen: boolean[] = []
  browserOnlineSource(win.target).subscribe((online) => seen.push(online))
  win.fire('offline')
  win.fire('online')
  assert.deepEqual(seen, [false, true])
})

test('detaches from the target once the last listener leaves', () => {
  const win = fakeWindow()
  const source = browserOnlineSource(win.target)
  const first = source.subscribe(() => {})
  const second = source.subscribe(() => {})
  assert.equal(win.count('offline'), 1)
  first()
  assert.equal(win.count('offline'), 1, 'one listener left, so stay attached')
  second()
  assert.equal(win.count('offline'), 0)
})

test('unsubscribing twice is harmless', () => {
  const win = fakeWindow()
  const release = browserOnlineSource(win.target).subscribe(() => {})
  release()
  release()
  assert.equal(win.count('online'), 0)
})

test('a listener that throws does not stop the others', () => {
  const win = fakeWindow()
  const source = browserOnlineSource(win.target)
  const seen: boolean[] = []
  source.subscribe(() => {
    throw new Error('mine')
  })
  source.subscribe((online) => seen.push(online))
  win.fire('offline')
  // The subscriber that matters here is the one reconnecting the socket. If a
  // throw upstream of it could skip it, a dead socket would keep reporting
  // `live` — which is the failure this whole source exists to prevent.
  assert.deepEqual(seen, [false])
})

test('assumeOnline is a real answer for an environment with no window', () => {
  const source = assumeOnline()
  assert.equal(source.online(), true)
  assert.equal(typeof source.subscribe(() => {}), 'function')
})

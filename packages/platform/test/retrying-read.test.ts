/**
 * `createRetryingRead` — Peek's FOL-42 rules, now the package's (FOL-5).
 *
 * Driven by hand-held timers rather than `mock.timers`: the object schedules
 * from inside a promise's settlement, and stepping it by hand says exactly
 * which wait was asked for.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createRetryingRead, retryDelayMs, type RetryTimers } from '../dist/index.js'

function fakeTimers() {
  const pending = new Map<number, { run: () => void; ms: number }>()
  let next = 0
  const timers: RetryTimers = {
    setTimeout(run, ms) {
      pending.set(++next, { run, ms })
      return next
    },
    clearTimeout(handle) {
      pending.delete(handle as number)
    },
  }
  /** Fire the one scheduled wait and say how long it was. */
  const fire = () => {
    const [[id, entry]] = [...pending]
    pending.delete(id)
    entry.run()
    return entry.ms
  }
  return { timers, pending, fire }
}

const settle = () => new Promise((resolve) => setImmediate(resolve))

test('a failed first read is read again, and the success lands without a reload', async () => {
  const { timers, pending, fire } = fakeTimers()
  const read = createRetryingRead<string[]>({ timers })
  let calls = 0
  const load = async () => {
    calls += 1
    if (calls === 1) throw new Error('fetch failed')
    return ['team']
  }
  await read.ensure(load)
  assert.equal(read.snapshot().value, undefined)
  assert.equal(read.snapshot().retrying, true)
  assert.equal(pending.size, 1)
  assert.equal(fire(), 5_000)
  await settle()
  assert.deepEqual(read.snapshot(), { value: ['team'], retrying: false })
  assert.equal(pending.size, 0, 'a success ends the retries')
})

test('the wait doubles to the ceiling while it keeps failing', async () => {
  const { timers, fire } = fakeTimers()
  const read = createRetryingRead<number>({ timers })
  await read.ensure(async () => {
    throw new Error('fetch failed')
  })
  const waits = []
  for (let i = 0; i < 6; i++) {
    waits.push(fire())
    await settle()
  }
  assert.deepEqual(waits, [5_000, 10_000, 20_000, 40_000, 60_000, 60_000])
})

test('a quota refusal waits the relay’s stated time', () => {
  assert.equal(retryDelayMs(1, new Error('rate-limited: quota exceeded; retry in 8s')), 8_000)
  assert.equal(retryDelayMs(1, new Error('rate-limited: quota exceeded; retry in 0s')), 1_000)
  assert.equal(retryDelayMs(3, new Error('rate-limited: quota exceeded')), 20_000)
})

test('a failure after a good answer keeps the answer', async () => {
  const { timers } = fakeTimers()
  const read = createRetryingRead<string>({ timers })
  await read.ensure(async () => 'first')
  await read.reload(async () => {
    throw new Error('fetch failed')
  })
  assert.deepEqual(read.snapshot(), { value: 'first', retrying: true })
})

test('a failure the caller says will not change is not asked again', async () => {
  const { timers, pending } = fakeTimers()
  const read = createRetryingRead<string>({ timers, retryable: (e) => !String(e).includes('not_a_member') })
  const refused = new Error('restricted: not_a_member')
  await read.ensure(async () => {
    throw refused
  })
  assert.equal(pending.size, 0)
  assert.deepEqual(read.snapshot(), { error: refused, retrying: false })
})

test('ensure reads once per tab; reload always asks; one read at a time', async () => {
  const { timers } = fakeTimers()
  const read = createRetryingRead<number>({ timers })
  let calls = 0
  const load = async () => ++calls
  await Promise.all([read.ensure(load), read.ensure(load)])
  assert.equal(calls, 1, 'two mounts in one render share a read')
  await read.ensure(load)
  assert.equal(calls, 1, 'a held answer is not asked again')
  await read.reload(load)
  assert.equal(calls, 2)
})

test('an answer older than freshMs is asked again on ensure', async () => {
  let clock = 0
  const read = createRetryingRead<number>({ timers: fakeTimers().timers, freshMs: 1_000, now: () => clock })
  let calls = 0
  const load = async () => ++calls
  await read.ensure(load)
  clock = 999
  await read.ensure(load)
  clock = 1_000
  await read.ensure(load)
  assert.equal(calls, 2)
})

test('a reload replaces a scheduled retry rather than adding a second read', async () => {
  const { timers, pending } = fakeTimers()
  const read = createRetryingRead<string>({ timers })
  await read.ensure(async () => {
    throw new Error('fetch failed')
  })
  assert.equal(pending.size, 1)
  await read.reload(async () => 'ok')
  assert.equal(pending.size, 0)
  assert.equal(read.snapshot().value, 'ok')
})

test('subscribers hear every change; the snapshot is stable between them', async () => {
  const read = createRetryingRead<string>({ timers: fakeTimers().timers })
  let heard = 0
  const off = read.subscribe(() => heard++)
  const before = read.snapshot()
  assert.equal(read.snapshot(), before)
  await read.ensure(async () => 'x')
  assert.equal(heard, 1)
  off()
  await read.reload(async () => 'y')
  assert.equal(heard, 1)
})

/** `loadAhead` — the order, the once, and the first failure stopping it (PEE-5). */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { loadAhead } from '../dist/index.js'

function gate() {
  let open: () => void = () => {}
  let fail: (error: unknown) => void = () => {}
  const promise = new Promise<void>((resolve, reject) => {
    open = resolve
    fail = reject
  })
  return { promise, open, fail }
}

const settle = () => new Promise((resolve) => setImmediate(resolve))

test('starts the steps in order, at most two at once, and settles once all have loaded', async () => {
  const gates = ['Topics', 'Open work 1', 'Open work 2', 'Starred 1'].map((label) => ({ label, ...gate() }))
  const started: string[] = []
  const loader = loadAhead(gates.map((g) => ({ label: g.label, run: () => (started.push(g.label), g.promise) })))
  await settle()
  assert.deepEqual(started, ['Topics', 'Open work 1'])
  gates[1].open()
  await settle()
  assert.deepEqual(started, ['Topics', 'Open work 1', 'Open work 2'])
  gates[0].open()
  gates[2].open()
  await settle()
  gates[3].open()
  const outcome = await loader.done
  assert.deepEqual(outcome.loaded, ['Open work 1', 'Topics', 'Open work 2', 'Starred 1'])
  assert.equal(outcome.stoppedBy, undefined)
})

test('the first failure starts nothing more, and says which step it was', async () => {
  const gates = ['Topics', 'Open work 1', 'Open work 2'].map((label) => ({ label, ...gate() }))
  const started: string[] = []
  const loader = loadAhead(gates.map((g) => ({ label: g.label, run: () => (started.push(g.label), g.promise) })))
  await settle()
  const refused = new Error('rate-limited: slow down')
  gates[0].fail(refused)
  await settle()
  gates[1].open()
  const outcome = await loader.done
  assert.deepEqual(started, ['Topics', 'Open work 1'])
  assert.deepEqual(outcome.loaded, ['Open work 1'])
  assert.deepEqual(outcome.stoppedBy, { label: 'Topics', error: refused })
})

test('stop starts nothing more and settles when the running steps have', async () => {
  const gates = ['Topics', 'Open work 1', 'Open work 2'].map((label) => ({ label, ...gate() }))
  const started: string[] = []
  const loader = loadAhead(
    gates.map((g) => ({ label: g.label, run: () => (started.push(g.label), g.promise) })),
    { concurrency: 1 },
  )
  await settle()
  loader.stop()
  let settled = false
  void loader.done.then(() => (settled = true))
  await settle()
  assert.equal(settled, false, 'Topics is still running')
  gates[0].open()
  const outcome = await loader.done
  assert.deepEqual(started, ['Topics'])
  assert.equal(outcome.stoppedBy, 'stopped')
})

test('an empty list settles at once', async () => {
  assert.deepEqual(await loadAhead([]).done, { loaded: [] })
})

test('a step that throws before returning its promise stops the loader like one that rejects', async () => {
  const outcome = await loadAhead([
    { label: 'sync', run: () => { throw new Error('boom') } },
    { label: 'never', run: async () => {} },
  ], { concurrency: 1 }).done
  assert.deepEqual(outcome.loaded, [])
  assert.equal((outcome.stoppedBy as { label: string }).label, 'sync')
})

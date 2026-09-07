/**
 * PER-1 — every filter's first page in one request.
 *
 * Ship's workspace read was 39 HTTP requests and 1015 ms warm, measured against
 * production 2026-09-07, and every one of those requests was a first page:
 * nothing was paging at all. The relay meters `POST /query` per call, at 300 a
 * minute shared across every app one person has open, so the request count was
 * the whole cost.
 *
 * Three measured facts make batching a transport change rather than a semantic
 * one, and the tests below are written against them:
 *
 *   - `limit` clamps **per filter** — 10 filters at `limit: 5` returned 48.
 *   - responses **concatenate**, they do not dedupe — the same filter twice in
 *     one POST returned 236 events, not 118.
 *   - runs come back **grouped, in filter order** — three Folder filters
 *     batched were element-for-element identical to the same three read singly.
 *
 * The load-bearing test is the last one: whatever the shape, the answer must
 * equal what `{ batch: false }` produces. Everything else is about *when* the
 * saving is allowed to apply, and the interesting cases are the ones where it
 * must not.
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { Relay, MAX_FILTERS_PER_QUERY, secretKeySigner } from '../dist/index.js'

const SECRET = '0000000000000000000000000000000000000000000000000000000000000001'
const hex = (n) => String(n).padStart(64, '0')

const event = (id, createdAt, kind, folder) => ({
  id: hex(id),
  pubkey: hex(1),
  kind,
  created_at: createdAt,
  tags: folder === undefined ? [] : [['h', folder]],
  content: `e${id}`,
  sig: hex(2),
})

/**
 * A relay modelled on the measured one: serves every filter in the body,
 * concatenates the runs in filter order, and clamps each run independently.
 *
 * `match` decides what a filter selects, so one double serves both the `#h`
 * shape and the `kinds` shape.
 */
function fakeRelay(events, serverCeiling = 1000, { maxFilters = MAX_FILTERS_PER_QUERY } = {}) {
  const calls = []
  const fetch = async (_url, init) => {
    const filters = JSON.parse(init.body)
    calls.push(filters)
    if (filters.length > maxFilters) {
      return { status: 400, text: async () => JSON.stringify({ error: 'too many explicit channels' }) }
    }
    const out = []
    for (const filter of filters) {
      const eligible = events
        .filter((e) => (filter.kinds ? filter.kinds.includes(e.kind) : true))
        .filter((e) => (filter['#h'] ? filter['#h'].includes(e.tags.find((t) => t[0] === 'h')?.[1]) : true))
        .filter((e) => (filter.until === undefined ? true : e.created_at <= filter.until))
        .sort((a, b) => b.created_at - a.created_at)
      out.push(...eligible.slice(0, Math.min(filter.limit ?? serverCeiling, serverCeiling)))
    }
    return { status: 200, text: async () => JSON.stringify(out) }
  }
  return { calls, relay: new Relay('https://r', secretKeySigner(SECRET), { fetch }) }
}

/** `count` events in `folder`, all of `kind`, newest first. */
const inFolder = (folder, kind, count, base) =>
  Array.from({ length: count }, (_, i) => event(base + i, 1_000_000 - i, kind, folder))

test('a workspace read collapses to one call plus the widest filter confirming', async () => {
  const folders = Array.from({ length: 36 }, (_, i) => `f${i}`)
  const events = folders.flatMap((f, i) => inFolder(f, 9, i === 0 ? 143 : 3 + i, i * 10_000))
  const { relay, calls } = fakeRelay(events)

  const got = await relay.queryAll(folders.map((f) => ({ kinds: [9], '#h': [f] })))

  assert.equal(got.length, events.length, 'every event, from every Folder')
  assert.equal(calls.length, 2, 'one batch, then the widest Folder pages itself')
})

test('the answer is identical to reading one filter at a time', async () => {
  const folders = ['a', 'b', 'c', 'd']
  const events = folders.flatMap((f, i) => inFolder(f, 9, 4 + i, i * 10_000))
  const { relay } = fakeRelay(events)
  const filters = folders.map((f) => ({ kinds: [9], '#h': [f] }))

  const batched = await relay.queryAll(filters)
  const serial = await fakeRelay(events).relay.queryAll(filters, { batch: false })

  assert.deepEqual(
    batched.map((e) => e.id),
    serial.map((e) => e.id),
    'element for element, not merely the same set',
  )
})

test('disjoint kinds attribute too — the discovery pair is one call', async () => {
  /*
    Ship's `loadAll` opens with `{kinds:[30850]}` and `{kinds:[30851]}`, which
    carry no `#h` at all. They are still attributable, because no kind appears
    in both — and that is the whole discovery half of the read.

    A wider filter is read first so the ceiling is strictly above both runs.
    Without that the larger of the two ties its own bound and pages itself,
    which is correct and is covered by the workspace test above; here the point
    is the case where nothing needs paging at all.
  */
  const events = [
    ...inFolder('a', 30850, 19, 0),
    ...inFolder('a', 30851, 243, 1000),
    ...inFolder('a', 9, 300, 500_000),
  ]
  const { relay, calls } = fakeRelay(events)

  await relay.queryAll([{ kinds: [9] }], { batch: false })
  calls.length = 0

  const got = await relay.queryAll([{ kinds: [30850] }, { kinds: [30851] }])

  assert.equal(got.length, 262)
  assert.equal(calls.length, 1, 'both kinds settled by a single batched call')
})

test('a run clamped by the relay is still paged to exhaustion', async () => {
  /*
    SHA-8 through the batched path. The relay hands back 40 per filter however
    much is asked for, so Folder `a`'s run is truncated inside the batch. Being
    part of a batch must not make that look complete.
  */
  const events = [...inFolder('a', 9, 200, 0), ...inFolder('b', 9, 3, 900_000)]
  const { relay } = fakeRelay(events, 40)

  const got = await relay.queryAll(
    [
      { kinds: [9], '#h': ['a'] },
      { kinds: [9], '#h': ['b'] },
    ],
    { pageSize: 500 },
  )

  assert.equal(got.length, 203, 'all of Folder a, despite every page being short')
})

test('two filters on one Folder cannot be attributed, and the answer is still right', async () => {
  // Both filters select the same events, so a run cannot be split by `h`. The
  // kinds overlap too, so neither discriminator applies: it must fall back.
  const events = inFolder('a', 9, 6, 0)
  const { relay } = fakeRelay(events)

  const got = await relay.queryAll([
    { kinds: [9], '#h': ['a'] },
    { kinds: [9], '#h': ['a'] },
  ])

  assert.equal(got.length, 6, 'deduped across the two identical filters, exactly as before')
})

test('an unattributable batch is not even attempted on a cold relay', async () => {
  // No `#h`, overlapping kinds: nothing could be concluded from the answer, so
  // the request is not worth making. Spending it would be a straight regression.
  const events = [...inFolder('a', 9, 3, 0), ...inFolder('b', 8, 3, 100)]
  const { relay, calls } = fakeRelay(events)

  await relay.queryAll([{ kinds: [8, 9] }, { kinds: [9] }])

  assert.ok(
    calls.every((filters) => filters.length === 1),
    'every call carried a single filter — no batch was speculatively spent',
  )
})

test('more filters than one request will take are chunked', async () => {
  const folders = Array.from({ length: MAX_FILTERS_PER_QUERY + 20 }, (_, i) => `f${i}`)
  const events = folders.flatMap((f, i) => inFolder(f, 9, 2, i * 100))
  const { relay, calls } = fakeRelay(events)

  const got = await relay.queryAll(folders.map((f) => ({ kinds: [9], '#h': [f] })))

  assert.equal(got.length, events.length, 'nothing lost across the chunk boundary')
  assert.ok(
    calls.every((filters) => filters.length <= MAX_FILTERS_PER_QUERY),
    `a call carried more than ${MAX_FILTERS_PER_QUERY} filters`,
  )
})

test('a refused batch fails the read instead of becoming N requests', async () => {
  const folders = Array.from({ length: 10 }, (_, i) => `f${i}`)
  const events = folders.flatMap((f, i) => inFolder(f, 9, 2, i * 100))
  // A relay that refuses anything carrying more than one filter.
  const { relay, calls } = fakeRelay(events, 1000, { maxFilters: 1 })

  await assert.rejects(() => relay.queryAll(folders.map((f) => ({ kinds: [9], '#h': [f] }))))

  assert.equal(calls.length, 1, 'the refusal cost one request, not eleven')
})

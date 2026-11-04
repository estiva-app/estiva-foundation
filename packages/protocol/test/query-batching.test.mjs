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
function fakeRelay(events, serverCeiling = 1000, { maxFilters = MAX_FILTERS_PER_QUERY, also = () => false } = {}) {
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
        .filter((e) => (filter['#a'] ? e.tags.some((t) => t[0] === 'a' && filter['#a'].includes(t[1])) || also(e, filter) : true))
        .filter((e) => (filter['#A'] ? e.tags.some((t) => t[0] === 'A' && filter['#A'].includes(t[1])) : true))
        .filter((e) => (filter['#p'] ? e.tags.some((t) => t[0] === 'p' && filter['#p'].includes(t[1])) : true))
        .filter((e) => (filter.authors ? filter.authors.includes(e.pubkey) : true))
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

/** `count` changes to each address, kind 1851, one `a` tag each — or every one of `targets` on one change. */
const changesTo = (targets, count, base) =>
  targets.flatMap((target, t) =>
    Array.from({ length: count }, (_, i) => ({ ...event(base + t * 1000 + i, 2_000_000 - t * 1000 - i, 1851), tags: [['a', target]] })),
  )

test('changes read in groups of addresses keep their page: a short group is settled, a long one pages on from it (APP-6)', async () => {
  /*
    The listing's read: a Folder's files' changes in groups of ten addresses,
    one kind, no Folder named. On production, 27 Oct, the answer to 21 such
    groups was 23.8 MB, and because no run could be told apart it was thrown
    away and every group asked again. Each change names one file, and the
    groups name disjoint files, so each event says which run it is in.
  */
  const groups = [['f0', 'f1'], ['f2', 'f3'], ['f4', 'f5']]
  const events = [...changesTo(['f0', 'f1'], 75, 0), ...changesTo(['f2'], 3, 10_000), ...changesTo(['f5'], 4, 20_000)]
  const { relay, calls } = fakeRelay(events, 100)
  await relay.queryAll([{ kinds: [9] }, { kinds: [1851], '#a': ['f0'] }], { batch: false }) // a warm relay: it has seen a full page
  calls.length = 0

  const filters = groups.map((group) => ({ kinds: [1851], '#a': group }))
  const got = await relay.queryAll(filters)

  assert.equal(got.length, events.length)
  assert.deepEqual(
    calls.slice(1).map((call) => call.map((f) => f['#a'])),
    [[['f0', 'f1']]],
    'after the one batched call, only the long group asks again — from where its page ended',
  )
  assert.ok(calls.slice(1).every(([f]) => f.until !== undefined), 'its first page is not asked a second time')
  const serial = await fakeRelay(events, 100).relay.queryAll(filters, { batch: false })
  assert.deepEqual(got.map((e) => e.id).sort(), serial.map((e) => e.id).sort())
})

test('a change naming files in two groups cannot be attributed, and the answer is still right', async () => {
  // The shared change is what fills the first group's page: credited to the
  // second group, the first would look short and its older changes be lost.
  const both = { ...event(99_999, 3_000_000, 1851), tags: [['a', 'f0'], ['a', 'f2']] }
  const events = [both, ...changesTo(['f0'], 120, 0), ...changesTo(['f2'], 3, 10_000)]
  const { relay } = fakeRelay(events, 100)
  await relay.queryAll([{ kinds: [9] }, { kinds: [1851] }], { batch: false })
  const filters = [{ kinds: [1851], '#a': ['f0', 'f1'] }, { kinds: [1851], '#a': ['f2', 'f3'] }]

  const got = await relay.queryAll(filters)

  const serial = await fakeRelay(events, 100).relay.queryAll(filters, { batch: false })
  assert.deepEqual(got.map((e) => e.id).sort(), serial.map((e) => e.id).sort(), 'every change once, the shared one and the first group’s oldest included')
})

/*
  A person's part in some topics (interop's `personInFilesFilters`): the
  changes naming them, the comments they wrote, the comments naming them —
  five filters, no Folder, and a comment on a topic carries both its `A` and
  its `a`, so it answers two filters and comes back twice. On Miky's Leaf open,
  4 Nov, the answer was 727 events, over the largest page seen, so it was
  thrown away and each filter asked again: 0.94 MB twice.
*/
const ME = hex(7)
const TOPICS = ['30840:x:t0', '30840:x:t1', '30840:x:t2']
const partIn = (topics, person) => [
  { kinds: [1851], '#a': topics, '#p': [person] },
  { kinds: [1111], '#A': topics, authors: [person] },
  { kinds: [1111], '#a': topics, authors: [person] },
  { kinds: [1111], '#A': topics, '#p': [person] },
  { kinds: [1111], '#a': topics, '#p': [person] },
]
const changesNaming = (person, count, base) =>
  Array.from({ length: count }, (_, i) => ({ ...event(base + i, 3_000_000 - i, 1851), tags: [['a', TOPICS[i % 3]], ['p', person]] }))
const commentsBy = (person, count, base) =>
  Array.from({ length: count }, (_, i) => ({ ...event(base + i, 2_000_000 - i, 1111), pubkey: person, tags: [['A', TOPICS[i % 3]], ['a', TOPICS[i % 3]]] }))
const commentsNaming = (person, count, base) =>
  Array.from({ length: count }, (_, i) => ({ ...event(base + i, 1_000_000 - i, 1111), tags: [['A', TOPICS[i % 3]], ['a', TOPICS[i % 3]], ['p', person]] }))

/** A relay that has handed back a page of 120 events, as Leaf's has by the time it reads its Topics. */
async function warmed(relay, calls) {
  await relay.queryAll([{ kinds: [9] }], { batch: false })
  calls.length = 0
}

test("a person's part in some topics is one request when each filter's run is under the largest page seen", async () => {
  const events = [...inFolder('w', 9, 120, 900_000), ...changesNaming(ME, 40, 0), ...commentsBy(ME, 50, 10_000), ...commentsNaming(ME, 30, 20_000)]
  const { relay, calls } = fakeRelay(events)
  await warmed(relay, calls)
  const filters = partIn(TOPICS, ME)

  const got = await relay.queryAll(filters)

  assert.equal(calls.length, 1, `the five filters were asked ${calls.length} times, not once`)
  assert.equal(calls[0].length, 5, 'and that one request carried all five')
  const serial = await fakeRelay(events).relay.queryAll(filters, { batch: false })
  assert.deepEqual(got.map((e) => e.id), serial.map((e) => e.id), 'the same events in the same order as reading one filter at a time')
})

test("a person's part in some topics still pages on the filters whose runs reach the largest page seen", async () => {
  const events = [...inFolder('w', 9, 120, 900_000), ...changesNaming(ME, 40, 0), ...commentsBy(ME, 150, 10_000), ...commentsNaming(ME, 30, 20_000)]
  const { relay, calls } = fakeRelay(events)
  await warmed(relay, calls)
  const filters = partIn(TOPICS, ME)

  const got = await relay.queryAll(filters)

  const which = ({ limit, until, ...f }) => filters.findIndex((g) => JSON.stringify(g) === JSON.stringify(f))
  const askedAgain = new Set(calls.slice(1).flatMap((call) => call.map(which)))
  assert.deepEqual([...askedAgain].sort(), [1, 2], 'after the batch, only the two filters of my comments, over the largest page seen, are asked again')
  assert.ok(calls.slice(1).every(([f]) => f.until !== undefined), 'from where their page ended, not their first page a second time')
  const serial = await fakeRelay(events).relay.queryAll(filters, { batch: false })
  assert.deepEqual(got.map((e) => e.id).sort(), serial.map((e) => e.id).sort(), 'all 150 of my comments, none cut at a page')
})

test('a batch is not cut into runs when the relay sent an event no filter matches as NIP-01 reads it', async () => {
  /*
    A relay matching more widely than NIP-01 (here, `#a` also answered by an
    older address form) sends events nothing here can attribute: the first
    filter's run is clamped at 100, though only its newest 60 match by NIP-01.
    Cut where those 60 end, it would look short and settle, and the rest of
    the changes naming me would be lost.
  */
  const legacy = Array.from({ length: 140 }, (_, i) => ({ ...event(50_000 + i, 2_500_000 - i, 1851), tags: [['a', 'old:t0'], ['p', ME]] }))
  const events = [...inFolder('w', 9, 120, 900_000), ...changesNaming(ME, 60, 0), ...legacy, ...commentsNaming(ME, 30, 20_000)]
  const also = (e, filter) => filter['#a'].includes('30840:x:t0') && e.tags.some((t) => t[0] === 'a' && t[1] === 'old:t0')
  const { relay, calls } = fakeRelay(events, 100, { also })
  await relay.queryAll([{ kinds: [9] }], { batch: false })
  calls.length = 0
  const filters = partIn(TOPICS, ME)

  const got = await relay.queryAll(filters)

  const serial = await fakeRelay(events, 100, { also }).relay.queryAll(filters, { batch: false })
  assert.deepEqual(got.map((e) => e.id).sort(), serial.map((e) => e.id).sort(), 'every change naming me, the older address form included')
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

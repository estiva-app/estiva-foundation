/**
 * SHA-14 — `queryAll` runs its filters concurrently, and that is unobservable
 * in the answer.
 *
 * The filters handed to one `queryAll` are independent; only the pages *inside*
 * a filter are a cursor walk. Doing them in sequence made a read cost the sum
 * of every filter's latency. Measured on Ship's `loadAll` against production:
 * 33 filters, 66 sequential round trips, median 206 ms, **100% of wall clock
 * spent inside `query`, one request at a time** — 9.0 s, against a 5 s poll.
 *
 * The tests that matter here are not "it is faster". They are the three ways a
 * fan-out silently changes behaviour: the answer stops being ordered, the error
 * you get depends on which request lost a race, and the width of the fan-out is
 * set by the data rather than by this file.
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { Relay, DEFAULT_QUERY_CONCURRENCY, secretKeySigner } from '../dist/index.js'

const SECRET = '0000000000000000000000000000000000000000000000000000000000000001'
const hex = (n) => String(n).padStart(64, '0')
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

/** An event whose id encodes which filter's set it belongs to. */
const event = (id, createdAt, kind = 9) => ({
  id: hex(id),
  pubkey: hex(1),
  kind,
  created_at: createdAt,
  tags: [],
  content: `event ${id}`,
  sig: hex(2),
})

/**
 * A relay that answers per `kind`, with a per-kind delay, and watches how many
 * requests are in flight at once.
 *
 * `answers` maps a kind to either an array of events or a function that throws.
 */
function fakeRelay(answers, { delayFor = () => 0 } = {}) {
  const seenKinds = []
  const calls = []
  let inFlight = 0
  let maxInFlight = 0
  const overlapped = []

  /*
    Serves every filter in the body, as Buzz does — measured 2026-09-07: one
    POST carrying ten filters at `limit: 5` returns 48 events, not 5, and the
    runs come back grouped in filter order.

    The delay is the slowest filter's, not the sum: one call is one round trip
    however many filters it carries, which is exactly why a batched read is
    worth having.
  */
  const fetch = async (_url, init) => {
    const filters = JSON.parse(init.body)
    calls.push(filters)
    const kinds = filters.map((f) => f.kinds[0])
    seenKinds.push(...kinds)
    inFlight++
    maxInFlight = Math.max(maxInFlight, inFlight)
    if (inFlight > 1) overlapped.push(...kinds)
    try {
      await sleep(Math.max(...kinds.map((k) => delayFor(k))))
      const out = []
      for (const filter of filters) {
        const answer = answers[filter.kinds[0]]
        if (typeof answer === 'function') return answer()
        const eligible = (answer ?? [])
          .filter((e) => (filter.until === undefined ? true : e.created_at <= filter.until))
          .sort((a, b) => b.created_at - a.created_at)
        out.push(...eligible.slice(0, filter.limit))
      }
      return { status: 200, text: async () => JSON.stringify(out) }
    } finally {
      inFlight--
    }
  }

  return {
    seenKinds,
    calls,
    overlapped,
    get maxInFlight() {
      return maxInFlight
    },
    relay: new Relay('https://r', secretKeySigner(SECRET), { fetch }),
  }
}

test('independent filters overlap instead of waiting for one another', async () => {
  // Four filters, each slow. Serial they cannot overlap at all.
  const answers = { 1: [event(11, 100, 1)], 2: [event(22, 100, 2)], 3: [event(33, 100, 3)], 4: [event(44, 100, 4)] }
  // `maxInFlight` is a live getter — read it off the probe, never destructure it.
  const probe = fakeRelay(answers, { delayFor: () => 15 })

  await probe.relay.queryAll([{ kinds: [1] }, { kinds: [2] }, { kinds: [3] }, { kinds: [4] }])

  assert.ok(probe.maxInFlight > 1, `filters must overlap; max in flight was ${probe.maxInFlight}`)
})

test('concurrency: 1 restores the strictly serial read', async () => {
  const answers = { 1: [event(11, 100, 1)], 2: [event(22, 100, 2)], 3: [event(33, 100, 3)] }
  const probe = fakeRelay(answers, { delayFor: () => 10 })

  await probe.relay.queryAll([{ kinds: [1] }, { kinds: [2] }, { kinds: [3] }], { concurrency: 1 })

  assert.equal(probe.maxInFlight, 1, 'nothing may overlap when the caller asks for serial')
  assert.deepEqual(probe.overlapped, [])
})

test('the fan-out is bounded by the option, not by how many filters there are', async () => {
  // Twenty filters and a bound of three. An unbounded `Promise.all` would open
  // all twenty at once — a width set by the data, against a shared relay.
  const answers = Object.fromEntries(Array.from({ length: 20 }, (_, i) => [i + 1, [event(i + 1, 100, i + 1)]]))
  const filters = Array.from({ length: 20 }, (_, i) => ({ kinds: [i + 1] }))
  const probe = fakeRelay(answers, { delayFor: () => 5 })

  await probe.relay.queryAll(filters, { concurrency: 3 })

  assert.equal(probe.maxInFlight, 3, `bound of 3 exceeded: saw ${probe.maxInFlight} in flight`)
})

test('there is a default bound, so no call site has to name one', () => {
  assert.equal(typeof DEFAULT_QUERY_CONCURRENCY, 'number')
  assert.ok(DEFAULT_QUERY_CONCURRENCY > 1, 'a default of 1 would be the serial read again')
})

test('the answer is identical serial and concurrent, whatever order responses arrive in', async () => {
  /*
    Filter 1 is slow and filter 2 is fast, and they share an event. Run
    concurrently, filter 2's response lands first — so an implementation that
    appended results as they arrived would return them in a different order,
    and would attribute the shared event to filter 2 rather than filter 1.
  */
  const shared = event(99, 500)
  const answers = {
    1: [event(11, 300), shared],
    2: [event(22, 400), shared],
  }
  const filters = [{ kinds: [1] }, { kinds: [2] }]
  const delayFor = (kind) => (kind === 1 ? 30 : 1)

  const serial = await fakeRelay(answers, { delayFor }).relay.queryAll(filters, { concurrency: 1 })
  const concurrent = await fakeRelay(answers, { delayFor }).relay.queryAll(filters, { concurrency: 8 })

  assert.deepEqual(
    concurrent.map((e) => e.id),
    serial.map((e) => e.id),
    'concurrency must not be visible in the returned array',
  )
  assert.equal(new Set(concurrent.map((e) => e.id)).size, concurrent.length, 'still deduplicated')
})

test('a failure reports the lowest-indexed filter, not whichever rejected first', async () => {
  /*
    Filter 1 fails slowly, filter 2 fails quickly. Under a plain `Promise.all`
    the caller would hear about filter 2 — and would hear about a different one
    on a slower day. Serial order is the only reproducible order, and it is what
    the serial version reported.
  */
  const answers = {
    1: () => {
      throw new Error('relay refused the FIRST filter')
    },
    2: () => {
      throw new Error('relay refused the SECOND filter')
    },
  }
  const { relay } = fakeRelay(answers, { delayFor: (kind) => (kind === 1 ? 30 : 1) })

  await assert.rejects(
    () => relay.queryAll([{ kinds: [1] }, { kinds: [2] }], { concurrency: 8 }),
    /FIRST filter/,
  )
})

test('a failure stops new filters being started, rather than firing the whole queue', async () => {
  const answers = {
    1: () => {
      throw new Error('refused')
    },
    ...Object.fromEntries(Array.from({ length: 19 }, (_, i) => [i + 2, [event(i + 2, 100)]])),
  }
  const filters = Array.from({ length: 20 }, (_, i) => ({ kinds: [i + 1] }))
  const probe = fakeRelay(answers, { delayFor: () => 1 })

  await assert.rejects(() => probe.relay.queryAll(filters, { concurrency: 2 }))

  /*
    Counted in HTTP calls, which is the unit the relay meters and the unit this
    test has always been about — "firing the whole queue" is a cost because it
    is twenty requests, not because it is twenty filters.

    Since PER-1 the twenty filters travel in one call, so a read that fails at
    the first filter costs exactly that one call: the batch is not caught and
    re-run per filter, precisely so that a refusal cannot be amplified.
  */
  assert.ok(
    probe.calls.length <= 2,
    `a read that failed still cost ${probe.calls.length} requests`,
  )
})

test('throw-rather-than-truncate survives the fan-out', async () => {
  // More events sharing one created_at than fit in a page: no value of `until`
  // advances without skipping some, under concurrency exactly as under serial.
  const crowded = Array.from({ length: 150 }, (_, i) => event(i + 1, 1_000_000))
  const { relay } = fakeRelay({ 1: [event(11, 100)], 2: crowded })

  await assert.rejects(
    () => relay.queryAll([{ kinds: [1] }, { kinds: [2] }], { pageSize: 100, concurrency: 8 }),
    /share created_at/,
  )
})

test('pages within one filter stay sequential — the cursor demands it', async () => {
  // 250 events, 100 a page. The pages of a single filter can never overlap:
  // page N+1's `until` is not known until page N has answered.
  const many = Array.from({ length: 250 }, (_, i) => event(i + 1, 1_000_000 - i))
  const probe = fakeRelay({ 1: many }, { delayFor: () => 3 })

  const got = await probe.relay.queryAll([{ kinds: [1] }], { pageSize: 100, concurrency: 8 })

  assert.equal(got.length, 250)
  assert.equal(probe.maxInFlight, 1, 'a single filter must not have two pages in flight')
})

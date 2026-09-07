/**
 * SHA-15 — a short page does not always need a confirming round trip.
 *
 * `queryAll` spent two requests on every filter, even one holding three events:
 * a page shorter than the requested `limit` is ambiguous, because the relay
 * clamps to `min(requested, ceiling)` and might have clamped at exactly that
 * many. Measured on Ship's `loadAll`, that doubling was **33 filters → 66
 * requests**, against a relay that meters `POST /query` at 300 a minute.
 *
 * The ambiguity dissolves arithmetically. A clamp at `n` requires the relay's
 * ceiling to *equal* `n`; the ceiling is one constant; and the largest page the
 * relay has already handed back is a lower bound on it. So `n <
 * observedPageCeiling` rules out the clamp without trusting anything.
 *
 * These tests are mostly about the cases where it must NOT conclude — the
 * conservative ones are what keep SHA-8 fixed.
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { Relay, secretKeySigner } from '../dist/index.js'

const SECRET = '0000000000000000000000000000000000000000000000000000000000000001'
const hex = (n) => String(n).padStart(64, '0')

// The `kind` is a parameter because the relay's answer carries it: a filter
// asking `kinds: [1]` never comes back holding an event of another kind, and a
// double that says otherwise cannot be used to reason about batched reads.
const event = (id, createdAt, kind = 9) => ({
  id: hex(id),
  pubkey: hex(1),
  kind,
  created_at: createdAt,
  tags: [],
  content: `e${id}`,
  sig: hex(2),
})

/** `count` events under `kind`, one second apart, newest first. */
const set = (kind, count) =>
  Array.from({ length: count }, (_, i) => event(kind * 100_000 + i, 1_000_000 - i, kind))

/**
 * A relay answering per kind, clamping every response to `serverCeiling`.
 *
 * **Serves every filter in the body, not only the first**, because that is what
 * Buzz does — measured against production 2026-09-07: ten filters at `limit: 5`
 * returned 48 events rather than 5, and the same filter twice in one request
 * returned 236 rather than 118. A double that answered only `body[0]` would
 * make a batched read look broken here and work in production, which is the
 * wrong way round.
 *
 * `requests` still records one entry per *filter*, so the existing per-kind
 * assertions keep counting what they always counted; `calls` is the number of
 * HTTP round trips, which is the number the relay's quota is spent in.
 */
function fakeRelay(byKind, serverCeiling) {
  const requests = []
  const calls = []
  const fetch = async (_url, init) => {
    const filters = JSON.parse(init.body)
    calls.push(filters)
    const out = []
    for (const filter of filters) {
      requests.push(filter)
      const eligible = (byKind[filter.kinds[0]] ?? [])
        .filter((e) => (filter.until === undefined ? true : e.created_at <= filter.until))
        .sort((a, b) => b.created_at - a.created_at)
      const take = Math.min(filter.limit ?? serverCeiling, serverCeiling)
      out.push(...eligible.slice(0, take))
    }
    return { status: 200, text: async () => JSON.stringify(out) }
  }
  return { requests, calls, relay: new Relay('https://r', secretKeySigner(SECRET), { fetch }) }
}

const countFor = (requests, kind) => requests.filter((f) => f.kinds[0] === kind).length

/**
 * HTTP calls that carried *only* this filter — that is, calls spent paging it.
 *
 * Since PER-1 every filter's first page arrives in a shared batched call, so
 * "did this filter need a confirming round trip?" is no longer the same
 * question as "how many times does it appear in a request body". A filter the
 * batch settled is paged 0 times; one that must confirm is paged twice, its own
 * first page and the confirmation.
 */
const pagedFor = (calls, kind) =>
  calls.filter((fs) => fs.length === 1 && fs[0].kinds[0] === kind).length

test('a filter smaller than a page already seen costs one request, not two', async () => {
  // Kind 1 establishes that this relay can produce 40 events in one response.
  // Kind 2 then returns 5, which cannot be a clamp at 5 — the ceiling is ≥ 40.
  const { relay, requests } = fakeRelay({ 1: set(1, 40), 2: set(2, 5) }, 1000)

  const got = await relay.queryAll([{ kinds: [1] }, { kinds: [2] }], { concurrency: 1 })

  assert.equal(got.length, 45, 'every event, both filters')
  assert.equal(countFor(requests, 2), 1, 'the small filter must not need a confirming page')
})

test('the first filter through a fresh relay still confirms — there is no evidence yet', async () => {
  const { relay, requests } = fakeRelay({ 1: set(1, 5) }, 1000)

  const got = await relay.queryAll([{ kinds: [1] }], { concurrency: 1 })

  assert.equal(got.length, 5)
  assert.equal(
    countFor(requests, 1),
    2,
    'with nothing observed, a short page is still ambiguous and must be confirmed',
  )
})

test('a page that merely ties the largest seen is not conclusive', async () => {
  // Both filters return 7. The second's 7 could still be a clamp at 7 — the
  // observed bound is 7, not "more than 7". Strictly less is the rule.
  const { relay, calls } = fakeRelay({ 1: set(1, 7), 2: set(2, 7) }, 1000)

  await relay.queryAll([{ kinds: [1] }, { kinds: [2] }], { concurrency: 1 })

  // One paging call, not none: the batch could not settle it, so it goes on to
  // confirm. It does not re-fetch the first page — the batch's own is carried
  // forward as the cursor — which is why this is 1 rather than 2.
  assert.equal(pagedFor(calls, 2), 1, 'equal is not smaller; it must confirm')
})

test('a page filled to the requested limit is never conclusive, whatever has been observed', async () => {
  // Kind 1 shows the relay can produce 500. Kind 2 is then read with
  // pageSize 10 and fills it — a truncation by *our own* limit, not the end.
  const { relay, requests } = fakeRelay({ 1: set(1, 500), 2: set(2, 25) }, 1000)

  await relay.queryAll([{ kinds: [1] }], { pageSize: 1000, concurrency: 1 })
  const got = await relay.queryAll([{ kinds: [2] }], { pageSize: 10, concurrency: 1 })

  assert.equal(got.length, 25, 'all 25, paged 10 at a time')
  assert.ok(countFor(requests, 2) >= 3, 'a full page must always provoke another request')
})

test('SHA-8 stays fixed: a relay clamping below the requested page still yields everything', async () => {
  // The caller asks for 500 a page; the relay quietly gives 40. Every page
  // looks short. Trusting "short means done" — or trusting a NIP-11 claim of
  // 500 — returns 40 of 200 and reports success.
  const { relay } = fakeRelay({ 1: set(1, 200) }, 40)

  const got = await relay.queryAll([{ kinds: [1] }], { pageSize: 500, concurrency: 1 })

  assert.equal(got.length, 200, 'all of them, despite every page being shorter than requested')
})

test('the widest filter always confirms — it is the one that sets the ceiling', async () => {
  /*
    The saving does not reach every filter, and it cannot. A page can only be
    ruled out as a clamp by being *smaller* than one already seen, so whichever
    filter is currently the widest ties its own bound and pays the confirming
    round trip on every read, warm or cold. Everything narrower goes free.

    Worth pinning rather than leaving as folklore: it is the difference between
    "one request per filter" and "one per filter plus one", and the arithmetic
    against a 300-a-minute quota is done in whole requests.
  */
  const { relay, calls } = fakeRelay({ 1: set(1, 30), 2: set(2, 4) }, 1000)

  await relay.queryAll([{ kinds: [1] }, { kinds: [2] }], { concurrency: 1 })
  const cold = calls.length
  calls.length = 0

  await relay.queryAll([{ kinds: [1] }, { kinds: [2] }], { concurrency: 1 })

  assert.equal(cold, 2, 'cold: the batch, then the widest filter confirming from it')
  assert.equal(calls.length, 2, 'warm: the same — the widest still ties its own bound')
  assert.equal(pagedFor(calls, 2), 0, 'the narrow filter is settled by the batch and never paged')
  assert.equal(pagedFor(calls, 1), 1, 'the widest one still pays its confirmation')
})

test('a realistic workspace read: one request per filter once the first is warm', async () => {
  // One large discovery filter and ten small folders — Ship's shape.
  const byKind = { 1: set(1, 160) }
  for (let k = 2; k <= 11; k++) byKind[k] = set(k, 3 + k)
  const filters = Array.from({ length: 11 }, (_, i) => ({ kinds: [i + 1] }))
  const { relay, calls } = fakeRelay(byKind, 1000)

  const got = await relay.queryAll(filters, { concurrency: 1 })

  assert.equal(got.length, 160 + Array.from({ length: 10 }, (_, i) => 5 + i).reduce((a, b) => a + b, 0))
  /*
    The same twelve filters, in three HTTP calls instead of twelve — which is
    the only number the relay's 300-a-minute quota counts.

    One batched call answers all eleven and establishes the ceiling; the widest
    filter ties that ceiling and confirms, resuming from the page the batch
    already fetched. Everything narrower is settled outright.

    Ship's real read against production: 39 calls to 2.
  */
  assert.equal(calls.length, 2, 'one batch, then only the widest filter confirming')
})

test('under concurrency the saving may be smaller, but never wrong', async () => {
  /*
    Filters run in parallel, so a filter can finish its first page before
    another has raised the observed ceiling — it then confirms unnecessarily.
    That is conservative, never unsafe, so the assertion is a bound and a
    correctness check rather than an exact count.
  */
  const byKind = { 1: set(1, 160) }
  for (let k = 2; k <= 11; k++) byKind[k] = set(k, 3 + k)
  const filters = Array.from({ length: 11 }, (_, i) => ({ kinds: [i + 1] }))

  const serial = fakeRelay(byKind, 1000)
  const parallel = fakeRelay(byKind, 1000)

  const a = await serial.relay.queryAll(filters, { concurrency: 1 })
  const b = await parallel.relay.queryAll(filters, { concurrency: 8 })

  assert.deepEqual(b.map((e) => e.id), a.map((e) => e.id), 'same answer either way')
  assert.ok(
    parallel.requests.length >= serial.requests.length,
    'parallel can only ever confirm more often, never fewer',
  )
  assert.ok(parallel.requests.length <= filters.length * 2, 'and never worse than the old behaviour')
})

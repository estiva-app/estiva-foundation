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

const event = (id, createdAt) => ({
  id: hex(id),
  pubkey: hex(1),
  kind: 9,
  created_at: createdAt,
  tags: [],
  content: `e${id}`,
  sig: hex(2),
})

/** `count` events under `kind`, one second apart, newest first. */
const set = (kind, count) =>
  Array.from({ length: count }, (_, i) => event(kind * 100_000 + i, 1_000_000 - i))

/** A relay answering per kind, clamping every response to `serverCeiling`. */
function fakeRelay(byKind, serverCeiling) {
  const requests = []
  const fetch = async (_url, init) => {
    const [filter] = JSON.parse(init.body)
    requests.push(filter)
    const eligible = (byKind[filter.kinds[0]] ?? [])
      .filter((e) => (filter.until === undefined ? true : e.created_at <= filter.until))
      .sort((a, b) => b.created_at - a.created_at)
    const take = Math.min(filter.limit ?? serverCeiling, serverCeiling)
    return { status: 200, text: async () => JSON.stringify(eligible.slice(0, take)) }
  }
  return { requests, relay: new Relay('https://r', secretKeySigner(SECRET), { fetch }) }
}

const countFor = (requests, kind) => requests.filter((f) => f.kinds[0] === kind).length

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
  const { relay, requests } = fakeRelay({ 1: set(1, 7), 2: set(2, 7) }, 1000)

  await relay.queryAll([{ kinds: [1] }, { kinds: [2] }], { concurrency: 1 })

  assert.equal(countFor(requests, 2), 2, 'equal is not smaller; it must confirm')
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
  const { relay, requests } = fakeRelay({ 1: set(1, 30), 2: set(2, 4) }, 1000)

  await relay.queryAll([{ kinds: [1] }, { kinds: [2] }], { concurrency: 1 })
  const cold = requests.length
  requests.length = 0

  await relay.queryAll([{ kinds: [1] }, { kinds: [2] }], { concurrency: 1 })

  assert.equal(cold, 3, 'cold: 2 for the first filter, 1 for the small one behind it')
  assert.equal(requests.length, 3, 'warm: still 2 for the widest, 1 for the narrow one')
  assert.equal(countFor(requests, 2), 1, 'the narrow filter is the one that got cheaper')
})

test('a realistic workspace read: one request per filter once the first is warm', async () => {
  // One large discovery filter and ten small folders — Ship's shape.
  const byKind = { 1: set(1, 160) }
  for (let k = 2; k <= 11; k++) byKind[k] = set(k, 3 + k)
  const filters = Array.from({ length: 11 }, (_, i) => ({ kinds: [i + 1] }))
  const { relay, requests } = fakeRelay(byKind, 1000)

  const got = await relay.queryAll(filters, { concurrency: 1 })

  assert.equal(got.length, 160 + Array.from({ length: 10 }, (_, i) => 5 + i).reduce((a, b) => a + b, 0))
  assert.equal(requests.length, 12, '11 filters, and only the first pays a confirmation')
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

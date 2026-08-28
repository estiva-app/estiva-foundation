/**
 * SHA-8 — the relay's page ceiling belongs here, and `queryAll` must page.
 *
 * Buzz clamps a REQ to its advertised NIP-11 `max_limit`, which halved from
 * 10000 to 1000 when the fork caught up with upstream. NIP-01 has no truncation
 * signal, so a caller asking for 2000 gets 1000 and no indication why — and
 * `limit: 2000` was a literal at four call sites across two apps and the agent.
 *
 * The interesting assertion is not "it pages". It is that paging **does not
 * depend on `RELAY_PAGE_CEILING` being the relay's real limit**: the fake below
 * clamps harder than the page size the caller asks for, which is the shape that
 * would make a "stop at a short page" implementation return the first page and
 * call it the whole set.
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { Relay, RELAY_PAGE_CEILING, secretKeySigner } from '../dist/index.js'

const SECRET = '0000000000000000000000000000000000000000000000000000000000000001'

const id = (n) => String(n).padStart(64, '0')

/** `count` events, newest first, one second apart unless `sharedTimestamp`. */
function makeEvents(count, { sharedTimestamp } = {}) {
  return Array.from({ length: count }, (_, i) => ({
    id: id(i),
    pubkey: id(1),
    kind: 9,
    created_at: sharedTimestamp ?? 1_000_000 - i,
    tags: [],
    content: `event ${i}`,
    sig: id(2),
  }))
}

/**
 * A relay that honours `until` (inclusive, per NIP-01) and clamps `limit` to its
 * own ceiling — which the caller is not told.
 */
function fakeRelay(events, serverCeiling) {
  const requests = []
  const fetch = async (_url, init) => {
    const [filter] = JSON.parse(init.body)
    requests.push(filter)
    const eligible = events
      .filter((e) => (filter.until === undefined ? true : e.created_at <= filter.until))
      .sort((a, b) => b.created_at - a.created_at)
    const take = Math.min(filter.limit ?? serverCeiling, serverCeiling)
    return { status: 200, text: async () => JSON.stringify(eligible.slice(0, take)) }
  }
  return { requests, relay: new Relay('https://r', secretKeySigner(SECRET), { fetch }) }
}

test('the ceiling is exported so no call site has to name one', () => {
  assert.equal(typeof RELAY_PAGE_CEILING, 'number')
  assert.ok(RELAY_PAGE_CEILING > 0)
})

test('queryAll returns every event when the set exceeds one page', async () => {
  const events = makeEvents(250)
  const { relay, requests } = fakeRelay(events, 100)

  const got = await relay.queryAll([{ kinds: [9] }], { pageSize: 100 })

  assert.equal(got.length, 250, 'every event, not the first page')
  assert.equal(new Set(got.map((e) => e.id)).size, 250, 'no duplicates from the inclusive `until`')
  assert.ok(requests.length > 1, 'it paged')
  assert.ok(
    requests.slice(1).every((f) => typeof f.until === 'number'),
    'every page after the first carries an `until` cursor',
  )
})

test('a full page is never mistaken for the whole set', async () => {
  // Exactly one page of events. The naive implementation asks once, sees a
  // "full" page and either stops (truncating) or trusts the count.
  const { relay, requests } = fakeRelay(makeEvents(100), 100)

  const got = await relay.queryAll([{ kinds: [9] }], { pageSize: 100 })

  assert.equal(got.length, 100)
  assert.ok(
    requests.length >= 2,
    'a page filled to the requested size must provoke another request, not be assumed complete',
  )
})

test('paging does not trust RELAY_PAGE_CEILING to be the relay’s real limit', async () => {
  // The caller asks for 500 a page; the relay quietly gives 40. A "short page
  // means done" implementation returns 40 of 200 and reports success.
  const { relay } = fakeRelay(makeEvents(200), 40)

  const got = await relay.queryAll([{ kinds: [9] }], { pageSize: 500 })

  assert.equal(got.length, 200, 'all of them, despite the relay clamping below the page size')
})

test('more than one page sharing a created_at throws instead of truncating', async () => {
  // `until` is the only cursor NIP-01 offers. If more events share the oldest
  // timestamp than fit in a page, no value of `until` advances without skipping
  // some — so there is no correct answer to return.
  const { relay } = fakeRelay(makeEvents(150, { sharedTimestamp: 1_000_000 }), 100)

  await assert.rejects(
    () => relay.queryAll([{ kinds: [9] }], { pageSize: 100 }),
    /share created_at/,
    'it must say so rather than return a plausible subset',
  )
})

test('an empty result is one request and no error', async () => {
  const { relay, requests } = fakeRelay([], 100)
  const got = await relay.queryAll([{ kinds: [9] }], { pageSize: 100 })
  assert.deepEqual(got, [])
  assert.equal(requests.length, 1)
})

test('multiple filters are each paged, and the union is deduplicated', async () => {
  const events = makeEvents(120)
  const { relay } = fakeRelay(events, 50)
  // The same filter twice: a naive union would return 240.
  const got = await relay.queryAll([{ kinds: [9] }, { kinds: [9] }], { pageSize: 50 })
  assert.equal(got.length, 120, 'ids seen under one filter are not re-added under the next')
})

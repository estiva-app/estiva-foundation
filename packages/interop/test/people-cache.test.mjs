/**
 * The foreign-profile cache — batching, and two TTLs.
 *
 * Moved here from Peek (SHA-16), where it was written for PEE-3. It never
 * expired and it cached misses for ever, which was defensible while nothing
 * refreshed; once Peek's panels re-read on a timer it became the remaining
 * reason a newly named person still rendered as `nostr:<8 chars>` until a full
 * reload — and that reads as "the refresh is broken".
 *
 * The miss TTL is the sharp end: a miss is somebody who has not finished
 * setting up their identity, which is exactly the person whose name is about to
 * arrive. Ship needs the same behaviour, and the second consumer is what moved
 * it out of one app.
 *
 * Converted from vitest by hand. A regex pass over an earlier suite produced
 * assertions with no assert in them — `expect(found?.openCount, 2)` reads fine
 * and tests nothing — so every case here was rewritten and then broken on
 * purpose to check it could fail.
 */
import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import { createPeopleCache, PROFILE_HIT_TTL_MS, PROFILE_MISS_TTL_MS } from '../dist/index.js'

const ADA = 'a'.repeat(64)
const BOB = 'b'.repeat(64)

/** A lookup that records what it was asked, standing in for the relay. */
function recording(answer) {
  const calls = []
  const fn = async (pubkeys) => {
    calls.push(pubkeys)
    return answer(pubkeys)
  }
  return { fn, calls, get count() { return calls.length } }
}

describe('batching', () => {
  test('asks once for a whole set', async () => {
    // A screen with ten reference widgets asks about the same handful of
    // people. Splitting this would turn one request into N.
    const relay = recording(async () => ({ [ADA]: { displayName: 'Ada' }, [BOB]: {} }))
    const people = createPeopleCache().through(relay.fn)

    await people([ADA, BOB])

    assert.equal(relay.count, 1)
    assert.deepEqual(relay.calls[0], [ADA, BOB])
  })

  test('does not re-ask for something already known', async () => {
    const relay = recording(async () => ({ [ADA]: { displayName: 'Ada' } }))
    const people = createPeopleCache().through(relay.fn)

    await people([ADA])
    await people([ADA])

    assert.equal(relay.count, 1)
  })

  test('asks only about the ones it does not hold', async () => {
    const relay = recording(async (keys) =>
      Object.fromEntries(keys.map((k) => [k, { displayName: k.slice(0, 3) }])),
    )
    const people = createPeopleCache().through(relay.fn)

    await people([ADA])
    await people([ADA, BOB])

    assert.equal(relay.count, 2)
    assert.deepEqual(relay.calls[1], [BOB], 'the second ask is only the unknown one')
  })

  test('answers for every key asked, held or not', async () => {
    const relay = recording(async () => ({ [ADA]: { displayName: 'Ada' } }))
    const people = createPeopleCache().through(relay.fn)

    const found = await people([ADA, BOB])

    assert.deepEqual(found[ADA], { displayName: 'Ada' })
    assert.deepEqual(found[BOB], {}, 'a key with no profile still gets an entry')
  })
})

describe('expiry', () => {
  test('a miss is re-asked much sooner than a hit', () => {
    assert.ok(
      PROFILE_MISS_TTL_MS < PROFILE_HIT_TTL_MS,
      'a name changes rarely; a missing profile is about to stop being missing',
    )
  })

  test('picks up a profile published after a miss was cached', async () => {
    let published = false
    const relay = recording(async () => ({ [ADA]: published ? { displayName: 'Ada' } : {} }))
    let now = 1_000_000
    const people = createPeopleCache({ now: () => now }).through(relay.fn)

    assert.deepEqual((await people([ADA]))[ADA], {})

    published = true
    now += PROFILE_MISS_TTL_MS
    assert.deepEqual((await people([ADA]))[ADA], { displayName: 'Ada' })
  })

  test('holds a miss until its TTL, rather than asking every render', async () => {
    const relay = recording(async () => ({ [ADA]: {} }))
    let now = 1_000_000
    const people = createPeopleCache({ now: () => now }).through(relay.fn)

    await people([ADA])
    now += PROFILE_MISS_TTL_MS - 1
    await people([ADA])

    assert.equal(relay.count, 1)
  })

  test('keeps a name for the longer TTL, then re-asks', async () => {
    const relay = recording(async () => ({ [ADA]: { displayName: 'Ada' } }))
    let now = 1_000_000
    const people = createPeopleCache({ now: () => now }).through(relay.fn)

    await people([ADA])
    now += PROFILE_MISS_TTL_MS * 2
    await people([ADA])
    assert.equal(relay.count, 1, 'a name outlives the miss TTL')

    now += PROFILE_HIT_TTL_MS
    await people([ADA])
    assert.equal(relay.count, 2, 'and is eventually re-asked')
  })
})

describe('the store outlives any one lookup', () => {
  test('a second lookup answers from what the first found', async () => {
    /*
      The reason this is a cache with `through` rather than a wrapped function.
      A consumer builds its query per call — Peek's carries the viewer's token —
      while profiles are public and worth keeping across all of them.
    */
    const first = recording(async () => ({ [ADA]: { displayName: 'Ada' } }))
    const second = recording(async () => ({ [ADA]: { displayName: 'should not be asked' } }))
    const cache = createPeopleCache()

    await cache.through(first.fn)([ADA])
    const found = await cache.through(second.fn)([ADA])

    assert.equal(second.count, 0, 'the store is shared, not the lookup')
    assert.deepEqual(found[ADA], { displayName: 'Ada' })
  })

  test('two caches do not share, so a screen can scope its own', async () => {
    const relay = recording(async () => ({ [ADA]: { displayName: 'Ada' } }))
    await createPeopleCache().through(relay.fn)([ADA])
    await createPeopleCache().through(relay.fn)([ADA])
    assert.equal(relay.count, 2)
  })

  test('clear() forgets, which is what a sign-out needs', async () => {
    const relay = recording(async () => ({ [ADA]: { displayName: 'Ada' } }))
    const cache = createPeopleCache()

    await cache.through(relay.fn)([ADA])
    cache.clear()
    await cache.through(relay.fn)([ADA])

    assert.equal(relay.count, 2)
  })

  test('viaRelay is the relay lookup, cached — one query, then none', async () => {
    let queries = 0
    const query = async () => {
      queries++
      return [{ id: '1'.padStart(64, '0'), pubkey: ADA, kind: 0, created_at: 1, tags: [], content: '{"name":"Ada"}', sig: '' }]
    }
    const people = createPeopleCache().viaRelay(query)

    // parseProfile maps kind:0's `name`/`display_name` onto `displayName`.
    assert.equal((await people([ADA]))[ADA].displayName, 'Ada')
    await people([ADA])
    assert.equal(queries, 1)
  })
})

/**
 * SHI-13 — what one reference costs to keep live.
 *
 * A consumer that re-resolves on a timer pays the whole resolve every tick.
 * Measured on Ship against production: **four requests per reference per tick**,
 * identical on the second resolve, against a relay that meters reads at 300 a
 * minute. Two of the four were NIP-89 discovery, which answers the same thing
 * until an app republishes; the other two were the object and its children,
 * and the second only waited on the first for a value it already had.
 *
 * These tests count round trips. That is the unusual part and the point: the
 * behaviour was already correct, so a suite that only checked the output would
 * have passed before and after and measured nothing.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { resolveForeignObject, createProjectionCache, MANIFEST_TTL_MS } from '../dist/index.js'

const AUTHOR = 'a'.repeat(64)
const KIND = 30850
const CHILD = 30851
const FOLDER = '7b32200c-e4c0-4216-b79a-8490fc05e0bd'

let seq = 0
const event = (partial) => ({
  id: String(++seq).padStart(64, '0'),
  sig: '',
  pubkey: AUTHOR,
  created_at: 1_700_000_000 + seq,
  tags: [],
  content: '',
  ...partial,
})

/** The fake relay, plus a count of how many times it was asked. */
function countingRelay(events) {
  const calls = []
  const query = async (filters) => {
    calls.push(filters)
    return events.filter((e) =>
      filters.some((f) => {
        if (f.ids && !f.ids.includes(e.id)) return false
        if (f.kinds && !f.kinds.includes(e.kind)) return false
        if (f.authors && !f.authors.includes(e.pubkey)) return false
        for (const [key, want] of Object.entries(f)) {
          if (!key.startsWith('#')) continue
          const held = e.tags.filter((t) => t[0] === key.slice(1)).map((t) => t[1])
          if (!want.some((v) => held.includes(v))) return false
        }
        return true
      }),
    )
  }
  return { query, calls, get count() { return calls.length } }
}

const manifest = event({
  kind: 31990,
  tags: [['d', 'some-app'], ['k', String(KIND)], ['k', String(CHILD)]],
  content: JSON.stringify({
    name: 'Some app',
    projections: {
      [KIND]: {
        widget: 'card',
        slots: {
          title: { tag: 'title' },
          list: { children: { kind: CHILD, via: 'a', limit: 200 } },
        },
      },
      [CHILD]: { widget: 'row', slots: { title: { tag: 'title' } } },
    },
  }),
})

const ADDRESS = `${KIND}:${AUTHOR}:p1`
const object = event({ kind: KIND, tags: [['d', 'p1'], ['title', 'Payment integration'], ['h', FOLDER]] })
const child = event({ kind: CHILD, tags: [['d', 'i1'], ['title', 'A ticket'], ['a', ADDRESS]] })

const world = () => countingRelay([manifest, object, child])

test('the children no longer cost a round trip of their own', async () => {
  const relay = world()
  const found = await resolveForeignObject(ADDRESS, relay.query)

  assert.equal(found.children.length, 1, 'the list still resolves')
  assert.equal(found.children[0].slots.title.value, 'A ticket')
  // Two for NIP-89 discovery, one for everything about the object.
  assert.equal(relay.count, 3, `expected 3 round trips, got ${relay.count}`)
})

test('with the manifest memoised, a refresh is a single request', async () => {
  const relay = world()
  const cache = createProjectionCache()

  await resolveForeignObject(ADDRESS, relay.query, undefined, 0, cache)
  const cold = relay.count
  await resolveForeignObject(ADDRESS, relay.query, undefined, 0, cache)
  const warm = relay.count - cold

  assert.equal(cold, 3)
  assert.equal(warm, 1, `a refresh must be one request, was ${warm}`)
})

test('the refresh still sees a change — it is the object that is re-read, not the cache', async () => {
  /*
    The whole hazard of caching here. PRO-10's finding was that resolving once
    made the widget a screenshot with a timestamp nobody can see; a cache that
    held the object would put that back.
  */
  const events = [manifest, object, child]
  const relay = countingRelay(events)
  const cache = createProjectionCache()

  const before = await resolveForeignObject(ADDRESS, relay.query, undefined, 0, cache)
  assert.equal(before.children.length, 1)

  events.push(event({ kind: CHILD, tags: [['d', 'i2'], ['title', 'Filed since'], ['a', ADDRESS]] }))
  const after = await resolveForeignObject(ADDRESS, relay.query, undefined, 0, cache)

  assert.equal(after.children.length, 2, 'a child added since the last resolve must appear')
  assert.equal(after.children[1].slots.title.value, 'Filed since')
})

test('no cache is exactly the old behaviour, twice over', async () => {
  const relay = world()
  await resolveForeignObject(ADDRESS, relay.query)
  await resolveForeignObject(ADDRESS, relay.query)
  assert.equal(relay.count, 6, 'without a cache nothing is remembered between resolves')
})

test('a manifest is not believed for ever', async () => {
  const relay = world()
  const cache = createProjectionCache(0)
  await resolveForeignObject(ADDRESS, relay.query, undefined, 0, cache)
  const cold = relay.count
  await resolveForeignObject(ADDRESS, relay.query, undefined, 0, cache)
  assert.equal(relay.count - cold, 3, 'a zero TTL must re-ask, or the TTL is decoration')
  assert.ok(MANIFEST_TTL_MS > 0)
})

test('clear() forgets, so republishing a manifest is recoverable without a reload', async () => {
  const relay = world()
  const cache = createProjectionCache()
  await resolveForeignObject(ADDRESS, relay.query, undefined, 0, cache)
  cache.clear()
  const before = relay.count
  await resolveForeignObject(ADDRESS, relay.query, undefined, 0, cache)
  assert.equal(relay.count - before, 3, 'after clear(), discovery runs again')
})

test('a kind nothing claims is memoised too, so the expensive miss is paid once', async () => {
  // The failing lookup costs the same two round trips as a hit and is just as
  // stable. Caching only successes leaves the worst case at full price for ever.
  const relay = world()
  const cache = createProjectionCache()
  assert.equal(await resolveForeignObject(`39999:${AUTHOR}:x`, relay.query, undefined, 0, cache), null)
  const cold = relay.count
  assert.equal(await resolveForeignObject(`39999:${AUTHOR}:x`, relay.query, undefined, 0, cache), null)
  assert.equal(relay.count - cold, 0, 'a miss must not be re-asked on every tick')
})

test('children are matched on the filter, not on kind — they can share one', async () => {
  /*
    Peek's Topic declares `kind:9` messages as its children and `kind:9` as its
    comment kind. Merging the two filters into one request puts both under one
    number in the response, and only the tag tells them apart. An event can
    honestly be both, and was returned to both result sets when these were two
    queries.
  */
  const TOPIC = 39000
  const MSG = 9
  const topicManifest = event({
    kind: 31990,
    tags: [['d', 'peek'], ['k', String(TOPIC)], ['k', String(MSG)]],
    content: JSON.stringify({
      name: 'Peek',
      // How a comment kind is really declared — on the `comment` action's
      // `emits`, which is what `commentKindsOf` reads. A `comments` key would
      // have been quietly ignored and left the default 1111 in place.
      actions: [{ id: 'comment', emits: { kind: MSG } }],
      projections: {
        [TOPIC]: {
          widget: 'card',
          // `match: 'identifier'` is how Peek really declares it: a Topic's `d`
          // *is* its channel uuid, and that is what a message's `h` holds.
          slots: { title: { tag: 'name' }, list: { children: { kind: MSG, via: 'h', limit: 50, match: 'identifier' } } },
        },
        [MSG]: { widget: ['message', 'row'], slots: { title: { field: 'content' } } },
      },
    }),
  })
  const topicAddr = `${TOPIC}:${AUTHOR}:${FOLDER}`
  const topic = event({ kind: TOPIC, tags: [['d', FOLDER], ['name', 'A topic']] })
  // In the Folder (a child) *and* addressed to the topic (a comment) — both.
  const both = event({ kind: MSG, tags: [['h', FOLDER], ['a', topicAddr]], content: 'hello' })
  // In the Folder only: a child, never a comment.
  const childOnly = event({ kind: MSG, tags: [['h', FOLDER]], content: 'just a message' })

  const relay = countingRelay([topicManifest, topic, both, childOnly])
  const found = await resolveForeignObject(topicAddr, relay.query)

  assert.equal(found.children.length, 2, 'both messages are children, by their `h` tag')
  assert.equal(found.comments.length, 1, 'only the one carrying `a` is a comment')
  assert.equal(found.comments[0].body, 'hello')
})

test('a second `a` tag still counts — the relay matches any of them, so this must too', async () => {
  /*
    Re-applying a filter's predicate to a merged response is only equivalent if
    it is applied the way the relay applies it. `#a` matches when ANY `a` tag
    holds the value, and reading just the first would drop a comment that
    happens to reference something else before its parent.
  */
  const other = `${KIND}:${AUTHOR}:elsewhere`
  const commentWithTwo = event({
    kind: 1111,
    tags: [['a', other], ['a', ADDRESS]],
    content: 'mentions another object first',
  })
  const relay = countingRelay([manifest, object, child, commentWithTwo])

  const found = await resolveForeignObject(ADDRESS, relay.query)

  assert.equal(found.comments.length, 1, 'the comment must not be lost to tag order')
  assert.equal(found.comments[0].body, 'mentions another object first')
})

/**
 * PER-10 — a set of objects for the price of one.
 *
 * Peek's Screener resolved every followed file on its own, every minute, and
 * an idle Desk spent 144 of its 194 requests in five minutes doing it, against
 * a relay metering 300 a minute per person. `resolveForeignObjects` reads the
 * same objects with the same filters in one POST.
 *
 * Two things are tested, and the second is the one that could go wrong
 * quietly: that the set costs a constant number of requests, and that every
 * object in it is *exactly* what `resolveForeignObject` returns for it alone —
 * a pooled answer is where one object's comments turn up on another.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { resolveForeignObject, resolveForeignObjects, createProjectionCache } from '../dist/index.js'
import { MAX_FILTERS_PER_QUERY } from '@estiva-app/protocol'

const AUTHOR = 'a'.repeat(64)
const OTHER = 'b'.repeat(64)
const ASSIGNEE = 'c'.repeat(64)
const PROJECT = 30850
const ISSUE = 30851
const CHANGE = 1851

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

/** The fake relay: honours `limit` per filter and concatenates, as buzz does. */
function countingRelay(events, { fail } = {}) {
  const calls = []
  const matches = (f, e) => {
    if (f.ids && !f.ids.includes(e.id)) return false
    if (f.kinds && !f.kinds.includes(e.kind)) return false
    if (f.authors && !f.authors.includes(e.pubkey)) return false
    for (const [key, want] of Object.entries(f)) {
      if (!key.startsWith('#')) continue
      const held = e.tags.filter((t) => t[0] === key.slice(1)).map((t) => t[1])
      if (!want.some((v) => held.includes(v))) return false
    }
    return true
  }
  const query = async (filters) => {
    calls.push(filters)
    if (fail?.(filters)) throw new Error('rate_limited')
    return filters.flatMap((f) =>
      events
        .filter((e) => matches(f, e))
        .sort((a, b) => b.created_at - a.created_at)
        .slice(0, f.limit ?? Infinity),
    )
  }
  return { query, calls, get count() { return calls.length } }
}

const manifest = event({
  kind: 31990,
  tags: [['d', 'ship'], ['k', String(PROJECT)], ['k', String(ISSUE)]],
  content: JSON.stringify({
    name: 'Ship',
    records: { changeKind: CHANGE, targetTag: 'a', fieldTag: 'field', valueTag: 'value' },
    projections: {
      [PROJECT]: {
        widget: 'card',
        slots: { title: { tag: 'title' }, list: { children: { kind: ISSUE, via: 'a' } } },
      },
      [ISSUE]: {
        widget: 'row',
        slots: {
          title: { tag: 'title' },
          status: { fold: 'status', default: 'todo' },
          meta: [{ label: 'Assignee', fold: 'assignee', as: 'pubkey' }],
        },
      },
    },
    actions: [{ id: 'comment', label: 'Comment', appliesTo: String(ISSUE), emits: { kind: 1111, scope: 'address' } }],
  }),
})

const address = (d, pubkey = AUTHOR, kind = ISSUE) => `${kind}:${pubkey}:${d}`
const issue = (d, title, pubkey = AUTHOR) => event({ kind: ISSUE, pubkey, tags: [['d', d], ['title', title]] })
const change = (target, field, value) =>
  event({ kind: CHANGE, tags: [['a', target], ['field', field], ['value', value]] })
const comment = (on, body, extra = []) => event({ kind: 1111, tags: [['A', on], ['a', on], ...extra], content: body })

/** Twenty issues, each with a change and a comment, and a project listing them. */
function world() {
  const events = [manifest]
  const refs = []
  for (let i = 0; i < 20; i++) {
    const ref = address(`i${i}`)
    refs.push(ref)
    events.push(issue(`i${i}`, `Issue ${i}`), change(ref, 'status', i % 2 ? 'done' : 'in_progress'), comment(ref, `On ${i}`))
  }
  return { events, refs }
}

test('a warm set of twenty costs one request, where it cost twenty', async () => {
  const { events, refs } = world()
  const relay = countingRelay(events)
  const cache = createProjectionCache()
  await resolveForeignObjects(refs, relay.query, undefined, cache)

  const before = relay.count
  const objects = await resolveForeignObjects(refs, relay.query, undefined, cache)
  assert.equal(relay.count - before, 1, 'one POST for twenty objects, the manifest memoised')
  assert.equal(Object.keys(objects).length, 20)
  assert.ok(refs.every((ref) => objects[ref]?.slots.title.value.startsWith('Issue')))

  // The baseline this replaces, measured the same way.
  const single = relay.count
  await Promise.all(refs.map((ref) => resolveForeignObject(ref, relay.query, undefined, 0, cache)))
  assert.equal(relay.count - single, 20)
})

test('every object is exactly what the single resolve returns for it', async () => {
  const { events, refs } = world()
  const project = event({ kind: PROJECT, tags: [['d', 'p1'], ['title', 'A project']] })
  const listed = event({ kind: ISSUE, tags: [['d', 'child'], ['title', 'Listed'], ['a', address('p1', AUTHOR, PROJECT)]] })
  events.push(project, listed, change(refs[3], 'assignee', ASSIGNEE))
  const relay = countingRelay(events)
  const asked = [...refs, address('p1', AUTHOR, PROJECT), address('missing')]

  const batched = await resolveForeignObjects(asked, relay.query)
  for (const ref of asked) {
    assert.deepEqual(batched[ref], await resolveForeignObject(ref, relay.query), ref)
  }
  assert.equal(batched[address('p1', AUTHOR, PROJECT)].children.length, 1, 'children ride along')
  assert.equal(batched[address('missing')].unreachable, true, 'unreachable, as the single form says')
  assert.equal(batched[refs[3]].meta[0].value, ASSIGNEE)
  assert.deepEqual(Object.keys(batched[refs[3]].people ?? {}), [], 'no profile published, none invented')
})

test('each object keeps its own comments, and a comment naming two is drawn once, on its own file', async () => {
  const a = address('x')
  const b = address('y')
  const both = comment(a, 'About x, mentioning y', [['a', b]])
  const relay = countingRelay([manifest, issue('x', 'X'), issue('y', 'Y'), both, comment(b, 'About y')])

  const objects = await resolveForeignObjects([a, b], relay.query)
  assert.deepEqual(objects[a].comments.map((c) => c.body), ['About x, mentioning y'], 'once, though two filters matched it')
  assert.deepEqual(objects[b].comments.map((c) => c.body), ['About y'], 'a mention is not the discussion')
})

test('two authors may use the same kind and d, and each gets its own root', async () => {
  const mine = address('same')
  const theirs = address('same', OTHER)
  const relay = countingRelay([manifest, issue('same', 'Mine'), issue('same', 'Theirs', OTHER)])

  const objects = await resolveForeignObjects([mine, theirs], relay.query)
  assert.equal(objects[mine].slots.title.value, 'Mine')
  assert.equal(objects[theirs].slots.title.value, 'Theirs')
})

test('a set larger than one POST takes is chunked, never truncated', async () => {
  const events = [manifest]
  const refs = []
  for (let i = 0; i < 50; i++) {
    refs.push(address(`big${i}`))
    events.push(issue(`big${i}`, `Big ${i}`))
  }
  const relay = countingRelay(events)
  const cache = createProjectionCache()
  await resolveForeignObjects(refs.slice(0, 1), relay.query, undefined, cache)

  const before = relay.count
  const objects = await resolveForeignObjects(refs, relay.query, undefined, cache)
  const sent = relay.calls.slice(before)
  // Three filters an issue: root, changes, comments.
  assert.equal(sent.length, Math.ceil((50 * 3) / MAX_FILTERS_PER_QUERY))
  assert.ok(sent.every((filters) => filters.length <= MAX_FILTERS_PER_QUERY))
  assert.ok(refs.every((ref) => objects[ref].slots.title.value.startsWith('Big')), 'the 43rd is there too')
})

test('without a cache, a manifest is still read once per app rather than once per object', async () => {
  const { events, refs } = world()
  const relay = countingRelay(events)
  await resolveForeignObjects(refs, relay.query)
  const discovery = relay.calls.filter((filters) => filters.some((f) => f.kinds?.includes(31990) || f.kinds?.includes(31989)))
  assert.ok(discovery.length <= 2, `discovery asked ${discovery.length} times for one app`)
})

test('two spellings of one object are two answers from one set of filters', async () => {
  const { events, refs } = world()
  const relay = countingRelay(events)
  const cache = createProjectionCache()
  await resolveForeignObjects([refs[0]], relay.query, undefined, cache)
  const naddr = (await resolveForeignObject(refs[0], relay.query, undefined, 0, cache)).naddr

  const before = relay.count
  const objects = await resolveForeignObjects([refs[0], `nostr:${naddr}`], relay.query, undefined, cache)
  assert.equal(relay.calls[before].length, 3, 'one root, one changes, one comments filter')
  assert.equal(objects[refs[0]].eventId, objects[`nostr:${naddr}`].eventId)
})

test('what is not an addressed object is null, and costs nothing', async () => {
  const relay = countingRelay([manifest])
  const objects = await resolveForeignObjects(['not a reference', 'e'.repeat(64), address('z', AUTHOR, 12345)], relay.query)
  assert.deepEqual(objects, { 'not a reference': null, ['e'.repeat(64)]: null, [address('z', AUTHOR, 12345)]: null })
  assert.ok(relay.calls.every((filters) => filters.every((f) => f.kinds?.includes(31990) || f.kinds?.includes(31989))), 'only discovery was asked')
})

test('a failed read rejects the whole set, as the single form throws', async () => {
  const { events, refs } = world()
  const cache = createProjectionCache()
  await resolveForeignObjects(refs, countingRelay(events).query, undefined, cache)
  const relay = countingRelay(events, { fail: (filters) => filters.some((f) => f['#d']) })
  await assert.rejects(resolveForeignObjects(refs, relay.query, undefined, cache), /rate_limited/)
})

test('an empty set asks nothing', async () => {
  const relay = countingRelay([manifest])
  assert.deepEqual(await resolveForeignObjects([], relay.query), {})
  assert.equal(relay.count, 0)
})

/**
 * APP-2 — a load reads each change once.
 *
 * Leaf's tree is `listFolders`, then every Folder's `resolveFolderContents`.
 * Both read every change naming every listed file, and the Folder read asked
 * for most of them twice more in one request: on production, 26 Oct, a Weekly
 * Plans load read 79 MB, 78 MB of it changes, while 36.9 MB of changes existed.
 *
 * These count what the relay sends, event by event, because the listing was
 * already right: a suite checking only the output passes before and after.
 */
import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import * as interop from '../dist/index.js'

const { listFolders, resolveFolderContents, topLevelFolders, KIND_FOLDER_STATE } = interop
// Before APP-2 there was no load query: a load used the plain one, and these fail on what it read.
const createLoadQuery = interop.createLoadQuery ?? ((query) => query)

const KEEPER = 'a'.repeat(64)
const RELAY = 'f'.repeat(64)
const APIARY = '7b32200c-e4c0-4216-b79a-8490fc05e0bd'
const ORCHARD = '05bebd5b-b699-4bd4-af50-f5377df0fd67'
const HIVE = 30871

let seq = 0
const event = (partial) => ({
  id: String(++seq).padStart(64, '0'),
  sig: '',
  pubkey: KEEPER,
  created_at: 1_700_000_000 + seq,
  tags: [],
  content: '',
  ...partial,
})

const matches = (f, e) => {
  if (f.kinds && !f.kinds.includes(e.kind)) return false
  if (f.authors && !f.authors.includes(e.pubkey)) return false
  for (const [key, want] of Object.entries(f)) {
    if (!key.startsWith('#')) continue
    const held = e.tags.filter((t) => t[0] === key.slice(1)).map((t) => t[1])
    if (!want.some((v) => held.includes(v))) return false
  }
  return true
}

/**
 * A relay that keeps each filter's page to its `limit`, newest first, and records every event it sends.
 * Like production's (probed 26 Oct), it answers each filter in full: an event two filters match is sent twice.
 */
function countingRelay(events) {
  const requests = []
  const sent = []
  const query = async (filters) => {
    requests.push(filters)
    const out = filters.flatMap((f) =>
      events.filter((e) => matches(f, e)).sort((a, b) => b.created_at - a.created_at).slice(0, f.limit ?? Infinity),
    )
    sent.push(...out)
    return out
  }
  const timesSent = (e) => sent.filter((s) => s.id === e.id).length
  return { query, requests, sent, timesSent }
}

const hiveLog = event({
  kind: 31990,
  tags: [['d', 'hive-log'], ['k', String(HIVE)]],
  content: JSON.stringify({
    name: 'Hive log',
    records: {
      changeKind: 1851,
      targetTag: 'a',
      fieldTag: 'field',
      valueTag: 'value',
      order: ['ts', 'created_at', 'id'],
      rule: 'last-write-wins-per-field',
    },
    projections: { [HIVE]: { widget: 'card', slots: { title: { tag: 'title' }, status: { fold: 'status' } } } },
  }),
})

const addressOf = (e) => `${e.kind}:${e.pubkey}:${e.tags.find((t) => t[0] === 'd')[1]}`
const channelOf = (id, name) => event({ kind: 39000, pubkey: RELAY, tags: [['d', id], ['name', name]] })
const stateOf = (id, name, files) =>
  event({ kind: KIND_FOLDER_STATE, pubkey: RELAY, tags: [['d', id], ['name', name], ...files.map((f) => ['a', addressOf(f)])] })
const hive = (d, folder) => event({ kind: HIVE, tags: [['d', d], ['title', `${d} hive`], ['h', folder]] })
const change = (file, field, value, folder) =>
  event({ kind: 1851, tags: [['a', addressOf(file)], ['field', field], ['value', value], ['h', folder]] })

const north = hive('north', APIARY)
const south = hive('south', APIARY)
const pear = hive('pear', ORCHARD)
const changes = [
  change(north, 'status', 'queen seen', APIARY),
  change(north, 'status', 'swarming', APIARY),
  change(south, 'status', 'quiet', APIARY),
  change(south, 'archived', 'true', APIARY),
  change(pear, 'status', 'in bloom', ORCHARD),
]
const world = () => [
  hiveLog,
  channelOf(APIARY, 'Apiary'),
  channelOf(ORCHARD, 'Orchard'),
  stateOf(APIARY, 'Apiary', [north, south]),
  stateOf(ORCHARD, 'Orchard', [pear]),
  north,
  south,
  pear,
  ...changes,
]

/** Leaf's tree: the listing, then every Folder's contents side by side. */
async function treeLoad(query) {
  const listing = await listFolders(query)
  const contents = await Promise.all(topLevelFolders(listing).map((f) => resolveFolderContents(f.id, query, async () => ({}))))
  return { listing, contents }
}

describe('a whole load reads each change once', () => {
  test('one Folder’s contents get each change from the relay once, not once per filter that names it', async () => {
    const relay = countingRelay(world())
    await resolveFolderContents(APIARY, relay.query, async () => ({}))
    for (const c of changes.slice(0, 4)) assert.equal(relay.timesSent(c), 1, `change ${c.id} sent ${relay.timesSent(c)} times`)
  })

  test('the listing and every Folder’s contents, through one load query, get each change once', async () => {
    const relay = countingRelay(world())
    await treeLoad(createLoadQuery(relay.query))
    for (const c of changes) assert.equal(relay.timesSent(c), 1, `change ${c.id} sent ${relay.timesSent(c)} times`)
  })

  test('the load query lists exactly what the plain query lists: files, fields and archived state', async () => {
    const plain = await treeLoad(countingRelay(world()).query)
    const shared = await treeLoad(createLoadQuery(countingRelay(world()).query))
    assert.deepEqual(shared, plain)
    const apiary = plain.contents.find((c) => c.id === APIARY)
    assert.deepEqual(apiary.files.map((f) => [f.slots.title.value, f.slots.status.value]), [['north hive', 'swarming']])
  })
})

describe('a load query answers from what it has read only when that read was complete', () => {
  const F = (values, limit = 10) => [{ kinds: [1851], '#a': values, limit }]
  const N = addressOf(north)
  const S = addressOf(south)

  test('a value already read whole is answered without the relay, and only the rest is asked', async () => {
    const relay = countingRelay(world())
    const query = createLoadQuery(relay.query)
    await query(F([N]))
    const second = await query(F([N, S]))
    assert.deepEqual(relay.requests.at(-1), F([S]))
    assert.deepEqual(second.map((e) => e.id).sort(), changes.slice(0, 4).map((e) => e.id).sort())
  })

  test('a page that came back full is asked again, so a change past it is not lost', async () => {
    const relay = countingRelay(world())
    const query = createLoadQuery(relay.query)
    await query(F([N], 2)) // two changes on north: the page is full, so more may exist
    const again = await query(F([N], 2))
    assert.equal(relay.requests.length, 2)
    assert.equal(again.length, 2)
  })

  test('a smaller page than the first read goes to the relay, so "the newest one" stays the newest one', async () => {
    const relay = countingRelay(world())
    const query = createLoadQuery(relay.query)
    await query(F([N], 10))
    const newest = await query(F([N], 1))
    assert.equal(relay.requests.length, 2)
    assert.deepEqual(newest.map((e) => e.id), [changes[1].id])
  })

  test('another load reads afresh: a change made between loads is seen', async () => {
    const events = world()
    const relay = countingRelay(events)
    await createLoadQuery(relay.query)(F([N]))
    const late = change(north, 'status', 'requeened', APIARY)
    events.push(late)
    const next = await createLoadQuery(relay.query)(F([N]))
    assert.ok(next.some((e) => e.id === late.id))
  })

  test('a filter with anything more than one kind, one tag and a limit always goes to the relay', async () => {
    const relay = countingRelay(world())
    const query = createLoadQuery(relay.query)
    const since = [{ kinds: [1851], '#a': [N], since: 0, limit: 10 }]
    await query(since)
    await query(since)
    assert.equal(relay.requests.length, 2)
  })
})

describe('a read of a whole kind answers later reads of that kind (APP-6)', () => {
  const N = addressOf(north)
  const S = addressOf(south)
  const ALL = [{ kinds: [1851] }]

  /** Like `Relay.queryAll`: every filter answered to its end, whatever its `limit`. */
  function pagingRelay(events) {
    const base = countingRelay(events)
    const query = (filters) => base.query(filters.map(({ limit, ...rest }) => rest))
    return { ...base, query }
  }

  test('the agent’s workspace read, then the listing beside it: each change comes from the relay once', async () => {
    const relay = pagingRelay(world())
    const query = createLoadQuery(relay.query, { paged: true })
    await query(ALL)
    await listFolders(query)
    for (const c of changes) assert.equal(relay.timesSent(c), 1, `change ${c.id} sent ${relay.timesSent(c)} times`)
  })

  test('a read by value after it is answered without the relay, and holds what the relay would send', async () => {
    const relay = countingRelay(world())
    const query = createLoadQuery(relay.query)
    await query([{ kinds: [1851], limit: 10 }])
    const byValue = await query([{ kinds: [1851], '#a': [N, S], limit: 10 }])
    assert.equal(relay.requests.length, 1)
    assert.deepEqual(byValue.map((e) => e.id).sort(), changes.slice(0, 4).map((e) => e.id).sort())
  })

  test('a read by value while it is in flight waits for it instead of asking', async () => {
    const relay = pagingRelay(world())
    let release
    const gate = new Promise((resolve) => (release = resolve))
    const query = createLoadQuery((filters) => gate.then(() => relay.query(filters)), { paged: true })
    const both = Promise.all([query(ALL), query([{ kinds: [1851], '#a': [S], limit: 500 }])])
    release()
    const [, south] = await both
    assert.equal(relay.requests.length, 1)
    assert.deepEqual(south.map((e) => e.id).sort(), changes.slice(2, 4).map((e) => e.id).sort())
  })

  test('through a query that pages to the end, a read longer than its limit still counts', async () => {
    const relay = pagingRelay(world())
    const query = createLoadQuery(relay.query, { paged: true })
    await query([{ kinds: [1851], limit: 2 }])
    const again = await query([{ kinds: [1851], '#a': [N], limit: 1 }])
    assert.equal(relay.requests.length, 1)
    assert.equal(again.length, 2)
  })

  test('through one page, a whole-kind read that filled it answers nothing: the relay is asked again', async () => {
    const relay = countingRelay(world())
    const query = createLoadQuery(relay.query)
    await query([{ kinds: [1851], limit: 5 }]) // five changes exist: the page is full, so more may
    const byValue = await query([{ kinds: [1851], '#a': [N], limit: 10 }])
    assert.equal(relay.requests.length, 2)
    assert.equal(byValue.length, 2)
  })

  test('a read of another kind still goes to the relay', async () => {
    const relay = countingRelay(world())
    const query = createLoadQuery(relay.query)
    await query(ALL)
    await query([{ kinds: [KIND_FOLDER_STATE], '#d': [APIARY], limit: 10 }])
    assert.equal(relay.requests.length, 2)
  })
})

describe('a read in flight is joined, not repeated', () => {
  /** A relay whose answers wait until released, so two asks overlap. */
  function heldRelay(events) {
    const base = countingRelay(events)
    const waiting = []
    const query = (filters) =>
      new Promise((resolve, reject) => waiting.push({ release: () => base.query(filters).then(resolve), refuse: () => reject(new Error('rate-limited')) }))
    return { ...base, query, waiting }
  }
  const N = addressOf(north)

  test('two asks for the same changes at once send one request', async () => {
    const relay = heldRelay(world())
    const query = createLoadQuery(relay.query)
    const both = Promise.all([query([{ kinds: [1851], '#a': [N], limit: 10 }]), query([{ kinds: [1851], '#a': [N], limit: 10 }])])
    assert.equal(relay.waiting.length, 1)
    relay.waiting[0].release()
    const [a, b] = await both
    assert.equal(a.length, 2)
    assert.deepEqual(b, a)
  })

  test('two identical asks of another shape at once send one request', async () => {
    const relay = heldRelay(world())
    const query = createLoadQuery(relay.query)
    const roots = [{ kinds: [HIVE], authors: [KEEPER], '#d': ['north'], limit: 1 }]
    const both = Promise.all([query(roots), query(roots)])
    assert.equal(relay.waiting.length, 1)
    relay.waiting[0].release()
    const [a, b] = await both
    assert.deepEqual(a.map((e) => e.id), [north.id])
    assert.deepEqual(b, a)
  })

  test('a refused read fails everyone waiting on it, and the next ask goes to the relay again', async () => {
    const relay = heldRelay(world())
    const query = createLoadQuery(relay.query)
    const first = query([{ kinds: [1851], '#a': [N], limit: 10 }])
    const joined = query([{ kinds: [1851], '#a': [N], limit: 10 }])
    assert.equal(relay.waiting.length, 1)
    relay.waiting[0].refuse()
    await assert.rejects(first, /rate-limited/)
    await assert.rejects(joined, /rate-limited/)
    const retry = query([{ kinds: [1851], '#a': [N], limit: 10 }])
    assert.equal(relay.waiting.length, 2)
    relay.waiting[1].release()
    assert.equal((await retry).length, 2)
  })
})

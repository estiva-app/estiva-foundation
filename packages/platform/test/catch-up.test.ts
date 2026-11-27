/**
 * THE-5 — a copy catches a question up with NIP-77, and falls back to asking again.
 *
 * The fake relay keeps its own events and who may read them, answers a plain
 * read as NIP-01 does (newest first, at most 1,000), and answers a
 * reconciliation with the negentropy relay side over the set that read would
 * return whole. Each test compares the caught-up copy with a fresh copy that
 * simply asked: they must end equal, and the catch-up must have downloaded only
 * what changed.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { Negentropy, NegentropySet, type ReconcileOutcome, type SignedEvent } from '@estiva-app/protocol'
import {
  catchUp,
  createEventSnapshot,
  matchesSnapshotFilter,
  memorySnapshotStorage,
  relaySpeaksNip77,
  type CatchUpRelay,
  type SnapshotFilter,
  type SnapshotTimers,
} from '../dist/index.js'

let n = 0
function ev(kind: number, created_at: number, tags: string[][] = [], pubkey = 'a'.repeat(64)): SignedEvent {
  n += 1
  return { id: n.toString(16).padStart(64, '0'), kind, created_at, tags, pubkey, content: `#${n}`, sig: '0'.repeat(128) }
}

const still: SnapshotTimers = { setTimeout: () => 1, clearTimeout: () => {} }

async function copy() {
  const snap = createEventSnapshot({ storage: memorySnapshotStorage(), scope: `wss://r|${'a'.repeat(64)}`, version: 1, timers: still })
  await snap.ready
  return snap
}

const coordinate = (e: SignedEvent) =>
  e.kind >= 30_000 && e.kind < 40_000 ? `${e.kind}:${e.pubkey}:${e.tags.find((t) => t[0] === 'd')?.[1] ?? ''}` : e.id

/** A file's change (SPEC §6.13): `a` names the file, `field` the field and its value. */
const CHANGE = 1851
const FILE = 30_840

function fakeRelay(
  options: {
    speaks?: boolean
    maxSet?: number
    teams?: Set<string>
    refusesLists?: boolean
    /** The relay's quota refusals, one per reconciliation, in order, before it answers again (THE-15). */
    quota?: string[]
  } = {},
) {
  const stored: SignedEvent[] = []
  const readable = options.teams ?? new Set<string>()
  const sent = { events: 0, reconciles: 0, queries: 0, blocked: 0 }
  /** What the relay holds now: the newest version of each addressable file, minus what this person cannot read. */
  function current(): SignedEvent[] {
    const newest = new Map<string, SignedEvent>()
    for (const e of stored) {
      const key = coordinate(e)
      const held = newest.get(key)
      if (!held || held.created_at < e.created_at) newest.set(key, e)
    }
    return [...newest.values()].filter((e) => {
      const team = e.tags.find((t) => t[0] === 'h')?.[1]
      return team === undefined || readable.has(team)
    })
  }
  const byRelayOrder = (a: SignedEvent, b: SignedEvent) => b.created_at - a.created_at || (a.id < b.id ? -1 : 1)
  /**
   * A list read: the first records the filter matches (newest first, cut at its `limit` and the
   * relay's page), each with its newest change of every field; a file whose `deleted` is set is left out.
   */
  function listed(filter: SnapshotFilter): SignedEvent[] {
    const { fields: _fields, limit, ...question } = filter
    const now = current()
    const roots = now
      .filter((e) => e.kind !== CHANGE && matchesSnapshotFilter(question, e))
      .sort(byRelayOrder)
      .slice(0, Math.min(typeof limit === 'number' ? limit : Infinity, 1_000))
    return roots.flatMap((root) => {
      const newest = new Map<string, SignedEvent>()
      for (const c of now) {
        if (c.kind !== CHANGE || !c.tags.some((t) => t[0] === 'a' && t[1] === coordinate(root))) continue
        const field = c.tags.find((t) => t[0] === 'field')![1]!
        if ((newest.get(field)?.created_at ?? -1) < c.created_at) newest.set(field, c)
      }
      if (newest.get('deleted')?.tags.find((t) => t[0] === 'field')?.[2] === 'true') return []
      return [root, ...newest.values()]
    })
  }
  const answerTo = (filter: SnapshotFilter) =>
    filter.fields !== undefined ? listed(filter) : current().filter((e) => matchesSnapshotFilter(filter, e))
  const relay: CatchUpRelay = {
    speaksNip77: () => options.speaks ?? true,
    async reconcile(filter, held): Promise<ReconcileOutcome> {
      sent.reconciles += 1
      const refusal = options.quota?.shift()
      if (refusal !== undefined) return { ok: false, reason: 'refused', message: refusal }
      if (filter.fields !== undefined && options.refusesLists) {
        return { ok: false, reason: 'refused', message: 'invalid: a reconciliation does not take the filter key "fields"' }
      }
      const set = answerTo(filter)
      if (set.length > (options.maxSet ?? Infinity)) {
        sent.blocked += 1
        return { ok: false, reason: 'blocked', message: `blocked: more than ${options.maxSet}`, max: options.maxSet! }
      }
      const relaySet = new NegentropySet()
      for (const e of set) relaySet.insert(e.created_at, e.id)
      const relaySide = new Negentropy(relaySet, 0)
      const clientSet = new NegentropySet()
      for (const item of held) clientSet.insert(item.created_at, item.id)
      const client = new Negentropy(clientSet, 60_000)
      const need: string[] = []
      const have: string[] = []
      let message: string | null = client.initiate()
      while (message !== null) {
        message = client.reconcile(relaySide.reconcile(message, () => {}, () => {})!, (id) => have.push(id), (id) => need.push(id))
      }
      return { ok: true, need, have }
    },
    async query(filters) {
      sent.queries += 1
      const out = new Map<string, SignedEvent>()
      for (const filter of filters) {
        if (filter.fields !== undefined) {
          for (const e of listed(filter)) out.set(e.id, e)
          continue
        }
        const limit = Math.min(typeof filter.limit === 'number' ? filter.limit : Infinity, 1_000)
        for (const e of current().filter((e) => matchesSnapshotFilter(filter, e)).sort(byRelayOrder).slice(0, limit)) out.set(e.id, e)
      }
      sent.events += out.size
      return [...out.values()]
    },
  }
  return {
    relay,
    sent,
    readable,
    publish: (...events: SignedEvent[]) => stored.push(...events),
    remove: (id: string) => stored.splice(stored.findIndex((e) => e.id === id), 1),
  }
}

/** A copy that asked `filters` plainly of `relay` now: what a catch-up must end equal to. */
async function askedAgain(relay: CatchUpRelay, filters: SnapshotFilter[]) {
  const fresh = await copy()
  fresh.absorb(filters, await relay.query(filters))
  return filters.map((f) => fresh.held({ ...f, limit: undefined })!.map((e) => e.id).sort())
}

const heldIds = (snap: Awaited<ReturnType<typeof copy>>, filters: SnapshotFilter[]) =>
  filters.map((f) => snap.held({ ...f, limit: undefined })!.map((e) => e.id).sort())

function team(name: string, count: number, from = 1_000) {
  return Array.from({ length: count }, (_, i) => ev(9, from + i, [['h', name]]))
}

test('a new message, an edited file and a deleted message: only the new events are fetched, and the copy ends as if it asked again', async () => {
  const r = fakeRelay({ teams: new Set(['t1']) })
  const messages = team('t1', 300)
  const file = ev(30_023, 1_100, [['d', 'notes'], ['h', 't1']])
  r.publish(...messages, file)
  const filters = [{ kinds: [9, 30_023], '#h': ['t1'] }]
  const snap = await copy()
  snap.absorb(filters, await r.relay.query(filters))

  const added = ev(9, 2_000, [['h', 't1']])
  const edited = ev(30_023, 2_001, [['d', 'notes'], ['h', 't1']])
  r.publish(added, edited)
  r.remove(messages[10]!.id)
  r.sent.events = 0

  const result = await catchUp(snap, filters, r.relay)
  assert.equal(r.sent.events, 2, 'downloaded the new message and the new version of the file, nothing else')
  assert.equal(result.fetched, 2)
  assert.equal(result.dropped, 2, 'the deleted message and the file version it replaced')
  assert.deepEqual(heldIds(snap, filters), await askedAgain(r.relay, filters))
  assert.ok(result.events.some((e) => e.id === edited.id) && !result.events.some((e) => e.id === file.id))
  assert.ok(!result.events.some((e) => e.id === messages[10]!.id))
})

test('a team the person lost is dropped from the copy on the next catch-up', async () => {
  const r = fakeRelay({ teams: new Set(['t1', 't2']) })
  r.publish(...team('t1', 40), ...team('t2', 40, 5_000))
  const filters = [{ kinds: [9], '#h': ['t1', 't2'] }]
  const snap = await copy()
  snap.absorb(filters, await r.relay.query(filters))
  assert.equal(snap.held(filters[0]!)!.length, 80)

  r.readable.delete('t2')
  r.sent.events = 0
  const result = await catchUp(snap, filters, r.relay)
  assert.equal(r.sent.events, 0)
  assert.equal(result.dropped, 40)
  assert.ok(snap.held(filters[0]!)!.every((e) => e.tags.some((t) => t[0] === 'h' && t[1] === 't1')))
  assert.deepEqual(heldIds(snap, filters), await askedAgain(r.relay, filters))
})

test('a relay that does not speak NIP-77 is asked again, and the copy ends the same', async () => {
  const r = fakeRelay({ speaks: false, teams: new Set(['t1']) })
  const messages = team('t1', 50)
  r.publish(...messages)
  const filters = [{ kinds: [9], '#h': ['t1'] }]
  const snap = await copy()
  snap.absorb(filters, await r.relay.query(filters))
  r.publish(ev(9, 3_000, [['h', 't1']]))
  r.remove(messages[0]!.id)

  const result = await catchUp(snap, filters, r.relay)
  assert.equal(r.sent.reconciles, 0)
  assert.equal(result.asked, 1)
  assert.deepEqual(heldIds(snap, filters), await askedAgain(r.relay, filters))
})

test('a catch-up refused for the person’s quota waits the relay’s stated pause and compares again, fetching only what changed', async () => {
  for (const [refusal, waited] of [
    ['rate-limited: quota exceeded; retry in 2s', 2_000],
    // The window just rolled over: still a moment, never none.
    ['rate-limited: quota exceeded; retry in 0s', 1_000],
  ] as const) {
    const r = fakeRelay({ teams: new Set(['t1']), quota: [refusal] })
    const messages = team('t1', 50)
    r.publish(...messages)
    const filters = [{ kinds: [9], '#h': ['t1'] }]
    const snap = await copy()
    snap.absorb(filters, await r.relay.query(filters))
    r.publish(ev(9, 3_000, [['h', 't1']]))
    r.remove(messages[0]!.id)
    r.sent.queries = 0
    const waits: number[] = []

    const result = await catchUp(snap, filters, r.relay, { sleep: async (ms) => void waits.push(ms) })
    assert.deepEqual(waits, [waited], refusal)
    assert.equal(r.sent.reconciles, 2, 'compared again after the pause')
    assert.equal(result.asked, 0, 'never asked whole')
    assert.equal(result.reconciled, 1)
    assert.equal(result.fetched, 1, 'only the new message')
    assert.equal(result.dropped, 1, 'the deleted one left the copy')
    assert.deepEqual(heldIds(snap, filters), await askedAgain(r.relay, filters))
  }
})

test('a quota refusal with no stated pause, a long one, or a second one is asked whole without waiting longer', async () => {
  for (const [quota, waited] of [
    [['rate-limited: quota exceeded'], []],
    [['rate-limited: quota exceeded; retry in 12s'], []],
    [['rate-limited: quota exceeded; retry in 1s', 'rate-limited: quota exceeded; retry in 1s'], [1_000]],
  ] as const) {
    const r = fakeRelay({ teams: new Set(['t1']), quota: [...quota] })
    r.publish(...team('t1', 50))
    const filters = [{ kinds: [9], '#h': ['t1'] }]
    const snap = await copy()
    snap.absorb(filters, await r.relay.query(filters))
    r.publish(ev(9, 3_000, [['h', 't1']]))
    const waits: number[] = []

    const result = await catchUp(snap, filters, r.relay, { sleep: async (ms) => void waits.push(ms) })
    assert.equal(result.asked, 1, quota.join(' / '))
    assert.deepEqual(waits, waited, quota.join(' / '))
    assert.deepEqual(heldIds(snap, filters), await askedAgain(r.relay, filters))
  }
})

test('a question split by time while the quota is spent never waits longer than the allowance in all', async () => {
  const r = fakeRelay({
    maxSet: 120,
    teams: new Set(['t1']),
    // Refused, then too big when compared again; each half refused once more.
    quota: ['rate-limited: quota exceeded; retry in 3s'],
  })
  r.publish(...team('t1', 400))
  const filters = [{ kinds: [9], '#h': ['t1'] }]
  const snap = await copy()
  snap.absorb(filters, await r.relay.query(filters))
  const relay: CatchUpRelay = {
    ...r.relay,
    async reconcile(filter, held) {
      const outcome = await r.relay.reconcile(filter, held)
      // After the first wait, the halves of the split are refused for quota too.
      return filter.since !== undefined ? { ok: false, reason: 'refused', message: 'rate-limited: quota exceeded; retry in 3s' } : outcome
    },
  }
  const waits: number[] = []

  const result = await catchUp(snap, filters, relay, { now: () => 2_000_000, sleep: async (ms) => void waits.push(ms) })
  assert.deepEqual(waits, [3_000], 'one 3 s wait; a second would pass the 5 s allowance')
  assert.equal(result.asked, 1)
  assert.deepEqual(heldIds(snap, filters), await askedAgain(r.relay, filters))
})

test('a question the relay calls too big is split by time and still ends whole', async () => {
  const r = fakeRelay({ maxSet: 120, teams: new Set(['t1']) })
  r.publish(...team('t1', 400))
  const filters = [{ kinds: [9], '#h': ['t1'] }]
  const snap = await copy()
  snap.absorb(filters, await r.relay.query(filters))
  r.publish(ev(9, 1_500, [['h', 't1']]))

  const result = await catchUp(snap, filters, r.relay, { now: () => 2_000_000 })
  assert.ok(r.sent.blocked > 0)
  assert.equal(result.reconciled, 1)
  assert.equal(result.fetched, 1)
  assert.deepEqual(heldIds(snap, filters), await askedAgain(r.relay, filters))
})

test('a windowed question catches up its window and answers its newest events', async () => {
  const r = fakeRelay({ teams: new Set(['t1']) })
  r.publish(...team('t1', 200))
  const filters = [{ kinds: [9], '#h': ['t1'], limit: 50 }]
  const snap = await copy()
  snap.absorb(filters, await r.relay.query(filters))
  const added = [ev(9, 4_000, [['h', 't1']]), ev(9, 4_001, [['h', 't1']])]
  r.publish(...added)
  r.sent.events = 0

  const result = await catchUp(snap, filters, r.relay)
  assert.equal(r.sent.events, 2)
  assert.equal(result.reconciled, 1)
  assert.deepEqual(
    result.events.map((e) => e.id),
    (await r.relay.query(filters)).map((e) => e.id),
  )
})

test('a windowed question whose window lost messages never answers an older message the relay did not compare', async () => {
  const r = fakeRelay({ teams: new Set(['t1']) })
  const messages = team('t1', 200)
  r.publish(...messages)
  const filters = [{ kinds: [9], '#h': ['t1'], limit: 50 }]
  const snap = await copy()
  // Scrolled back: the copy holds all 200, far past the window.
  snap.absorb([{ kinds: [9], '#h': ['t1'] }], messages)
  // While away, five in the window were deleted, and the five just below it too.
  for (const gone of [...messages.slice(195), ...messages.slice(145, 150)]) r.remove(gone.id)

  const result = await catchUp(snap, filters, r.relay)
  assert.deepEqual(
    result.events.map((e) => e.id),
    (await r.relay.query(filters)).map((e) => e.id),
  )
})

test('a question with almost nothing held is simply asked again', async () => {
  const r = fakeRelay({ teams: new Set(['t1']) })
  r.publish(...team('t1', 3))
  const filters = [{ kinds: [9], '#h': ['t1'] }]
  const snap = await copy()
  snap.absorb(filters, await r.relay.query(filters))
  const result = await catchUp(snap, filters, r.relay)
  assert.equal(r.sent.reconciles, 0)
  assert.equal(result.asked, 1)
})

test('a question past the relay page is caught up whole, where asking again could not be', async () => {
  const r = fakeRelay({ teams: new Set(['t1']) })
  const messages = team('t1', 1_500)
  r.publish(...messages)
  const filters = [{ kinds: [9], '#h': ['t1'] }]
  const snap = await copy()
  // What an app paging through it held: every one of the 1,500.
  snap.absorb([{ ...filters[0], until: 999_999 }], messages)
  r.remove(messages[5]!.id)
  r.publish(ev(9, 9_000, [['h', 't1']]))
  r.sent.events = 0

  const result = await catchUp(snap, filters, r.relay)
  assert.equal(r.sent.events, 1)
  assert.equal(snap.held(filters[0]!)!.length, 1_500)
  assert.ok(!snap.held(filters[0]!)!.some((e) => e.id === messages[5]!.id))
  assert.equal(result.events.length, 1_500)
})

test('a relay whose information document cannot be read is asked plainly, not failed', async () => {
  const r = fakeRelay({ teams: new Set(['t1']) })
  r.publish(...team('t1', 40))
  const filters = [{ kinds: [9], '#h': ['t1'] }]
  const snap = await copy()
  snap.absorb(filters, await r.relay.query(filters))
  const broken: CatchUpRelay = { ...r.relay, speaksNip77: () => Promise.reject(new Error('NIP-11 unreachable')) }
  const result = await catchUp(snap, filters, broken)
  assert.equal(result.asked, 1)
  assert.equal(result.events.length, 40)
})

test('a split question keeps a held event dated ahead of this device clock', async () => {
  const r = fakeRelay({ maxSet: 120, teams: new Set(['t1']) })
  const ahead = ev(9, 2_000_100, [['h', 't1']])
  r.publish(...team('t1', 400), ahead)
  const filters = [{ kinds: [9], '#h': ['t1'] }]
  const snap = await copy()
  snap.absorb([{ ...filters[0], until: 9_999_999 }], await r.relay.query([{ ...filters[0], limit: 1_000 }]))
  await catchUp(snap, filters, r.relay, { now: () => 2_000_000 * 1000 })
  assert.ok(snap.held(filters[0]!)!.some((e) => e.id === ahead.id), 'still held')
})

test('the relay information document says whether it speaks NIP-77', () => {
  assert.equal(relaySpeaksNip77({ supported_nips: [1, 11, 77] }), true)
  assert.equal(relaySpeaksNip77({ supported_nips: [1, 11] }), false)
  assert.equal(relaySpeaksNip77(null), false)
})

/* THE-9 — a file list (SPEC §6.13, `"fields": "newest"`) catches up from the ids of its last answer. */

const OWNER = 'a'.repeat(64)
const teamOf = (e: SignedEvent) => e.tags.find((t) => t[0] === 'h')![1]!
const change = (file: SignedEvent, field: string, value: string, at: number) =>
  ev(CHANGE, at, [['a', coordinate(file)], ['h', teamOf(file)], ['field', field, value]])
const listOf = (name: string): SnapshotFilter => ({ fields: 'newest', kinds: [FILE], '#h': [name] })
const ids = (events: SignedEvent[]) => events.map((e) => e.id).sort()

/** `count` files in a team, each with a title; published to `r`. */
function filesIn(r: ReturnType<typeof fakeRelay>, name: string, count: number, from = 1_000) {
  const roots = Array.from({ length: count }, (_, i) => ev(FILE, from + i, [['d', `${name}-${i}`], ['h', name]]))
  const titles = roots.map((root, i) => change(root, 'title', `File ${i}`, from + 500 + i))
  r.publish(...roots, ...titles)
  return { roots, titles }
}

/** What the relay's list read answers now, without counting it as a download. */
async function listedNow(r: ReturnType<typeof fakeRelay>, list: SnapshotFilter) {
  const before = { ...r.sent }
  const answer = await r.relay.query([list])
  Object.assign(r.sent, before)
  return ids(answer)
}

test('a file list catches up: nothing changed downloads nothing, a retitle fetches that change alone, a deleted file leaves the list', async () => {
  const r = fakeRelay({ teams: new Set(['t1']) })
  const { roots, titles } = filesIn(r, 't1', 20)
  const list = listOf('t1')
  const snap = await copy()
  snap.absorb([list], await r.relay.query([list]))

  r.sent.events = 0
  let result = await catchUp(snap, [list], r.relay)
  assert.equal(result.reconciled, 1, 'caught up, not asked again')
  assert.equal(r.sent.events, 0, 'nothing changed: nothing downloaded')
  assert.deepEqual(ids(result.events), await listedNow(r, list))

  const retitle = change(roots[3]!, 'title', 'Renamed', 3_000)
  r.publish(retitle)
  result = await catchUp(snap, [list], r.relay)
  assert.equal(r.sent.events, 1, 'only the new title was downloaded')
  assert.equal(result.dropped, 1, 'the title it replaced left the list')
  assert.ok(result.events.some((e) => e.id === retitle.id) && !result.events.some((e) => e.id === titles[3]!.id))
  assert.deepEqual(ids(result.events), await listedNow(r, list))
  assert.equal(snap.held({ ids: [titles[3]!.id] })?.length, 1, 'the replaced title is still a signed event the copy holds')

  r.sent.events = 0
  r.publish(change(roots[5]!, 'deleted', 'true', 3_001))
  result = await catchUp(snap, [list], r.relay)
  assert.equal(r.sent.events, 0, 'a deleted file is left out of the list: nothing to fetch')
  assert.ok(!result.events.some((e) => e.id === roots[5]!.id || e.id === titles[5]!.id), 'the deleted file and its title are out of the list')
  assert.deepEqual(ids(result.events), await listedNow(r, list))
  assert.equal(snap.held({ ids: [roots[5]!.id] })?.length, 1, 'and still readable by id')

  r.sent.events = 0
  result = await catchUp(snap, [list], r.relay)
  assert.equal(r.sent.events, 0, 'the next catch-up starts from the list it ended with')
  assert.equal(result.fetched + result.dropped, 0)
})

test('a file list reopened from storage catches up without downloading it again', async () => {
  const r = fakeRelay({ teams: new Set(['t1']) })
  filesIn(r, 't1', 30)
  const list = listOf('t1')
  const storage = memorySnapshotStorage()
  const open = async () => {
    const snap = createEventSnapshot({ storage, scope: `wss://r|${OWNER}`, version: 1, timers: still })
    await snap.ready
    return snap
  }
  const first = await open()
  first.absorb([list], await r.relay.query([list]))
  await first.flush()
  // A save of events alone, after, keeps the stored lists.
  first.absorb([{ kinds: [9], '#h': ['t1'] }], [ev(9, 4_000, [['h', 't1']])])
  await first.flush()

  const reopened = await open()
  r.sent.events = 0
  const result = await catchUp(reopened, [list], r.relay)
  assert.equal(result.reconciled, 1)
  assert.equal(r.sent.events, 0)
  assert.deepEqual(ids(result.events), await listedNow(r, list))
})

test('one answer to several lists is split per list: a file to each list it matches, a change to its file’s', async () => {
  const r = fakeRelay({ teams: new Set(['t1', 't2']) })
  filesIn(r, 't1', 20)
  filesIn(r, 't2', 20, 5_000)
  r.publish(...team('t1', 5))
  const [one, two] = [listOf('t1'), listOf('t2')]
  const both = [one, two, { kinds: [9], '#h': ['t1'] }]
  const snap = await copy()
  snap.absorb(both, await r.relay.query(both))

  r.sent.events = 0
  for (const list of [one, two]) {
    const result = await catchUp(snap, [list], r.relay)
    assert.equal(result.reconciled, 1)
    assert.equal(result.fetched + result.dropped, 0, 'held exactly what the relay lists')
    assert.deepEqual(ids(result.events), await listedNow(r, list))
  }
  assert.equal(r.sent.events, 0)
})

test('a file list with a limit is caught up only when the limit cannot cut it', async () => {
  const r = fakeRelay({ teams: new Set(['t1']) })
  const { roots } = filesIn(r, 't1', 20)
  const d = roots.map((root) => root.tags.find((t) => t[0] === 'd')![1]!)
  const whole: SnapshotFilter = { fields: 'newest', kinds: [FILE], authors: [OWNER], '#d': d, limit: d.length }
  const cut: SnapshotFilter = { ...whole, limit: d.length - 1 }
  const snap = await copy()
  snap.absorb([whole], await r.relay.query([whole]))
  snap.absorb([cut], await r.relay.query([cut]))

  r.sent.reconciles = 0
  assert.equal((await catchUp(snap, [whole], r.relay)).reconciled, 1, 'interop’s shape: a limit of one per address cannot cut')
  const result = await catchUp(snap, [cut], r.relay)
  assert.equal(result.reconciled, 0)
  assert.equal(result.asked, 1, 'a limit that could cut it is asked plainly')
  assert.equal(r.sent.reconciles, 1)
})

test('past the most lists the copy remembers, the least recently answered is forgotten and asked plainly', async () => {
  const r = fakeRelay({ teams: new Set(['t1', 't2', 't3']) })
  for (const [i, name] of ['t1', 't2', 't3'].entries()) filesIn(r, name, 20, 1_000 + i * 100)
  const snap = createEventSnapshot({ storage: memorySnapshotStorage(), scope: `wss://r|${OWNER}`, version: 1, timers: still, maxLists: 2 })
  await snap.ready
  for (const name of ['t1', 't2']) snap.absorb([listOf(name)], await r.relay.query([listOf(name)]))
  await catchUp(snap, [listOf('t1')], r.relay) // t1 answered again: now t2 is the oldest
  snap.absorb([listOf('t3')], await r.relay.query([listOf('t3')]))

  assert.equal(snap.held(listOf('t2')), null, 'the least recently answered list is forgotten')
  assert.ok(snap.held(listOf('t1')) && snap.held(listOf('t3')))
  const result = await catchUp(snap, [listOf('t2')], r.relay)
  assert.equal(result.asked, 1, 'and asked plainly')
  assert.deepEqual(ids(result.events), await listedNow(r, listOf('t2')))
})

test('a relay that refuses a file list, or calls it too big, is asked plainly, never split by time', async () => {
  for (const relayOptions of [{ refusesLists: true }, { maxSet: 10 }]) {
    const r = fakeRelay({ teams: new Set(['t1']), ...relayOptions })
    const { roots } = filesIn(r, 't1', 20)
    const list = listOf('t1')
    const snap = await copy()
    snap.absorb([list], await r.relay.query([list]))
    r.publish(change(roots[0]!, 'title', 'Renamed', 3_000))

    r.sent.reconciles = 0
    const result = await catchUp(snap, [list], r.relay)
    assert.equal(r.sent.reconciles, 1, `${JSON.stringify(relayOptions)}: one reconciliation, not split`)
    assert.equal(result.asked, 1)
    assert.deepEqual(ids(result.events), await listedNow(r, list))
    // The plain answer is remembered: the copy's list follows it.
    assert.deepEqual(ids(snap.held(list)!), await listedNow(r, list))
  }
})

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

function fakeRelay(options: { speaks?: boolean; maxSet?: number; teams?: Set<string> } = {}) {
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
  const relay: CatchUpRelay = {
    speaksNip77: () => options.speaks ?? true,
    async reconcile(filter, held): Promise<ReconcileOutcome> {
      sent.reconciles += 1
      const set = current().filter((e) => matchesSnapshotFilter(filter, e))
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

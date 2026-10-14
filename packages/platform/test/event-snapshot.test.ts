/**
 * `createEventSnapshot` — the copy on the device a reload draws from (PEE-2).
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import type { SignedEvent } from '@estiva-app/protocol'
import {
  createEventSnapshot,
  memorySnapshotStorage,
  SNAPSHOT_SEEN_REFRESH_MS,
  snapshotFilterKey,
  snapshotScope,
  type SnapshotTimers,
} from '../dist/index.js'

let n = 0
function ev(kind: number, created_at: number, tags: string[][] = [], pubkey = 'a'.repeat(64), content = ''): SignedEvent {
  n += 1
  return { id: n.toString(16).padStart(64, '0'), kind, created_at, tags, pubkey, content, sig: '0'.repeat(128) }
}

/** Timers that never fire on their own: `flush()` is the test's save. */
const still: SnapshotTimers = { setTimeout: () => 1, clearTimeout: () => {} }

async function fresh(storage = memorySnapshotStorage(), version = 1) {
  const snap = createEventSnapshot({ storage, scope: `wss://r|${'a'.repeat(64)}`, version, timers: still })
  await snap.ready
  return { snap, storage }
}

test('a filter never answered by the relay is not answered by the copy', async () => {
  const { snap } = await fresh()
  assert.equal(snap.answer([{ kinds: [9] }]), null)
  snap.absorb([{ kinds: [9] }], [])
  assert.deepEqual(snap.answer([{ kinds: [9] }]), [])
  assert.equal(snap.answer([{ kinds: [9] }, { kinds: [1] }]), null, 'every filter must have been asked')
  assert.equal(snap.answer([{ kinds: [9], search: 'x' }]), null)
})

test('since and until are the clock, not the question', () => {
  assert.equal(snapshotFilterKey({ kinds: [9, 1], since: 1 }), snapshotFilterKey({ until: 5, kinds: [1, 9] }))
  assert.notEqual(snapshotFilterKey({ kinds: [9], limit: 1 }), snapshotFilterKey({ kinds: [9], limit: 2 }))
})

test('answers as the relay would: matched, newest first, cut at limit, across filters once', async () => {
  const { snap } = await fresh()
  const a = ev(9, 10, [['h', 'g1']])
  const b = ev(9, 20, [['h', 'g1']])
  const c = ev(9, 30, [['h', 'g2']])
  snap.absorb([{ kinds: [9], '#h': ['g1', 'g2'], limit: 10 }], [a, b, c])
  // The answer was whole (3 under a limit of 10), so a narrower list or a smaller limit is answered from it.
  assert.deepEqual(snap.answer([{ kinds: [9], '#h': ['g1'], limit: 1 }])?.map((e) => e.created_at), [20])
  assert.deepEqual(snap.answer([{ kinds: [9], '#h': ['g1', 'g2'], limit: 2 }])?.map((e) => e.created_at), [30, 20])
  assert.equal(snap.answer([{ kinds: [9], '#h': ['g1', 'g3'], limit: 10 }]), null, 'a value never asked')
  assert.deepEqual(snap.answer([{ kinds: [9], '#h': ['g1', 'g2'], limit: 10, since: 15 }])?.map((e) => e.created_at), [30, 20])
})

test('a filter by kinds or ids sees only what is held now: a dropped or replaced event is gone from both', async () => {
  const { snap } = await fresh()
  const older = ev(30078, 10, [['d', 'list']])
  const message = ev(9, 20, [['h', 'g1']])
  const gone = ev(9, 30, [['h', 'g1']])
  snap.absorb([{ kinds: [30078], authors: ['a'.repeat(64)] }, { kinds: [9], '#h': ['g1'] }], [older, message, gone])
  snap.absorb([{ ids: [message.id, gone.id] }], [message, gone])
  // The relay no longer has `gone`, and the list has a newer version.
  const newer = ev(30078, 40, [['d', 'list']])
  snap.absorb([{ kinds: [9], '#h': ['g1'] }, { kinds: [30078], authors: ['a'.repeat(64)] }], [message, newer])
  assert.deepEqual(snap.answer([{ kinds: [9], '#h': ['g1'] }])?.map((e) => e.id), [message.id])
  assert.deepEqual(snap.answer([{ ids: [message.id, gone.id] }])?.map((e) => e.id), [message.id])
  assert.deepEqual(snap.answer([{ kinds: [30078], authors: ['a'.repeat(64)] }])?.map((e) => e.id), [newer.id])
  assert.deepEqual(snap.answer([{ kinds: [9, 30078], '#h': ['g1'] }]), null, 'a filter never asked')
})

test('a tag value other kinds carry too is judged by the whole filter, whichever list it is looked up by', async () => {
  const { snap } = await fresh()
  const message = ev(9, 10, [['h', 'g1'], ['p', 'b'.repeat(64)]])
  const edit = ev(40003, 20, [['h', 'g1'], ['p', 'b'.repeat(64)]])
  const other = ev(9, 30, [['h', 'g2'], ['p', 'b'.repeat(64)]])
  snap.absorb([{ kinds: [9, 40003], '#h': ['g1', 'g2'] }, { kinds: [9], '#p': ['b'.repeat(64)] }], [message, edit, other])
  // Covered by its kinds, the `#h` list as asked: the edit carries g1 and g2's tag too, and is left out by kind.
  assert.deepEqual(snap.answer([{ kinds: [9], '#h': ['g1', 'g2'] }])?.map((e) => e.id), [other.id, message.id])
  // Covered by its `#h` list: the message in g2 is left out by tag.
  assert.deepEqual(snap.answer([{ kinds: [9, 40003], '#h': ['g1'] }])?.map((e) => e.id), [edit.id, message.id])
  assert.equal(snap.answer([{ kinds: [9], '#h': ['g1'] }]), null, 'two lists differ from any answered filter: not covered')
  assert.deepEqual(snap.answer([{ kinds: [9], '#p': ['b'.repeat(64)] }])?.map((e) => e.id), [other.id, message.id])
})

test('what the relay no longer sends is dropped: a deletion, a lost Folder', async () => {
  const { snap } = await fresh()
  const kept = ev(9, 10, [['h', 'g1']])
  const deleted = ev(9, 20, [['h', 'g1']])
  const filter = { kinds: [9], '#h': ['g1'] }
  snap.absorb([filter], [kept, deleted])
  snap.absorb([filter], [kept])
  assert.deepEqual(snap.answer([filter])?.map((e) => e.id), [kept.id])
  snap.absorb([filter], [])
  assert.deepEqual(snap.answer([filter]), [], 'an empty answer is lost access: nothing is kept')
})

test('an answer cut by its limit judges only the window it covers', async () => {
  const { snap } = await fresh()
  const old = ev(9, 5, [['h', 'g']])
  const mid = ev(9, 10, [['h', 'g']])
  const gone = ev(9, 15, [['h', 'g']])
  const top = ev(9, 20, [['h', 'g']])
  snap.absorb([{ kinds: [9], '#h': ['g'] }], [old, mid, gone, top])
  snap.absorb([{ kinds: [9], '#h': ['g'], limit: 2 }], [top, mid])
  assert.deepEqual(
    snap.answer([{ kinds: [9], '#h': ['g'] }])?.map((e) => e.created_at),
    [20, 10, 5],
    'the older one is below the window and stays; the one inside it is gone',
  )
})

test('a kind:5 drops what its own author signed, and nobody else’s', async () => {
  const { snap } = await fresh()
  const mine = ev(9, 10, [['h', 'g']], 'b'.repeat(64))
  const theirs = ev(9, 11, [['h', 'g']], 'c'.repeat(64))
  snap.absorb([{ kinds: [9], '#h': ['g'] }], [mine, theirs])
  const deletion = ev(5, 12, [['e', mine.id], ['e', theirs.id]], 'b'.repeat(64))
  snap.absorb([{ kinds: [5], '#e': [mine.id, theirs.id] }], [deletion])
  assert.deepEqual(snap.answer([{ kinds: [9], '#h': ['g'] }])?.map((e) => e.id), [theirs.id])
})

test('a replaceable event keeps only its newest', async () => {
  const { snap } = await fresh()
  const older = ev(30078, 10, [['d', 'blob']])
  const newer = ev(30078, 20, [['d', 'blob']])
  const filter = { kinds: [30078], '#d': ['blob'] }
  snap.absorb([{ kinds: [30078] }], [newer])
  snap.absorb([{ kinds: [30078], authors: ['x'] }], [older])
  assert.deepEqual(snap.answer([{ kinds: [30078] }])?.map((e) => e.id), [newer.id])
  snap.absorb([filter], [newer])
  assert.deepEqual(snap.answer([filter])?.map((e) => e.id), [newer.id])
})

test('survives a reload, plaintexts included; another version is dropped unread', async () => {
  const { snap, storage } = await fresh()
  const blob = ev(30078, 10, [['d', 'open-work']], 'a'.repeat(64), 'cipher')
  snap.absorb([{ kinds: [30078], '#d': ['open-work'] }], [blob])
  snap.keepPlaintext('cipher', '{"entries":[]}')
  await snap.flush()

  const again = (await fresh(storage)).snap
  assert.deepEqual(again.answer([{ kinds: [30078], '#d': ['open-work'] }])?.map((e) => e.id), [blob.id])
  assert.equal(again.plaintextOf('cipher'), '{"entries":[]}')

  const bumped = (await fresh(storage, 2)).snap
  assert.equal(bumped.answer([{ kinds: [30078], '#d': ['open-work'] }]), null)
  assert.equal(bumped.size(), 0)
})

test('a plaintext kept before its event arrives is kept with it', async () => {
  const { snap } = await fresh()
  snap.keepPlaintext('cipher', 'text')
  snap.absorb([{ kinds: [30078] }], [ev(30078, 1, [['d', 'x']], 'a'.repeat(64), 'cipher')])
  assert.equal(snap.plaintextOf('cipher'), 'text')
})

test('past the cap the least recently seen go first', async () => {
  let clock = 0
  const storage = memorySnapshotStorage()
  const snap = createEventSnapshot({ storage, scope: 's', version: 1, maxEvents: 2, timers: still, now: () => ++clock })
  await snap.ready
  const a = ev(1, 1)
  const b = ev(1, 2)
  const c = ev(1, 3)
  snap.absorb([{ ids: [a.id] }], [a])
  snap.absorb([{ ids: [b.id] }], [b])
  snap.absorb([{ ids: [c.id] }], [c])
  assert.equal(snap.size(), 2)
  assert.equal(snap.answer([{ ids: [a.id] }])?.length, 0)
})

test('an unreadable store is no copy, not a failure', async () => {
  const storage = { ...memorySnapshotStorage(), load: async () => Promise.reject(new Error('refused')) }
  const snap = createEventSnapshot({ storage, scope: 's', version: 1, timers: still })
  await snap.ready
  assert.equal(snap.answer([{ kinds: [1] }]), null)
})

test('an answer taken in before the stored copy is read is applied over it, not under it', async () => {
  const storage = memorySnapshotStorage()
  const filter = { kinds: [9], '#h': ['g'] }
  const kept = ev(9, 10, [['h', 'g']])
  const deleted = ev(9, 20, [['h', 'g']])
  const first = createEventSnapshot({ storage, scope: 's', version: 1, timers: still })
  await first.ready
  first.absorb([filter], [kept, deleted])
  await first.flush()

  const next = createEventSnapshot({ storage, scope: 's', version: 1, timers: still })
  next.absorb([filter], [kept]) // before `ready`
  await next.ready
  assert.deepEqual(next.answer([filter])?.map((e) => e.id), [kept.id])
})

test('a save that fails is asked again, removals included', async () => {
  const storage = memorySnapshotStorage()
  let refuse = false
  const flaky = { ...storage, save: (scope: string, change: Parameters<typeof storage.save>[1]) => (refuse ? Promise.reject(new Error('quota')) : storage.save(scope, change)) }
  const snap = createEventSnapshot({ storage: flaky, scope: 's', version: 1, timers: still })
  await snap.ready
  const filter = { kinds: [9], '#h': ['g'] }
  const gone = ev(9, 20, [['h', 'g']])
  snap.absorb([filter], [gone])
  await snap.flush()
  refuse = true
  snap.absorb([filter], [])
  await snap.flush()
  refuse = false
  await snap.flush()
  assert.deepEqual(storage.records.get('s')?.events, [])
})

test('an event held already and unchanged is not written again until its last-seen time is an hour old (PEE-4)', async () => {
  const storage = memorySnapshotStorage()
  const puts: number[] = []
  const counting = { ...storage, save: (scope: string, change: Parameters<typeof storage.save>[1]) => (puts.push(change.put.length), storage.save(scope, change)) }
  let clock = 1_000
  const snap = createEventSnapshot({ storage: counting, scope: 's', version: 1, timers: still, now: () => clock })
  await snap.ready
  const filter = { kinds: [9], '#h': ['g'] }
  const a = ev(9, 10, [['h', 'g']])
  const b = ev(9, 20, [['h', 'g']])
  snap.absorb([filter], [a])
  await snap.flush()
  clock += 1_000
  snap.absorb([filter], [a, b])
  await snap.flush()
  assert.deepEqual(puts, [1, 1], 'only the new event is written the second time')
  assert.equal(storage.records.get('s')?.events.find((s) => s.event.id === a.id)?.seenAt, 1_000, 'the last-seen time written stays')

  clock += SNAPSHOT_SEEN_REFRESH_MS
  snap.absorb([filter], [a, b])
  await snap.flush()
  assert.deepEqual(puts, [1, 1, 2], 'seen again an hour on: written with the new time')
  assert.equal(storage.records.get('s')?.events.find((s) => s.event.id === a.id)?.seenAt, clock)

  // Negative control: the answer is still taken in — a missing event is dropped as before.
  snap.absorb([filter], [b])
  assert.deepEqual(snap.answer([filter])?.map((e) => e.id), [b.id])
})

test('a kind:5 naming an address drops that file, if its author signed it', async () => {
  const { snap } = await fresh()
  const author = 'b'.repeat(64)
  const file = ev(30840, 10, [['d', 'topic']], author)
  snap.absorb([{ kinds: [30840] }], [file])
  snap.absorb([{ kinds: [5] }], [ev(5, 11, [['a', `30840:${author}:topic`]], 'c'.repeat(64))])
  assert.equal(snap.answer([{ kinds: [30840] }])?.length, 1, 'somebody else cannot delete it')
  snap.absorb([{ kinds: [5], authors: [author] }], [ev(5, 12, [['a', `30840:${author}:topic`]], author)])
  assert.deepEqual(snap.answer([{ kinds: [30840] }]), [])
})

test('close writes what changed; discard writes nothing', async () => {
  const storage = memorySnapshotStorage()
  const closing = createEventSnapshot({ storage, scope: 'a', version: 1, timers: still })
  await closing.ready
  closing.absorb([{ kinds: [1] }], [ev(1, 1)])
  closing.close()
  const discarding = createEventSnapshot({ storage, scope: 'b', version: 1, timers: still })
  await discarding.ready
  discarding.absorb([{ kinds: [1] }], [ev(1, 1)])
  discarding.discard()
  await new Promise((resolve) => setTimeout(resolve, 0))
  assert.equal(storage.records.get('a')?.events.length, 1)
  assert.equal(storage.records.has('b'), false)
})

test('after a sign-out, a copy opened before it writes nothing back — whichever tab it is in', async () => {
  const storage = memorySnapshotStorage()
  const before = createEventSnapshot({ storage, scope: 's', version: 1, timers: still })
  await before.ready
  before.absorb([{ kinds: [1] }], [ev(1, 1)])
  await storage.clear() // another tab signed out; this one never heard
  await before.flush()
  assert.equal(storage.records.size, 0)

  const after = createEventSnapshot({ storage, scope: 's', version: 1, timers: still })
  await after.ready
  after.absorb([{ kinds: [1] }], [ev(1, 2)])
  await after.flush()
  assert.equal(storage.records.get('s')?.events.length, 1, 'the next sign-in keeps a copy again')
})

test('a plaintext is kept only for the person’s own blob, never for someone else’s with the same ciphertext', async () => {
  const { snap, storage } = await fresh()
  snap.keepPlaintext('cipher', 'mine')
  const theirs = ev(30078, 5, [['d', 'x']], 'c'.repeat(64), 'cipher')
  snap.absorb([{ kinds: [30078], '#d': ['x'] }], [theirs])
  await snap.flush()
  const saved = [...storage.records.values()][0].events.find((s) => s.event.id === theirs.id)
  assert.equal(saved?.plaintext, undefined)
})

test('a cut answer does not judge events at its oldest second, which the relay may have held back', async () => {
  const { snap } = await fresh()
  const tie = ev(9, 10, [['h', 'g']])
  const top = ev(9, 20, [['h', 'g']])
  const atCut = ev(9, 10, [['h', 'g']])
  snap.absorb([{ kinds: [9], '#h': ['g'] }], [tie, top, atCut])
  snap.absorb([{ kinds: [9], '#h': ['g'], limit: 2 }], [top, tie])
  assert.equal(snap.answer([{ kinds: [9], '#h': ['g'] }])?.length, 3)
})

/** A change naming each address, as a set's archive read asks for them in groups. */
function changes(addresses: string[]) {
  return addresses.map((address, i) => ev(1851, 100 + i, [['a', address]]))
}
const addr = (i: number) => `30851:${'b'.repeat(64)}:${i}`

test('a pooled list is answered when whole answers already held every value in it (Miky, 13 Oct)', async () => {
  const { snap } = await fresh()
  const all = [0, 1, 2, 3, 4, 5].map(addr)
  const events = changes(all)
  // The first visit asked its set in two groups; the reload's set is regrouped and one shorter.
  snap.absorb([{ kinds: [1851], '#a': all.slice(0, 3), limit: 1000 }], events.slice(0, 3))
  snap.absorb([{ kinds: [1851], '#a': all.slice(3), limit: 1000 }], events.slice(3))
  const asked = [{ kinds: [1851], '#a': [all[1], all[2], all[4]], limit: 1000 }]
  assert.deepEqual(snap.answer(asked)?.map((e) => e.id).sort(), [events[1], events[2], events[4]].map((e) => e.id).sort())
  assert.deepEqual(snap.answer([{ kinds: [1851], '#a': [all[5]], limit: 1000 }])?.map((e) => e.id), [events[5].id])
  assert.equal(snap.answer([{ kinds: [1851], '#a': [all[1], addr(9)], limit: 1000 }]), null, 'a value never answered')
  assert.equal(snap.answer([{ kinds: [1111], '#a': [all[1]], limit: 1000 }]), null, 'another field differs')
})

test('a cut answer covers nothing beyond its own key', async () => {
  const { snap } = await fresh()
  const all = [0, 1, 2].map(addr)
  const events = changes(all)
  // Three matches asked with limit 2: the relay held back the rest, so a value with none sent may still have some.
  snap.absorb([{ kinds: [1851], '#a': all, limit: 2 }], events.slice(1))
  assert.notEqual(snap.answer([{ kinds: [1851], '#a': all, limit: 2 }]), null, 'its own key still answers')
  assert.equal(snap.answer([{ kinds: [1851], '#a': [all[0]], limit: 2 }]), null)
})

test('a limit past the most a filter can match never cuts it: a set of roots, a set of profiles', async () => {
  const { snap } = await fresh()
  const alice = ev(0, 10, [], '1'.repeat(64))
  const bob = ev(0, 11, [], '2'.repeat(64))
  // Interop asks profiles with limit = the number of people: every one found is not a cut.
  snap.absorb([{ kinds: [0], authors: [alice.pubkey, bob.pubkey], limit: 2 }], [alice, bob])
  assert.deepEqual(snap.answer([{ kinds: [0], authors: [bob.pubkey], limit: 1 }])?.map((e) => e.id), [bob.id])
  const one = ev(30851, 20, [['d', 'x']], '3'.repeat(64))
  const two = ev(30851, 21, [['d', 'y']], '3'.repeat(64))
  snap.absorb([{ kinds: [30851], authors: [one.pubkey], '#d': ['x', 'y'], limit: 2 }], [one, two])
  assert.deepEqual(snap.answer([{ kinds: [30851], authors: [one.pubkey], '#d': ['y'], limit: 1 }])?.map((e) => e.id), [two.id])
  // Two versions of one replaceable event: the relay keeps history, so the bound does not hold.
  const old = ev(0, 5, [], '4'.repeat(64))
  const newer = ev(0, 6, [], '4'.repeat(64))
  snap.absorb([{ kinds: [0], authors: ['4'.repeat(64), '5'.repeat(64)], limit: 2 }], [newer, old])
  assert.equal(snap.answer([{ kinds: [0], authors: ['5'.repeat(64)], limit: 1 }]), null)
})

test('an answer from `since` on, or one whose events carry two `d` tags, covers nothing (#129 review)', async () => {
  const { snap } = await fresh()
  const a = ev(1111, 10, [['a', 'x']])
  // A catch-up: whole from its cursor, silent about what came before it.
  snap.absorb([{ kinds: [1111], '#a': ['x', 'y'], since: 5 }], [a])
  assert.equal(snap.answer([{ kinds: [1111], '#a': ['x'] }]), null)
  // Two files that both also name d1 fill a limit of two: the relay may have cut d2's file.
  const z = ev(30851, 20, [['d', 'z'], ['d', 'd1']], 'b'.repeat(64))
  const y = ev(30851, 30, [['d', 'y'], ['d', 'd1']], 'b'.repeat(64))
  snap.absorb([{ kinds: [30851], authors: ['b'.repeat(64)], '#d': ['d1', 'd2'], limit: 2 }], [z, y])
  assert.equal(snap.answer([{ kinds: [30851], authors: ['b'.repeat(64)], '#d': ['d2'], limit: 1 }]), null)
})

test('a read before the stored copy is in does not leave its covers empty for the page load', async () => {
  const storage = memorySnapshotStorage()
  const first = await fresh(storage)
  const a = ev(9, 10, [['h', 'g1']])
  first.snap.absorb([{ kinds: [9], '#h': ['g1', 'g2'] }], [a])
  await first.snap.flush()
  const snap = createEventSnapshot({ storage, scope: `wss://r|${'a'.repeat(64)}`, version: 1, timers: still })
  assert.equal(snap.answer([{ kinds: [9], '#h': ['g1'] }]), null, 'not loaded yet')
  await snap.ready
  assert.deepEqual(snap.answer([{ kinds: [9], '#h': ['g1'] }])?.map((e) => e.id), [a.id])
})

test('an id held again with other tags is looked up by what is held now', async () => {
  const { snap } = await fresh()
  const a = ev(9, 10, [['h', 'g1']])
  snap.absorb([{ kinds: [9], '#h': ['g1'] }], [a])
  snap.absorb([{ kinds: [9], '#h': ['g2'] }], [{ ...a, tags: [['h', 'g2']] }])
  snap.absorb([{ kinds: [9], '#h': ['g2'] }], [])
  assert.deepEqual(snap.answer([{ kinds: [9], '#h': ['g1'] }]), [])
})

test('what was answered whole survives a reload; a copy written before it covers nothing until asked again', async () => {
  const storage = memorySnapshotStorage()
  const { snap } = await fresh(storage)
  const all = [0, 1].map(addr)
  snap.absorb([{ kinds: [1851], '#a': all, limit: 1000 }], changes(all))
  await snap.flush()
  const asked = [{ kinds: [1851], '#a': [all[1]], limit: 1000 }]
  const { snap: next } = await fresh(storage)
  assert.equal(next.answer(asked)?.length, 1)

  const record = storage.records.get(`wss://r|${'a'.repeat(64)}`)!
  storage.records.set(`wss://r|${'a'.repeat(64)}`, { ...record, whole: undefined })
  const { snap: older } = await fresh(storage)
  assert.equal(older.answer(asked), null)
  assert.notEqual(older.answer([{ kinds: [1851], '#a': all, limit: 1000 }]), null, 'its exact keys still answer')
})

test('a scope is one person on one relay', () => {
  assert.equal(snapshotScope('wss://relay/', 'pk'), 'wss://relay|pk')
})

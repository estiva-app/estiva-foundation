/**
 * `createEventSnapshot` — the copy on the device a reload draws from (PEE-2).
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import type { SignedEvent } from '@estiva-app/protocol'
import {
  createEventSnapshot,
  memorySnapshotStorage,
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
  const snap = createEventSnapshot({ storage, scope: 'wss://r|me', version, timers: still })
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
  assert.equal(snap.answer([{ kinds: [9], '#h': ['g1'], limit: 1 }]), null, 'a narrower question was never asked')
  assert.equal(snap.answer([{ kinds: [9], '#h': ['g1', 'g2'], limit: 2 }]), null, 'the limit is part of the question')
  assert.deepEqual(snap.answer([{ kinds: [9], '#h': ['g1', 'g2'], limit: 10, since: 15 }])?.map((e) => e.created_at), [30, 20])
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

test('a scope is one person on one relay', () => {
  assert.equal(snapshotScope('wss://relay/', 'pk'), 'wss://relay|pk')
})

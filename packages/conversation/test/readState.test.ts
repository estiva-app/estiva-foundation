/*
  SPEC §11 read state: context ids, the blob, the byte cap, the merge, and the
  injected fetch and publish.
*/
import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { randomBytes } from 'node:crypto'
import type { SignedEvent, UnsignedEvent } from '@estiva-app/protocol'
import {
  advanceContexts,
  allSlotsFilter,
  buildReadStateEvent,
  capContextsToBytes,
  capReadStateContexts,
  channelContext,
  createSlotCache,
  effectiveReadAt,
  fetchReadState,
  fileContext,
  isPublishableContextId,
  isUnread,
  loadSlotIdentity,
  MAX_BLOB_BYTES,
  MAX_CONTEXTS_BYTES,
  MAX_TIMESTAMP,
  mergeSlots,
  parseReadStateBlob,
  publishReadState,
  REACTIONS_FLOOR_CONTEXT,
  reactionsContext,
  reactionsSeenOf,
  REPLY_FLOOR_CONTEXT,
  rotateSlotId,
  serializeReadStateBlob,
  streamMarkerOf,
  threadContext,
  threadReadAt,
  belowReplyFloor,
  THREAD_RULE_FROM,
  type SlotStorage,
} from '../dist/index.js'

const ME = 'e'.repeat(64)
const FOLDER = '85db5b59-9e49-4ea1-8e93-3d2a2d78c048'
const ISSUE = `30851:${'a'.repeat(64)}:Case-Sensitive-d`
const ROOT = 'f'.repeat(64)
const random = (n: number) => new Uint8Array(randomBytes(n))
const memory = (): SlotStorage & { map: Map<string, string> } => {
  const map = new Map<string, string>()
  return { map, getItem: (k) => map.get(k) ?? null, setItem: (k, v) => void map.set(k, v) }
}

describe('context ids (§11.1)', () => {
  it('channel and file are bare; d is verbatim; thread needs 64 hex', () => {
    assert.equal(channelContext(FOLDER.toUpperCase()), FOLDER)
    assert.equal(channelContext('topic-seed-key'), undefined)
    assert.equal(fileContext(ISSUE), ISSUE)
    assert.equal(fileContext(`file:${ISSUE}`), undefined)
    assert.equal(fileContext(`20000:${'a'.repeat(64)}:x`), undefined)
    assert.equal(threadContext(ROOT), `thread:${ROOT}`)
    assert.equal(threadContext('abc'), undefined)
    assert.equal(isPublishableContextId(`folder:${ISSUE}`), false)
  })
})

describe('a file’s marker in two keys (§11.1, §11.8, C45)', () => {
  const ID = '15e9b50a-825a-4537-8b4a-df46efb9c7e4'
  const PROJECT = `30850:${'a'.repeat(64)}:${ID}`
  const BY_ID = `file:${ID}`
  const comment = (created_at: number) => ({ id: '1'.repeat(64), pubkey: 'b'.repeat(64), kind: 1111, created_at, tags: [], content: '' })
  const judge = { stream: PROJECT, me: ME, member: true }

  it('reads a file’s comments by the later of its address key and its file: key', () => {
    // file:<d> at 200 is later than the address key at 100: a comment at 150 is read.
    assert.equal(isUnread(comment(150), undefined, { [PROJECT]: 100, [BY_ID]: 200 }, judge), false)
    assert.equal(isUnread(comment(250), undefined, { [PROJECT]: 100, [BY_ID]: 200 }, judge), true)
    // The address key alone is still a marker, and the later of the two wins either way round.
    assert.equal(isUnread(comment(150), undefined, { [PROJECT]: 200, [BY_ID]: 100 }, judge), false)
    assert.equal(isUnread(comment(150), undefined, { [BY_ID]: 200 }, judge), false)
    // A stream passed by the id reads a read stored under the address too (§11.1).
    const byIdJudge = { ...judge, stream: BY_ID }
    assert.equal(isUnread(comment(150), undefined, { [PROJECT]: 200 }, byIdJudge), false)
    assert.equal(isUnread(comment(150), undefined, { [PROJECT]: 100, [BY_ID]: 200 }, byIdJudge), false)
    assert.equal(isUnread(comment(250), undefined, { [PROJECT]: 200, [BY_ID]: 100 }, byIdJudge), true)
    // A thread under the file reads its stream's marker by the same two keys.
    assert.equal(effectiveReadAt({ [BY_ID]: 300 }, `thread:${ROOT}`, PROJECT, 1_000), 300)
  })

  it('keys a new read of a file by its id as file:<d>, and only for a lowercase UUID', async () => {
    const { fileIdContext } = await import('../dist/index.js')
    assert.equal(fileIdContext(ID), BY_ID)
    assert.equal(fileIdContext(ID.toUpperCase()), undefined)
    assert.equal(fileIdContext(PROJECT), undefined)
  })

  it('a read of a project writes file:<d> and its address once projects are kept in order, and its address alone before (ALO-4)', async () => {
    const { fileReadMarkers } = await import('../dist/index.js')
    assert.deepEqual(fileReadMarkers(PROJECT, 300, ['osnova.project']), { [BY_ID]: 300, [PROJECT]: 300 })
    assert.deepEqual(fileReadMarkers(PROJECT, 300, []), { [PROJECT]: 300 })
    assert.deepEqual(fileReadMarkers(PROJECT, 300, ['osnova.issue']), { [PROJECT]: 300 })
    assert.deepEqual(fileReadMarkers('not an address', 300, ['osnova.project']), {})
  })

  it('reads only the address of a file whose d is no UUID', () => {
    assert.equal(isUnread(comment(150), undefined, { [ISSUE]: 100, 'file:Case-Sensitive-d': 200 }, { ...judge, stream: ISSUE }), true)
  })
})

describe('slots', () => {
  it('is minted once, reused, and rotated keeping client_id', () => {
    const storage = memory()
    const source = { storage, storageKey: 'k', clientPrefix: 'ship', random }
    const first = loadSlotIdentity(source)
    assert.match(first.slotId, /^[0-9a-f]{32}$/)
    assert.match(first.clientId, /^ship-[0-9a-f]{8}$/)
    assert.deepEqual(loadSlotIdentity(source), first)
    const rotated = rotateSlotId(first, source)
    assert.notEqual(rotated.slotId, first.slotId)
    assert.equal(rotated.clientId, first.clientId)
    assert.deepEqual(loadSlotIdentity(source), rotated)
  })

  it('a throwing storage degrades to an ephemeral slot', () => {
    const storage: SlotStorage = { getItem: () => { throw new Error('blocked') }, setItem: () => { throw new Error('blocked') } }
    assert.match(loadSlotIdentity({ storage, storageKey: 'k', clientPrefix: 'peek', random }).slotId, /^[0-9a-f]{32}$/)
  })
})

describe('the blob', () => {
  it('refuses a non-v1 blob (entries: readStateCarry.test.ts)', () => {
    assert.equal(parseReadStateBlob(JSON.stringify({ v: 2, contexts: {} })), undefined)
  })

  it('never lowers a marker', () => {
    assert.deepEqual(advanceContexts({ [FOLDER]: 10 }, { [FOLDER]: 5, [ISSUE]: 7, nope: 9 }).contexts, { [FOLDER]: 10, [ISSUE]: 7 })
  })

  it('the byte cap evicts the oldest, deterministically, and its accounting is the serializer’s', () => {
    const contexts: Record<string, number> = {}
    for (let i = 0; i < 1200; i++) contexts[`thread:${i.toString(16).padStart(64, '0')}`] = 1_700_000_000 + (i % 7)
    const capped = capContextsToBytes(contexts)
    assert.ok(capped.evicted.length > 0)
    assert.equal(capped.bytes, Buffer.byteLength(JSON.stringify(capped.contexts)))
    assert.ok(capped.bytes <= MAX_CONTEXTS_BYTES)
    assert.deepEqual(capContextsToBytes(capped.contexts).evicted, [])
    const longest = serializeReadStateBlob({ v: 1, client_id: 'x'.repeat(64), contexts: capped.contexts })
    assert.ok(Buffer.byteLength(longest) <= MAX_BLOB_BYTES)
  })
})

describe('merge and hierarchy (§11.3)', () => {
  it('merges by max and takes the later of thread and stream', () => {
    const slot = (contexts: Record<string, number>) => ({ blob: { v: 1 as const, client_id: 'c', contexts } })
    const merged = mergeSlots([slot({ [ISSUE]: 10, [`thread:${ROOT}`]: 30 }), slot({ [ISSUE]: 20 })])
    assert.deepEqual(merged, { [ISSUE]: 20, [`thread:${ROOT}`]: 30 })
    assert.equal(effectiveReadAt(merged, `thread:${ROOT}`, ISSUE), 30)
    assert.equal(effectiveReadAt({ [ISSUE]: 40 }, `thread:${ROOT}`, ISSUE), 40)
  })

  it('cuts over at the second SPEC §11.3 states (CON-34)', () => {
    assert.equal(THREAD_RULE_FROM, 1791226800)
    assert.ok(THREAD_RULE_FROM < MAX_TIMESTAMP)
  })

  it('after the cut-over, reading the stream does not read a thread (CON-34)', () => {
    const T0 = 100
    const thread = `thread:${ROOT}`
    // The stream was read at 500: a reply up to T0 is read by it, a later one is not.
    assert.equal(effectiveReadAt({ [ISSUE]: 500 }, thread, ISSUE, T0), 100)
    assert.equal(effectiveReadAt({ [ISSUE]: 50 }, thread, ISSUE, T0), 50)
    // The thread's own marker reads it, whatever the stream says.
    assert.equal(effectiveReadAt({ [ISSUE]: 500, [thread]: 300 }, thread, ISSUE, T0), 300)
    assert.equal(effectiveReadAt({ [thread]: 300 }, thread, undefined, T0), 300)
    // A context that is not a thread keeps NIP-RS's rule.
    assert.equal(effectiveReadAt({ [ISSUE]: 500 }, `msg:${ROOT}`, ISSUE, T0), 500)
  })

  it('the reply floor reads every reply at or before it, and nothing else', () => {
    const thread = `thread:${ROOT}`
    assert.equal(effectiveReadAt({ [ISSUE]: 500, [REPLY_FLOOR_CONTEXT]: 400 }, thread, ISSUE, 100), 400)
    assert.equal(effectiveReadAt({ [REPLY_FLOOR_CONTEXT]: 400, [thread]: 450 }, thread, ISSUE, 100), 450)
    assert.equal(effectiveReadAt({ [REPLY_FLOOR_CONTEXT]: 400 }, ISSUE), undefined)
    // Alone it is not a frontier: the caller's absent-marker rule still decides, and belowReplyFloor adds what it reads.
    assert.equal(effectiveReadAt({ [REPLY_FLOOR_CONTEXT]: 400 }, thread, ISSUE, 100), undefined)
    assert.ok(belowReplyFloor(400, 400))
    assert.ok(!belowReplyFloor(401, 400))
    assert.ok(!belowReplyFloor(1, undefined))
  })

  it('threadReadAt is the same rule from loose markers', () => {
    assert.equal(threadReadAt({ thread: undefined, stream: 500, floor: undefined }, 100), 100)
    assert.equal(threadReadAt({ thread: 300, stream: 500, floor: 400 }, 100), 400)
    assert.equal(threadReadAt({ thread: undefined, stream: undefined, floor: undefined }), undefined)
    assert.equal(threadReadAt({ thread: 10, stream: 500, floor: undefined }), 500)
  })
})

describe('the reply floor (§11.6, CON-34)', () => {
  const thread = (i: number) => `thread:${i.toString(16).padStart(64, '0')}`

  it('is publishable and survives a merge', () => {
    assert.ok(isPublishableContextId(REPLY_FLOOR_CONTEXT))
    const slot = (contexts: Record<string, number>) => ({ blob: { v: 1 as const, client_id: 'c', contexts } })
    assert.deepEqual(mergeSlots([slot({ [REPLY_FLOOR_CONTEXT]: 5 }), slot({ [REPLY_FLOOR_CONTEXT]: 9 })]), { [REPLY_FLOOR_CONTEXT]: 9 })
    assert.deepEqual(parseReadStateBlob(JSON.stringify({ v: 1, client_id: 'c', contexts: { [REPLY_FLOOR_CONTEXT]: 7 } }))?.contexts, { [REPLY_FLOOR_CONTEXT]: 7 })
  })

  it('is raised to the newest thread marker the cap drops, so no read reply lights again', () => {
    const contexts: Record<string, number> = {}
    for (let i = 0; i < 1200; i++) contexts[thread(i)] = 1_700_000_000 + i
    const capped = capReadStateContexts(contexts)
    assert.ok(capped.evicted.length > 0)
    const newestDropped = Math.max(...capped.evicted.map((k) => contexts[k]))
    assert.equal(capped.contexts[REPLY_FLOOR_CONTEXT], newestDropped)
    assert.equal(capped.bytes, Buffer.byteLength(JSON.stringify(capped.contexts)))
    assert.ok(capped.bytes <= MAX_CONTEXTS_BYTES)
    // Every dropped thread is still read at the time it was.
    for (const key of capped.evicted) {
      assert.ok(belowReplyFloor(contexts[key], capped.contexts[REPLY_FLOOR_CONTEXT]))
      assert.ok(effectiveReadAt({ ...capped.contexts, [ISSUE]: 1 }, key, ISSUE, 0)! >= contexts[key])
    }
    // Idempotent: capping the result changes nothing.
    assert.deepEqual(capReadStateContexts(capped.contexts), { ...capped, evicted: [] })
  })

  it('is never evicted, and is not added when no thread marker is dropped', () => {
    const contexts: Record<string, number> = { [REPLY_FLOOR_CONTEXT]: 1 }
    for (let i = 0; i < 1200; i++) contexts[thread(i)] = 1_700_000_000 + i
    const capped = capReadStateContexts(contexts)
    assert.ok(capped.contexts[REPLY_FLOOR_CONTEXT] > 1)
    assert.ok(!capped.evicted.includes(REPLY_FLOOR_CONTEXT))
    assert.deepEqual(capReadStateContexts({ [ISSUE]: 3 }).contexts, { [ISSUE]: 3 })
    const files: Record<string, number> = {}
    for (let i = 0; i < 1200; i++) files[`30851:${'a'.repeat(64)}:${i}`] = 1_700_000_000 + i
    assert.equal(capReadStateContexts(files).contexts[REPLY_FLOOR_CONTEXT], undefined)
  })

  it('only the cap raises it: an update cannot set it, and what current holds is kept', () => {
    assert.deepEqual(advanceContexts({}, { [REPLY_FLOOR_CONTEXT]: MAX_TIMESTAMP }).contexts, {})
    assert.deepEqual(advanceContexts({ [REPLY_FLOOR_CONTEXT]: 5 }, { [REPLY_FLOOR_CONTEXT]: 9, [ISSUE]: 7 }).contexts, { [REPLY_FLOOR_CONTEXT]: 5, [ISSUE]: 7 })
  })

  it('a reader never takes it past the blob that holds it', () => {
    const slot = (contexts: Record<string, number>, createdAt: number) => ({ blob: { v: 1 as const, client_id: 'c', contexts }, createdAt })
    assert.deepEqual(mergeSlots([slot({ [REPLY_FLOOR_CONTEXT]: MAX_TIMESTAMP }, 1000)]), { [REPLY_FLOOR_CONTEXT]: 1000 })
    assert.deepEqual(mergeSlots([slot({ [REPLY_FLOOR_CONTEXT]: 500 }, 1000)]), { [REPLY_FLOOR_CONTEXT]: 500 })
  })

  it('survives the merged count cap, raised by the thread markers it drops', () => {
    const slots = []
    for (let s = 0; s < 15; s++) {
      const contexts: Record<string, number> = { [REPLY_FLOOR_CONTEXT]: 10 }
      for (let i = 0; i < 760; i++) contexts[thread(s * 1000 + i)] = 1_700_000_000 + s * 1000 + i
      slots.push({ blob: { v: 1 as const, client_id: `c${s}`, contexts } })
    }
    const merged = mergeSlots(slots)
    assert.equal(Object.keys(merged).length, 10_000)
    assert.ok(merged[REPLY_FLOOR_CONTEXT] > 1_700_000_000)
    const all = Object.assign({}, ...slots.map((s) => s.blob.contexts)) as Record<string, number>
    for (const [key, value] of Object.entries(all)) {
      if (key !== REPLY_FLOOR_CONTEXT && merged[key] === undefined) assert.ok(belowReplyFloor(value, merged[REPLY_FLOOR_CONTEXT]))
    }
  })

  it('advanceContexts caps with it', () => {
    const contexts: Record<string, number> = {}
    for (let i = 0; i < 1200; i++) contexts[thread(i)] = 1_700_000_000 + i
    assert.ok(advanceContexts({}, contexts).contexts[REPLY_FLOOR_CONTEXT] !== undefined)
  })
})

describe('fetch and publish, injected', () => {
  const identity = { slotId: '0'.repeat(32), clientId: 'ship-00000000' }
  const nip44 = { encrypt: async (p: string) => `enc:${p}`, decrypt: async (c: string) => (c.startsWith('enc:') ? c.slice(4) : undefined) }
  const slotEvent = (slotId: string, plaintext: string, created_at = 1): SignedEvent => ({
    ...(buildReadStateEvent(ME, created_at * 1000, slotId, `enc:${plaintext}`) as UnsignedEvent),
    id: slotId.padEnd(64, '0'),
    sig: '',
  })

  it('the event has exactly one d and one t and no h', () => {
    assert.deepEqual(buildReadStateEvent(ME, 1000, identity.slotId, 'c').tags, [['d', `read-state:${identity.slotId}`], ['t', 'read-state']])
    assert.deepEqual(allSlotsFilter(ME, 100 * 86_400_000, 90), { kinds: [30078], authors: [ME], '#t': ['read-state'], since: 10 * 86_400 })
  })

  it('an unreachable relay is not "no slots"', async () => {
    const read = await fetchReadState(async () => { throw new Error('down') }, ME, nip44, identity, 0)
    assert.equal(read.reachable, false)
  })

  it('reports our own slot undecryptable, and a conflicted coordinate', async () => {
    const other = slotEvent('1'.repeat(32), JSON.stringify({ v: 1, client_id: 'peek-1', contexts: { [FOLDER]: 9 } }))
    const undecryptable = { ...slotEvent(identity.slotId, ''), content: 'garbage' }
    const a = await fetchReadState(async () => [other, undecryptable], ME, nip44, identity, 0)
    assert.equal(a.ownUndecryptable, true)
    assert.deepEqual(a.merged, { [FOLDER]: 9 })
    // A rotated key will never decrypt: asking again changes nothing, so the merge is whole (PEE-68).
    assert.equal(a.complete, true)
    const taken = slotEvent(identity.slotId, JSON.stringify({ v: 1, client_id: 'peek-1', contexts: {} }))
    const b = await fetchReadState(async () => [taken], ME, nip44, identity, 0)
    assert.equal(b.coordinateConflicted, true)
    assert.equal(b.own, undefined)
  })

  describe('with a slot cache (Peek 23130326)', () => {
    const blobOf = (contexts: Record<string, number>, client_id = 'peek-1') => JSON.stringify({ v: 1, client_id, contexts })
    const counting = (refuse: (c: string) => boolean = () => false) => {
      const asked: string[] = []
      return {
        asked,
        decrypt: async (c: string) => {
          asked.push(c)
          if (refuse(c)) throw new Error('POST /nip44/decrypt failed: 429')
          return nip44.decrypt(c)
        },
      }
    }

    it('decrypts a slot again only when its content changed', async () => {
      const cache = createSlotCache()
      const a = slotEvent('1'.repeat(32), blobOf({ [FOLDER]: 1 }))
      const b = slotEvent('2'.repeat(32), blobOf({ [ISSUE]: 2 }, 'peek-2'))
      const seam = counting()
      await fetchReadState(async () => [a, b], ME, seam, identity, 0, 90, cache)
      assert.equal(seam.asked.length, 2)
      const again = await fetchReadState(async () => [a, b], ME, seam, identity, 0, 90, cache)
      assert.equal(seam.asked.length, 2)
      assert.deepEqual(again.merged, { [FOLDER]: 1, [ISSUE]: 2 })
      const b2 = slotEvent('2'.repeat(32), blobOf({ [ISSUE]: 3 }, 'peek-2'), 2)
      const changed = await fetchReadState(async () => [a, b2], ME, seam, identity, 0, 90, cache)
      assert.deepEqual(seam.asked.slice(2), [b2.content])
      assert.deepEqual(changed.merged, { [FOLDER]: 1, [ISSUE]: 3 })
    })

    it('a refused slot keeps its last markers, and the round stops asking', async () => {
      const cache = createSlotCache()
      const a = slotEvent('1'.repeat(32), blobOf({ [FOLDER]: 1 }))
      const b = slotEvent('2'.repeat(32), blobOf({ [ISSUE]: 2 }, 'peek-2'))
      await fetchReadState(async () => [a, b], ME, counting(), identity, 0, 90, cache)
      const a2 = slotEvent('1'.repeat(32), blobOf({ [FOLDER]: 5 }), 2)
      const b2 = slotEvent('2'.repeat(32), blobOf({ [ISSUE]: 6 }, 'peek-2'), 2)
      const seam = counting(() => true)
      const read = await fetchReadState(async () => [a2, b2], ME, seam, identity, 0, 90, cache)
      assert.equal(seam.asked.length, 1)
      assert.deepEqual(read.merged, { [FOLDER]: 1, [ISSUE]: 2 })
      const later = await fetchReadState(async () => [a2, b2], ME, counting(), identity, 0, 90, cache)
      assert.deepEqual(later.merged, { [FOLDER]: 5, [ISSUE]: 6 })
    })

    it('asks for our own slot first, and a refusal there still blocks publishing', async () => {
      const cache = createSlotCache()
      const other = slotEvent('1'.repeat(32), blobOf({ [FOLDER]: 1 }))
      const own = slotEvent(identity.slotId, blobOf({ [ISSUE]: 2 }, identity.clientId))
      await fetchReadState(async () => [other, own], ME, counting(), identity, 0, 90, cache)
      const own2 = slotEvent(identity.slotId, blobOf({ [ISSUE]: 4 }, identity.clientId), 2)
      const other2 = slotEvent('1'.repeat(32), blobOf({ [FOLDER]: 3 }), 2)
      const seam = counting(() => true)
      const read = await fetchReadState(async () => [other2, own2], ME, seam, identity, 0, 90, cache)
      assert.deepEqual(seam.asked, [own2.content])
      assert.equal(read.ownUndecryptable, true)
      assert.equal(read.own, undefined)
      assert.deepEqual(read.merged, { [FOLDER]: 1, [ISSUE]: 2 })
    })

    it('never asks again for a slot that will not decrypt, and resets for another person', async () => {
      const cache = createSlotCache()
      const rotated = { ...slotEvent('1'.repeat(32), ''), content: 'garbage' }
      const seam = counting()
      await fetchReadState(async () => [rotated], ME, seam, identity, 0, 90, cache)
      await fetchReadState(async () => [rotated], ME, seam, identity, 0, 90, cache)
      assert.equal(seam.asked.length, 1)
      const someoneElse = 'd'.repeat(64)
      await fetchReadState(async () => [{ ...rotated, pubkey: someoneElse }], someoneElse, seam, identity, 0, 90, cache)
      assert.equal(seam.asked.length, 2)
    })

    it('two overlapping calls decrypt a changed slot once', async () => {
      const cache = createSlotCache()
      const a = slotEvent('1'.repeat(32), blobOf({ [FOLDER]: 1 }))
      const seam = counting()
      const [x, y] = await Promise.all([
        fetchReadState(async () => [a], ME, seam, identity, 0, 90, cache),
        fetchReadState(async () => [a], ME, seam, identity, 0, 90, cache),
      ])
      assert.equal(seam.asked.length, 1)
      assert.deepEqual(x.merged, y.merged)
    })

    it('without a cache, a refused slot is dropped and the round stops asking', async () => {
      const a = slotEvent('1'.repeat(32), blobOf({ [FOLDER]: 1 }))
      const b = slotEvent('2'.repeat(32), blobOf({ [ISSUE]: 2 }, 'peek-2'))
      const seam = counting((c) => c === a.content)
      const read = await fetchReadState(async () => [a, b], ME, seam, identity, 0)
      assert.deepEqual(seam.asked, [a.content])
      assert.deepEqual(read.merged, {})
      assert.equal(read.reachable, true)
      assert.equal(read.complete, false)
    })

    it('a new tab refused a slot it never decrypted reports the merge incomplete, until one decrypts it (PEE-68)', async () => {
      const cache = createSlotCache()
      const ship = slotEvent('1'.repeat(32), blobOf({ [FOLDER]: 1 }, 'ship-1'))
      const peek = slotEvent('2'.repeat(32), blobOf({ [ISSUE]: 2 }, 'peek-2'))
      const cold = await fetchReadState(async () => [ship, peek], ME, counting((c) => c === ship.content), identity, 0, 90, cache)
      assert.deepEqual(cold.merged, {})
      assert.equal(cold.complete, false)
      const next = await fetchReadState(async () => [ship, peek], ME, counting(), identity, 0, 90, cache)
      assert.deepEqual(next.merged, { [FOLDER]: 1, [ISSUE]: 2 })
      assert.equal(next.complete, true)
    })

    it('a refused slot with an earlier copy, or one that will never decrypt, leaves the merge complete', async () => {
      const cache = createSlotCache()
      const a = slotEvent('1'.repeat(32), blobOf({ [FOLDER]: 1 }))
      const rotated = { ...slotEvent('3'.repeat(32), ''), content: 'garbage' }
      const first = await fetchReadState(async () => [a, rotated], ME, counting(), identity, 0, 90, cache)
      assert.equal(first.complete, true)
      const a2 = slotEvent('1'.repeat(32), blobOf({ [FOLDER]: 5 }), 2)
      const refused = await fetchReadState(async () => [a2, rotated], ME, counting(() => true), identity, 0, 90, cache)
      assert.deepEqual(refused.merged, { [FOLDER]: 1 })
      assert.equal(refused.complete, true)
    })

    it('an unreachable relay is not a complete merge', async () => {
      const read = await fetchReadState(async () => { throw new Error('down') }, ME, counting(), identity, 0, 90, createSlotCache())
      assert.equal(read.complete, false)
    })

    it('forgets slots the relay no longer holds', async () => {
      const cache = createSlotCache()
      const a = slotEvent('1'.repeat(32), blobOf({ [FOLDER]: 1 }))
      await fetchReadState(async () => [a], ME, counting(), identity, 0, 90, cache)
      const read = await fetchReadState(async () => [], ME, counting(), identity, 0, 90, cache)
      assert.deepEqual(read.merged, {})
      assert.equal(cache.slots.size, 0)
    })
  })

  it('publish encrypts the sorted blob and signs the read-state shape', async () => {
    let published: SignedEvent | undefined
    const result = await publishReadState(
      { nip44, sign: async (u) => ({ ...u, id: '0'.repeat(64), sig: '' }), publish: async (e) => ((published = e), { ok: true }) },
      ME,
      identity,
      { [ISSUE]: 2, [FOLDER]: 1 },
      5000,
    )
    assert.equal(result.ok, true)
    assert.equal(published?.content, `enc:${JSON.stringify({ v: 1, client_id: identity.clientId, contexts: { [ISSUE]: 2, [FOLDER]: 1 } })}`)
  })

  it('publish keeps the reply floor the caller already capped in', async () => {
    let published: SignedEvent | undefined
    await publishReadState(
      { nip44, sign: async (u) => ({ ...u, id: '0'.repeat(64), sig: '' }), publish: async (e) => ((published = e), { ok: true }) },
      ME,
      identity,
      { [ISSUE]: 2, [REPLY_FLOOR_CONTEXT]: 1 },
      5000,
    )
    assert.equal(JSON.parse(published!.content.slice(4)).contexts[REPLY_FLOOR_CONTEXT], 1)
  })
})

describe('the reactions to P are seen per conversation (§11.1, §11.3, §11.6, ACT-7)', () => {
  const ID = '15e9b50a-825a-4537-8b4a-df46efb9c7e4'
  const PROJECT = `30850:${'a'.repeat(64)}:${ID}`
  const BY_ID = `file:${ID}`
  const R = (context: string) => reactionsContext(context)

  const publishable: [string, string, boolean][] = [
    ['a chat’s reactions, by its channel uuid', R(FOLDER), true],
    ['a file’s reactions, by its address', R(ISSUE), true],
    ['a file’s reactions, by its id', R(BY_ID), true],
    ['no stream: reactions of a thread (they count in its root’s stream)', R(threadContext(ROOT)!), false],
    ['floor: reactions of the reply floor', R(REPLY_FLOOR_CONTEXT), false],
    ['floor: reactions of the reactions floor', R(REACTIONS_FLOOR_CONTEXT), false],
    ['nested: reactions of a reactions key', R(R(FOLDER)), false],
    ['reserved: reactions of the folder grain (§11.5)', R(`folder:${ISSUE}`), false],
    ['malformed: reactions of a file id that is not a uuid', R('file:x'), false],
    ['malformed: reactions of nothing', R(''), false],
  ]
  for (const [name, key, ok] of publishable) {
    it(`${ok ? 'writes' : 'never writes'} ${name}`, () => {
      assert.deepEqual(advanceContexts({}, { [key]: 5 }).contexts, ok ? { [key]: 5 } : {})
    })
  }

  it('a reactions: key has no parent: opening the file, its threads or the reply floor never sees its reactions', () => {
    const merged = { [ISSUE]: 900, [threadContext(ROOT)!]: 900, [REPLY_FLOOR_CONTEXT]: 900, [R(ISSUE)]: 100 }
    assert.equal(reactionsSeenOf(merged, [ISSUE]), 100)
    assert.equal(effectiveReadAt(merged, R(ISSUE), ISSUE), 100)
    assert.equal(reactionsSeenOf({ [ISSUE]: 900 }, [ISSUE]), 0)
  })

  it('the effective marker of a reactions: key is the later of the key and the reactions floor, as reactionsSeenOf reads it', () => {
    assert.equal(effectiveReadAt({ [R(ISSUE)]: 100, [REACTIONS_FLOOR_CONTEXT]: 300 }, R(ISSUE), ISSUE), 300)
    assert.equal(effectiveReadAt({ [REACTIONS_FLOOR_CONTEXT]: 300 }, R(ISSUE)), 300)
    assert.equal(effectiveReadAt({ [R(ISSUE)]: 400, [REACTIONS_FLOOR_CONTEXT]: 300 }, R(ISSUE)), 400)
  })

  it('a reactions: key reads no message as read', () => {
    assert.equal(streamMarkerOf({ [R(ISSUE)]: 900, [R(BY_ID)]: 900 }, ISSUE), undefined)
    assert.equal(streamMarkerOf({ [R(PROJECT)]: 900 }, BY_ID), undefined)
  })

  it('is kept beside a later stream marker, never dropped as dominated', () => {
    const merged = mergeSlots([{ blob: { v: 1, client_id: 'c', contexts: { [ISSUE]: 900, [R(ISSUE)]: 100 } } }])
    assert.equal(merged[R(ISSUE)], 100)
    assert.equal(advanceContexts(merged, { [ISSUE]: 950 }).contexts[R(ISSUE)], 100)
  })

  const bothWays: [string, Record<string, number>, string[], number][] = [
    ['by its id, asked by address', { [R(BY_ID)]: 50, [R(PROJECT)]: 40 }, [PROJECT], 50],
    ['by its address, asked both ways', { [R(PROJECT)]: 60, [R(BY_ID)]: 50 }, [PROJECT, BY_ID], 60],
    ['by its id, asked by id', { [R(BY_ID)]: 50 }, [BY_ID], 50],
    ['under the floor', { [R(BY_ID)]: 50, [REACTIONS_FLOOR_CONTEXT]: 70 }, [PROJECT, BY_ID], 70],
    ['in another conversation only', { [R(FOLDER)]: 80 }, [PROJECT, BY_ID], 0],
  ]
  for (const [name, merged, contexts, want] of bothWays) {
    it(`a file named both ways is seen to the later key: ${name}`, () => assert.equal(reactionsSeenOf(merged, contexts), want))
  }

  it('a reactions: key on a thread or a message is no stream: an app cannot write one, and dropping one carried raises no floor', () => {
    const hex = 'b'.repeat(64)
    const odd = { [R(`thread:${hex}`)]: 1_600_000_000, [R(`msg:${hex}`)]: 1_600_000_000 }
    assert.deepEqual(advanceContexts({}, odd).contexts, {})
    const contexts: Record<string, number> = { ...odd }
    for (let i = 0; i < 1200; i++) contexts[`30851:${'a'.repeat(64)}:${i}`] = 1_700_000_000 + i
    const capped = capReadStateContexts(contexts)
    assert.ok(capped.evicted.includes(R(`thread:${hex}`)) || capped.evicted.includes(R(`msg:${hex}`)))
    assert.equal(capped.contexts[REACTIONS_FLOOR_CONTEXT], undefined)
  })

  it('the reactions floor is raised to the newest reactions: key the byte cap drops, and not by an update', () => {
    const contexts: Record<string, number> = {}
    for (let i = 0; i < 1200; i++) contexts[R(`30851:${'a'.repeat(64)}:${i}`)] = 1_700_000_000 + i
    const capped = capReadStateContexts(contexts)
    assert.ok(capped.evicted.length > 0)
    assert.ok(capped.bytes <= MAX_CONTEXTS_BYTES)
    const floor = capped.contexts[REACTIONS_FLOOR_CONTEXT]
    assert.equal(floor, Math.max(...capped.evicted.map((k) => contexts[k])))
    for (const key of capped.evicted) assert.ok(reactionsSeenOf(capped.contexts, [key.slice('reactions:'.length)]) >= contexts[key])
    assert.equal(capped.contexts[REPLY_FLOOR_CONTEXT], undefined)
    assert.deepEqual(capReadStateContexts(capped.contexts), { ...capped, evicted: [] })
    assert.deepEqual(advanceContexts({ [REACTIONS_FLOOR_CONTEXT]: 5 }, { [REACTIONS_FLOOR_CONTEXT]: 9 }).contexts, { [REACTIONS_FLOOR_CONTEXT]: 5 })
  })

  it('the reactions floor survives the merged count cap, raised by the reactions: keys it drops, and never past its blob', () => {
    const slots = []
    for (let s = 0; s < 15; s++) {
      const contexts: Record<string, number> = { [REACTIONS_FLOOR_CONTEXT]: 10 }
      for (let i = 0; i < 760; i++) contexts[R(`30851:${'a'.repeat(64)}:${s * 1000 + i}`)] = 1_700_000_000 + s * 1000 + i
      slots.push({ blob: { v: 1 as const, client_id: `c${s}`, contexts } })
    }
    const merged = mergeSlots(slots)
    assert.ok(Object.keys(merged).length <= 10_000)
    assert.ok(merged[REACTIONS_FLOOR_CONTEXT] > 1_700_000_000)
    for (const slot of slots) {
      for (const [key, value] of Object.entries(slot.blob.contexts)) {
        if (merged[key] === undefined) assert.ok(reactionsSeenOf(merged, [key.slice('reactions:'.length)]) >= value)
      }
    }
    assert.deepEqual(mergeSlots([{ blob: { v: 1, client_id: 'c', contexts: { [REACTIONS_FLOOR_CONTEXT]: MAX_TIMESTAMP } }, createdAt: 1000 }]), {
      [REACTIONS_FLOOR_CONTEXT]: 1000,
    })
  })
})

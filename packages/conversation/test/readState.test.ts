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
  effectiveReadAt,
  fetchReadState,
  fileContext,
  isPublishableContextId,
  loadSlotIdentity,
  MAX_BLOB_BYTES,
  MAX_CONTEXTS_BYTES,
  MAX_TIMESTAMP,
  mergeSlots,
  parseReadStateBlob,
  publishReadState,
  REPLY_FLOOR_CONTEXT,
  rotateSlotId,
  serializeReadStateBlob,
  threadContext,
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
  it('parses per entry and refuses a non-v1 blob', () => {
    const blob = parseReadStateBlob(JSON.stringify({ v: 1, client_id: 'x', contexts: { [FOLDER]: 5, bad: 6, [ISSUE]: -1 } }))
    assert.deepEqual(blob, { v: 1, client_id: 'x', contexts: { [FOLDER]: 5 } })
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

  it('ships with the cut-over unset, which is the old rule exactly', () => {
    assert.equal(THREAD_RULE_FROM, MAX_TIMESTAMP)
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
    assert.equal(effectiveReadAt({ [REPLY_FLOOR_CONTEXT]: 400 }, thread, ISSUE, 100), 400)
    assert.equal(effectiveReadAt({ [REPLY_FLOOR_CONTEXT]: 400, [thread]: 450 }, thread, ISSUE, 100), 450)
    assert.equal(effectiveReadAt({ [REPLY_FLOOR_CONTEXT]: 400 }, ISSUE), undefined)
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
    for (const key of capped.evicted) assert.ok(effectiveReadAt(capped.contexts, key, ISSUE, 0)! >= contexts[key])
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
    const taken = slotEvent(identity.slotId, JSON.stringify({ v: 1, client_id: 'peek-1', contexts: {} }))
    const b = await fetchReadState(async () => [taken], ME, nip44, identity, 0)
    assert.equal(b.coordinateConflicted, true)
    assert.equal(b.own, undefined)
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
})

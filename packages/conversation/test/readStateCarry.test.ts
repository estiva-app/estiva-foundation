/*
  SPEC §11.1: a read-state key this code does not know is carried verbatim and
  never judged (ACT-7). Every import here exists before ACT-7, so each test runs
  on the code that dropped such keys, and fails there.
*/
import { describe, it, mock, beforeEach, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import { randomBytes } from 'node:crypto'
import type { SignedEvent, UnsignedEvent } from '@estiva-app/protocol'
import {
  advanceContexts,
  createReadStateQueue,
  mergeSlots,
  parseReadStateBlob,
  publishReadState,
  readStateDTag,
  serializeReadStateBlob,
  streamMarkerOf,
} from '../dist/index.js'

const ME = 'e'.repeat(64)
const FOLDER = '85db5b59-9e49-4ea1-8e93-3d2a2d78c048'
const ISSUE = `30851:${'a'.repeat(64)}:Case-Sensitive-d`
const ID = '15e9b50a-825a-4537-8b4a-df46efb9c7e4'
const PROJECT = `30850:${'a'.repeat(64)}:${ID}`
const BY_ID = `file:${ID}`
/** A key a later version writes, which this one does not know. */
const LATER = `reactions:${FOLDER}x`
/** The reserved folder grain (§11.5): never written by this code, still carried when a slot holds it. */
const RESERVED = `folder:${ISSUE}`
/** Keys named like members of `Object.prototype`. */
const PROTO = ['constructor', 'toString', 'valueOf', 'hasOwnProperty', 'isPrototypeOf']

const nip44 = { encrypt: async (p: string) => `enc:${p}`, decrypt: async (c: string) => (c.startsWith('enc:') ? c.slice(4) : undefined) }
const identity = { slotId: '0'.repeat(32), clientId: 'peek-00000000' }

/** Publishes `contexts` as the app's map, with `slot` as this slot read back, and returns the blob that went out. */
async function published(contexts: Record<string, number>, slot?: Record<string, number>): Promise<Record<string, number>> {
  let event: SignedEvent | undefined
  await publishReadState(
    { nip44, sign: async (u) => ({ ...u, id: '0'.repeat(64), sig: '' }), publish: async (e) => ((event = e), { ok: true }) },
    ME,
    identity,
    contexts,
    5000,
    slot,
  )
  return JSON.parse(event!.content.slice(4)).contexts
}

describe('read state carries a key it does not know (§11.1)', () => {
  it('parse keeps an unknown key, and drops a bad timestamp, an over-long key and an empty one', () => {
    const blob = parseReadStateBlob(JSON.stringify({ v: 1, client_id: 'x', contexts: { [FOLDER]: 5, bad: 6, [ISSUE]: -1, ['x'.repeat(257)]: 7, '': 8 } }))
    assert.deepEqual(blob, { v: 1, client_id: 'x', contexts: { [FOLDER]: 5, bad: 6 } })
  })

  it('parse keeps a file:<d> key, and carries one whose rest is not a lowercase UUID without reading it as a marker', () => {
    const contexts = { [BY_ID]: 5, [`file:${ISSUE}`]: 6, 'file:x': 7, [`file:${ID.toUpperCase()}`]: 8 }
    const blob = parseReadStateBlob(serializeReadStateBlob({ v: 1, client_id: 'c', contexts }))
    assert.deepEqual(blob?.contexts, contexts)
    assert.equal(streamMarkerOf(blob!.contexts, PROJECT), 5)
    assert.equal(streamMarkerOf(blob!.contexts, BY_ID), 5)
  })

  it('an unknown key survives parse, merge and advance verbatim, and is no stream’s marker', () => {
    const parsed = parseReadStateBlob(JSON.stringify({ v: 1, client_id: 'old', contexts: { [LATER]: 9, [FOLDER]: 5 } }))!
    const merged = mergeSlots([{ blob: parsed, createdAt: 100 }, { blob: { v: 1, client_id: 'b', contexts: { [ISSUE]: 7 } }, createdAt: 100 }])
    assert.deepEqual(merged, { [LATER]: 9, [FOLDER]: 5, [ISSUE]: 7 })
    assert.deepEqual(advanceContexts(parsed.contexts, { [FOLDER]: 12 }).contexts, { [LATER]: 9, [FOLDER]: 12 })
    assert.equal(streamMarkerOf(merged, FOLDER), 5)
  })

  it('keys named like Object.prototype members are carried through parse, merge, advance and publish, and the map still prints', async () => {
    const contexts = Object.fromEntries(PROTO.map((key, i) => [key, 10 + i]))
    const parsed = parseReadStateBlob(JSON.stringify({ v: 1, client_id: 'old', contexts }))!
    assert.deepEqual({ ...parsed.contexts }, contexts)
    assert.doesNotThrow(() => String(parsed.contexts))
    const merged = mergeSlots([{ blob: parsed }, { blob: { v: 1, client_id: 'b', contexts: { constructor: 99 } } }])
    assert.deepEqual({ ...merged }, { ...contexts, constructor: 99 })
    assert.doesNotThrow(() => String(merged))
    const advanced = advanceContexts(parsed.contexts, { [FOLDER]: 3 }).contexts
    assert.deepEqual({ ...advanced }, { ...contexts, [FOLDER]: 3 })
    assert.deepEqual(await published({ [FOLDER]: 3 }, parsed.contexts), { ...contexts, [FOLDER]: 3 })
  })

  it('publishing carries what this slot already held, a reserved key included, beside the app’s own markers', async () => {
    assert.deepEqual(await published({ [ISSUE]: 2 }, { [LATER]: 9, [RESERVED]: 8, [FOLDER]: 1 }), { [ISSUE]: 2, [LATER]: 9, [RESERVED]: 8, [FOLDER]: 1 })
  })

  it('an app’s own map never writes a key this code does not write, unknown or reserved', async () => {
    assert.deepEqual(await published({ [ISSUE]: 2, [LATER]: 9, [RESERVED]: 8, 'not-a-context': 7 }), { [ISSUE]: 2 })
    assert.deepEqual(advanceContexts({}, { [LATER]: 9, [RESERVED]: 8 }).contexts, {})
  })
})

describe('the read-state queue carries its slot’s unknown keys onto the wire (§11.1)', () => {
  const AT = 1_790_000_000_000
  beforeEach(() => mock.timers.enable({ apis: ['setTimeout', 'Date'], now: AT }))
  afterEach(() => mock.timers.reset())

  it('a mark republishes the slot with the keys another version wrote in it', async () => {
    const events = new Map<string, SignedEvent>()
    const dOf = (e: SignedEvent) => e.tags.find((t) => t[0] === 'd')?.[1] ?? ''
    let n = 0
    const storage = new Map<string, string>()
    const queue = createReadStateQueue({
      storage: () => ({ getItem: (k: string) => storage.get(k) ?? null, setItem: (k: string, v: string) => void storage.set(k, v) }),
      storageKey: 'test.readstate.slot',
      clientPrefix: 'test',
      random: (size) => new Uint8Array(randomBytes(size)),
      pubkey: () => ME,
      query: async (filters) => {
        const f = filters[0] as { authors: string[]; '#d': string[] }
        return [...events.values()].filter((e) => f.authors.includes(e.pubkey) && f['#d'].includes(dOf(e)))
      },
      nip44,
      sign: async (u: UnsignedEvent) => ({ ...u, id: (++n).toString(16).padStart(64, '0'), sig: '' }) as SignedEvent,
      publish: async (e: SignedEvent) => (events.set(`${e.pubkey}:${dOf(e)}`, e), { ok: true }),
    })
    const { slotId, clientId } = queue.identity()
    const d = readStateDTag(slotId)
    const plaintext = JSON.stringify({ v: 1, client_id: clientId, contexts: { [LATER]: 1_789_000_000, [RESERVED]: 1_789_000_001 } })
    events.set(`${ME}:${d}`, { id: 'f'.repeat(64), sig: '', pubkey: ME, kind: 30078, created_at: 1_789_000_002, tags: [['d', d], ['t', 'read-state']], content: `enc:${plaintext}` })
    queue.markRead([FOLDER], AT)
    mock.timers.tick(3000)
    await queue.flush()
    const blob = JSON.parse(events.get(`${ME}:${d}`)!.content.slice(4))
    assert.deepEqual(blob.contexts, { [FOLDER]: AT / 1000, [LATER]: 1_789_000_000, [RESERVED]: 1_789_000_001 })
  })
})

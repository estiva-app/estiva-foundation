/*
  SPEC §11: the one queue Ship and Leaf mark read through (TOPIC-3). Asserted
  on what reaches the relay: the 30078 at `read-state:<slot>` and the blob in it.
*/
import { describe, it, mock, beforeEach, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import { randomBytes } from 'node:crypto'
import type { SignedEvent, UnsignedEvent } from '@estiva-app/protocol'
import {
  MAX_CONTEXTS_BYTES,
  REPLY_FLOOR_CONTEXT,
  createReadStateQueue,
  readStateDTag,
  watchDwell,
  type ReadStateQueueOptions,
  type VisibilitySource,
} from '../dist/index.js'

const ALICE = 'a'.repeat(64)
const BOB = 'b'.repeat(64)
const T1 = `thread:${'1'.repeat(64)}`
const T2 = `thread:${'2'.repeat(64)}`
const T3 = `thread:${'3'.repeat(64)}`
const AT = 1_790_000_000_000

/** A relay holding replaceable events by coordinate, as the real one does for 30078. */
function fakeRelay() {
  const events = new Map<string, SignedEvent>()
  let n = 0
  const dOf = (e: SignedEvent) => e.tags.find((t) => t[0] === 'd')?.[1] ?? ''
  return {
    events,
    query: async (filters: Record<string, unknown>[]) => {
      const f = filters[0] as { authors: string[]; '#d': string[] }
      return [...events.values()].filter((e) => f.authors.includes(e.pubkey) && f['#d'].includes(dOf(e)))
    },
    publish: async (e: SignedEvent) => {
      events.set(`${e.pubkey}:${dOf(e)}`, e)
      return { ok: true }
    },
    sign: async (u: UnsignedEvent): Promise<SignedEvent> => ({ ...u, id: (++n).toString(16).padStart(64, '0'), sig: '' }) as SignedEvent,
    blob(pubkey: string, slotId: string) {
      const e = events.get(`${pubkey}:${readStateDTag(slotId)}`)
      return e ? JSON.parse(e.content.slice(4)) : undefined
    },
  }
}

function memoryStorage() {
  const m = new Map<string, string>()
  return { getItem: (k: string) => m.get(k) ?? null, setItem: (k: string, v: string) => void m.set(k, v) }
}

function setup(over: Partial<ReadStateQueueOptions> = {}, relay = fakeRelay(), storage = memoryStorage()) {
  const decrypts: string[] = []
  const nip44 = {
    encrypt: async (p: string) => `enc:${p}`,
    decrypt: async (c: string) => (decrypts.push(c), c.startsWith('enc:') ? c.slice(4) : undefined),
  }
  let who: string | undefined = ALICE
  const queue = createReadStateQueue({
    storage: () => storage,
    storageKey: 'test.readstate.slot',
    clientPrefix: 'test',
    random: (n) => new Uint8Array(randomBytes(n)),
    pubkey: () => who,
    query: relay.query,
    nip44,
    sign: relay.sign,
    publish: relay.publish,
    ...over,
  })
  return { queue, relay, storage, decrypts, nip44, as: (p: string | undefined) => (who = p) }
}

describe('createReadStateQueue', () => {
  beforeEach(() => mock.timers.enable({ apis: ['setTimeout', 'Date'], now: AT }))
  afterEach(() => mock.timers.reset())

  it('publishes the marks as one blob in this installation\'s slot, after the debounce', async () => {
    const { queue, relay } = setup()
    queue.markRead([T1, undefined, T2], AT)
    assert.equal(relay.events.size, 0, 'nothing before the debounce')
    mock.timers.tick(3000)
    await queue.flush()
    const blob = relay.blob(ALICE, queue.identity().slotId)
    assert.deepEqual(blob.contexts, { [T1]: AT / 1000, [T2]: AT / 1000 })
    assert.equal(blob.client_id, queue.identity().clientId)
    assert.match(blob.client_id, /^test-/)
  })

  it('reads the slot back before every write, so a second tab never drops what the first one published', async () => {
    const relay = fakeRelay()
    const storage = memoryStorage()
    const a = setup({}, relay, storage)
    const b = setup({}, relay, storage)
    a.queue.markRead([T1], AT)
    await a.queue.flush()
    b.queue.markRead([T2], AT)
    await b.queue.flush()
    // Tab A marks again, after B's publish: its blob must carry B's marker too.
    a.queue.markRead([T3], AT)
    await a.queue.flush()
    assert.deepEqual(Object.keys(relay.blob(ALICE, a.queue.identity().slotId).contexts).sort(), [T1, T2, T3])
  })

  it('does not publish over its slot while the slot would not decrypt, and publishes once it does', async () => {
    let refuse = true
    const { queue, relay, nip44 } = setup()
    queue.markRead([T1], AT)
    await queue.flush()
    const slotId = queue.identity().slotId
    const first = relay.events.get(`${ALICE}:${readStateDTag(slotId)}`)
    // Another tab grew the slot; this tab's decrypt now answers 429.
    relay.events.set(`${ALICE}:${readStateDTag(slotId)}`, { ...first!, content: `enc:${JSON.stringify({ v: 1, client_id: queue.identity().clientId, contexts: { [T1]: AT / 1000, [T2]: AT / 1000 } })}` })
    const decrypt = nip44.decrypt
    nip44.decrypt = async (c) => {
      if (refuse) throw new Error('429')
      return decrypt(c)
    }
    queue.markRead([T3], AT)
    await queue.flush()
    assert.deepEqual(Object.keys(relay.blob(ALICE, slotId).contexts).sort(), [T1, T2], 'the other tab\'s blob is untouched')
    refuse = false
    mock.timers.tick(3000)
    await queue.flush()
    assert.deepEqual(Object.keys(relay.blob(ALICE, slotId).contexts).sort(), [T1, T2, T3])
  })

  it('takes a new slot when its coordinate holds another installation\'s blob, leaving that blob as it was', async () => {
    const { queue, relay } = setup()
    const taken = queue.identity()
    const theirs = `enc:${JSON.stringify({ v: 1, client_id: 'peek-00000000', contexts: { [T2]: 5 } })}`
    await relay.publish(await relay.sign({ kind: 30078, pubkey: ALICE, created_at: 1, tags: [['d', readStateDTag(taken.slotId)]], content: theirs }))
    queue.markRead([T1], AT)
    await queue.flush()
    assert.equal(relay.events.get(`${ALICE}:${readStateDTag(taken.slotId)}`)!.content, theirs)
    assert.notEqual(queue.identity().slotId, taken.slotId)
    assert.deepEqual(relay.blob(ALICE, queue.identity().slotId).contexts, { [T1]: AT / 1000 })
  })

  it('never writes one person\'s marks into the next person\'s slot', async () => {
    const { queue, relay, as } = setup()
    queue.markRead([T1], AT)
    as(BOB)
    await queue.flush()
    assert.equal([...relay.events.values()].filter((e) => e.pubkey === BOB).length, 0)
  })

  it('refuses to sign when the person changed while the flush was under way', async () => {
    const relay = fakeRelay()
    let ctl: ReturnType<typeof setup> | undefined
    const query: typeof relay.query = async (f) => {
      const out = await relay.query(f)
      ctl!.as(BOB)
      return out
    }
    ctl = setup({ query }, relay)
    ctl.queue.markRead([T1], AT)
    await ctl.queue.flush()
    assert.equal(relay.events.size, 0)
  })

  it('reads back its own publish without decrypting it again', async () => {
    const { queue, decrypts } = setup()
    queue.markRead([T1], AT)
    await queue.flush()
    queue.markRead([T2], AT + 5000)
    await queue.flush()
    assert.equal(decrypts.length, 0)
  })

  it('keeps the marks while the session cannot write, and publishes when it can', async () => {
    let ready = false
    const { queue, relay } = setup({ canWrite: () => ready })
    queue.markRead([T1], AT)
    await queue.flush()
    assert.equal(relay.events.size, 0)
    ready = true
    mock.timers.tick(3000)
    await queue.flush()
    assert.deepEqual(relay.blob(ALICE, queue.identity().slotId).contexts, { [T1]: AT / 1000 })
  })

  it('reports each mark that moved, before the publish, and not one that did not', () => {
    const seen: Record<string, number>[] = []
    const { queue } = setup({ onMarked: (c) => seen.push({ ...c }) })
    queue.markRead([T1], AT)
    queue.markRead([T1], AT - 10_000)
    assert.deepEqual(seen, [{ [T1]: AT / 1000 }])
  })

  // `advanceContexts` refuses a floor among its updates, and the read-back hands it what this tab marked as updates: a
  // floor the cap raised before the first publish was dropped there, and every reply under it lit up again (CON-34).
  it('keeps a reply floor the byte cap raised before the slot was read back, beside what the slot held', async () => {
    const CHANNEL = 'b7c1e0a4-2f3d-4a86-9c15-8d0e6f2a4b91'
    const relay = fakeRelay()
    const storage = memoryStorage()
    const { queue } = setup({}, relay, storage)
    const slot = queue.identity()
    const held = `enc:${JSON.stringify({ v: 1, client_id: slot.clientId, contexts: { [CHANNEL]: 1000 } })}`
    await relay.publish(await relay.sign({ kind: 30078, pubkey: ALICE, created_at: 1, tags: [['d', readStateDTag(slot.slotId)]], content: held }))
    const warn = mock.method(console, 'warn', () => {})
    // A `thread:` entry costs 85 bytes, so this is a few dozen past the budget.
    const threads = Array.from({ length: Math.ceil(MAX_CONTEXTS_BYTES / 80) }, (_, i) => `thread:${i.toString(16).padStart(64, '0')}`)
    threads.forEach((context, i) => queue.markRead([context], AT + i * 1000))
    await queue.flush()
    warn.mock.restore()
    const contexts = relay.blob(ALICE, slot.slotId).contexts
    assert.ok(contexts[REPLY_FLOOR_CONTEXT] > 1000)
    assert.equal(contexts[CHANNEL], 1000)
  })

  it('keeps the marks after the relay refuses a publish, and publishes them on the retry', async () => {
    const relay = fakeRelay()
    let refused = 0
    const publish: typeof relay.publish = async (e) => (refused++ === 0 ? { ok: false, reason: 'rate-limited' } : relay.publish(e))
    const { queue } = setup({ publish }, relay)
    const warn = mock.method(console, 'warn', () => {})
    queue.markRead([T1], AT)
    await queue.flush()
    assert.equal(relay.events.size, 0)
    assert.deepEqual(Object.keys(queue.state().pending), [T1])
    mock.timers.tick(3000)
    await queue.flush()
    warn.mock.restore()
    assert.deepEqual(relay.blob(ALICE, queue.identity().slotId).contexts, { [T1]: AT / 1000 })
  })

  it('reads back the newest copy of its slot when the relay returns more than one', async () => {
    const relay = fakeRelay()
    const { queue } = setup({}, relay)
    const slot = queue.identity()
    const copy = async (createdAt: number, contexts: Record<string, number>) =>
      relay.sign({ kind: 30078, pubkey: ALICE, created_at: createdAt, tags: [['d', readStateDTag(slot.slotId)]], content: `enc:${JSON.stringify({ v: 1, client_id: slot.clientId, contexts })}` })
    const older = await copy(1, { [T1]: 100 })
    const newer = await copy(2, { [T1]: 100, [T2]: 200 })
    const query: typeof relay.query = async () => [older, newer]
    const { queue: q } = setup({ query }, relay, (() => {
      const s = memoryStorage()
      s.setItem('test.readstate.slot', JSON.stringify(slot))
      return s
    })())
    void queue
    q.markRead([T3], AT)
    await q.flush()
    assert.deepEqual(Object.keys(relay.blob(ALICE, slot.slotId).contexts).sort(), [T1, T2, T3])
  })

  // The relay keeps the lower id when two copies of a slot share a second, and calls the loser a duplicate.
  it('dates a publish after the copy it read back, so a larger blob in the same second is not the one dropped', async () => {
    const { queue, relay } = setup()
    queue.markRead([T1], AT)
    await queue.flush()
    const d = `${ALICE}:${readStateDTag(queue.identity().slotId)}`
    const first = relay.events.get(d)!.created_at
    queue.markRead([T2], AT)
    await queue.flush()
    assert.ok(relay.events.get(d)!.created_at > first)
  })

  it('keeps publishing after a flush threw where nothing expected it to', async () => {
    let calls = 0
    const { queue, relay } = setup({
      canWrite: () => {
        if (calls++ === 0) throw new Error('a session check that broke')
        return true
      },
    })
    const warn = mock.method(console, 'warn', () => {})
    queue.markRead([T1], AT)
    await queue.flush().catch(() => {})
    queue.markRead([T2], AT)
    await queue.flush()
    warn.mock.restore()
    assert.deepEqual(Object.keys(relay.blob(ALICE, queue.identity().slotId).contexts).sort(), [T1, T2])
  })

  it('drops a mark made while nobody is signed in', async () => {
    const { queue, relay, as } = setup()
    as(undefined)
    queue.markRead([T1], AT)
    as(ALICE)
    await queue.flush()
    assert.equal(relay.events.size, 0)
  })
})

describe('watchDwell', () => {
  beforeEach(() => mock.timers.enable({ apis: ['setTimeout', 'Date'], now: AT }))
  afterEach(() => mock.timers.reset())

  function page(hidden = false) {
    const listeners = new Set<() => void>()
    const doc: VisibilitySource & { show(h: boolean): void } = {
      hidden,
      addEventListener: (_t, l) => void listeners.add(l),
      removeEventListener: (_t, l) => void listeners.delete(l),
      show(h) {
        ;(this as { hidden: boolean }).hidden = h
        for (const l of listeners) l()
      },
    }
    return doc
  }

  it('marks what stayed on screen for the dwell, at the newest message drawn, and not what was glanced past', () => {
    const marks: [readonly string[], number][] = []
    const doc = page()
    const glance = watchDwell([T1], AT - 60_000, (c, at) => marks.push([c, at]), doc)
    mock.timers.tick(1000)
    glance()
    mock.timers.tick(5000)
    assert.equal(marks.length, 0)
    watchDwell([T2], AT - 60_000, (c, at) => marks.push([c, at]), doc)
    mock.timers.tick(1500)
    assert.deepEqual(marks, [[[T2], AT - 60_000]])
  })

  it('does not mark while the page is hidden, and marks once it is shown again', () => {
    const marks: number[] = []
    const doc = page(true)
    watchDwell([T1], undefined, (_c, at) => marks.push(at), doc)
    mock.timers.tick(10_000)
    assert.equal(marks.length, 0)
    doc.show(false)
    mock.timers.tick(1500)
    assert.deepEqual(marks, [AT + 11_500])
  })

  it('never marks past the clock: a message dated ahead is read once the clock reaches it', () => {
    const marks: number[] = []
    watchDwell([T1], AT + 30_000, (_c, at) => marks.push(at), page())
    mock.timers.tick(1500)
    assert.deepEqual(marks, [AT + 1500])
    mock.timers.tick(28_500)
    assert.deepEqual(marks, [AT + 1500, AT + 30_000])
  })
})

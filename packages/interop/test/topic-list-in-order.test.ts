/**
 * A topic's list of files on a team the relay keeps topics in order — SPEC
 * §6.13, §6.14 (ALL-3).
 *
 * The relay here refuses as buzz does on such a team (buzz#68): a change
 * naming no `prev` with `invalid: requires-prev:`, a stale `prev` with
 * `conflict: <field> follows <id>`. `member:<P>` and `follow:<P>` are not
 * list fields and are not written here. Every write is asserted on the event
 * that reached it, and every read is the list read an app makes.
 */
import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import {
  listsField,
  planListInTopic,
  planPutBackInTopic,
  planRemoveFromTopic,
  prevsAfterSwitch,
  topicList,
  writeChange,
  type QueryFn,
} from '../dist/index.js'
import type { SignedEvent, UnsignedEvent } from '@estiva-app/protocol'

const QA1 = 'a'.repeat(64)
const QA2 = 'b'.repeat(64)
const TEAM = '4a279f9d-9247-4479-8aea-dd15ffe86297'
const MS = 1_787_142_018_561
const TOPIC_D = '3c9d1e2f-4a5b-4c6d-8e7f-901a2b3c4d5e'
const TOPIC = `30840:${QA1}:${TOPIC_D}`
const holder = { address: TOPIC, folder: TEAM }
const PAGE = '7e1f0a2b-3c4d-4e5f-8a9b-0c1d2e3f4a5b'
const ISSUE = '9a8b7c6d-5e4f-4a3b-8c2d-1e0f9a8b7c6d'

let seq = 0
const sign = (event: UnsignedEvent): SignedEvent => ({ ...event, id: (++seq).toString(16).padStart(64, '0'), sig: '' })
const tag = (e: { tags: string[][] }, name: string) => e.tags.find((t) => t[0] === name)?.[1]
const root = (kind: number, pubkey: string, d: string) =>
  sign({ pubkey, created_at: 1_787_000_000, kind, tags: [['d', d], ['title', d], ['h', TEAM]], content: '' })

type Filter = { ids?: string[]; kinds?: number[]; fields?: string } & Record<string, unknown>

/** One topic on a team kept in order, a page and an issue to list on it. */
function orderedRelay() {
  const topicRoot = root(30840, QA1, TOPIC_D)
  const events: SignedEvent[] = [topicRoot, root(30842, QA2, PAGE), root(30851, QA2, ISSUE)]
  const heads = new Map<string, SignedEvent>()
  const published: SignedEvent[] = []
  const publish = async (e: SignedEvent) => {
    published.push(e)
    const field = tag(e, 'field')!
    const prev = tag(e, 'prev')
    if (!prev) return { ok: false, reason: 'invalid: requires-prev: a topic change names the change it follows in prev; update the app' }
    const head = heads.get(field)?.id ?? topicRoot.id
    if (prev !== head) return { ok: false, reason: `conflict: ${field} follows ${head}` }
    events.push(e)
    heads.set(field, e)
    return { ok: true, eventId: e.id }
  }
  const matches = (e: SignedEvent, f: Filter) => {
    if (f.ids && !f.ids.includes(e.id)) return false
    if (f.kinds && !f.kinds.includes(e.kind)) return false
    for (const [key, values] of Object.entries(f)) {
      if (!key.startsWith('#')) continue
      if (!e.tags.some((t) => t[0] === key.slice(1) && (values as string[]).includes(t[1]))) return false
    }
    return true
  }
  // NIP-01 filters, and the list read: each picked root with its fields' newest changes.
  const query: QueryFn = async (filters) => {
    const out = new Set<SignedEvent>()
    for (const f of filters as Filter[]) {
      if (f.fields !== 'newest') {
        for (const e of events) if (matches(e, f)) out.add(e)
        continue
      }
      for (const r of events.filter((e) => e.kind !== 1851 && matches(e, f))) {
        out.add(r)
        if (r === topicRoot) for (const e of heads.values()) out.add(e)
      }
    }
    return [...out]
  }
  const current = async (field: string) => heads.get(field) ?? topicRoot
  return { publish, query, current, published, topicRoot }
}

type Relay = ReturnType<typeof orderedRelay>

/** An entry sent as an app sends it on a team kept in order: through writeChange, so a stale prev is followed again. */
const send = (relay: Relay, by: string, at: number, file: string, listed: boolean, prev: string) =>
  writeChange({
    field: listsField(file),
    value: listed ? 'true' : 'false',
    prev,
    build: (input) => (listed ? planListInTopic : planRemoveFromTopic)(by, input.createdAtMs, { topic: holder, file, prev: input.prev })[0],
    sign: async (e) => sign(e),
    publish: relay.publish,
    query: relay.query,
    current: relay.current,
    now: () => at,
  })

/** What a tab that has not read the list yet follows for one file: its entry, or the topic's first record. */
const entryPrev = async (relay: Relay, file: string) =>
  (await prevsAfterSwitch(relay.query, { kind: 30840, pubkey: QA1, d: TOPIC_D }, [listsField(file)]))![listsField(file)]

const listedOn = async (relay: Relay) => (await topicList(relay.query, TOPIC, { listRead: true })).map((f) => f.file).sort()

describe('adding to and taking off a topic kept in order — §6.13, §6.14', () => {
  it('two people adding different files from copies of the same age both land, each after the topic’s first record', async () => {
    const relay = orderedRelay()
    // Both tabs read the topic before either add.
    const [qa1Prev, qa2Prev] = [await entryPrev(relay, PAGE), await entryPrev(relay, ISSUE)]
    const [a, b] = await Promise.all([send(relay, QA1, MS, PAGE, true, qa1Prev), send(relay, QA2, MS, ISSUE, true, qa2Prev)])
    assert.ok(a.ok && b.ok, JSON.stringify([a, b]))
    assert.equal(relay.published.length, 2, 'each sent once: different files never clash')
    for (const sent of relay.published) {
      assert.deepEqual(
        sent.tags.map((t) => t[0]),
        ['a', 'O', 'K', 'field', 'value', 'h', 'ts', 'prev', 'o'],
        '§6.14’s tags, with prev after ts as order: and look: carry it',
      )
      assert.equal(tag(sent, 'prev'), relay.topicRoot.id)
    }
    assert.deepEqual(await listedOn(relay), [ISSUE, PAGE].sort())
  })

  it('taking a file off follows its entry, read from the list as prev.lists', async () => {
    const relay = orderedRelay()
    const added = await send(relay, QA1, MS, PAGE, true, await entryPrev(relay, PAGE))
    assert.ok(added.ok)
    const [file] = await topicList(relay.query, TOPIC, { listRead: true })
    assert.equal(file.prev.lists, added.id)
    const off = await send(relay, QA2, MS + 1_000, PAGE, false, file.prev.lists!)
    assert.ok(off.ok, JSON.stringify(off))
    assert.equal(relay.published.length, 2, 'accepted at the first send')
    assert.deepEqual(await listedOn(relay), [])
  })

  it('a tab that read the list before someone else took the file off and put it back still takes it off', async () => {
    const relay = orderedRelay()
    const added = await send(relay, QA1, MS, PAGE, true, await entryPrev(relay, PAGE))
    assert.ok(added.ok)
    const [stale] = await topicList(relay.query, TOPIC, { listRead: true })
    const off = await send(relay, QA2, MS + 1_000, PAGE, false, added.id)
    assert.ok(off.ok)
    const back = await send(relay, QA2, MS + 2_000, PAGE, true, off.id)
    assert.ok(back.ok)
    const mine = await send(relay, QA1, MS + 3_000, PAGE, false, stale.prev.lists!)
    assert.ok(mine.ok, JSON.stringify(mine))
    assert.equal(tag(relay.published.at(-1)!, 'prev'), back.id, 'sent again after the change now current')
    assert.deepEqual(await listedOn(relay), [])
  })

  it('Undo of Remove puts the file back after the Remove it undoes', async () => {
    const relay = orderedRelay()
    const added = await send(relay, QA1, MS, PAGE, true, await entryPrev(relay, PAGE))
    assert.ok(added.ok)
    const [file] = await topicList(relay.query, TOPIC, { listRead: true })
    const off = await send(relay, QA1, MS + 1_000, PAGE, false, file.prev.lists!)
    assert.ok(off.ok)
    const undo = planPutBackInTopic(QA1, MS + 2_000, { topic: holder, file, after: null, listsPrev: off.id })
    const relisted = await relay.publish(sign(undo.relist))
    assert.ok(relisted.ok, JSON.stringify(relisted))
    assert.deepEqual(await listedOn(relay), [PAGE])
  })
})

describe('where topics are not kept in order', () => {
  it('an entry names no change it follows, as every relay and reader took it before', () => {
    const [entry] = planListInTopic(QA1, MS, { topic: holder, file: PAGE })
    assert.deepEqual(
      entry.tags.map((t) => t[0]),
      ['a', 'O', 'K', 'field', 'value', 'h', 'ts', 'o'],
    )
  })
})

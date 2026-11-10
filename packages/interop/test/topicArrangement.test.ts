/*
  A topic's files in the order and look someone gave them — SPEC §6.14, C31.

  Each file's place (`order:<d>`) and look (`look:<d>`) are `kind:1851`
  fields of their own on the topic. Placed files come first by key, equal keys
  by the lower id; the rest follow, oldest listed first. A place older than the
  file's newest listing is ignored. Every `order:` change names its `prev`.
*/
import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import {
  isPlaceKey,
  keyBetween,
  planListInTopic,
  planLookInTopic,
  planMoveInTopic,
  planPutBackInTopic,
  planRemoveFromTopic,
  topicList,
  topicsOfFile,
  writeArrangement,
  type ArrangedFile,
} from '../dist/index.js'
import type { SignedEvent, UnsignedEvent } from '@estiva-app/protocol'

const QA1 = 'a'.repeat(64)
const QA2 = 'b'.repeat(64)
const FOLDER = '7b32200c-e4c0-4216-b79a-8490fc05e0bd'
const MS = 1_787_142_018_561
const TOPIC_D = '3c9d1e2f-4a5b-4c6d-8e7f-901a2b3c4d5e'
const TOPIC = `30840:${QA1}:${TOPIC_D}`
const holder = { address: TOPIC, folder: FOLDER }
const FILES = ['f-a', 'f-b', 'f-c', 'f-d']

let seq = 0
function signed(event: UnsignedEvent, id?: string): SignedEvent {
  seq += 1
  return { ...event, id: id ?? String(seq).padStart(64, '0'), sig: '' }
}
const root = (kind: number, pubkey: string, d: string): SignedEvent =>
  signed({ pubkey, created_at: 1_787_000_000, kind, tags: [['d', d], ['title', d], ['h', FOLDER]], content: '' })
const topicRoot = root(30840, QA1, TOPIC_D)
const fileRoots = FILES.map((d) => root(30842, QA2, d))
const list = (file: string, at: number, by = QA1) => signed(planListInTopic(by, at, { topic: holder, file })[0])
const tag = (e: { tags: string[][] }, name: string) => e.tags.find((t) => t[0] === name)?.[1]

type Filter = { ids?: string[]; kinds?: number[]; fields?: string } & Record<string, unknown>
/**
 * A relay: NIP-01 tag filters, and the list read (`fields: "newest"`): each
 * picked root with the newest change per field, a change a reader skips
 * included, as production answers it.
 */
function relay(events: SignedEvent[]) {
  const matches = (e: SignedEvent, filter: Filter) => {
    if (filter.ids && !filter.ids.includes(e.id)) return false
    if (filter.kinds && !filter.kinds.includes(e.kind)) return false
    for (const [key, values] of Object.entries(filter)) {
      if (!key.startsWith('#')) continue
      const held = e.tags.filter((t) => t[0] === key.slice(1)).map((t) => t[1])
      if (!held.some((v) => (values as string[]).includes(v))) return false
    }
    return true
  }
  const fieldsOf = (e: SignedEvent) => {
    const sets = e.tags.filter((t) => t[0] === 'set').map((t) => t[1])
    return sets.length ? sets : [tag(e, 'field')!]
  }
  const asked: Filter[] = []
  const query = async (filters: Record<string, unknown>[]) => {
    asked.push(...(filters as Filter[]))
    const out = new Set<SignedEvent>()
    for (const f of filters as Filter[]) {
      if (f.fields !== 'newest') {
        for (const e of events) if (matches(e, f)) out.add(e)
        continue
      }
      for (const r of events.filter((e) => e.kind !== 1851 && matches(e, f))) {
        out.add(r)
        const address = `${r.kind}:${r.pubkey}:${tag(r, 'd')}`
        const newest = new Map<string, SignedEvent>()
        for (const e of events) {
          if (e.kind !== 1851 || tag(e, 'a') !== address) continue
          for (const field of fieldsOf(e)) {
            const held = newest.get(field)
            if (!held || Number(tag(e, 'ts')) > Number(tag(held, 'ts'))) newest.set(field, e)
          }
        }
        for (const e of newest.values()) out.add(e)
      }
    }
    return [...out]
  }
  return Object.assign(query, { asked, events })
}

/** Four files listed a second apart, in FILES order. */
const listed = () => FILES.map((d, i) => list(d, MS + i * 1000))
const order = (files: { file: string }[]) => files.map((f) => f.file).join(' ')
const read = async (events: SignedEvent[], listRead = false) => topicList(relay([topicRoot, ...fileRoots, ...events]), TOPIC, { listRead })

describe('the place key', () => {
  it('always finds a key strictly between two, at either open end, and never one ending in 0', () => {
    let keys = [keyBetween()]
    for (let i = 0; i < 200; i++) {
      // Always at the front, always just after the first: the cases that deepen a key fastest.
      keys = i % 2 ? [keyBetween(undefined, keys[0]), ...keys] : [keys[0], keyBetween(keys[0], keys[1]), ...keys.slice(1)]
    }
    for (const k of keys) assert.ok(isPlaceKey(k), k)
    assert.deepEqual([...keys].sort(), keys, 'byte-wise ascending')
    assert.equal(new Set(keys).size, keys.length)
  })

  it('reads a key longer than 64 as no place, and places every file afresh rather than write one', async () => {
    const long = 'z'.repeat(10_000)
    assert.equal(isPlaceKey(long), false)
    // f-a placed at a key just under the limit that ends in many z's: the next drop after it would pass the limit.
    const near = `${'z'.repeat(63)}V`
    const at = MS + 5_000
    const placed = signed({
      pubkey: QA1, created_at: Math.floor(at / 1000), kind: 1851, content: '',
      tags: [['a', TOPIC], ['O', TOPIC_D], ['field', 'order:f-a'], ['value', near], ['h', FOLDER], ['ts', String(at)], ['prev', topicRoot.id], ['o', 'f-a']],
    })
    const files = await read([...listed(), placed])
    const change = planMoveInTopic(QA1, MS + 10_000, { topic: holder, files, file: 'f-c', after: 'f-a' })!
    for (const t of change.tags.filter((x) => x[0] === 'set')) assert.ok(isPlaceKey(t[2]), t[2])
    assert.equal(order(await read([...listed(), placed, signed(change)])), 'f-a f-c f-b f-d')
  })

  it('places between keys a person could not have made ("5" and "5V"), and refuses ones out of order', () => {
    const k = keyBetween('5', '5V')
    assert.ok('5' < k && k < '5V', k)
    assert.throws(() => keyBetween('b', 'a'))
    assert.throws(() => keyBetween('a0'))
  })
})

describe('the fold: one order and look for everyone', () => {
  it('draws placed files first by key, then the rest oldest listed first', async () => {
    const files = await read(listed())
    assert.equal(order(files), 'f-a f-b f-c f-d', 'nothing placed: the order they were listed in')
    const top = planMoveInTopic(QA1, MS + 10_000, { topic: holder, files, file: 'f-d', after: null })!
    // A move to the top among unplaced files is one change for the file that moved.
    assert.equal(tag(top, 'field'), 'order:f-d')
    assert.equal(tag(top, 'prev'), topicRoot.id, "a field's first change follows the topic's first record")
    assert.deepEqual(top.tags.filter((t) => t[0] === 'o'), [['o', 'f-d']])
    assert.equal(order(await read([...listed(), signed(top)])), 'f-d f-a f-b f-c')
  })

  it("keeps two people's moves of different files made at the same moment", async () => {
    // Arranged once already: every file placed, a b c d.
    const at = MS + 5_000
    const placed = signed({
      pubkey: QA1,
      created_at: Math.floor(at / 1000),
      kind: 1851,
      tags: [['a', TOPIC], ['O', TOPIC_D], ['h', FOLDER], ['ts', String(at)], ...FILES.map((d, i) => ['set', `order:${d}`, String(i + 1), topicRoot.id]), ...FILES.map((d) => ['o', d])],
      content: '',
    })
    const events = [...listed(), placed]
    const files = await read(events)
    assert.ok(files.every((f) => f.order !== undefined), order(files))
    const mine = planMoveInTopic(QA1, MS + 10_000, { topic: holder, files, file: 'f-d', after: null })!
    // QA-2 read the same list, and drags f-c to just after f-a while QA-1 drags f-d to the top.
    const theirs = planMoveInTopic(QA2, MS + 10_000, { topic: holder, files, file: 'f-c', after: 'f-a' })!
    const both = await read([...events, signed(mine), signed(theirs)])
    assert.equal(order(both), 'f-d f-a f-c f-b')
  })

  it('breaks a tie between two first places by id: both files are placed, before the rest', async () => {
    const files = await read(listed())
    const d = signed(planMoveInTopic(QA1, MS + 10_000, { topic: holder, files, file: 'f-d', after: null })!)
    const c = signed(planMoveInTopic(QA2, MS + 10_000, { topic: holder, files, file: 'f-c', after: null })!)
    assert.equal(order(await read([...listed(), d, c])), 'f-c f-d f-a f-b')
  })

  it('places the unplaced files above a file dropped among them, in one change taken whole', async () => {
    const files = await read(listed())
    const change = planMoveInTopic(QA1, MS + 10_000, { topic: holder, files, file: 'f-d', after: 'f-b' })!
    assert.equal(tag(change, 'field'), undefined, 'several fields: no `field`')
    assert.deepEqual(change.tags.filter((t) => t[0] === 'set').map((t) => [t[1], t[3]]), [
      ['order:f-a', topicRoot.id],
      ['order:f-b', topicRoot.id],
      ['order:f-d', topicRoot.id],
    ])
    assert.deepEqual(change.tags.filter((t) => t[0] === 'o').map((t) => t[1]), ['f-a', 'f-b', 'f-d'])
    assert.equal(order(await read([...listed(), signed(change)])), 'f-a f-b f-d f-c')
  })

  it('lands a file between two that share a key, placing the tied ones after it again', async () => {
    const files = await read(listed())
    // Both dropped between nothing and nothing at once: one key, ordered by id (f-b before f-c).
    const b = planMoveInTopic(QA1, MS + 10_000, { topic: holder, files, file: 'f-b', after: null })!
    const c = planMoveInTopic(QA2, MS + 10_000, { topic: holder, files, file: 'f-c', after: null })!
    assert.equal(tag(b, 'value'), tag(c, 'value'))
    const tied = await read([...listed(), signed(b), signed(c)])
    assert.equal(order(tied), 'f-b f-c f-a f-d')
    const between = planMoveInTopic(QA1, MS + 20_000, { topic: holder, files: tied, file: 'f-d', after: 'f-b' })!
    assert.equal(order(await read([...listed(), signed(b), signed(c), signed(between)])), 'f-b f-d f-c f-a')
  })

  it("ignores a place older than the file's newest listing, and a key a reader does not know", async () => {
    const files = await read(listed())
    const top = signed(planMoveInTopic(QA1, MS + 10_000, { topic: holder, files, file: 'f-d', after: null })!)
    const off = signed(planRemoveFromTopic(QA1, MS + 11_000, { topic: holder, file: 'f-d' })[0])
    const on = list('f-d', MS + 12_000)
    assert.equal(order(await read([...listed(), top, off, on])), 'f-a f-b f-c f-d', 'put back without its place: last')
    const odd = signed({ ...top, tags: top.tags.map((t) => (t[0] === 'value' ? ['value', 'a0'] : t)) })
    assert.equal(order(await read([...listed(), odd])), 'f-a f-b f-c f-d', '"a0" is no place')
  })

  it('never lets a change with the wrong `o` move a file, nor hide the good place before it, in either read', async () => {
    const files = await read(listed())
    const top = signed(planMoveInTopic(QA1, MS + 10_000, { topic: holder, files, file: 'f-d', after: null })!)
    const bad = signed({
      ...top,
      created_at: Math.floor((MS + 20_000) / 1000),
      tags: [...top.tags.filter((t) => t[0] !== 'o' && t[0] !== 'ts' && t[0] !== 'value'), ['ts', String(MS + 20_000)], ['value', '1'], ['o', 'f-x']],
    })
    for (const listRead of [false, true]) {
      const got = await read([...listed(), top, bad], listRead)
      assert.equal(order(got), 'f-d f-a f-b f-c', `listRead ${listRead}`)
      // The next move follows the relay's newest change for the field, the skipped one: the relay chains them all.
      assert.equal(got[0].prev.order, bad.id)
    }
  })

  it("never lets a move or a look filed in another team than the topic's change it, in either read", async () => {
    const files = await read(listed())
    const elsewhere = (e: UnsignedEvent) => signed({ ...e, tags: e.tags.map((t) => (t[0] === 'h' ? ['h', '0e2f4c1a-5b6d-4e7f-8a9b-0c1d2e3f4a5b'] : t)) })
    const top = elsewhere(planMoveInTopic(QA2, MS + 10_000, { topic: holder, files, file: 'f-d', after: null })!)
    const row = elsewhere(planLookInTopic(QA2, MS + 10_000, { topic: holder, file: files[0], look: 'row' }))
    for (const listRead of [false, true]) {
      const got = await read([...listed(), top, row], listRead)
      assert.equal(order(got), 'f-a f-b f-c f-d', `listRead ${listRead}`)
      assert.equal(got[0].look, undefined, `listRead ${listRead}`)
    }
  })

  it('keeps a file listed by the list read when a newer change listing it names the wrong `o`', async () => {
    const good = listed()
    const bad = signed({ ...good[1], created_at: Math.floor((MS + 30_000) / 1000), tags: good[1].tags.map((t) => (t[0] === 'ts' ? ['ts', String(MS + 30_000)] : t[0] === 'value' ? ['value', 'false'] : t[0] === 'o' ? ['o', 'f-x'] : t)) })
    assert.equal(order(await read([...good, bad], true)), 'f-a f-b f-c f-d')
  })

  it('reads a look a reader knows, and draws an unknown one as the file\'s own widget', async () => {
    const files = await read(listed())
    const row = signed(planLookInTopic(QA1, MS + 10_000, { topic: holder, file: files[1], look: 'row' }))
    assert.deepEqual([tag(row, 'field'), tag(row, 'value'), tag(row, 'o')], ['look:f-b', 'row', 'f-b'])
    const odd = signed({ ...row, tags: row.tags.map((t) => (t[0] === 'field' ? ['field', 'look:f-c'] : t[0] === 'o' ? ['o', 'f-c'] : t[0] === 'value' ? ['value', 'banner'] : t)) })
    const got = await read([...listed(), row, odd])
    assert.equal(got.find((f) => f.file === 'f-b')?.look, 'row')
    assert.equal(got.find((f) => f.file === 'f-c')?.look, undefined)
  })
})

describe('the list read stays bounded however often files are moved', () => {
  it('folds the same order from the newest fields as from every change, in one read', async () => {
    const events = listed()
    for (let i = 0; i < 30; i++) {
      const files = await read(events)
      events.push(signed(planMoveInTopic(i % 2 ? QA1 : QA2, MS + 10_000 + i * 1000, { topic: holder, files, file: FILES[i % 4], after: null })!))
    }
    const query = relay([topicRoot, ...fileRoots, ...events])
    const viaNewest = await topicList(query, TOPIC, { listRead: true })
    assert.equal(order(viaNewest), order(await read(events)))
    assert.equal(query.asked.filter((f) => '#O' in f).length, 0, 'no whole #O read')
  })
})

describe('Undo of Remove', () => {
  it('puts the file back in the place it had, with its look', async () => {
    const start = listed()
    const files = await read(start)
    const moved = signed(planMoveInTopic(QA1, MS + 10_000, { topic: holder, files, file: 'f-d', after: 'f-a' })!)
    const look = signed(planLookInTopic(QA1, MS + 10_500, { topic: holder, file: files[3], look: 'row' }))
    const before = await read([...start, moved, look])
    assert.equal(order(before), 'f-a f-d f-b f-c')
    const gone = before.find((f) => f.file === 'f-d')!
    const off = signed(planRemoveFromTopic(QA1, MS + 11_000, { topic: holder, file: 'f-d' })[0])
    const without = await read([...start, moved, look, off])
    const undo = planPutBackInTopic(QA1, MS + 12_000, { topic: holder, file: gone, after: 'f-a' })
    assert.equal(tag(undo.relist, 'field'), 'lists:f-d')
    const relisted = signed(undo.relist)
    // Sent as the app sends it: the move planned over the list read after the listing.
    const back = signed(undo.move(await read([...start, moved, look, off, relisted]), MS + 12_000)!)
    assert.equal(order(without), 'f-a f-b f-c')
    const after = await read([...start, moved, look, off, relisted, back])
    assert.equal(order(after), 'f-a f-d f-b f-c')
    assert.equal(after.find((f) => f.file === 'f-d')?.look, 'row')
  })
})

describe('a tab that read the topic before someone else moved a file', () => {
  it('plans its move again on the current list after a conflict, never re-sending a place it added', async () => {
    const start = listed()
    const stale = await read(start)
    // QA-2 moves f-a to the end since QA-1's tab read the topic.
    const theirs = signed(planMoveInTopic(QA2, MS + 10_000, { topic: holder, files: stale, file: 'f-a', after: 'f-d' })!)
    const events = [...start, theirs]
    const sent: UnsignedEvent[] = []
    const result = await writeArrangement({
      files: stale,
      read: () => read(events),
      // QA-1 drops f-d just after f-a, which its tab still shows first and unplaced.
      plan: (files, ms) => planMoveInTopic(QA1, ms, { topic: holder, files: [...files], file: 'f-d', after: 'f-a' }),
      sign: async (e) => signed(e),
      publish: async (e) => {
        sent.push(e)
        // The relay checks every prev it is given against the field's current change.
        const sets = e.tags.filter((t) => t[0] === 'set').map((t) => [t[1], t[3]])
        const pairs = sets.length ? sets : [[tag(e, 'field')!, tag(e, 'prev')!]]
        for (const [field, prev] of pairs) {
          const current = events.filter((x) => x.tags.some((t) => t[1] === field)).at(-1)?.id ?? topicRoot.id
          if (prev !== current) return { ok: false, reason: `conflict: ${field} follows ${current}` }
        }
        events.push(e as SignedEvent)
        return { ok: true }
      },
      now: () => MS + 20_000,
    })
    assert.equal(result.ok, true)
    assert.equal(sent.length, 2, 'refused once, planned again once')
    // QA-1's stale tab would have written f-a's old place back; planned again, only f-d moves.
    assert.equal(order(await read(events)), 'f-b f-c f-a f-d', "QA-2's move of f-a stands, and f-d lands after it")
    assert.equal(sent[1].tags.filter((t) => t[0] === 'set').length, 0, 'the second send places f-d alone')
  })
})


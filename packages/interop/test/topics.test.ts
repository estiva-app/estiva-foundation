/*
  A topic's list of files — SPEC §6.14, C31.

  A topic lists files from any Folder, one `kind:1851` entry per file, by the
  file's id: `O` names the topic the change is about, `o` the listed file.
  "Which topics list this file" asks `#o`; what changed on a file asks `#O`,
  and never gets back an entry that only lists it. The newest entry per topic
  and file counts, and only `true` lists.
*/
import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import {
  listEntries,
  planListInTopic,
  planRemoveFromTopic,
  topicList,
  topicListFilter,
  topicsOfFile,
} from '../dist/index.js'
import type { SignedEvent, UnsignedEvent } from '@estiva-app/protocol'

const QA1 = 'a'.repeat(64)
const QA2 = 'b'.repeat(64)
const RELAY = 'f'.repeat(64)
const FOLDER = '7b32200c-e4c0-4216-b79a-8490fc05e0bd'
const OTHER_FOLDER = '0e2f4c1a-5b6d-4e7f-8a9b-0c1d2e3f4a5b'
const MS = 1_787_142_018_561

const TOPIC_D = '3c9d1e2f-4a5b-4c6d-8e7f-901a2b3c4d5e'
const TOPIC = `30840:${QA1}:${TOPIC_D}`
const PROJECT_D = '5d6e7f80-9a1b-4c2d-8e3f-4a5b6c7d8e9f'
const PROJECT = `30850:${QA2}:${PROJECT_D}`
const DOC_D = '9e8d7c6b-5a49-4382-9716-05f4e3d2c1b0'
const DOC = `30842:${QA1}:${DOC_D}`

let seq = 0
/** A signed event as the relay would return it. Ids rise with each call unless given. */
function signed(event: UnsignedEvent, id?: string): SignedEvent {
  seq += 1
  return { ...event, id: id ?? String(seq).padStart(64, '0'), sig: '' }
}

const root = (kind: number, pubkey: string, d: string, folder: string): SignedEvent =>
  signed({ pubkey, created_at: 1_787_000_000, kind, tags: [['d', d], ['title', d.slice(0, 4)], ['h', folder]], content: '' })

const list = (file: string, at = MS, by = QA1) => signed(planListInTopic(by, at, { topic: { address: TOPIC, folder: FOLDER }, file })[0])
const unlist = (file: string, at = MS, by = QA1) =>
  signed(planRemoveFromTopic(by, at, { topic: { address: TOPIC, folder: FOLDER }, file })[0])

/** The same entry with its tags rewritten, as an outside client might send it. */
const retagged = (event: SignedEvent, edit: (tags: string[][]) => string[][]) => signed({ ...event, tags: edit(event.tags.map((t) => [...t])) })

type Filter = { ids?: string[]; kinds?: number[]; authors?: string[] } & Record<string, unknown>

/** A relay answering NIP-01 filters: kinds, authors and single-letter tag filters, any tag of that name matching. */
function relay(events: SignedEvent[]) {
  const matches = (e: SignedEvent, filter: Filter) => {
    if (filter.ids && !filter.ids.includes(e.id)) return false
    if (filter.kinds && !filter.kinds.includes(e.kind)) return false
    if (filter.authors && !filter.authors.includes(e.pubkey)) return false
    for (const [key, values] of Object.entries(filter)) {
      if (!key.startsWith('#')) continue
      const held = e.tags.filter((t) => t[0] === key.slice(1)).map((t) => t[1])
      if (!held.some((v) => (values as string[]).includes(v))) return false
    }
    return true
  }
  return async (filters: Record<string, unknown>[]) => events.filter((e) => filters.some((f) => matches(e, f as Filter)))
}

const topicRoot = root(30840, QA1, TOPIC_D, FOLDER)
const projectRoot = root(30850, QA2, PROJECT_D, OTHER_FOLDER)
const docRoot = root(30842, QA1, DOC_D, OTHER_FOLDER)

describe('an entry on the wire', () => {
  it('lists a file as a kind:1851 on the topic: a, O, field, value, h, ts, o, in that order, and no p', () => {
    const [event] = planListInTopic(QA1, MS, { topic: { address: TOPIC, folder: FOLDER }, file: PROJECT_D })
    assert.equal(event.kind, 1851)
    assert.equal(event.pubkey, QA1)
    assert.equal(event.created_at, Math.floor(MS / 1000))
    assert.deepEqual(event.tags, [
      ['a', TOPIC],
      ['O', TOPIC_D],
      ['field', `lists:${PROJECT_D}`],
      ['value', 'true'],
      ['h', FOLDER],
      ['ts', String(MS)],
      ['o', PROJECT_D],
    ])
    assert.equal(event.content, '')
  })

  it('takes a file off with a false entry of the same shape, never a deletion', () => {
    const events = planRemoveFromTopic(QA2, MS, { topic: { address: TOPIC, folder: FOLDER }, file: DOC_D })
    assert.equal(events.length, 1)
    assert.equal(events[0].kind, 1851)
    assert.deepEqual(events[0].tags.find((t) => t[0] === 'value'), ['value', 'false'])
    assert.deepEqual(events[0].tags.find((t) => t[0] === 'o'), ['o', DOC_D])
    assert.equal(events[0].content, '')
  })

  it('refuses an entry with no Folder, a list named by something other than an address, or a topic on its own list', () => {
    assert.throws(() => planListInTopic(QA1, MS, { topic: { address: TOPIC, folder: '' }, file: DOC_D }))
    assert.throws(() => planListInTopic(QA1, MS, { topic: { address: TOPIC_D, folder: FOLDER }, file: DOC_D }))
    assert.throws(() => planListInTopic(QA1, MS, { topic: { address: TOPIC, folder: FOLDER }, file: TOPIC_D }))
  })
})

describe('the fold: newest entry per topic and file, and only true lists', () => {
  it('of two entries inside one second, the later by ts counts even when its id is lower', () => {
    const first = signed(planListInTopic(QA1, MS, { topic: { address: TOPIC, folder: FOLDER }, file: DOC_D })[0], 'f'.repeat(64))
    const later = signed(planRemoveFromTopic(QA2, MS + 400, { topic: { address: TOPIC, folder: FOLDER }, file: DOC_D })[0], '0'.repeat(64))
    const [entry] = listEntries([first, later])
    assert.equal(entry.listed, false)
    assert.equal(entry.event.id, later.id)
  })

  it('lists a file only by exactly true', () => {
    const one = retagged(list(DOC_D), (tags) => tags.map((t) => (t[0] === 'value' ? ['value', '1'] : t)))
    const empty = retagged(list(PROJECT_D), (tags) => tags.map((t) => (t[0] === 'value' ? ['value', ''] : t)))
    assert.deepEqual(
      listEntries([one, empty]).map((e) => e.listed),
      [false, false],
    )
  })

  it('folds per file: removing one file leaves the other listed', () => {
    const entries = listEntries([list(PROJECT_D, MS), list(DOC_D, MS + 1), unlist(DOC_D, MS + 2000)])
    assert.deepEqual(
      Object.fromEntries(entries.map((e) => [e.file, e.listed])),
      { [PROJECT_D]: true, [DOC_D]: false },
    )
  })
})

describe('a malformed entry is skipped, and never hides an older good one', () => {
  const good = list(DOC_D, MS)
  const later = MS + 5000
  const cases: [string, SignedEvent][] = [
    ['its o is not the file its field names', retagged(unlist(DOC_D, later), (tags) => tags.map((t) => (t[0] === 'o' ? ['o', PROJECT_D] : t)))],
    ['it has no o at all', retagged(unlist(DOC_D, later), (tags) => tags.filter((t) => t[0] !== 'o'))],
    ['its O is not its a’s d', retagged(unlist(DOC_D, later), (tags) => tags.map((t) => (t[0] === 'O' ? ['O', PROJECT_D] : t)))],
    ['it names no Folder', retagged(unlist(DOC_D, later), (tags) => tags.filter((t) => t[0] !== 'h'))],
  ]
  for (const [why, bad] of cases) {
    it(`when ${why}`, () => {
      const entries = listEntries([good, bad])
      assert.equal(entries.length, 1)
      assert.equal(entries[0].listed, true)
      assert.equal(entries[0].event.id, good.id)
    })
  }

  it('counts an entry whose o naming the file comes second, after an o for something else', () => {
    const second = retagged(unlist(DOC_D, later), (tags) => [...tags.filter((t) => t[0] !== 'o'), ['o', PROJECT_D], ['o', DOC_D]])
    const entries = listEntries([good, second])
    assert.equal(entries.length, 1)
    assert.equal(entries[0].listed, false)
  })

  it('ignores a topic listing itself, as an outside client might write it', () => {
    const self = retagged(list(DOC_D), (tags) =>
      tags.map((t) => (t[0] === 'field' ? ['field', `lists:${TOPIC_D}`] : t[0] === 'o' ? ['o', TOPIC_D] : t)),
    )
    assert.deepEqual(listEntries([self]), [])
  })
})

describe('which topics list a file, and what changed on it', () => {
  it('finds the topic for a project and a document filed in two other Folders, and loses the one taken off', async () => {
    const events = [topicRoot, projectRoot, docRoot, list(PROJECT_D, MS), list(DOC_D, MS + 1)]
    const query = relay(events)
    assert.deepEqual((await topicsOfFile(query, PROJECT_D)).map((t) => t.address), [TOPIC])
    assert.deepEqual((await topicsOfFile(query, DOC_D)).map((t) => t.address), [TOPIC])

    const after = relay([...events, unlist(DOC_D, MS + 3000, QA2)])
    assert.deepEqual(await topicsOfFile(after, DOC_D), [])
    assert.deepEqual((await topicsOfFile(after, PROJECT_D)).map((t) => t.address), [TOPIC])
  })

  it('never returns the topic’s entry when asking what changed on the project itself', async () => {
    const rename = signed({
      pubkey: QA2,
      created_at: Math.floor(MS / 1000),
      kind: 1851,
      tags: [['a', PROJECT], ['O', PROJECT_D], ['field', 'title'], ['value', 'Launch'], ['h', OTHER_FOLDER], ['ts', String(MS)]],
      content: '',
    })
    const query = relay([topicRoot, projectRoot, list(PROJECT_D), rename])
    const own = await query([topicListFilter(PROJECT)])
    assert.deepEqual(own.map((e) => e.id), [rename.id])
    assert.deepEqual(await query([{ kinds: [1851], '#a': [PROJECT] }]).then((r) => r.map((e) => e.id)), [rename.id])
  })

  it('drops an entry filed outside the topic’s Folder, and one whose topic it cannot read', async () => {
    const outside = retagged(list(PROJECT_D), (tags) => tags.map((t) => (t[0] === 'h' ? ['h', OTHER_FOLDER] : t)))
    assert.deepEqual(await topicsOfFile(relay([topicRoot, outside]), PROJECT_D), [])
    assert.deepEqual(await topicsOfFile(relay([list(PROJECT_D)]), PROJECT_D), [])
  })

  it('reads only topics’ lists, though any type may carry one', async () => {
    const onProject = signed(planListInTopic(QA2, MS, { topic: { address: PROJECT, folder: OTHER_FOLDER }, file: DOC_D })[0])
    assert.deepEqual(await topicsOfFile(relay([projectRoot, docRoot, onProject]), DOC_D), [])
  })
})

describe("a topic's list", () => {
  it('resolves each listed id to the one file holding it', async () => {
    const query = relay([topicRoot, projectRoot, docRoot, list(DOC_D, MS + 1000), list(PROJECT_D, MS)])
    const files = await topicList(query, { address: TOPIC, folder: FOLDER })
    assert.deepEqual(files.map((f) => f.address).sort(), [DOC, PROJECT].sort())
  })

  it('draws and counts no id held by two files, or held only by a Folder', async () => {
    const twin = root(30851, QA2, PROJECT_D, OTHER_FOLDER)
    const folder = signed({ pubkey: RELAY, created_at: 1_787_000_000, kind: 39000, tags: [['d', OTHER_FOLDER], ['name', 'Ops']], content: '' })
    const query = relay([topicRoot, projectRoot, twin, folder, list(PROJECT_D, MS), list(OTHER_FOLDER, MS + 1)])
    const files = await topicList(query, { address: TOPIC, folder: FOLDER }, { fileKinds: [30840, 30842, 30850, 30851, 39000] })
    assert.deepEqual(
      files.map((f) => [f.file, f.address]),
      [
        [PROJECT_D, null],
        [OTHER_FOLDER, null],
      ],
    )
  })

  it('resolves every file of a long list from a relay that caps each lookup at 250 events', async () => {
    const ids = Array.from({ length: 300 }, (_, i) => `file-${String(i).padStart(3, '0')}`)
    const roots = ids.map((d) => root(30842, QA1, d, OTHER_FOLDER))
    const entries = ids.map((d, i) => list(d, MS + i))
    const all = relay([topicRoot, ...roots, ...entries])
    const capped = async (filters: Record<string, unknown>[]) =>
      filters.some((f) => '#d' in f) ? (await all(filters)).slice(0, 250) : all(filters)
    const files = await topicList(capped, { address: TOPIC, folder: FOLDER })
    assert.equal(files.length, 300)
    assert.equal(files.filter((f) => f.address === null).length, 0)
  })

  it('leaves out a file taken off and an entry filed in another Folder', async () => {
    const outside = retagged(list(PROJECT_D, MS + 10), (tags) => tags.map((t) => (t[0] === 'h' ? ['h', OTHER_FOLDER] : t)))
    const query = relay([topicRoot, projectRoot, docRoot, list(DOC_D, MS), unlist(DOC_D, MS + 2000), outside])
    assert.deepEqual(await topicList(query, { address: TOPIC, folder: FOLDER }), [])
  })
})

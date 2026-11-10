/**
 * ALO-15 — finding a file's parents, and whether one is archived, by the
 * relay's list read (SPEC §6.13).
 *
 * Peek and Leaf opened a project without its old changes, yet the same page
 * read every change of each project it drew as a parent, or walked through to
 * see whether a parent was archived. The claims under test:
 *
 * - with `listRead` (or the switched kinds, `openRead`), a parent is read as its
 *   first record and each field's current change, never by `#a`, and the answer
 *   is what a read of every change gives;
 * - a file the list read leaves out (deleted) is read as before, so a deleted
 *   parent is still found and still says it was archived;
 * - without the option, nothing changes.
 */
import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import { resolveForeignObject, resolveForeignRoots, resolveParents, filesOf, readTopics } from '../dist/index.js'

const OWNER = 'a'.repeat(64)
const OTHER = 'b'.repeat(64)
const TEAM = '22222222-0000-4000-8000-000000000002'
const PROJECT = 30850
const ISSUE = 30851
const CHANGE = 1851

let seq = 0
const event = (partial) => ({
  id: String(++seq).padStart(64, '0'),
  sig: '',
  pubkey: OWNER,
  created_at: 1_700_000_000 + seq,
  tags: [],
  content: '',
  ...partial,
})

const addressOf = (e) => `${e.kind}:${e.pubkey}:${e.tags.find((t) => t[0] === 'd')[1]}`

const ship = event({
  kind: 31990,
  tags: [['d', 'ship'], ['k', String(PROJECT)], ['k', String(ISSUE)]],
  content: JSON.stringify({
    name: 'Ship',
    records: { changeKind: CHANGE, targetTag: 'a', fieldTag: 'field', valueTag: 'value', order: ['ts', 'created_at', 'id'], rule: 'last-write-wins-per-field' },
    projections: {
      [PROJECT]: { widget: 'card', slots: { title: { fold: 'title', tag: 'title' }, list: { children: { kind: ISSUE, via: 'a', movedBy: 'project' } } } },
      [ISSUE]: { widget: 'row', slots: { title: { fold: 'title', tag: 'title' } } },
    },
  }),
})

const project = (d) => event({ kind: PROJECT, tags: [['d', d], ['title', d], ['h', TEAM]] })
const issue = (d, parent) => event({ kind: ISSUE, tags: [['d', d], ['title', d], ['a', addressOf(parent)], ['h', TEAM]] })
const change = (file, field, value, by = OWNER) =>
  event({ kind: CHANGE, pubkey: by, tags: [['a', addressOf(file)], ['field', field], ['value', value], ['h', TEAM]] })
/** Twenty text saves: the history a read by `#a` pays for and the list read does not. */
const edits = (file) => Array.from({ length: 20 }, (_, n) => change(file, 'description', `Draft ${n}`))

const matches = (f, e) => {
  if (f.kinds && !f.kinds.includes(e.kind)) return false
  if (f.authors && !f.authors.includes(e.pubkey)) return false
  for (const [key, want] of Object.entries(f)) {
    if (!key.startsWith('#')) continue
    const held = e.tags.filter((t) => t[0] === key.slice(1)).map((t) => t[1])
    if (!want.some((v) => held.includes(v))) return false
  }
  return true
}

/** A relay with §6.13's list read: a request is all `fields` or none, and a deleted file is left out. */
function relay(events) {
  const asked = []
  const query = async (filters) => {
    asked.push(filters)
    const byFields = filters.filter((f) => f.fields)
    if (byFields.length === 0) return events.filter((e) => filters.some((f) => matches(f, e)))
    if (byFields.length !== filters.length) throw new Error('fields: every filter must ask for "fields": "newest"')
    const roots = events.filter((e) => byFields.some((f) => matches(f, e)))
    return filesOf(events)
      .filter((file) => roots.includes(file.root) && file.fields.deleted?.value !== 'true')
      .flatMap((file) => file.events)
  }
  return {
    query,
    /** Every filter asked of the relay. */
    asked: () => asked.flat(),
    /** Every address whose changes were read one by one, by `#a` with the change kind. */
    changesByA: () => asked.flat().filter((f) => f.kinds?.includes(CHANGE)).flatMap((f) => f['#a'] ?? []),
  }
}

describe('resolveParents by the list read', () => {
  test('a moved issue’s parent is the project it was moved to, and no issue’s changes are read', async () => {
    const p1 = project('p1')
    const p2 = project('p2')
    const moved = issue('moved', p1)
    const stays = issue('stays', p1)
    const events = [ship, p1, p2, moved, stays, change(moved, 'project', addressOf(p2), OTHER), ...edits(moved), ...edits(stays)]
    const r = relay(events)
    const parents = await resolveParents([addressOf(moved), addressOf(stays)], r.query, undefined, { listRead: true })
    assert.deepEqual(parents, { [addressOf(moved)]: addressOf(p2), [addressOf(stays)]: addressOf(p1) })
    assert.deepEqual(r.changesByA(), [])
    // The same answer as a read of every change.
    assert.deepEqual(await resolveParents([addressOf(moved), addressOf(stays)], relay(events).query), parents)
  })

  test('a deleted issue, which the list read leaves out, still has its moved parent', async () => {
    const p1 = project('p1')
    const p2 = project('p2')
    const gone = issue('gone', p1)
    const r = relay([ship, p1, p2, gone, change(gone, 'project', addressOf(p2)), change(gone, 'deleted', 'true')])
    assert.deepEqual(await resolveParents([addressOf(gone)], r.query, undefined, { listRead: true }), { [addressOf(gone)]: addressOf(p2) })
    assert.deepEqual(r.changesByA(), [addressOf(gone)])
  })

  test('another author’s file with the same id does not answer for a deleted one, which keeps its moved parent', async () => {
    const p1 = project('p1')
    const p2 = project('p2')
    const mine = issue('twin', p1)
    const theirs = event({ kind: ISSUE, pubkey: OTHER, tags: [['d', 'twin'], ['title', 'twin'], ['a', addressOf(p1)], ['h', TEAM]] })
    const r = relay([ship, p1, p2, mine, theirs, change(theirs, 'project', addressOf(p2), OTHER), change(theirs, 'deleted', 'true', OTHER)])
    const parents = await resolveParents([addressOf(mine), addressOf(theirs)], r.query, undefined, { listRead: true })
    assert.deepEqual(parents, { [addressOf(mine)]: addressOf(p1), [addressOf(theirs)]: addressOf(p2) })
  })
})

describe('an archived parent, read by the list read', () => {
  const setup = ({ deleted = false } = {}) => {
    const shelved = project('shelved')
    const open = project('open')
    const under = issue('under', shelved)
    const fine = issue('fine', open)
    const events = [
      ship,
      shelved,
      open,
      under,
      fine,
      ...edits(shelved),
      ...edits(open),
      change(shelved, 'archived', 'true'),
      ...(deleted ? [change(shelved, 'deleted', 'true')] : []),
    ]
    return { shelved, open, under, fine, events }
  }

  test('an issue opened with the switched kinds is archived with its project, and no project’s changes are read', async () => {
    const { shelved, under, fine, events } = setup()
    const r = relay(events)
    const opened = await resolveForeignObject(addressOf(under), r.query, async () => ({}), 0, undefined, { archivedWith: true, openRead: [PROJECT] })
    const other = await resolveForeignObject(addressOf(fine), r.query, async () => ({}), 0, undefined, { archivedWith: true, openRead: [PROJECT] })
    assert.equal(opened.archived?.with, addressOf(shelved))
    assert.equal(other.archived, undefined)
    const projects = r.changesByA().filter((a) => a.startsWith(`${PROJECT}:`))
    assert.deepEqual(projects, [], `read by #a: ${projects}`)
  })

  test('with listRead and no switched kinds, an issue is archived with its project, and no project’s changes are read', async () => {
    const { shelved, under, events } = setup()
    const r = relay(events)
    const opened = await resolveForeignObject(addressOf(under), r.query, async () => ({}), 0, undefined, { archivedWith: true, listRead: true })
    assert.equal(opened.archived?.with, addressOf(shelved))
    assert.deepEqual(r.changesByA().filter((a) => a.startsWith(`${PROJECT}:`)), [])
  })

  test('issues listed by the list read are archived with their project, and no changes are read one by one', async () => {
    const { shelved, under, fine, events } = setup()
    const r = relay(events)
    const roots = await resolveForeignRoots([addressOf(under), addressOf(fine)], r.query, undefined, { archivedWith: true, listRead: true })
    const byD = Object.fromEntries(roots.map((o) => [o.address, o.archived?.with]))
    assert.deepEqual(byD, { [addressOf(under)]: addressOf(shelved), [addressOf(fine)]: undefined })
    assert.deepEqual(r.changesByA(), [])
  })

  test('a deleted archived project, which the list read leaves out, is read as before and still archives its issue', async () => {
    const { shelved, under, events } = setup({ deleted: true })
    const r = relay(events)
    const opened = await resolveForeignObject(addressOf(under), r.query, async () => ({}), 0, undefined, { archivedWith: true, openRead: [PROJECT] })
    assert.equal(opened.archived?.with, addressOf(shelved))
    assert.ok(r.changesByA().includes(addressOf(shelved)))
  })

  test('without the switched kinds, the project’s changes are read as before', async () => {
    const { shelved, under, events } = setup()
    const r = relay(events)
    const opened = await resolveForeignObject(addressOf(under), r.query, async () => ({}), 0, undefined, { archivedWith: true })
    assert.equal(opened.archived?.with, addressOf(shelved))
    assert.ok(r.changesByA().includes(addressOf(shelved)))
  })
})

describe('readTopics: a topic’s archived project, read by the list read', () => {
  const TOPIC = 30840
  const setup = () => {
    const shelved = project('shelved-t')
    const open = project('open-t')
    const topic = (d, parent) => event({ kind: TOPIC, tags: [['d', d], ['title', d], ['a', addressOf(parent)], ['h', TEAM]] })
    const under = topic('under-t', shelved)
    const fine = topic('fine-t', open)
    const text = change(under, 'description', 'The plan')
    const events = [ship, shelved, open, under, fine, ...edits(shelved), ...edits(open), change(shelved, 'archived', 'true'), text]
    return { shelved, under, fine, text, events }
  }

  test('with parentsListRead, a topic under an archived project is archived with it, and no project’s changes are read', async () => {
    const { shelved, under, fine, text, events } = setup()
    const r = relay(events)
    const read = await readTopics(r.query, OTHER, { parentsListRead: true })
    const archivedWith = Object.fromEntries(read.topics.map((t) => [t.address, t.object.archived?.with]))
    assert.deepEqual(archivedWith, { [addressOf(under)]: addressOf(shelved), [addressOf(fine)]: undefined })
    const projects = r.changesByA().filter((a) => a.startsWith(`${PROJECT}:`))
    assert.deepEqual(projects, [], `read by #a: ${projects}`)
    // The topics themselves are still read in full, their text with them: its newest change is known, so it can be edited.
    assert.equal(read.topics.find((t) => t.address === addressOf(under)).object.prevs?.description, text.id)
  })

  test('without parentsListRead, the archived project’s changes are read as before', async () => {
    const { shelved, under, events } = setup()
    const r = relay(events)
    const read = await readTopics(r.query, OTHER)
    assert.equal(read.topics.find((t) => t.address === addressOf(under)).object.archived?.with, addressOf(shelved))
    assert.ok(r.changesByA().includes(addressOf(shelved)))
  })
})

describe('resolveForeignRoots with children, by the list read (TOPI-8)', () => {
  const move = (file, to, by = OWNER) =>
    event({ kind: CHANGE, pubkey: by, tags: [['a', addressOf(file)], ['field', 'project'], ['value', addressOf(to)], ['A', addressOf(to)], ['h', TEAM]] })

  test('a file comes back with the files under it now: created here, moved in, not moved away or archived; and no text or change history is read', async () => {
    const p1 = project('p1')
    const p2 = project('p2')
    const stays = issue('stays', p1)
    const away = issue('away', p1)
    const shelved = issue('shelved', p1)
    const arrived = issue('arrived', p2)
    const events = [
      ship, p1, p2, stays, away, shelved, arrived,
      move(away, p2, OTHER), move(arrived, p1, OTHER),
      change(stays, 'title', 'Stays, renamed', OTHER),
      change(shelved, 'archived', 'true'),
      ...edits(stays), ...edits(p1),
    ]
    const r = relay(events)
    const roots = await resolveForeignRoots([addressOf(p1)], r.query, undefined, { listRead: true, children: true })
    assert.deepEqual(roots.map((o) => o.address), [addressOf(p1)])
    const children = roots[0].children ?? []
    assert.deepEqual(new Set(children.map((c) => c.slots.title?.value)), new Set(['Stays, renamed', 'arrived']))
    // Who changed a child last, from its current changes alone.
    assert.equal(children.find((c) => c.address === addressOf(stays)).changedBy, OTHER)
    assert.deepEqual(r.changesByA(), [])
    // The children are asked by the list read, which never carries text: no plain read of them by `#a`.
    const byParent = r.asked().filter((f) => f.kinds?.includes(ISSUE) && f['#a']?.includes(addressOf(p1)))
    assert.ok(byParent.length > 0)
    assert.ok(byParent.every((f) => f.fields === 'newest'), JSON.stringify(byParent))
  })

  test('without children, nothing under the file is read', async () => {
    const p1 = project('p1')
    const r = relay([ship, p1, issue('stays', p1)])
    const [root] = await resolveForeignRoots([addressOf(p1)], r.query, undefined, { listRead: true })
    assert.equal(root.children, undefined)
    assert.deepEqual(r.asked().filter((f) => f['#a']?.includes(addressOf(p1)) || f['#A']?.includes(addressOf(p1))), [])
  })
})

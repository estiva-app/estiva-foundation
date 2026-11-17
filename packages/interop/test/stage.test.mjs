/**
 * A status counts by the stage on its change — EAC-2, SPEC §6.2 and §7.4.
 *
 * Peek's and Leaf's project card draws `progress` and the `[` picker sorts by
 * `isClosedStatus`; both read the status slot's `stage`. The claims under test:
 *
 * - a change's `["stage", "status", …]` is what counts, for an id no listing
 *   names too, and that id is shown as itself in the neutral grey;
 * - a change with no stage counts as before: the directory's stage for the id
 *   (TYPES.md), never the manifest's, then the words;
 * - a stage naming another field, outside the four, or on an older change than
 *   the winning one counts for nothing; a root's stage counts until a change;
 * - progress is done over everything not dropped (Miky, 17 Nov).
 */
import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import { resolveForeignObject, isClosedStatus } from '../dist/index.js'

const SHIP = 'a'.repeat(64)
const PROJECT = 30850
const ISSUE = 30851

let seq = 0
const event = (partial) => ({
  id: String(++seq).padStart(64, '0'),
  sig: '',
  pubkey: SHIP,
  created_at: 1_700_000_000 + seq,
  tags: [],
  content: '',
  ...partial,
})

const relay = (events) => async (filters) =>
  events.filter((e) =>
    filters.some((f) => {
      if (f.kinds && !f.kinds.includes(e.kind)) return false
      if (f.authors && !f.authors.includes(e.pubkey)) return false
      if (f.ids && !f.ids.includes(e.id)) return false
      for (const [key, want] of Object.entries(f)) {
        if (!key.startsWith('#')) continue
        const held = e.tags.filter((t) => t[0] === key.slice(1)).map((t) => t[1])
        if (!want.some((v) => held.includes(v))) return false
      }
      return true
    }),
  )

/** A tracker whose listing gives stages that disagree with the directory's, so a test can tell which was read. */
const TRACKER = {
  name: 'Tracker',
  records: { changeKind: 1851, targetTag: 'a', fieldTag: 'field', valueTag: 'value' },
  vocabularies: {
    issueStatuses: [
      { value: 'todo', label: 'Todo', colour: 'neutral', stage: 'open' },
      { value: 'in_progress', label: 'In Progress', colour: 'blue', stage: 'started' },
      { value: 'done', label: 'Done', colour: 'green', stage: 'done' },
      { value: 'cancelled', label: 'Cancelled', colour: 'muted', stage: 'dropped' },
      // A listing that says "Afgerond" is done: the reader must not believe it for a base type.
      { value: 'afgerond', label: 'Afgerond', colour: 'green', stage: 'done' },
    ],
  },
  projections: {
    [PROJECT]: { widget: 'card', slots: { title: { tag: 'title' }, list: { children: { kind: ISSUE, via: 'a', limit: 200 } } } },
    [ISSUE]: { widget: 'row', slots: { title: { tag: 'title' }, status: { fold: 'status', map: 'issueStatuses', default: 'todo' } } },
  },
}

const projectAddress = `${PROJECT}:${SHIP}:p1`
const issueAddress = (d) => `${ISSUE}:${SHIP}:${d}`
const manifest = () =>
  event({ kind: 31990, tags: [['d', 'tracker'], ['k', String(PROJECT)], ['k', String(ISSUE)]], content: JSON.stringify(TRACKER) })
const issue = (d, extra = []) => event({ kind: ISSUE, tags: [['d', d], ['title', d], ['a', projectAddress], ...extra] })
const status = (d, value, extra = []) => event({ kind: 1851, tags: [['a', issueAddress(d)], ['field', 'status'], ['value', value], ...extra] })

async function card(...events) {
  const object = await resolveForeignObject(projectAddress, relay([manifest(), event({ kind: PROJECT, tags: [['d', 'p1'], ['title', 'P']] }), ...events]))
  const byTitle = Object.fromEntries(object.children.map((c) => [c.slots.title.value, c.slots.status]))
  return { object, byTitle }
}

describe('a status no listing names', () => {
  test('counts by the stage its change carries, and shows by its id in the neutral grey', async () => {
    const { object, byTitle } = await card(
      issue('blocked'),
      status('blocked', 'blocked', [['stage', 'status', 'started']]),
      issue('shipped'),
      status('shipped', 'shipped', [['stage', 'status', 'done']]),
    )
    assert.deepEqual(
      { value: byTitle.blocked.value, colour: byTitle.blocked.colour, stage: byTitle.blocked.stage },
      { value: 'blocked', colour: 'neutral', stage: 'started' },
    )
    assert.equal(isClosedStatus(byTitle.blocked), false, '`[` lists it as open')
    assert.equal(isClosedStatus(byTitle.shipped), true)
    assert.deepEqual(object.progress, { done: 1, total: 2 })
  })

  test('with no stage, is underway: in the total, not done', async () => {
    const { object, byTitle } = await card(issue('blocked'), status('blocked', 'blocked'))
    assert.equal(byTitle.blocked.stage, undefined)
    assert.equal(isClosedStatus(byTitle.blocked), false)
    assert.deepEqual(object.progress, { done: 0, total: 1 })
  })
})

describe('a change with no stage — the control', () => {
  test('counts by the directory: done is done, cancelled is out of both numbers', async () => {
    const { object, byTitle } = await card(
      issue('a'),
      status('a', 'done'),
      issue('b'),
      status('b', 'cancelled'),
      issue('c'),
      status('c', 'in_progress'),
      issue('d'),
    )
    assert.deepEqual(
      Object.fromEntries(Object.entries(byTitle).map(([t, s]) => [t, s.stage])),
      { a: 'done', b: 'dropped', c: 'started', d: 'open' },
    )
    assert.equal(isClosedStatus(byTitle.b), true, 'a cancelled issue sorts after the open ones in `[`')
    assert.deepEqual(object.progress, { done: 1, total: 3 })
  })

  test('counts by the directory’s stage for the id, even when neither the id nor its label is a word the reader knows', async () => {
    // A project's `planned`, labelled "Later": no word list reads either; TYPES.md says it is open.
    const withProjects = structuredClone(TRACKER)
    withProjects.vocabularies.projectStatuses = [{ value: 'planned', label: 'Later', colour: 'neutral', stage: 'done' }]
    withProjects.projections[PROJECT].slots.status = { fold: 'status', map: 'projectStatuses' }
    const events = [
      event({ kind: 31990, tags: [['d', 'tracker'], ['k', String(PROJECT)], ['k', String(ISSUE)]], content: JSON.stringify(withProjects) }),
      event({ kind: PROJECT, tags: [['d', 'p1'], ['title', 'P']] }),
      event({ kind: 1851, tags: [['a', projectAddress], ['field', 'status'], ['value', 'planned']] }),
    ]
    const object = await resolveForeignObject(projectAddress, relay(events))
    assert.equal(object.slots.status.value, 'Later')
    assert.equal(object.slots.status.stage, 'open', 'the directory’s stage, not the words’ nothing nor the listing’s done')
    assert.equal(isClosedStatus(object.slots.status), false)
  })

  test('never takes a base type’s stage from the manifest it resolved (SPEC §7.4)', async () => {
    const { object } = await card(issue('a'), status('a', 'afgerond'))
    assert.deepEqual(object.progress, { done: 0, total: 1 })
  })
})

describe('which stage counts', () => {
  test('the change’s, even where the directory gives the id another', async () => {
    const { object } = await card(issue('a'), status('a', 'todo', [['stage', 'status', 'done']]))
    assert.deepEqual(object.progress, { done: 1, total: 1 })
  })

  test('not one naming another field, nor one outside the four', async () => {
    const { object } = await card(
      issue('a'),
      status('a', 'blocked', [['stage', 'title', 'done']]),
      issue('b'),
      status('b', 'blocked', [['stage', 'status', 'finished']]),
    )
    assert.deepEqual(object.progress, { done: 0, total: 2 })
  })

  test('the winning change’s: a later change with none leaves none', async () => {
    const { object } = await card(
      issue('a'),
      status('a', 'blocked', [['stage', 'status', 'done']]),
      status('a', 'blocked'),
    )
    assert.deepEqual(object.progress, { done: 0, total: 1 })
  })

  test('a root’s, until a change sets the field', async () => {
    // A creation that sets the status carries it as a tag the slot seeds from, and its stage beside it.
    const seeded = structuredClone(TRACKER)
    seeded.projections[ISSUE].slots.status.tag = 'status'
    const events = [
      event({ kind: 31990, tags: [['d', 'tracker'], ['k', String(PROJECT)], ['k', String(ISSUE)]], content: JSON.stringify(seeded) }),
      event({ kind: PROJECT, tags: [['d', 'p1'], ['title', 'P']] }),
      issue('a', [['status', 'blocked'], ['stage', 'status', 'done']]),
    ]
    const object = await resolveForeignObject(projectAddress, relay(events))
    assert.deepEqual(object.progress, { done: 1, total: 1 })
    events.push(status('a', 'blocked', [['stage', 'status', 'started']]))
    assert.deepEqual((await resolveForeignObject(projectAddress, relay(events))).progress, { done: 0, total: 1 })
  })
})

test('a card with no children, or a child with no status, has no progress', async () => {
  const bare = structuredClone(TRACKER)
  delete bare.projections[ISSUE].slots.status
  const events = [
    event({ kind: 31990, tags: [['d', 'tracker'], ['k', String(PROJECT)], ['k', String(ISSUE)]], content: JSON.stringify(bare) }),
    event({ kind: PROJECT, tags: [['d', 'p1'], ['title', 'P']] }),
  ]
  assert.equal((await resolveForeignObject(projectAddress, relay(events))).progress, undefined)
  events.push(issue('a'))
  const object = await resolveForeignObject(projectAddress, relay(events))
  assert.equal(object.children.length, 1)
  assert.equal(object.progress, undefined)
})

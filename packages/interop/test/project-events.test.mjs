/**
 * `projectEvents` — PER-21. Events the caller already holds, projected exactly
 * as `resolveForeignObject` projects them, with no requests.
 *
 * Asserted against the network reader itself rather than against expected
 * values: the claim is "the same object", and a hand-written expectation would
 * only prove the two agree with the author of this test.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { projectEvents, resolveForeignObject, resolveManifest } from '../dist/index.js'
import { encodeNaddr } from '@estiva-app/protocol'

const APP = 'c'.repeat(64)
const AUTHOR = 'a'.repeat(64)
const OTHER = 'b'.repeat(64)
const FOLDER = '7b32200c-e4c0-4216-b79a-8490fc05e0bd'

let seq = 0
const event = (partial) => ({
  id: String(++seq).padStart(64, '0'),
  sig: '',
  pubkey: AUTHOR,
  created_at: 1_700_000_000 + seq,
  tags: [],
  content: '',
  ...partial,
})

const manifest = event({
  kind: 31990,
  pubkey: APP,
  tags: [['d', 'tracker'], ['k', '30850'], ['k', '30851']],
  content: JSON.stringify({
    name: 'Tracker',
    records: { changeKind: 1851, targetTag: 'a', fieldTag: 'field', valueTag: 'value', order: ['ts', 'created_at', 'id'], rule: 'last-write-wins-per-field' },
    projections: {
      30850: {
        widget: 'card',
        slots: { title: { tag: 'title', fold: 'title' }, list: { children: { kind: 30851, via: 'a', limit: 200, movedBy: 'project' } } },
      },
      30851: {
        widget: 'row',
        slots: { title: { tag: 'title', fold: 'title' }, status: { fold: 'status', map: 'statuses', default: 'todo' }, meta: [{ label: 'Assignee', fold: 'assignee', as: 'pubkey' }] },
      },
    },
    vocabularies: { statuses: [{ value: 'todo', label: 'Todo', colour: 'muted' }, { value: 'done', label: 'Done', colour: 'green' }] },
    actions: [],
  }),
})

const project = event({ kind: 30850, tags: [['d', 'p1'], ['title', 'Payments'], ['h', FOLDER]] })
const PROJECT = `30850:${AUTHOR}:p1`
const target = event({ kind: 30850, tags: [['d', 'p2'], ['title', 'Billing'], ['h', FOLDER]] })
const TARGET = `30850:${AUTHOR}:p2`
const issue = event({ kind: 30851, tags: [['d', 'i1'], ['title', 'Filed title'], ['a', PROJECT], ['h', FOLDER]] })
const ISSUE = `30851:${AUTHOR}:i1`
const change = (field, value, extra = {}) =>
  event({ kind: 1851, pubkey: OTHER, tags: [['a', ISSUE], ['field', field], ['value', value], ['h', FOLDER]], ...extra })

const renamed = change('title', 'Renamed')
const done = change('status', 'done')
const assigned = change('assignee', OTHER)
const archived = change('archived', 'true')
// The issue moved to another project: `movedBy` folds over the `a` it was filed with.
const moved = change('project', TARGET)
const events = [manifest, project, target, issue, renamed, done, assigned, archived, moved]

/** A relay over `events`, answering the filter shapes the resolver sends. */
const query = async (filters) => {
  const hit = new Map()
  for (const f of filters) {
    for (const e of events) {
      if (f.ids && !f.ids.includes(e.id)) continue
      if (f.kinds && !f.kinds.includes(e.kind)) continue
      if (f.authors && !f.authors.includes(e.pubkey)) continue
      const tagsOk = Object.entries(f).every(([k, v]) => !k.startsWith('#') || e.tags.some((t) => t[0] === k.slice(1) && v.includes(t[1])))
      if (tagsOk) hit.set(e.id, e)
    }
  }
  return [...hit.values()]
}

const pointer = (address) => {
  const [kind, pubkey, identifier] = address.split(':')
  return { kind: Number(kind), pubkey, identifier, relays: [] }
}

test('each root comes back as the object resolveForeignObject builds, minus what needs a read', async () => {
  const resolved = await resolveManifest(pointer(ISSUE), query)
  assert.ok(resolved, 'the manifest resolves over the fake relay')
  const projected = projectEvents(events, () => resolved)
  assert.deepEqual(projected.map((o) => o.address).sort(), [ISSUE, PROJECT, TARGET].sort())

  for (const object of projected) {
    const network = await resolveForeignObject(encodeNaddr(pointer(object.address)), query, async () => ({}))
    // Reads the pure path deliberately does not make.
    const { comments, children, people, ...same } = network
    assert.deepEqual(object.comments, [])
    assert.deepEqual({ ...object, comments: undefined }, { ...same, comments: undefined }, object.address)
  }
})

test('the fold, the archive and the parent are read from the held changes', async () => {
  const resolved = await resolveManifest(pointer(ISSUE), query)
  const issueObject = projectEvents(events, () => resolved).find((o) => o.address === ISSUE)
  assert.equal(issueObject.slots.title.value, 'Renamed')
  assert.equal(issueObject.slots.status.value, 'Done')
  assert.equal(issueObject.meta[0].value, OTHER)
  assert.ok(issueObject.archived, 'an archived change marks it archived')
  assert.equal(issueObject.parentRef, TARGET, 'the move folds over the project it was filed under')
  const projectObject = projectEvents(events, () => resolved).find((o) => o.address === PROJECT)
  assert.equal(projectObject.listsChildren, true)
  assert.equal(projectObject.children, undefined, 'children are other objects in the answer, not nested here')
})

test('two versions of one root collapse by NIP-01: later created_at, then the lower id', async () => {
  const resolved = await resolveManifest(pointer(ISSUE), query)
  const tie = (title, id) => ({ ...project, id: id.repeat(64), created_at: 1_800_000_000, tags: [['d', 'p1'], ['title', title], ['h', FOLDER]] })
  for (const order of [[tie('kept', '1'), tie('dropped', '9')], [tie('dropped', '9'), tie('kept', '1')]]) {
    const [object] = projectEvents([project, ...order], () => resolved)
    assert.equal(object.slots.title.value, 'kept')
  }
})

test('a kind the manifest does not project, and an event with no d, are not objects', async () => {
  const resolved = await resolveManifest(pointer(ISSUE), query)
  const stray = event({ kind: 30840, tags: [['d', 'x']] })
  const noD = event({ kind: 30851, tags: [['title', 'no d']] })
  assert.deepEqual(projectEvents([stray, noD, renamed], () => resolved), [])
})

test('each root is read through its own author\'s manifest, as resolveForeignObject reads it', async () => {
  const resolved = await resolveManifest(pointer(ISSUE), query)
  const recommended = { ...resolved, viaRecommendation: true }
  const guessed = { ...resolved, viaRecommendation: false }
  const byOther = event({ kind: 30851, pubkey: OTHER, tags: [['d', 'i9'], ['title', 'Theirs'], ['h', FOLDER]] })
  const asked = []
  const objects = projectEvents([project, byOther], (p) => (asked.push(p.pubkey), p.pubkey === AUTHOR ? recommended : guessed))
  assert.equal(objects.find((o) => o.address === PROJECT).viaRecommendation, true)
  assert.equal(objects.find((o) => o.address === `30851:${OTHER}:i9`).viaRecommendation, false, 'not the other author\'s recommendation')
  assert.deepEqual([...new Set(asked)].sort(), [AUTHOR, OTHER].sort())
  // An author whose kind no manifest claims is not drawn by somebody else's.
  assert.deepEqual(projectEvents([project, byOther], (p) => (p.pubkey === AUTHOR ? resolved : undefined)).map((o) => o.address), [PROJECT])
})

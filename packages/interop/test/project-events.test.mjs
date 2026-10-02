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
      30850: { widget: 'card', slots: { title: { tag: 'title', fold: 'title' } } },
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
const issue = event({ kind: 30851, tags: [['d', 'i1'], ['title', 'Filed title'], ['a', PROJECT], ['h', FOLDER]] })
const ISSUE = `30851:${AUTHOR}:i1`
const change = (field, value, extra = {}) =>
  event({ kind: 1851, pubkey: OTHER, tags: [['a', ISSUE], ['field', field], ['value', value], ['h', FOLDER]], ...extra })

const renamed = change('title', 'Renamed')
const done = change('status', 'done')
const assigned = change('assignee', OTHER)
const archived = change('archived', 'true')
const events = [manifest, project, issue, renamed, done, assigned, archived]

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
  const projected = projectEvents(events, resolved)
  assert.deepEqual(projected.map((o) => o.address).sort(), [ISSUE, PROJECT].sort())

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
  const issueObject = projectEvents(events, resolved).find((o) => o.address === ISSUE)
  assert.equal(issueObject.slots.title.value, 'Renamed')
  assert.equal(issueObject.slots.status.value, 'Done')
  assert.equal(issueObject.meta[0].value, OTHER)
  assert.ok(issueObject.archived, 'an archived change marks it archived')
  assert.equal(issueObject.parentRef, undefined, 'no list slot declared, so no parent relation')
})

test('two versions of one root collapse by NIP-01: later created_at, then the lower id', async () => {
  const resolved = await resolveManifest(pointer(ISSUE), query)
  const tie = (title, id) => ({ ...project, id: id.repeat(64), created_at: 1_800_000_000, tags: [['d', 'p1'], ['title', title], ['h', FOLDER]] })
  for (const order of [[tie('kept', '1'), tie('dropped', '9')], [tie('dropped', '9'), tie('kept', '1')]]) {
    const [object] = projectEvents([project, ...order], resolved)
    assert.equal(object.slots.title.value, 'kept')
  }
})

test('a kind the manifest does not project, and an event with no d, are not objects', async () => {
  const resolved = await resolveManifest(pointer(ISSUE), query)
  const stray = event({ kind: 30840, tags: [['d', 'x']] })
  const noD = event({ kind: 30851, tags: [['title', 'no d']] })
  assert.deepEqual(projectEvents([stray, noD, renamed], resolved), [])
})

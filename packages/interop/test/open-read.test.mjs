/**
 * Opening a file by the relay's open read — ALO-6, SPEC §6.13.
 *
 * The claims under test:
 *
 * - a file of a kind the caller opens by fields is read as its first record,
 *   each field's current change and its current text, and none of its changes
 *   by `#a`; it draws what a read of every change draws;
 * - each changed field's current change id comes with it, the `prev` its next
 *   change names;
 * - a deleted file, which the open read leaves out, is read as before and says
 *   who deleted it; a restored one does not;
 * - many files open in one read per author and kind, apart from plain reads.
 */
import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
// By namespace, so on a build without `prevOf` only the test that calls it fails.
import * as interop from '../dist/index.js'

const { resolveForeignObject, resolveForeignObjects, filesOf } = interop

const OWNER = 'a'.repeat(64)
const OTHER = 'b'.repeat(64)
const TEAM = '22222222-0000-4000-8000-000000000002'
const PLAN = 30850

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

const app = event({
  kind: 31990,
  tags: [['d', 'plans'], ['k', String(PLAN)]],
  content: JSON.stringify({
    name: 'Plans',
    records: { changeKind: 1851, targetTag: 'a', fieldTag: 'field', valueTag: 'value', order: ['ts', 'created_at', 'id'], rule: 'last-write-wins-per-field' },
    projections: { [PLAN]: { widget: 'card', slots: { title: { fold: 'title', tag: 'title' }, body: { fold: 'description', tag: 'description' } } } },
  }),
})

const plan = (d, title) => event({ kind: PLAN, tags: [['d', d], ['title', title], ['description', 'First words'], ['h', TEAM]] })
const change = (file, field, value, by = OWNER) =>
  event({ kind: 1851, pubkey: by, tags: [['a', addressOf(file)], ['field', field], ['value', value], ['h', TEAM]] })

const plain = (events) => async (filters) =>
  events.filter((e) =>
    filters.some((f) => {
      if (f.kinds && !f.kinds.includes(e.kind)) return false
      if (f.authors && !f.authors.includes(e.pubkey)) return false
      for (const [key, want] of Object.entries(f)) {
        if (!key.startsWith('#')) continue
        const held = e.tags.filter((t) => t[0] === key.slice(1)).map((t) => t[1])
        if (!want.some((v) => held.includes(v))) return false
      }
      return true
    }),
  )

/** A relay with §6.13's read: a request is all `fields` or none, and a deleted file is left out. */
const opening = (events) => {
  const asked = []
  const query = async (filters) => {
    asked.push(filters)
    const byFields = filters.filter((f) => f.fields)
    if (byFields.length === 0) return plain(events)(filters)
    if (byFields.length !== filters.length) throw new Error('fields: every filter must ask for "fields": "newest"')
    if (byFields.some((f) => f.text && !f['#d']?.length)) throw new Error('text: only with #d')
    const roots = await plain(events)(byFields)
    return filesOf(events, { withText: byFields.some((f) => f.text) })
      .filter((file) => roots.includes(file.root) && file.fields.deleted?.value !== 'true')
      .flatMap((file) => file.events)
  }
  return {
    query,
    /** Every value asked for by `#a` with the change kind: a file's changes read one by one. */
    changesByA: () => asked.flat().filter((f) => f.kinds?.includes(1851)).flatMap((f) => f['#a'] ?? []),
    opens: () => asked.flat().filter((f) => f.fields),
  }
}

const noPeople = async () => ({})

describe('opening a file by the open read (ALO-6)', () => {
  const launch = plan('launch', 'Launch')
  const older = [change(launch, 'description', 'Older words'), change(launch, 'title', 'Launch v2')]
  const renamed = change(launch, 'title', 'Launch, renamed')
  const words = change(launch, 'description', 'Newest words', OTHER)
  const events = [app, launch, ...older, renamed, words]

  test('a project opened by fields reads none of its changes by `#a`, and draws its newest title and text', async () => {
    const relay = opening(events)
    const object = await resolveForeignObject(addressOf(launch), relay.query, noPeople, 0, undefined, { openRead: [PLAN] })
    assert.equal(object.slots.title?.value, 'Launch, renamed')
    assert.equal(object.slots.body?.value, 'Newest words')
    assert.deepEqual(relay.changesByA(), [], 'no change is read by `#a`')
    assert.deepEqual(relay.opens().map((f) => [f['#d'], f.text]), [[['launch'], true]], 'one open read, with the text')
  })

  test('without the option the same project reads every change, and draws the same', async () => {
    const relay = opening(events)
    const object = await resolveForeignObject(addressOf(launch), relay.query, noPeople)
    assert.equal(object.slots.title?.value, 'Launch, renamed')
    assert.equal(object.slots.body?.value, 'Newest words')
    assert.deepEqual(relay.changesByA(), [addressOf(launch)])
    assert.deepEqual(relay.opens(), [])
  })

  test('each changed field names its current change as the next `prev`; an unchanged one names the first record', async () => {
    const object = await resolveForeignObject(addressOf(launch), opening(events).query, noPeople, 0, undefined, { openRead: [PLAN] })
    assert.equal(object.prevs?.title, renamed.id)
    assert.equal(object.prevs?.description, words.id)
    assert.equal(typeof interop.prevOf, 'function', 'prevOf is exported')
    assert.equal(interop.prevOf(object, 'title'), renamed.id)
    assert.equal(interop.prevOf(object, 'status'), launch.id)
  })

  test('a project read by a list names no `prev` for its text, which the list does not carry', async () => {
    const [listed] = await interop.resolveForeignRoots([addressOf(launch)], opening(events).query, undefined, { listRead: true })
    assert.equal(listed.prevs?.title, renamed.id)
    assert.equal(typeof interop.prevOf, 'function', 'prevOf is exported')
    assert.equal(interop.prevOf(listed, 'description'), undefined, 'not the first record: its text is unread')
  })

  test('a deleted project, which the open read leaves out, is read whole and says who deleted it', async () => {
    const gone = change(launch, 'deleted', 'true', OTHER)
    const relay = opening([...events, gone])
    const object = await resolveForeignObject(addressOf(launch), relay.query, noPeople, 0, undefined, { openRead: [PLAN] })
    assert.equal(object.unreachable, undefined)
    assert.deepEqual(object.deleted, { by: OTHER, at: gone.created_at })
    assert.equal(object.slots.title?.value, 'Launch, renamed', 'still drawn, for the notice and Restore')
    assert.deepEqual(relay.changesByA(), [addressOf(launch)], 'its changes are read only because the open read left it out')

    const back = change(launch, 'deleted', '')
    const restored = await resolveForeignObject(addressOf(launch), opening([...events, gone, back]).query, noPeople, 0, undefined, { openRead: [PLAN] })
    assert.equal(restored.deleted, undefined)
  })

  test('a file whose first record names no team is not deleted by a change, which no team can make', async () => {
    const bare = event({ kind: PLAN, tags: [['d', 'bare'], ['title', 'Bare']] })
    // No `h` either, so nothing tells it apart from the root's own team.
    const gone = event({ kind: 1851, pubkey: OTHER, tags: [['a', addressOf(bare)], ['field', 'deleted'], ['value', 'true']] })
    const object = await resolveForeignObject(addressOf(bare), opening([app, bare, gone]).query, noPeople, 0, undefined, { openRead: [PLAN] })
    assert.equal(object.unreachable, undefined)
    assert.equal(object.slots.title?.value, 'Bare')
    assert.equal(object.deleted, undefined)
  })

  test('a file nobody can read is still unreachable, not deleted', async () => {
    const missing = `${PLAN}:${OWNER}:nowhere`
    const object = await resolveForeignObject(missing, opening(events).query, noPeople, 0, undefined, { openRead: [PLAN] })
    assert.equal(object.unreachable, true)
    assert.equal(object.deleted, undefined)
  })

  test('many projects open in one read per author and kind, never mixed with a plain read', async () => {
    const roadmap = plan('roadmap', 'Roadmap')
    const relay = opening([...events, roadmap, change(roadmap, 'title', 'Roadmap 2027')])
    const objects = await resolveForeignObjects([addressOf(launch), addressOf(roadmap)], relay.query, noPeople, undefined, { openRead: [PLAN] })
    assert.deepEqual(
      [addressOf(launch), addressOf(roadmap)].map((a) => objects[a]?.slots.title?.value),
      ['Launch, renamed', 'Roadmap 2027'],
    )
    assert.deepEqual(relay.opens().map((f) => [f.authors, f['#d']]), [[[OWNER], ['launch', 'roadmap']]])
    assert.deepEqual(relay.changesByA(), [])
  })
})

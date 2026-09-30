/**
 * MAN-8 — an action one app declares on a kind another app owns.
 *
 * Ship declares `add-project` with `appliesTo: "39000"`: a project is made *in
 * a Folder*. A Folder is Peek's kind, so `resolveManifest` answers with Peek's
 * manifest and a Folder resolved with Peek's `start-a-conversation` alone —
 * Ship's declaration was on the relay and no consumer could reach it. Measured
 * on production 2026-09-30.
 *
 * The fixtures are two apps nobody wrote, as `action-conformance` uses: a
 * conversation app that owns the Folder's projection, and a ledger that makes
 * its books in Folders. The Folder is the relay's `kind:39000`, as on
 * production.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  buildActionEvents,
  createProjectionCache,
  resolveActingManifest,
  resolveForeignObject,
  resolveForeignObjects,
  KIND_CHANNEL_METADATA,
} from '../dist/index.js'

const RELAY = 'f'.repeat(64)
const TALK_APP = 'a'.repeat(64)
const LEDGER_APP = 'b'.repeat(64)
const STAGING = 'c'.repeat(64)
const PERSON = 'd'.repeat(64)
const BOOK = 30870
const ENTRY = 30871
const FOLDER = '7b32200c-e4c0-4216-b79a-8490fc05e0bd'
const OTHER_FOLDER = '0e2f4c1a-5b6d-4e7f-8a9b-0c1d2e3f4a5b'
const FOLDER_ADDRESS = `${KIND_CHANNEL_METADATA}:${RELAY}:${FOLDER}`

let seq = 0
const event = (partial) => ({
  id: String(++seq).padStart(64, '0'),
  sig: '',
  pubkey: RELAY,
  created_at: 1_700_000_000 + seq,
  tags: [],
  content: '',
  ...partial,
})

function countingRelay(events) {
  const calls = []
  const query = async (filters) => {
    calls.push(filters)
    return events.filter((e) =>
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
  }
  return { query, calls }
}

const startTalking = {
  id: 'start-talking',
  label: 'Start talking',
  description: 'Open a conversation in this Folder with a first message.',
  effect: 'writes',
  appliesTo: String(KIND_CHANNEL_METADATA),
  emits: { kind: 9, toAddressOf: 'self' },
  input: { type: 'object', properties: { message: { type: 'string', target: 'content' } }, required: ['message'] },
}

/** The app that draws a Folder — Peek's role. */
const talk = event({
  kind: 31990,
  pubkey: TALK_APP,
  tags: [['d', 'talk'], ['k', String(KIND_CHANNEL_METADATA)], ['k', '9']],
  content: JSON.stringify({
    name: 'Talk',
    projections: {
      [KIND_CHANNEL_METADATA]: { widget: 'card', slots: { title: { tag: 'name' } } },
      9: { widget: 'card', slots: { body: { field: 'content' } } },
    },
    actions: [startTalking],
  }),
})

const openBook = {
  id: 'open-book',
  label: 'New book',
  description: 'Open a ledger book in a Folder, with a name.',
  effect: 'writes',
  appliesTo: String(KIND_CHANNEL_METADATA),
  emits: { kind: BOOK, placement: 'buzz-channel', listed: true },
  input: { type: 'object', properties: { name: { type: 'string' } }, required: ['name'] },
}

/** An app that makes its own kind in someone else's — Ship's role. */
const ledgerManifest = (pubkey, extraActions = []) =>
  event({
    kind: 31990,
    pubkey,
    tags: [['d', 'ledger'], ['k', String(BOOK)], ['k', String(ENTRY)]],
    content: JSON.stringify({
      name: pubkey === STAGING ? 'Ledger (staging)' : 'Ledger',
      records: { changeKind: 1851, targetTag: 'a', fieldTag: 'field', valueTag: 'value', rule: 'last-write-wins-per-field' },
      projections: {
        [BOOK]: { widget: 'card', slots: { title: { tag: 'name' } } },
        [ENTRY]: { widget: 'row', slots: { title: { tag: 'title' } } },
      },
      actions: [openBook, ...extraActions],
    }),
  })

const folder = (id = FOLDER) => event({ kind: KIND_CHANNEL_METADATA, tags: [['d', id], ['name', 'Accounts']] })

test('a Folder offers the creation another app declares on it, and says whose it is', async () => {
  const ledger = ledgerManifest(LEDGER_APP)
  const { query } = countingRelay([talk, ledger, folder()])
  const found = await resolveForeignObject(FOLDER_ADDRESS, query)

  assert.equal(found.appName, 'Talk', 'the Folder is still drawn by its owner')
  assert.deepEqual(
    found.actions.map((a) => [a.id, a.declaredBy?.address]),
    [
      ['start-talking', undefined],
      ['open-book', `31990:${LEDGER_APP}:ledger`],
    ],
    "the owner's actions first, then the borrowed one naming its manifest",
  )
  const borrowed = found.actions[1]
  assert.equal(borrowed.control, 'form')
  assert.equal(borrowed.declaredBy.appName, 'Ledger')
  assert.equal(borrowed.listed, true)
  assert.deepEqual(borrowed.fields.map((f) => f.name), ['name'])
})

test('acting with the declaring manifest builds the other app’s object in the Folder', async () => {
  const ledger = ledgerManifest(LEDGER_APP)
  const { query } = countingRelay([talk, ledger, folder()])
  const pointer = { kind: KIND_CHANNEL_METADATA, pubkey: RELAY, identifier: FOLDER, relays: [] }

  const owner = await resolveActingManifest(pointer, undefined, query)
  assert.equal(owner.manifest.name, 'Talk', 'no declaredBy is the owner, exactly as resolveManifest')

  const acting = await resolveActingManifest(pointer, `31990:${LEDGER_APP}:ledger`, query)
  assert.equal(acting.address, `31990:${LEDGER_APP}:ledger`)
  const built = buildActionEvents({
    manifest: acting.manifest,
    kind: KIND_CHANNEL_METADATA,
    address: FOLDER_ADDRESS,
    objectAuthor: RELAY,
    folder: FOLDER,
    actionId: 'open-book',
    value: { name: 'FY27' },
    newId: 'book-1',
    pubkey: PERSON,
    createdAtMs: 1_700_000_500_000,
    folderHasState: true,
  })
  assert.ok(Array.isArray(built), String(built))
  const [book, command] = built
  assert.equal(book.kind, BOOK)
  assert.deepEqual(book.tags, [['d', 'book-1'], ['name', 'FY27'], ['buzz-channel', FOLDER]])
  assert.equal(command.kind, 1852, 'a listed creation is followed by the Folder command')
  assert.ok(command.tags.some((t) => t[0] === 'a' && t[1] === `${BOOK}:${PERSON}:book-1`))

  // The owner's manifest cannot build it — the reason `declaredBy` exists.
  const wrong = buildActionEvents({
    manifest: owner.manifest,
    kind: KIND_CHANNEL_METADATA,
    address: FOLDER_ADDRESS,
    objectAuthor: RELAY,
    folder: FOLDER,
    actionId: 'open-book',
    value: { name: 'FY27' },
    newId: 'book-1',
    pubkey: PERSON,
    createdAtMs: 1_700_000_500_000,
    folderHasState: true,
  })
  assert.equal(wrong, 'This app does not offer "open-book".')
})

test('naming a manifest that was never offered acts with nothing', async () => {
  const ledger = ledgerManifest(LEDGER_APP)
  const { query } = countingRelay([talk, ledger, folder()])
  const pointer = { kind: KIND_CHANNEL_METADATA, pubkey: RELAY, identifier: FOLDER, relays: [] }
  assert.equal(await resolveActingManifest(pointer, `31990:${PERSON}:made-up`, query), null)

  // The ledger declares nothing on its own entries, so it is not an actor there.
  const entry = { kind: 9, pubkey: PERSON, identifier: 'x', relays: [] }
  assert.equal(await resolveActingManifest(entry, `31990:${LEDGER_APP}:ledger`, query), null)
})

test('only a creation of the declaring app’s own kind is borrowed', async () => {
  /*
    A change on a Folder is folded by the Folder's owner's `records`, so a
    stranger declaring one would be offering something nobody folds the way it
    says. A creation of a kind the declarer does not draw would make an object
    nothing draws.
  */
  const ledger = ledgerManifest(LEDGER_APP, [
    { id: 'rename-folder', label: 'Rename', description: 'x', effect: 'writes', appliesTo: String(KIND_CHANNEL_METADATA), emits: { kind: 1851, field: 'name' }, input: { type: 'string' } },
    { id: 'make-note', label: 'New note', description: 'x', effect: 'writes', appliesTo: String(KIND_CHANNEL_METADATA), emits: { kind: 30999 }, input: { type: 'object', properties: { title: { type: 'string' } } } },
    { id: 'archive-folder', label: 'Archive', description: 'x', effect: 'destructive', appliesTo: String(KIND_CHANNEL_METADATA), emits: { kind: 5 } },
  ])
  const { query } = countingRelay([talk, ledger, folder()])
  const found = await resolveForeignObject(FOLDER_ADDRESS, query)
  assert.deepEqual(found.actions.map((a) => a.id), ['start-talking', 'open-book'])

  const pointer = { kind: KIND_CHANNEL_METADATA, pubkey: RELAY, identifier: FOLDER, relays: [] }
  const acting = await resolveActingManifest(pointer, `31990:${LEDGER_APP}:ledger`, query)
  assert.deepEqual(acting.manifest.actions.map((a) => a.id), ['open-book'], 'nothing else is buildable with it here')
})

test('a stale copy declaring the same creation is one row, from the newest manifest', async () => {
  const staging = ledgerManifest(STAGING)
  const ledger = ledgerManifest(LEDGER_APP)
  const { query } = countingRelay([talk, staging, ledger, folder()])
  const found = await resolveForeignObject(FOLDER_ADDRESS, query)
  const books = found.actions.filter((a) => a.id === 'open-book')
  assert.equal(books.length, 1)
  assert.equal(books[0].declaredBy.address, `31990:${LEDGER_APP}:ledger`)
})

test('what the owner makes on its own kind is not offered again by another app', async () => {
  // Another app declaring a `kind:9` on a Folder, which the owner already
  // creates there: the owner's row is the one offered.
  const echo = event({
    kind: 31990,
    pubkey: STAGING,
    tags: [['d', 'echo'], ['k', '9']],
    content: JSON.stringify({
      name: 'Echo',
      projections: { 9: { widget: 'card', slots: { body: { field: 'content' } } } },
      actions: [{ ...startTalking, id: 'echo' }],
    }),
  })
  const { query } = countingRelay([talk, echo, folder()])
  const found = await resolveForeignObject(FOLDER_ADDRESS, query)
  assert.deepEqual(found.actions.map((a) => a.id), ['start-talking'])
})

test('a set of Folders sweeps once for the kind, and each Folder carries the borrowed row', async () => {
  const ledger = ledgerManifest(LEDGER_APP)
  const relay = countingRelay([talk, ledger, folder(), folder(OTHER_FOLDER)])
  const refs = [FOLDER_ADDRESS, `${KIND_CHANNEL_METADATA}:${RELAY}:${OTHER_FOLDER}`]
  const objects = await resolveForeignObjects(refs, relay.query)
  for (const ref of refs) {
    assert.deepEqual(objects[ref].actions.map((a) => a.id), ['start-talking', 'open-book'], ref)
  }
  const sweeps = relay.calls.filter((filters) => filters.some((f) => f.kinds?.includes(31990) && !f['#k']))
  assert.equal(sweeps.length, 1)
})

test('with a cache the sweep is paid once, and a Folder nobody can read offers nothing', async () => {
  const ledger = ledgerManifest(LEDGER_APP)
  const relay = countingRelay([talk, ledger, folder()])
  const cache = createProjectionCache()
  await resolveForeignObject(FOLDER_ADDRESS, relay.query, undefined, 0, cache)
  const before = relay.calls.length
  const again = await resolveForeignObject(FOLDER_ADDRESS, relay.query, undefined, 0, cache)
  assert.equal(relay.calls.length - before, 1, 'a refresh is the object alone')
  assert.equal(again.actions.length, 2)

  const hidden = await resolveForeignObject(`${KIND_CHANNEL_METADATA}:${RELAY}:${OTHER_FOLDER}`, relay.query, undefined, 0, cache)
  assert.equal(hidden.unreachable, true)
  assert.deepEqual(hidden.actions, [])
})

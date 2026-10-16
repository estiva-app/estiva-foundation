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
 * conversation app that opens Folders, and a ledger that makes its books in
 * them. The Folder is the relay's `kind:39000`, as on production, and since
 * Folders were built in (SPEC §3.2) it is drawn by the specification, never by
 * a manifest — `staleTalk` is the conversation app still claiming it, as
 * Peek's manifest did until its republish.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  buildActionEvents,
  createProjectionCache,
  resolveActingManifest,
  resolveForeignObject,
  resolveForeignObjects,
  FOLDER_ACTIONS_ADDRESS,
  KIND_BARE_FILE,
  KIND_CHANNEL_METADATA,
} from '../dist/index.js'

const KIND_MESSAGE = 9

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

const TALK_WEB = 'https://talk.example/o/<bech32>'

/** The app a Folder opens in — Peek's role: it declares the conversation aspect and claims no kind. */
const talk = event({
  kind: 31990,
  pubkey: TALK_APP,
  tags: [['d', 'talk'], ['web', TALK_WEB, 'naddr'], ['web', TALK_WEB, 'nevent']],
  content: JSON.stringify({ name: 'Talk', aspect: 'conversation', projections: {} }),
})

/** The same app before Folders were built in: it claims the Folder and the message, and declares starting one. */
const staleTalk = event({
  kind: 31990,
  pubkey: TALK_APP,
  tags: [['d', 'talk'], ['k', String(KIND_CHANNEL_METADATA)], ['k', '9'], ['web', TALK_WEB, 'naddr']],
  content: JSON.stringify({
    name: 'Talk',
    aspect: 'conversation',
    projections: {
      [KIND_CHANNEL_METADATA]: {
        widget: 'card',
        slots: { title: { field: 'pubkey' }, list: { children: { kind: 9, via: 'h', match: 'identifier', limit: 50 } } },
      },
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

  assert.ok(found, 'a Folder draws with no manifest claiming it')
  assert.equal(found.appName, 'Talk', 'named by the app it opens in')
  assert.deepEqual(
    found.actions.map((a) => [a.id, a.declaredBy?.address]),
    [
      ['create-file', FOLDER_ACTIONS_ADDRESS],
      ['start-a-conversation', FOLDER_ACTIONS_ADDRESS],
      ['open-book', `31990:${LEDGER_APP}:ledger`],
    ],
    "the Folder's built-ins first, then the borrowed one naming its manifest",
  )
  const borrowed = found.actions[2]
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
  assert.equal(owner?.address, FOLDER_ACTIONS_ADDRESS,'no declaredBy is the owner, exactly as resolveManifest — the specification')

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

/*
  INT-12. A Folder is owned by no app (SPEC §3.2), so putting a file in one is
  the specification's action, not a manifest's: it is on every Folder with no
  `kind:31990` declaring it, and acting with it builds a bare file in `h` and
  the command that lists it.
*/
test('a Folder offers a new file as its own built-in, and acting with it lists the file', async () => {
  const { query } = countingRelay([talk, folder()])
  const found = await resolveForeignObject(FOLDER_ADDRESS, query)
  const create = found.actions.find((a) => a.id === 'create-file')
  assert.ok(create, 'offered with no manifest declaring it')
  assert.equal(create.declaredBy.address, FOLDER_ACTIONS_ADDRESS)
  assert.equal(create.control, 'form')
  assert.equal(create.listed, true)
  assert.deepEqual(create.fields.map((f) => f.name), ['title', 'summary'])

  const pointer = { kind: KIND_CHANNEL_METADATA, pubkey: RELAY, identifier: FOLDER, relays: [] }
  const acting = await resolveActingManifest(pointer, FOLDER_ACTIONS_ADDRESS, query)
  assert.equal(acting.address, FOLDER_ACTIONS_ADDRESS)
  const args = {
    manifest: acting.manifest,
    kind: KIND_CHANNEL_METADATA,
    address: FOLDER_ADDRESS,
    objectAuthor: RELAY,
    folder: FOLDER,
    actionId: 'create-file',
    value: { title: 'Pricing' },
    newId: 'file-1',
    pubkey: PERSON,
    createdAtMs: 1_700_000_500_000,
  }
  const listed = buildActionEvents({ ...args, folderHasState: true })
  assert.ok(Array.isArray(listed), String(listed))
  const [file, command] = listed
  assert.equal(file.kind, KIND_BARE_FILE)
  // SPEC §6.7's order, and `h` — never `buzz-channel`, so a private Folder's titles stay its own.
  assert.deepEqual(file.tags, [['d', 'file-1'], ['title', 'Pricing'], ['h', FOLDER]])
  assert.equal(command.kind, 1852)
  assert.ok(command.tags.some((t) => t[0] === 'a' && t[1] === `${KIND_BARE_FILE}:${PERSON}:file-1`))

  // A Folder with no state lists by containment, and a command would empty it.
  const unlisted = buildActionEvents({ ...args, folderHasState: false })
  assert.equal(unlisted.length, 1)
})

test('an app declaring a new file on a Folder does not add a second row', async () => {
  const notes = event({
    kind: 31990,
    pubkey: STAGING,
    tags: [['d', 'notes'], ['k', String(KIND_BARE_FILE)]],
    content: JSON.stringify({
      name: 'Notes',
      projections: { [KIND_BARE_FILE]: { widget: 'card', slots: { title: { tag: 'title' } } } },
      actions: [
        { id: 'new-note', label: 'New note', description: 'x', effect: 'writes', appliesTo: String(KIND_CHANNEL_METADATA), emits: { kind: KIND_BARE_FILE }, input: { type: 'object', properties: { title: { type: 'string' } } } },
      ],
    }),
  })
  const { query } = countingRelay([talk, notes, folder()])
  const found = await resolveForeignObject(FOLDER_ADDRESS, query)
  assert.deepEqual(found?.actions.map((a) => a.id), ['create-file', 'start-a-conversation'], 'the specification’s row, once')
})

/*
  Starting a conversation moved from Peek's manifest into the specification
  (folders-belong-to-the-protocol). Acting with it writes a `kind:9` naming
  the Folder by `h` alone: an `a` naming the `39000` is what §3.2 reads as a
  mention of the Folder, and the message would be counted as one.
*/
test('a Folder offers starting a conversation as its own built-in, and the message names it by h alone', async () => {
  const { query } = countingRelay([talk, folder()])
  const found = await resolveForeignObject(FOLDER_ADDRESS, query)
  const start = found?.actions.find((a) => a.id === 'start-a-conversation')
  assert.ok(start, 'offered with no manifest declaring it')
  assert.equal(start.declaredBy.address, FOLDER_ACTIONS_ADDRESS)
  assert.equal(start.control, 'form')
  assert.deepEqual(start.fields.map((f) => f.name), ['message'])

  const pointer = { kind: KIND_CHANNEL_METADATA, pubkey: RELAY, identifier: FOLDER, relays: [] }
  const acting = await resolveActingManifest(pointer, FOLDER_ACTIONS_ADDRESS, query)
  const built = buildActionEvents({
    manifest: acting.manifest,
    kind: KIND_CHANNEL_METADATA,
    address: FOLDER_ADDRESS,
    objectAuthor: RELAY,
    folder: FOLDER,
    actionId: 'start-a-conversation',
    value: { message: 'Shall we close the quarter on Friday?' },
    pubkey: PERSON,
    createdAtMs: 1_700_000_500_000,
  })
  assert.ok(Array.isArray(built), String(built))
  assert.equal(built.length, 1, 'a message is not listed: no Folder command follows it')
  assert.equal(built[0].kind, KIND_MESSAGE)
  assert.equal(built[0].content, 'Shall we close the quarter on Friday?')
  assert.deepEqual(built[0].tags, [['h', FOLDER]])
})

test('a manifest still claiming the Folder neither draws it nor adds a second row', async () => {
  const { query } = countingRelay([staleTalk, folder()])
  const found = await resolveForeignObject(FOLDER_ADDRESS, query)
  assert.equal(found.slots.title.value, 'Accounts', 'the name, not what the claim says the title is')
  assert.equal(found.noun, 'folder')
  assert.equal(found.children, undefined, 'no messages listed as its contents')
  assert.deepEqual(
    found.actions.map((a) => [a.id, a.declaredBy?.address]),
    [
      ['create-file', FOLDER_ACTIONS_ADDRESS],
      ['start-a-conversation', FOLDER_ACTIONS_ADDRESS],
    ],
  )
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
  assert.deepEqual(found?.actions.map((a) => a.id), ['create-file', 'start-a-conversation', 'open-book'])

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

test('another app declaring a message on a Folder does not add a second row', async () => {
  // A `kind:9` on a Folder is the specification's to start: its row is the
  // one offered, whoever else declares the same.
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
  assert.deepEqual(found?.actions.map((a) => a.id), ['create-file', 'start-a-conversation'])
})

test('a set of Folders sweeps once for the kind, and each Folder carries the borrowed row', async () => {
  const ledger = ledgerManifest(LEDGER_APP)
  const THIRD_FOLDER = '5c9d1e2f-3a4b-4c5d-8e6f-7a8b9c0d1e2f'
  const relay = countingRelay([talk, ledger, folder(), folder(OTHER_FOLDER), folder(THIRD_FOLDER)])
  const refs = [FOLDER, OTHER_FOLDER, THIRD_FOLDER].map((id) => `${KIND_CHANNEL_METADATA}:${RELAY}:${id}`)
  const objects = await resolveForeignObjects(refs, relay.query)
  for (const ref of refs) {
    assert.deepEqual(objects[ref]?.actions.map((a) => a.id), ['create-file', 'start-a-conversation', 'open-book'], ref)
  }
  // Two questions, each asked once for the set: where a Folder opens, and who
  // else creates in one. Neither is asked per Folder, nor of a `k` tag.
  const sweeps = relay.calls.filter((filters) => filters.some((f) => f.kinds?.includes(31990)))
  assert.equal(sweeps.length, 2)
  assert.ok(!sweeps.flat().some((f) => f['#k']))
})

test('a refused sweep costs the borrowed rows, not the object, and is asked again', async () => {
  const ledger = ledgerManifest(LEDGER_APP)
  const relay = countingRelay([talk, ledger, folder()])
  let refuse = true
  const query = async (filters) => {
    const sweep = filters.some((f) => f.kinds?.includes(31990) && !f['#k'] && !f['#d'])
    if (refuse && sweep) throw new Error('rate-limited: quota exceeded; retry in 8s')
    return relay.query(filters)
  }
  const cache = createProjectionCache()
  const degraded = await resolveForeignObject(FOLDER_ADDRESS, query, undefined, 0, cache)
  assert.equal(degraded?.slots.title.value, 'Accounts', 'the Folder still resolves')
  assert.equal(degraded.openUrl, undefined, 'with nowhere to open it, since the opener was in the sweep too')
  // The Folder's built-ins need no sweep, so a refused one does not cost them.
  assert.deepEqual(degraded.actions.map((a) => a.id), ['create-file', 'start-a-conversation'])

  const pointer = { kind: KIND_CHANNEL_METADATA, pubkey: RELAY, identifier: FOLDER, relays: [] }
  await assert.rejects(resolveActingManifest(pointer, `31990:${LEDGER_APP}:ledger`, query, cache), /rate-limited/, 'acting says so')
  // What is offered without the sweep can be acted with without it.
  const builtIn = await resolveActingManifest(pointer, FOLDER_ACTIONS_ADDRESS, query, cache)
  assert.equal(builtIn.address, FOLDER_ACTIONS_ADDRESS)

  refuse = false
  const recovered = await resolveForeignObject(FOLDER_ADDRESS, query, undefined, 0, cache)
  assert.deepEqual(recovered.actions.map((a) => a.id), ['create-file', 'start-a-conversation', 'open-book'], 'the failure was not remembered')
  assert.ok(recovered.openUrl?.startsWith('https://talk.example/o/naddr1'), 'nor was the missing opener')
})

test('with a cache the sweep is paid once, and a Folder nobody can read offers nothing', async () => {
  const ledger = ledgerManifest(LEDGER_APP)
  const relay = countingRelay([talk, ledger, folder()])
  const cache = createProjectionCache()
  await resolveForeignObject(FOLDER_ADDRESS, relay.query, undefined, 0, cache)
  const before = relay.calls.length
  const again = await resolveForeignObject(FOLDER_ADDRESS, relay.query, undefined, 0, cache)
  assert.equal(relay.calls.length - before, 1, 'a refresh is the object alone')
  assert.equal(again.actions.length, 3)

  const hidden = await resolveForeignObject(`${KIND_CHANNEL_METADATA}:${RELAY}:${OTHER_FOLDER}`, relay.query, undefined, 0, cache)
  assert.equal(hidden.unreachable, true)
  assert.deepEqual(hidden.actions, [])
})

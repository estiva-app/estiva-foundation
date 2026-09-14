/**
 * The folder read model — RFC 0.4 §4 and §5.
 *
 * The claim under test is the one the whole navigation model rests on: given a
 * folder id, a consumer lists what is in it **across apps**, drawing each file
 * through the manifest of whoever owns it, and knowing nothing about any of
 * them. Two apps doing that show the same folder.
 *
 * The apps below are two nobody wrote — a bird-ringing log and a tide table —
 * for the same reason `action-conformance` uses one: the test of a vocabulary
 * is that it works for an app this team has never seen. If these tests only
 * passed for Ship and Peek they would be measuring an integration.
 */
import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import { resolveFolderContents, listFolders, KIND_FOLDER_STATE } from '../dist/index.js'

const RINGER = 'a'.repeat(64)
const TIDES = 'b'.repeat(64)
const RELAY = 'f'.repeat(64)
const FOLDER = '7b32200c-e4c0-4216-b79a-8490fc05e0bd'
const COLONY = 39701
const READING = 30911
const SIGHTING = 9

let seq = 0
const event = (partial) => ({
  id: String(++seq).padStart(64, '0'),
  sig: '',
  pubkey: RINGER,
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
      for (const [key, want] of Object.entries(f)) {
        if (!key.startsWith('#')) continue
        const held = e.tags.filter((t) => t[0] === key.slice(1)).map((t) => t[1])
        if (!want.some((v) => held.includes(v))) return false
      }
      return true
    }),
  )

/** The ringing log: colonies, and sightings inside them. */
const ringingManifest = event({
  kind: 31990,
  pubkey: RINGER,
  tags: [['d', 'ringing-log'], ['k', String(COLONY)]],
  content: JSON.stringify({
    name: 'Ringing log',
    records: { changeKind: 1851, targetTag: 'a', fieldTag: 'f', valueTag: 'v', hiddenWhen: { field: 'archived', equals: 'true' } },
    projections: {
      [COLONY]: { widget: 'card', slots: { title: { tag: 'title' } } },
      [SIGHTING]: { widget: ['message', 'card'], slots: { title: { field: 'pubkey' } } },
    },
  }),
})

/**
 * The tide table, and the point of it: its widget is `tideboard`, which no
 * consumer has heard of. RFC 0.4 §13.3 closes the chain in `card`.
 */
const tidesManifest = event({
  kind: 31990,
  pubkey: TIDES,
  tags: [['d', 'tide-table'], ['k', String(READING)]],
  content: JSON.stringify({
    name: 'Tide table',
    projections: { [READING]: { widget: ['tideboard', 'card'], slots: { title: { tag: 'title' } } } },
  }),
})

const colony = event({ kind: COLONY, pubkey: RINGER, tags: [['d', 'weir'], ['title', 'Weir colony'], ['h', FOLDER]] })
const reading = event({ kind: READING, pubkey: TIDES, tags: [['d', 'spring'], ['title', 'Spring tides'], ['h', FOLDER]] })
const channel = event({ kind: 39000, pubkey: RELAY, tags: [['d', FOLDER], ['name', 'The estuary']] })

const addressOf = (e) => `${e.kind}:${e.pubkey}:${e.tags.find((t) => t[0] === 'd')[1]}`

/** Folder state: contents named by `a`, the way §5.2 says every file can be. */
const state = (contents, tags = []) =>
  event({
    kind: KIND_FOLDER_STATE,
    pubkey: RELAY,
    tags: [['d', FOLDER], ['name', 'Estuary survey'], ...contents.map((a) => ['a', a]), ...tags],
  })

describe('a folder lists files from different apps as peers', () => {
  test('one list, two apps, each drawn through its own manifest', async () => {
    const query = relay([ringingManifest, tidesManifest, channel, colony, reading, state([addressOf(colony), addressOf(reading)])])
    const contents = await resolveFolderContents(FOLDER, query, async () => ({}))

    assert.equal(contents.source, 'state')
    assert.equal(contents.name, 'Estuary survey', 'the folder names itself, not its channel')
    assert.deepEqual(
      contents.files.map((f) => [f.appName, f.slots.title?.value]),
      [['Ringing log', 'Weir colony'], ['Tide table', 'Spring tides']],
    )
  })

  test('peers, not one nested inside the other', async () => {
    const query = relay([ringingManifest, tidesManifest, channel, colony, reading, state([addressOf(colony), addressOf(reading)])])
    const { files } = await resolveFolderContents(FOLDER, query, async () => ({}))
    // The thing A4 asks to be proved: neither is reachable only by expanding
    // the other. Both are top-level entries in one list.
    assert.equal(files.length, 2)
    for (const file of files) assert.ok(!file.children?.length, `${file.appName} holds the other`)
  })

  test('the order is the folder’s, not the relay’s', async () => {
    const query = relay([ringingManifest, tidesManifest, channel, colony, reading, state([addressOf(reading), addressOf(colony)])])
    const { files } = await resolveFolderContents(FOLDER, query, async () => ({}))
    assert.deepEqual(files.map((f) => f.slots.title?.value), ['Spring tides', 'Weir colony'])
  })

  test('a kind neither consumer designed for still renders, via the fallback chain', async () => {
    const query = relay([ringingManifest, tidesManifest, channel, colony, reading, state([addressOf(colony), addressOf(reading)])])
    const { files } = await resolveFolderContents(FOLDER, query, async () => ({}))
    const tide = files.find((f) => f.kind === READING)
    // Declared as a chain the consumer only half understands. It is handed the
    // whole chain and `pickWidget` walks it to something closed.
    assert.deepEqual(tide.widget, ['tideboard', 'card'])
  })
})

describe('what is not a file', () => {
  test('a message is conversation, not contents — it has no address', async () => {
    const message = event({ kind: SIGHTING, pubkey: RINGER, tags: [['h', FOLDER]], content: 'a chiffchaff' })
    const query = relay([ringingManifest, channel, colony, message])
    const { files, source } = await resolveFolderContents(FOLDER, query, async () => ({}))
    assert.equal(source, 'channel')
    assert.deepEqual(files.map((f) => f.kind), [COLONY], 'the kind:9 was listed as a file')
  })

  test('a folder is not a file inside itself', async () => {
    // The channel's own discovery event comes back from an `#h` query for that
    // channel; what marks it out is that its `d` is the folder uuid.
    const query = relay([ringingManifest, { ...channel, tags: [...channel.tags, ['h', FOLDER]] }, colony])
    const { files } = await resolveFolderContents(FOLDER, query, async () => ({}))
    assert.deepEqual(files.map((f) => f.kind), [COLONY])
  })
})

describe('a file the reader cannot see is absent, not “unavailable”', () => {
  test('the unreadable address is dropped', async () => {
    // The folder lists both; only one is readable. This is the divergence from
    // upstream NIP-MP, and the reason is that the count is the disclosure.
    const query = relay([ringingManifest, tidesManifest, channel, colony, state([addressOf(colony), `${READING}:${TIDES}:spring`])])
    const { files } = await resolveFolderContents(FOLDER, query, async () => ({}))
    assert.deepEqual(files.map((f) => f.slots.title?.value), ['Weir colony'])
    assert.ok(!files.some((f) => f.unreachable), 'an unreadable file was marked rather than dropped')
  })

  test('nothing in the result counts what was hidden', async () => {
    const query = relay([ringingManifest, tidesManifest, channel, colony, state([addressOf(colony), `${READING}:${TIDES}:spring`])])
    const contents = await resolveFolderContents(FOLDER, query, async () => ({}))
    // A total, a `hiddenCount`, or a length that disagreed with `files` would
    // all leak the same number.
    assert.equal(JSON.stringify(contents).includes('spring'), false)
  })

  test('an archived record is hidden, because its own app says so', async () => {
    const archived = event({
      kind: 1851,
      pubkey: RINGER,
      tags: [['a', addressOf(colony)], ['f', 'archived'], ['v', 'true'], ['h', FOLDER]],
    })
    const query = relay([ringingManifest, channel, colony, archived, state([addressOf(colony)])])
    const { files } = await resolveFolderContents(FOLDER, query, async () => ({}))
    assert.deepEqual(files, [])
  })
})

describe('the folder that has no state yet', () => {
  test('containment by h still lists an app’s records', async () => {
    const query = relay([ringingManifest, tidesManifest, channel, colony, reading])
    const contents = await resolveFolderContents(FOLDER, query, async () => ({}))
    assert.equal(contents.source, 'channel')
    assert.equal(contents.hasState, false)
    assert.equal(contents.name, 'The estuary', 'falls back to the channel’s name')
    assert.deepEqual(new Set(contents.files.map((f) => f.kind)), new Set([COLONY, READING]))
  })

  test('a record placed globally is found by buzz-channel, not by h', async () => {
    // Reading only `h` is what made five of Ship's fifteen projects
    // unactionable, and on production today nine of nineteen are placed this way.
    const global = event({ kind: COLONY, pubkey: RINGER, tags: [['d', 'far'], ['title', 'Far colony'], ['buzz-channel', FOLDER]] })
    const query = relay([ringingManifest, channel, global])
    const { files } = await resolveFolderContents(FOLDER, query, async () => ({}))
    assert.deepEqual(files.map((f) => f.slots.title?.value), ['Far colony'])
  })
})

/**
 * The union rule — FOL-20. A folder lists the files whose `h` it is *and* the
 * files placed in it. A placement is a change carried in the folder, naming
 * a target, whose value is the folder itself: what Ship announces into a
 * Folder when a project is linked to it, and the only thing an append-only
 * record can say once its `h` is fixed.
 */
describe('a folder lists the files placed in it, not only the files whose h it is', () => {
  const TEAM = '1d0f2a4e-9c7b-4e1a-8f3c-5b6d7e8f9a0b'
  const team = event({ kind: 39000, pubkey: RELAY, tags: [['d', TEAM], ['name', 'Ringers']] })
  /** The colony's record lives in the estuary; this statement links its work to the team. */
  const placement = (value = TEAM, at = {}) =>
    event({ kind: 1851, pubkey: RINGER, tags: [['a', addressOf(colony)], ['f', 'folder'], ['v', value], ['h', TEAM]], ...at })

  test('a record whose h is elsewhere lists under the folder it was placed in', async () => {
    const query = relay([ringingManifest, channel, team, colony, placement()])
    const contents = await resolveFolderContents(TEAM, query, async () => ({}))
    assert.equal(contents.name, 'Ringers')
    assert.deepEqual(contents.files.map((f) => f.slots.title?.value), ['Weir colony'])
  })

  test('and still lists under the folder its h is — nothing moved', async () => {
    const query = relay([ringingManifest, channel, team, colony, placement()])
    const { files } = await resolveFolderContents(FOLDER, query, async () => ({}))
    assert.deepEqual(files.map((f) => f.slots.title?.value), ['Weir colony'])
  })

  test('a placement the record has since moved on from is not current, and the file is absent', async () => {
    // Linked to the team, then linked again to a third Folder from the record's
    // own Folder. The team keeps the first statement for ever; the fold does not.
    const ELSEWHERE = '9e8d7c6b-5a4f-4e3d-8c2b-1a0f9e8d7c6b'
    const first = placement()
    const moved = event({ kind: 1851, pubkey: RINGER, tags: [['a', addressOf(colony)], ['f', 'folder'], ['v', ELSEWHERE], ['h', FOLDER]] })
    const query = relay([ringingManifest, channel, team, colony, first, moved])
    const { files } = await resolveFolderContents(TEAM, query, async () => ({}))
    assert.deepEqual(files, [])
  })

  test('an ordinary change that strayed into the folder places nothing', async () => {
    // The relay accepts a change published into the wrong Folder. Its value is
    // not the folder, so it is an edit that landed here, not a placement.
    const stray = event({ kind: 1851, pubkey: RINGER, tags: [['a', addressOf(colony)], ['f', 'title'], ['v', 'Renamed'], ['h', TEAM]] })
    const query = relay([ringingManifest, channel, team, colony, stray])
    const { files } = await resolveFolderContents(TEAM, query, async () => ({}))
    assert.deepEqual(files, [])
  })

  test('a placed record its app has archived is hidden like any other', async () => {
    const archived = event({ kind: 1851, pubkey: RINGER, tags: [['a', addressOf(colony)], ['f', 'archived'], ['v', 'true'], ['h', FOLDER]] })
    const query = relay([ringingManifest, channel, team, colony, placement(), archived])
    const { files } = await resolveFolderContents(TEAM, query, async () => ({}))
    assert.deepEqual(files, [])
  })

  test('the placement rides in the containment request — no extra round trip', async () => {
    let posts = 0
    const inner = relay([ringingManifest, channel, team, colony, placement()])
    const counting = async (filters) => {
      posts++
      return inner(filters)
    }
    await resolveFolderContents(TEAM, counting, async () => ({}))
    const before = posts
    posts = 0
    await resolveFolderContents(FOLDER, counting, async () => ({}))
    assert.equal(before, posts, 'listing a folder by placement cost more requests than listing one by h')
  })
})

describe('listFolders', () => {
  test('state and bare channels in one list, state naming the folder', async () => {
    const other = event({ kind: 39000, pubkey: RELAY, tags: [['d', 'aaa'], ['name', 'Another channel']] })
    const query = relay([channel, other, state([])])
    const folders = await listFolders(query)
    assert.deepEqual(folders, [
      { id: 'aaa', name: 'Another channel', hasState: false },
      { id: FOLDER, name: 'Estuary survey', hasState: true },
    ])
  })
})

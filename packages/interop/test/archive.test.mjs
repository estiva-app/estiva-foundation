/**
 * Archive is one concept for every file, and hides its subtree — FOL-46.
 *
 * The claims under test:
 *
 * - any file is archived by one change, `archived = 'true'` on its address,
 *   and restored by an empty value — a record, a bare file, a Folder;
 * - the cascade is computed when reading and never written to the children: an
 *   archived parent hides what is under it, and unarchiving it restores exactly
 *   what was there;
 * - a file another Folder also lists stays visible there;
 * - a link still opens an archived file, and says so, with the resolution.
 *
 * The app is one nobody wrote — a hive log whose hives hold inspections — for
 * the reason `folder-contents` gives: a rule that only held for Ship would be
 * measuring an integration.
 */
import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import {
  resolveFolderContents,
  resolveForeignObject,
  resolveForeignObjects,
  listFolders,
  topLevelFolders,
  archiveImpact,
  isArchived,
  planArchiveFolder,
  buildActionEvent,
  KIND_BARE_FILE,
  KIND_FOLDER_STATE,
} from '../dist/index.js'

const KEEPER = 'a'.repeat(64)
const HELPER = 'c'.repeat(64)
const RELAY = 'f'.repeat(64)
const APIARY = '7b32200c-e4c0-4216-b79a-8490fc05e0bd'
const ORCHARD = '05bebd5b-b699-4bd4-af50-f5377df0fd67'
const HIVE_TALK = '11111111-0000-4000-8000-000000000001'
const HIVE = 30871
const INSPECTION = 30872

let seq = 0
const event = (partial) => ({
  id: String(++seq).padStart(64, '0'),
  sig: '',
  pubkey: KEEPER,
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

const addressOf = (e) => `${e.kind}:${e.pubkey}:${e.tags.find((t) => t[0] === 'd')[1]}`

const hiveLog = event({
  kind: 31990,
  tags: [['d', 'hive-log'], ['k', String(HIVE)], ['k', String(INSPECTION)]],
  content: JSON.stringify({
    name: 'Hive log',
    records: {
      changeKind: 1851,
      targetTag: 'a',
      fieldTag: 'field',
      valueTag: 'value',
      order: ['ts', 'created_at', 'id'],
      rule: 'last-write-wins-per-field',
      hiddenWhen: { field: 'archived', equals: 'true' },
    },
    projections: {
      [HIVE]: {
        widget: 'card',
        slots: { title: { tag: 'title' }, list: { children: { kind: INSPECTION, via: 'a', limit: 200 } } },
      },
      [INSPECTION]: { widget: 'card', slots: { title: { tag: 'title' } } },
    },
    actions: [
      {
        id: 'archive',
        label: 'Archive',
        description: 'Take a hive and its inspections out of every list, or bring them back with an empty value.',
        effect: 'writes',
        appliesTo: [String(HIVE), String(INSPECTION)],
        emits: { kind: 1851, field: 'archived' },
        input: { type: 'string' },
      },
    ],
  }),
})

const channelOf = (id, name) => event({ kind: 39000, pubkey: RELAY, tags: [['d', id], ['name', name]] })
const apiary = channelOf(APIARY, 'Apiary')
const orchard = channelOf(ORCHARD, 'Orchard')
const hiveTalk = channelOf(HIVE_TALK, 'Hive talk')

// A hive whose conversation is its own channel, and two inspections in it.
const hive = event({ kind: HIVE, tags: [['d', 'north'], ['title', 'North hive'], ['h', HIVE_TALK]] })
const inspect = (d, title) =>
  event({ kind: INSPECTION, pubkey: HELPER, tags: [['d', d], ['title', title], ['a', addressOf(hive)], ['h', HIVE_TALK]] })
const spring = inspect('spring', 'Spring inspection')
const summer = inspect('summer', 'Summer inspection')

const stateOf = (id, name, addresses) =>
  event({ kind: KIND_FOLDER_STATE, pubkey: RELAY, tags: [['d', id], ['name', name], ...addresses.map((a) => ['a', a])] })

let clock = 1_800_000_000
/** An archive change, or with `archived: false` the restore. SPEC's shape. */
const archive = (address, { folder = APIARY, archived = true, note = '', by = HELPER } = {}) => {
  clock += 10
  return event({
    kind: 1851,
    pubkey: by,
    created_at: clock,
    tags: [['a', address], ['field', 'archived'], ['value', archived ? 'true' : ''], ['h', folder], ['ts', String(clock * 1000)]],
    content: note,
  })
}

const titles = (contents) => contents.files.map((f) => f.slots.title?.value)
const noPeople = async () => ({})

describe('an archived parent hides what is under it, and unarchiving restores it', () => {
  // The hive's own channel lists by containment: the hive and both inspections.
  test('a hive and its inspections are listed until the hive is archived', async () => {
    const live = await resolveFolderContents(HIVE_TALK, relay([hiveLog, hiveTalk, hive, spring, summer]), noPeople)
    assert.deepEqual(new Set(titles(live)), new Set(['North hive', 'Spring inspection', 'Summer inspection']))

    const archived = archive(addressOf(hive), { folder: HIVE_TALK })
    const hidden = await resolveFolderContents(HIVE_TALK, relay([hiveLog, hiveTalk, hive, spring, summer, archived]), noPeople)
    assert.deepEqual(titles(hidden), [], 'the inspections went with their hive')
  })

  test('nothing was written to the inspections, so unarchiving the hive restores them all', async () => {
    const archived = archive(addressOf(hive), { folder: HIVE_TALK })
    const restored = archive(addressOf(hive), { folder: HIVE_TALK, archived: false })
    const events = [hiveLog, hiveTalk, hive, spring, summer, archived, restored]
    const back = await resolveFolderContents(HIVE_TALK, relay(events), noPeople)
    assert.equal(back.files.length, 3)
  })

  test('an inspection archived on its own stays archived when the hive comes back', async () => {
    const own = archive(addressOf(spring), { folder: HIVE_TALK })
    const archived = archive(addressOf(hive), { folder: HIVE_TALK })
    const restored = archive(addressOf(hive), { folder: HIVE_TALK, archived: false })
    const events = [hiveLog, hiveTalk, hive, spring, summer, own, archived, restored]
    const back = await resolveFolderContents(HIVE_TALK, relay(events), noPeople)
    assert.deepEqual(new Set(titles(back)), new Set(['North hive', 'Summer inspection']))
  })

  test('includeArchived returns them marked, each saying what it is archived with', async () => {
    const archived = archive(addressOf(hive), { folder: HIVE_TALK, note: 'Hive moved to the orchard.' })
    const events = [hiveLog, hiveTalk, hive, spring, summer, archived]
    const all = await resolveFolderContents(HIVE_TALK, relay(events), noPeople, undefined, { includeArchived: true })
    const byTitle = Object.fromEntries(all.files.map((f) => [f.slots.title?.value, f.archived]))
    assert.deepEqual(byTitle['North hive'], { by: HELPER, at: archived.created_at, resolution: 'Hive moved to the orchard.' })
    assert.equal(byTitle['Spring inspection'].with, addressOf(hive))
    assert.equal(byTitle['Spring inspection'].resolution, 'Hive moved to the orchard.')
  })

  test('a parent in another Folder is read once, and hides its child here', async () => {
    // The inspection is listed in the apiary; its hive is listed nowhere here.
    const archived = archive(addressOf(hive), { folder: HIVE_TALK })
    const events = [hiveLog, apiary, hive, spring, archived, stateOf(APIARY, 'Apiary', [addressOf(spring)])]
    assert.deepEqual(titles(await resolveFolderContents(APIARY, relay(events), noPeople)), [])
    assert.deepEqual(
      titles(await resolveFolderContents(APIARY, relay(events.filter((e) => e !== archived)), noPeople)),
      ['Spring inspection'],
    )
  })

  test('two files under each other do not loop', async () => {
    const a = event({ kind: KIND_BARE_FILE, tags: [['d', 'a'], ['title', 'A'], ['h', APIARY], ['a', `${KIND_BARE_FILE}:${KEEPER}:b`]] })
    const b = event({ kind: KIND_BARE_FILE, tags: [['d', 'b'], ['title', 'B'], ['h', APIARY], ['a', `${KIND_BARE_FILE}:${KEEPER}:a`]] })
    const contents = await resolveFolderContents(APIARY, relay([apiary, a, b, stateOf(APIARY, 'Apiary', [addressOf(a), addressOf(b)])]), noPeople)
    assert.deepEqual(new Set(titles(contents)), new Set(['A', 'B']))
  })
})

describe('a link still opens an archived file, and says so', () => {
  test('a hive reached by address carries its archive and resolution', async () => {
    const archived = archive(addressOf(hive), { folder: HIVE_TALK, note: 'Swarmed in June.' })
    const found = await resolveForeignObject(addressOf(hive), relay([hiveLog, hive, archived]), noPeople)
    assert.ok(isArchived(found))
    assert.equal(found.archived.resolution, 'Swarmed in June.')
    assert.equal(found.archived.with, undefined, 'archived itself, not with anything')
  })

  test('an inspection reached by address is archived with its hive', async () => {
    const archived = archive(addressOf(hive), { folder: HIVE_TALK, note: 'Swarmed in June.' })
    const events = [hiveLog, hive, spring, archived]
    const withParent = { archivedWith: true }
    const found = await resolveForeignObject(addressOf(spring), relay(events), noPeople, 0, undefined, withParent)
    assert.equal(found.archived.with, addressOf(hive))
    assert.equal(found.archived.resolution, 'Swarmed in June.')
    const live = await resolveForeignObject(addressOf(spring), relay([hiveLog, hive, spring]), noPeople, 0, undefined, withParent)
    assert.equal(isArchived(live), false)
  })

  test('the parent is read only when asked for, and then in one more request for a whole set', async () => {
    const archived = archive(addressOf(hive), { folder: HIVE_TALK })
    const inner = relay([hiveLog, hive, spring, summer, archived])
    let posts = 0
    const counting = async (filters) => {
      posts++
      return inner(filters)
    }
    const plain = await resolveForeignObject(addressOf(spring), counting, noPeople)
    assert.equal(isArchived(plain), false, 'not asked, not read')
    const before = posts
    posts = 0
    await resolveForeignObject(addressOf(spring), counting, noPeople, 0, undefined, { archivedWith: true })
    assert.equal(posts, before + 1)

    const set = await resolveForeignObjects([addressOf(spring), addressOf(summer)], inner, noPeople, undefined, { archivedWith: true })
    assert.deepEqual(Object.values(set).map((o) => o.archived?.with), [addressOf(hive), addressOf(hive)])
  })

  test('a change archiving one file does not archive another it also names', async () => {
    const archived = archive(addressOf(spring), { folder: HIVE_TALK })
    archived.tags.push(['a', addressOf(summer)])
    const found = await resolveForeignObject(addressOf(summer), relay([hiveLog, summer, archived]), noPeople)
    assert.equal(isArchived(found), false)
  })

  test('a Folder busy with other changes still reads its archive', async () => {
    // 600 status changes on the hive, newer than the archive: past the shared filter's page.
    const archived = archive(addressOf(apiary))
    const busy = Array.from({ length: 600 }, (_, i) =>
      event({ kind: 1851, created_at: 1_900_000_000 + i, tags: [['a', addressOf(hive)], ['field', 'status'], ['value', 'open'], ['h', APIARY]] }),
    )
    const limited = (events) => async (filters) => {
      const out = []
      for (const f of filters) out.push(...(await relay(events)([f])).sort((a, b) => b.created_at - a.created_at).slice(0, f.limit ?? Infinity))
      return out
    }
    const contents = await resolveFolderContents(APIARY, limited([hiveLog, apiary, hive, stateOf(APIARY, 'Apiary', [addressOf(hive)]), archived, ...busy]), noPeople)
    assert.ok(contents.archived, 'the archive was not pushed off the page')
  })

  test('Ship’s placeholder note is not a resolution', async () => {
    const archived = archive(addressOf(hive), { folder: HIVE_TALK, note: 'archived' })
    const found = await resolveForeignObject(addressOf(hive), relay([hiveLog, hive, archived]), noPeople)
    assert.ok(isArchived(found))
    assert.equal('resolution' in found.archived, false)
  })

  test('only `true` archives: any other value reads as live, as `hiddenWhen` does', async () => {
    const odd = archive(addressOf(hive), { folder: HIVE_TALK })
    odd.tags = odd.tags.map((t) => (t[0] === 'value' ? ['value', 'yes'] : t))
    const found = await resolveForeignObject(addressOf(hive), relay([hiveLog, hive, odd]), noPeople)
    assert.equal(isArchived(found), false)
  })
})

describe('a Folder is archived the way any file is', () => {
  const topic = event({ kind: KIND_BARE_FILE, tags: [['d', 'queens'], ['title', 'Queens'], ['h', APIARY]] })
  const both = [addressOf(hive), addressOf(topic)]

  test('planArchiveFolder writes the change buildActionEvent writes for any other file', () => {
    const [folderChange] = planArchiveFolder(HELPER, 1_800_000_000_123, {
      folder: APIARY,
      channel: addressOf(apiary),
      archived: true,
      resolution: 'Season over.',
    })
    const fileChange = buildActionEvent({
      manifest: JSON.parse(hiveLog.content),
      kind: HIVE,
      address: addressOf(apiary),
      objectAuthor: RELAY,
      folder: APIARY,
      actionId: 'archive',
      value: 'true',
      note: 'Season over.',
      pubkey: HELPER,
      createdAtMs: 1_800_000_000_123,
    })
    assert.deepEqual(folderChange, fileChange)
    const [restore] = planArchiveFolder(HELPER, 1, { folder: APIARY, channel: addressOf(apiary), archived: false, resolution: 'ignored' })
    assert.deepEqual([restore.tags[2], restore.content], [['value', ''], ''])
    // A nested Folder's archive goes where its container's readers read it.
    const [nested] = planArchiveFolder(HELPER, 1, { folder: APIARY, channel: addressOf(apiary), archived: true, into: ORCHARD })
    assert.deepEqual(nested.tags.find((t) => t[0] === 'h'), ['h', ORCHARD])
  })

  test('an app’s own change tags are read for a parent and for a child, not only for the file itself', async () => {
    // The hive log, rewritten to fold `f`/`v` rather than SPEC's `field`/`value`.
    const own = { ...JSON.parse(hiveLog.content) }
    own.records = { ...own.records, fieldTag: 'f', valueTag: 'v' }
    const log = event({ ...hiveLog, id: 'e'.repeat(64), content: JSON.stringify(own), created_at: hiveLog.created_at + 1 })
    const archived = event({ kind: 1851, pubkey: HELPER, tags: [['a', addressOf(hive)], ['f', 'archived'], ['v', 'true'], ['h', HIVE_TALK]] })
    const found = await resolveForeignObject(addressOf(spring), relay([log, hive, spring, archived]), noPeople, 0, undefined, { archivedWith: true })
    assert.equal(found.archived?.with, addressOf(hive), 'the parent is read by the app that draws it')
    const childArchived = event({ kind: 1851, pubkey: HELPER, tags: [['a', addressOf(summer)], ['f', 'archived'], ['v', 'true'], ['h', HIVE_TALK]] })
    const impact = await archiveImpact(addressOf(hive), relay([log, hive, spring, summer, childArchived]))
    assert.deepEqual(impact.hides, [{ kind: INSPECTION, count: 1 }], 'an archived child is not counted as live')
  })

  test('an archived Folder is not top-level, and says why; restoring brings it back', async () => {
    const archived = archive(addressOf(apiary), { note: 'Season over.' })
    const base = [apiary, orchard, stateOf(APIARY, 'Apiary', []), stateOf(ORCHARD, 'Orchard', [])]
    const folders = await listFolders(relay([...base, archived]))
    const held = folders.find((f) => f.id === APIARY)
    assert.equal(held.channel, addressOf(apiary))
    assert.deepEqual(held.archived, { by: HELPER, at: archived.created_at, resolution: 'Season over.' })
    assert.deepEqual(topLevelFolders(folders).map((f) => f.id), [ORCHARD])

    const restored = archive(addressOf(apiary), { archived: false })
    const back = await listFolders(relay([...base, archived, restored]))
    assert.deepEqual(new Set(topLevelFolders(back).map((f) => f.id)), new Set([APIARY, ORCHARD]))
  })

  test('opened by id, an archived Folder still lists what it holds, and carries its archive', async () => {
    const archived = archive(addressOf(apiary), { note: 'Season over.' })
    const contents = await resolveFolderContents(APIARY, relay([hiveLog, apiary, hive, topic, stateOf(APIARY, 'Apiary', both), archived]), noPeople)
    assert.equal(contents.archived.resolution, 'Season over.')
    assert.equal(contents.channel, addressOf(apiary))
    assert.deepEqual(new Set(titles(contents)), new Set(['North hive', 'Queens']))
    const empty = await resolveFolderContents(APIARY, relay([apiary, stateOf(APIARY, 'Apiary', []), archived]), noPeople)
    assert.equal(empty.archived.resolution, 'Season over.', 'an empty Folder reads its archive too')
  })

  test('a nested Folder that is archived is left out of the Folder listing it', async () => {
    const archived = archive(addressOf(apiary))
    const events = [apiary, orchard, stateOf(APIARY, 'Apiary', []), stateOf(ORCHARD, 'Orchard', [addressOf(apiary)])]
    // The orchard lists the apiary as a file; drawn with the relay's own 39000 projection, when there is one.
    const peekLike = event({
      kind: 31990,
      pubkey: RELAY,
      tags: [['d', 'folders'], ['k', '39000']],
      content: JSON.stringify({ name: 'Folders', projections: { 39000: { widget: 'card', slots: { title: { tag: 'name' } } } } }),
    })
    const live = await resolveFolderContents(ORCHARD, relay([peekLike, ...events]), noPeople)
    assert.deepEqual(titles(live), ['Apiary'])
    const gone = await resolveFolderContents(ORCHARD, relay([peekLike, ...events, archived]), noPeople)
    assert.deepEqual(titles(gone), [], 'archived, although its app folds nothing')
  })

  test('a record’s channel is archived with its record, and not with a topic published into it', async () => {
    const hiveArchived = archive(addressOf(hive), { folder: HIVE_TALK })
    const topicArchived = archive(addressOf(topic))
    const events = [apiary, hiveTalk, hive, topic, stateOf(APIARY, 'Apiary', both)]
    const folders = await listFolders(relay([...events, hiveArchived, topicArchived]))
    assert.equal(folders.find((f) => f.id === HIVE_TALK).archived.with, addressOf(hive))
    assert.equal(folders.find((f) => f.id === APIARY).archived, undefined, 'a topic’s `h` is its team, which it does not own')
  })
})

describe('archiveImpact counts what would be hidden', () => {
  const topic = event({ kind: KIND_BARE_FILE, tags: [['d', 'queens'], ['title', 'Queens'], ['h', APIARY]] })
  const sub = event({ kind: KIND_BARE_FILE, tags: [['d', 'marking'], ['title', 'Marking'], ['h', APIARY], ['a', addressOf(topic)]] })

  test('a hive: its live inspections, not the one already archived', async () => {
    const own = archive(addressOf(summer), { folder: HIVE_TALK })
    const impact = await archiveImpact(addressOf(hive), relay([hiveLog, hive, spring, summer, own]))
    assert.deepEqual(impact, { hides: [{ kind: INSPECTION, count: 1 }], staysVisible: [] })
  })

  test('a topic: the sub-topics under it', async () => {
    const impact = await archiveImpact(addressOf(topic), relay([topic, sub]))
    assert.deepEqual(impact.hides, [{ kind: KIND_BARE_FILE, count: 1 }])
  })

  test('a Folder: what only it lists, with their children; what another Folder lists stays visible', async () => {
    const events = [
      hiveLog, apiary, orchard, hive, spring, summer, topic, sub,
      stateOf(APIARY, 'Apiary', [addressOf(hive), addressOf(topic)]),
      stateOf(ORCHARD, 'Orchard', [addressOf(topic)]),
    ]
    const impact = await archiveImpact(addressOf(apiary), relay(events))
    assert.deepEqual(
      Object.fromEntries(impact.hides.map((h) => [h.kind, h.count])),
      { [HIVE]: 1, [INSPECTION]: 2 },
    )
    assert.deepEqual(impact.staysVisible, [{ address: addressOf(topic), kind: KIND_BARE_FILE, in: [{ id: ORCHARD, name: 'Orchard' }] }])
  })

  test('a Folder listed elsewhere only by an archived Folder hides it', async () => {
    const orchardArchived = archive(addressOf(orchard), { folder: ORCHARD })
    const events = [
      hiveLog, apiary, orchard, topic,
      stateOf(APIARY, 'Apiary', [addressOf(topic)]),
      stateOf(ORCHARD, 'Orchard', [addressOf(topic)]),
      orchardArchived,
    ]
    const impact = await archiveImpact(addressOf(apiary), relay(events))
    assert.deepEqual(impact, { hides: [{ kind: KIND_BARE_FILE, count: 1 }], staysVisible: [] })
  })

  test('a nested Folder only this one lists is walked, and what it holds is counted', async () => {
    const events = [
      hiveLog, apiary, orchard, hive, topic,
      stateOf(APIARY, 'Apiary', [addressOf(orchard)]),
      stateOf(ORCHARD, 'Orchard', [addressOf(hive), addressOf(topic)]),
      // The relay's 39000s are drawn through a manifest when one declares them.
      event({
        kind: 31990,
        pubkey: RELAY,
        tags: [['d', 'folders'], ['k', '39000']],
        content: JSON.stringify({ name: 'Folders', projections: { 39000: { widget: 'card', slots: { title: { tag: 'name' } } } } }),
      }),
    ]
    const impact = await archiveImpact(addressOf(apiary), relay(events))
    assert.deepEqual(
      Object.fromEntries(impact.hides.map((h) => [h.kind, h.count])),
      { 39000: 1, [HIVE]: 1, [KIND_BARE_FILE]: 1 },
    )
  })

  test('a record channel listing a hive and its inspections counts each once', async () => {
    const impact = await archiveImpact(addressOf(hiveTalk), relay([hiveLog, hiveTalk, hive, spring, summer]))
    assert.deepEqual(
      Object.fromEntries(impact.hides.map((h) => [h.kind, h.count])),
      { [HIVE]: 1, [INSPECTION]: 2 },
    )
  })
})

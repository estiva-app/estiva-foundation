/**
 * PEE-21 — the files `[` offers, folded to their current title.
 *
 * The relay indexes a root's `title` and a rename's `value`; neither is the
 * current title on its own. These pin that a hit is only an address: an issue
 * renamed since is found by its new title and not by its old one, a rename
 * whose file the reader cannot read offers nothing, and an issue is captioned
 * with its project's title.
 */
import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import { fileCandidates, resolveForeignObjects, searchFileReferences } from '../dist/index.js'

const AUTHOR = 'a'.repeat(64)
const PROJECT = 30850
const ISSUE = 30851
const CHANGE = 1851
const P1 = `${PROJECT}:${AUTHOR}:p1`
const I = (d) => `${ISSUE}:${AUTHOR}:${d}`

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

/** Honours kinds, tags and `limit`; `search` matches a word of `title` or `value`, as the relay ticket indexes. */
function searchingRelay(events) {
  const calls = []
  const matches = (f, e) => {
    if (f.kinds && !f.kinds.includes(e.kind)) return false
    if (f.authors && !f.authors.includes(e.pubkey)) return false
    if (f.ids && !f.ids.includes(e.id)) return false
    for (const [key, want] of Object.entries(f)) {
      if (!key.startsWith('#')) continue
      const held = e.tags.filter((t) => t[0] === key.slice(1)).map((t) => t[1])
      if (!want.some((v) => held.includes(v))) return false
    }
    if (f.search) {
      const text = e.tags
        .filter((t) => t[0] === 'title' || t[0] === 'ref' || t[0] === 'value')
        .map((t) => t[1])
        .join(' ')
        .toLowerCase()
      if (!text.includes(f.search.toLowerCase())) return false
    }
    return true
  }
  const query = async (filters) => {
    calls.push(filters)
    return filters.flatMap((f) =>
      events
        .filter((e) => matches(f, e))
        .sort((a, b) => b.created_at - a.created_at)
        .slice(0, f.limit ?? Infinity),
    )
  }
  const own = () => calls.filter((filters) => !filters.some((f) => f.kinds?.some((k) => k === 31990 || k === 31989)))
  return { query, calls, own }
}

const manifest = event({
  kind: 31990,
  tags: [['d', 'ship'], ['k', String(PROJECT)], ['k', String(ISSUE)]],
  content: JSON.stringify({
    name: 'Ship',
    records: { changeKind: CHANGE, targetTag: 'a', fieldTag: 'field', valueTag: 'value' },
    projections: {
      [PROJECT]: {
        widget: 'card',
        slots: { title: { tag: 'title', fold: 'title' }, list: { children: { kind: ISSUE, via: 'a', movedBy: 'project' } } },
      },
      [ISSUE]: {
        widget: 'row',
        slots: { title: { tag: 'title', fold: 'title' }, status: { tag: 'status', fold: 'status' }, meta: [{ fold: 'ref', tag: 'ref' }] },
      },
    },
  }),
})

const project = event({ kind: PROJECT, tags: [['d', 'p1'], ['title', 'Conversation standard'], ['h', 'f1']] })
const issue = (d, title, status = 'todo') =>
  event({ kind: ISSUE, tags: [['d', d], ['title', title], ['status', status], ['a', P1], ['h', 'f1']] })
const rename = (address, value) =>
  event({ kind: CHANGE, tags: [['a', address], ['field', 'title'], ['value', value], ['h', 'f1']] })
const archive = (address) =>
  event({ kind: CHANGE, tags: [['a', address], ['field', 'archived'], ['value', 'true'], ['h', 'f1'], ['ts', String(Date.now())]] })

describe('searchFileReferences', () => {
  test('finds an issue by the title it was renamed to, captioned with its project', async () => {
    const relay = searchingRelay([manifest, project, issue('i1', 'Old words'), rename(I('i1'), 'Typing a bracket finds files')])
    const found = await searchFileReferences('bracket', relay.query)
    assert.equal(found.length, 1)
    assert.deepEqual(
      { id: found[0].id, type: found[0].type, title: found[0].title, caption: found[0].caption, tier: found[0].tier },
      { id: I('i1'), type: 'issue', title: 'Typing a bracket finds files', caption: 'Conversation standard', tier: 2 },
    )
    assert.match(found[0].uri, /^nostr:naddr1/)
    assert.equal(found[0].closed, undefined)
  })

  test('does not offer an issue by a title it no longer has', async () => {
    const relay = searchingRelay([manifest, project, issue('i1', 'Old words'), rename(I('i1'), 'New name')])
    assert.deepEqual(await searchFileReferences('old words', relay.query), [])
  })

  test('a rename whose file the reader cannot read offers nothing', async () => {
    // The root is not on this relay for this reader: only its rename came back.
    const relay = searchingRelay([manifest, project, rename(I('hidden'), 'Secret plans')])
    assert.deepEqual(await searchFileReferences('secret', relay.query), [])
  })

  test('finds an issue by its ref, captioned ref then project, and carries the ref to match on', async () => {
    const withRef = event({ kind: ISSUE, tags: [['d', 'r1'], ['title', 'Relay search'], ['ref', 'CON-33'], ['a', P1], ['h', 'f1']] })
    const relay = searchingRelay([manifest, project, withRef])
    const found = await searchFileReferences('CON-33', relay.query)
    assert.deepEqual(
      found.map((c) => ({ id: c.id, title: c.title, caption: c.caption, search: c.search })),
      [{ id: I('r1'), title: 'Relay search', caption: 'CON-33 · Conversation standard', search: 'CON-33' }],
    )
  })

  test('a ref matches only from its start, and only once a digit or hyphen is typed', async () => {
    const withRef = event({ kind: ISSUE, tags: [['d', 'r3'], ['title', 'Relay search'], ['ref', 'CON-33'], ['a', P1], ['h', 'f1']] })
    const relay = searchingRelay([manifest, project, withRef])
    assert.deepEqual(await searchFileReferences('33', relay.query), [])
    // `con` still finds the project by its title, "Conversation standard" — never the issue by its ref.
    assert.deepEqual((await searchFileReferences('con', relay.query)).map((c) => c.id), [P1])
    assert.deepEqual((await searchFileReferences('con-3', relay.query)).map((c) => c.id), [I('r3')])
  })

  test('finds an issue by the ref it was given since, and not by the one it had', async () => {
    const renumbered = event({ kind: ISSUE, tags: [['d', 'r2'], ['title', 'Relay search'], ['ref', 'NEW-1'], ['a', P1], ['h', 'f1']] })
    const reref = event({ kind: CHANGE, tags: [['a', I('r2')], ['field', 'ref'], ['value', 'CON-34'], ['h', 'f1']] })
    const relay = searchingRelay([manifest, project, renumbered, reref])
    assert.deepEqual((await searchFileReferences('CON-34', relay.query)).map((c) => c.id), [I('r2')])
    assert.deepEqual(await searchFileReferences('NEW-1', relay.query), [])
  })

  test('a change to another field is not a hit', async () => {
    const described = event({ kind: CHANGE, tags: [['a', I('i1')], ['field', 'description'], ['value', 'bracket'], ['h', 'f1']] })
    const relay = searchingRelay([manifest, project, issue('i1', 'Old words'), described])
    assert.deepEqual(await searchFileReferences('bracket', relay.query), [])
  })

  test('marks a done issue closed, and finds a project by its root title', async () => {
    const relay = searchingRelay([manifest, project, issue('i2', 'Standard rollout', 'done')])
    const found = await searchFileReferences('standard', relay.query)
    const byId = Object.fromEntries(found.map((c) => [c.id, c]))
    assert.equal(byId[I('i2')].closed, true)
    assert.equal(byId[P1].type, 'project')
    assert.equal(byId[P1].caption, '')
  })

  test('a relay that indexes nothing answers nothing, in one request', async () => {
    const relay = searchingRelay([manifest, project, issue('i1', 'Unindexed')])
    const quiet = { ...relay, query: async (filters) => (filters.some((f) => f.search) ? (relay.calls.push(filters), []) : relay.query(filters)) }
    assert.deepEqual(await searchFileReferences('unindexed', quiet.query), [])
    assert.equal(relay.calls.length, 1)
  })

  test('asks for roots and renames apart, as a prefix search, and reads no comments', async () => {
    const renames = Array.from({ length: 5 }, (_, n) => rename(I('busy'), `Sync attempt ${n}`))
    const relay = searchingRelay([manifest, project, issue('busy', 'x'), issue('quiet', 'Sync engine'), ...renames])
    const found = await searchFileReferences('sync', relay.query, { limit: 3 })
    assert.deepEqual(found.map((c) => c.id).sort(), [I('busy'), I('quiet')])
    const [search] = relay.calls
    assert.equal(search.length, 2)
    assert.ok(search.every((f) => f.search === 'sync' && f.search_mode === 'prefix'))
    assert.ok(!relay.calls.flat().some((f) => f.kinds?.includes(1111)))
  })

  test('offers an archived file, and an issue in an archived project, marked archived', async () => {
    const relay = searchingRelay([manifest, project, archive(P1), issue('i4', 'Archived work')])
    const found = await searchFileReferences('archived', relay.query)
    assert.equal(found.length, 1)
    assert.equal(found[0].archived, true)
    const projects = await searchFileReferences('conversation', relay.query)
    assert.equal(projects[0].archived, true)
  })

  test('nothing typed asks nothing', async () => {
    const relay = searchingRelay([manifest])
    assert.deepEqual(await searchFileReferences('   ', relay.query), [])
    assert.equal(relay.calls.length, 0)
  })
})

describe('fileCandidates', () => {
  test('takes the project title from the set without another read', async () => {
    const relay = searchingRelay([manifest, project, issue('i3', 'Ship it')])
    const objects = await resolveForeignObjects([P1, I('i3')], relay.query)
    const before = relay.own().length
    const rows = await fileCandidates(Object.values(objects), 0, relay.query)
    assert.equal(relay.own().length, before)
    assert.equal(rows.find((r) => r.id === I('i3')).caption, 'Conversation standard')
  })

  test('a Folder tier issue carries its ref to match on and in its caption; a project carries none', async () => {
    const withRef = event({ kind: ISSUE, tags: [['d', 'r4'], ['title', 'Relay search'], ['ref', 'CON-33'], ['a', P1], ['h', 'f1']] })
    const relay = searchingRelay([manifest, project, withRef])
    const objects = await resolveForeignObjects([P1, I('r4')], relay.query)
    const rows = await fileCandidates(Object.values(objects), 0, relay.query)
    const byId = Object.fromEntries(rows.map((r) => [r.id, r]))
    assert.equal(byId[I('r4')].search, 'CON-33')
    assert.equal(byId[I('r4')].caption, 'CON-33 · Conversation standard')
    assert.equal(byId[P1].search, undefined)
  })

  test('leaves out what did not resolve', async () => {
    const relay = searchingRelay([manifest, project])
    const objects = await resolveForeignObjects([I('gone')], relay.query)
    assert.deepEqual(await fileCandidates(Object.values(objects), 1, relay.query), [])
  })
})

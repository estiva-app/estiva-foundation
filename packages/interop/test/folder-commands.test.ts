/*
  Folder write planners — FOL-4, SPEC §3.3.

  The property every test comes back to: **no plan sends a `kind:1852` to a
  Folder that has no state**, except the one that just created it — because the
  relay would emit state listing only what the command named, and everything
  filed in that Folder by `h` would stop being listed (peek#192). And since
  MAN-17: **no command carries a name** — the title is the `kind:39000`'s.
*/
import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import {
  listedBeneath,
  planArchiveFolder,
  planCreateFolder,
  planDeleteFolder,
  planMoveFile,
  planPlaceFile,
  planRenameFolder,
  planUnlistFile,
} from '../dist/index.js'

const PUB = 'b'.repeat(64)
const MS = 1787142018561
const A = '24f5c271-3ed4-47f7-92e4-e9d6cf7f42d1'
const B = '6b1f0b4e-9a0c-4c43-8d1e-2f3a4b5c6d7e'
const C = '0c1d2e3f-4a5b-4c6d-8e7f-901a2b3c4d5e'
const FILE = `30840:${PUB}:t1`
const CHILD = `30840:${PUB}:t2`
const GRANDCHILD = `30840:${PUB}:t3`
const OTHER = `30840:${PUB}:t4`

type Shape = { kind: number; tags: string[][] }
const shape = (events: Shape[]) => events.map(({ kind, tags }) => ({ kind, tags }))
const commandsTo = (events: Shape[], folder: string) =>
  events.filter((e) => e.kind === 1852 && e.tags.some(([t, v]) => t === 'h' && v === folder))
const file = (address: string, parent?: string, folder: string = A) => ({
  ref: address,
  address,
  folder,
  ...(parent ? { parentRef: parent } : {}),
})

describe('planCreateFolder', () => {
  it('creates the channel with its name, then gives it state that lists nothing and names nothing', () => {
    const events = planCreateFolder(PUB, MS, { folder: A, name: 'Design' })
    assert.deepEqual(shape(events), [
      { kind: 9007, tags: [['h', A], ['name', 'Design']] },
      { kind: 1852, tags: [['h', A], ['op', 'add']] },
    ])
  })

  it('canonicalises the channel name', () => {
    const [channel] = planCreateFolder(PUB, MS, { folder: A, name: '  # Design ' })
    assert.deepEqual(channel.tags.find(([t]) => t === 'name'), ['name', 'Design'])
  })

  it('passes visibility to the channel', () => {
    const [channel] = planCreateFolder(PUB, MS, { folder: A, name: 'Ops', visibility: 'private' })
    assert.deepEqual(channel.tags, [['h', A], ['name', 'Ops'], ['visibility', 'private']])
  })
})

describe('planRenameFolder', () => {
  it('renames the channel and nothing else — the title is the 39000 name', () => {
    assert.deepEqual(shape(planRenameFolder(PUB, MS, { folder: A, name: 'Renamed' })), [
      { kind: 9002, tags: [['h', A], ['name', 'Renamed']] },
    ])
  })
})

describe('planDeleteFolder', () => {
  it('is one kind:9008 with the Folder as h', () => {
    assert.deepEqual(shape(planDeleteFolder(PUB, MS, { folder: A })), [{ kind: 9008, tags: [['h', A]] }])
  })

  it('refuses to plan a delete that names no Folder', () => {
    assert.throws(() => planDeleteFolder(PUB, MS, { folder: '' }))
  })
})

describe('planArchiveFolder', () => {
  it('always publishes into the Folder’s own h', () => {
    const channel = `39000:${'c'.repeat(64)}:${A}`
    const [change] = planArchiveFolder(PUB, MS, { folder: A, channel, archived: true, resolution: 'Done' })
    assert.deepEqual(change.tags.find(([t]) => t === 'h'), ['h', A])
    assert.equal(change.content, 'Done')
  })
})

describe('planPlaceFile and planUnlistFile', () => {
  it('plans nothing for a group read by containment', () => {
    assert.deepEqual(planPlaceFile(PUB, MS, { folder: A, address: FILE, hasState: false }), [])
    assert.deepEqual(planUnlistFile(PUB, MS, { folder: A, address: FILE, hasState: false }), [])
  })

  it('adds and removes the one address when the Folder has state', () => {
    assert.deepEqual(shape(planPlaceFile(PUB, MS, { folder: A, address: FILE, hasState: true })), [
      { kind: 1852, tags: [['h', A], ['op', 'add'], ['a', FILE]] },
    ])
    assert.deepEqual(shape(planUnlistFile(PUB, MS, { folder: A, address: FILE, hasState: true })), [
      { kind: 1852, tags: [['h', A], ['op', 'remove'], ['a', FILE]] },
    ])
  })
})

describe('listedBeneath', () => {
  it('walks every depth, in listing order, and leaves out what is beside it', () => {
    const listing = [file(GRANDCHILD, CHILD), file(OTHER), file(FILE), file(CHILD, FILE)]
    assert.deepEqual(
      listedBeneath(listing, file(FILE)).map((f) => f.address),
      [GRANDCHILD, CHILD],
    )
  })

  it('puts nothing beneath a file through a cycle', () => {
    // FILE and CHILD each moved under the other: both are drawn at the top.
    const listing = [file(FILE, CHILD), file(CHILD, FILE), file(GRANDCHILD, CHILD)]
    assert.deepEqual(listedBeneath(listing, listing[0]), [])
    // What sits directly under a file on a cycle is still beneath it.
    assert.deepEqual(
      listedBeneath([...listing, file(OTHER, FILE)], listing[0]).map((f) => f.address),
      [OTHER],
    )
  })
})

describe('planMoveFile', () => {
  const from = { id: A, hasState: true }
  const to = { id: B, hasState: true }

  it('adds to the target before removing from the source', () => {
    const plan = planMoveFile(PUB, MS, { listing: null, file: file(FILE), from, to })
    assert.ok(plan.ok)
    assert.deepEqual(shape(plan.events), [
      { kind: 1852, tags: [['h', B], ['op', 'add'], ['a', FILE]] },
      { kind: 1852, tags: [['h', A], ['op', 'remove'], ['a', FILE]] },
    ])
    assert.deepEqual(plan.moved, [FILE])
  })

  it('moves the subtree whole: one add naming every file, then one remove naming the same set', () => {
    const listing = [file(OTHER), file(FILE), file(CHILD, FILE), file(GRANDCHILD, CHILD)]
    const plan = planMoveFile(PUB, MS, { file: listing[1], from, to, listing })
    assert.ok(plan.ok)
    assert.deepEqual(shape(plan.events), [
      { kind: 1852, tags: [['h', B], ['op', 'add'], ['a', FILE], ['a', CHILD], ['a', GRANDCHILD]] },
      { kind: 1852, tags: [['h', A], ['op', 'remove'], ['a', FILE], ['a', CHILD], ['a', GRANDCHILD]] },
    ])
  })

  it('moves only what is beneath a file the source does not list — an issue is listed by its project', () => {
    const issue = { ref: `30851:${PUB}:i1`, address: `30851:${PUB}:i1`, parentRef: `30850:${PUB}:p1` }
    const listing = [file(OTHER), file(CHILD, issue.ref)]
    const plan = planMoveFile(PUB, MS, { file: issue, from, to, listing })
    assert.ok(plan.ok)
    assert.deepEqual(plan.moved, [CHILD])
  })

  it('walks from the listing’s own entry, whatever ref the caller holds', () => {
    const listing = [file(FILE), file(CHILD, FILE)]
    const plan = planMoveFile(PUB, MS, { file: { ref: 'naddr1-something-else', address: FILE, folder: A }, from, to, listing })
    assert.ok(plan.ok)
    assert.deepEqual(plan.moved, [FILE, CHILD])
  })

  it('plans nothing when nothing it would move is listed', () => {
    const issue = { ref: `30851:${PUB}:i1`, address: `30851:${PUB}:i1` }
    assert.deepEqual(planMoveFile(PUB, MS, { file: issue, from, to, listing: [file(OTHER)] }), { ok: true, events: [], moved: [] })
  })

  it('refuses a move into a private Folder when a moved file lives in another channel', () => {
    const listing = [file(FILE, undefined, B), file(CHILD, FILE, A)]
    const plan = planMoveFile(PUB, MS, { file: listing[0], from, to: { ...to, private: true }, listing })
    assert.deepEqual(plan, { ok: false, reason: 'target-is-private' })
  })

  it('refuses a move into a private Folder of a file with no h — readable by the whole workspace', () => {
    const project = { ref: `30850:${PUB}:p1`, address: `30850:${PUB}:p1` }
    assert.deepEqual(planMoveFile(PUB, MS, { listing: null, file: project, from, to: { ...to, private: true } }), {
      ok: false,
      reason: 'target-is-private',
    })
  })

  it('allows a move into a private Folder of files that already live there', () => {
    const listing = [file(FILE, undefined, B), file(CHILD, FILE, B)]
    const plan = planMoveFile(PUB, MS, { file: listing[0], from, to: { ...to, private: true }, listing })
    assert.ok(plan.ok)
    assert.deepEqual(plan.moved, [FILE, CHILD])
  })

  it('does not care whether the source is private: a listing never changes who can read', () => {
    const plan = planMoveFile(PUB, MS, { listing: null, file: file(FILE, undefined, C), from: { ...from, private: true }, to })
    assert.ok(plan.ok)
  })

  it('refuses a move into a Folder with no state — its contents would disappear', () => {
    const plan = planMoveFile(PUB, MS, { listing: null, file: file(FILE), from, to: { id: B, hasState: false } })
    assert.deepEqual(plan, { ok: false, reason: 'target-has-no-state' })
  })

  it('refuses a move out of a Folder with no state — the source would empty', () => {
    const plan = planMoveFile(PUB, MS, { listing: null, file: file(FILE), from: { id: A, hasState: false }, to })
    assert.deepEqual(plan, { ok: false, reason: 'source-has-no-state' })
  })

  it('reports the source first when neither has state, since no target fixes it', () => {
    const plan = planMoveFile(PUB, MS, { listing: null, file: file(FILE), from: { id: A, hasState: false }, to: { id: B, hasState: false } })
    assert.deepEqual(plan, { ok: false, reason: 'source-has-no-state' })
  })

  it('plans nothing for a move to the same Folder, whatever its state', () => {
    for (const hasState of [true, false]) {
      assert.deepEqual(planMoveFile(PUB, MS, { listing: null, file: file(FILE), from: { id: A, hasState }, to: { id: A, hasState } }), {
        ok: true,
        events: [],
        moved: [],
      })
    }
  })
})

describe('the invariants', () => {
  it('no plan but create sends a command to a Folder without state', () => {
    const plans: Shape[][] = [
      planRenameFolder(PUB, MS, { folder: A, name: 'x' }),
      planDeleteFolder(PUB, MS, { folder: A }),
      planPlaceFile(PUB, MS, { folder: A, address: FILE, hasState: false }),
      planUnlistFile(PUB, MS, { folder: A, address: FILE, hasState: false }),
    ]
    for (const [from, to] of [
      [false, true],
      [true, false],
      [false, false],
    ]) {
      const plan = planMoveFile(PUB, MS, { listing: null, file: file(FILE), from: { id: A, hasState: from }, to: { id: B, hasState: to } })
      plans.push(plan.ok ? plan.events : [])
    }
    for (const events of plans) assert.deepEqual(commandsTo(events, A), [])
  })

  it('no command carries a name', () => {
    const listing = [file(FILE), file(CHILD, FILE)]
    const move = planMoveFile(PUB, MS, { file: listing[0], from: { id: A, hasState: true }, to: { id: B, hasState: true }, listing })
    const events = [
      ...planCreateFolder(PUB, MS, { folder: A, name: 'x' }),
      ...planRenameFolder(PUB, MS, { folder: A, name: 'x' }),
      ...planPlaceFile(PUB, MS, { folder: A, address: FILE, hasState: true }),
      ...(move.ok ? move.events : []),
    ]
    for (const command of events.filter((e) => e.kind === 1852)) assert.equal(command.tags.some(([t]) => t === 'name'), false)
  })

  it('every event is unsigned and authored by the caller', () => {
    const events = [
      ...planCreateFolder(PUB, MS, { folder: A, name: 'x' }),
      ...planRenameFolder(PUB, MS, { folder: A, name: 'x' }),
      ...planDeleteFolder(PUB, MS, { folder: A }),
    ]
    for (const e of events) {
      assert.equal(e.pubkey, PUB)
      assert.equal(e.created_at, Math.floor(MS / 1000))
      assert.equal('sig' in e, false)
      assert.equal('id' in e, false)
    }
  })
})

/*
  Folder write planners — FOL-4.

  The property every test comes back to: **no plan sends a `kind:1852` to a
  Folder that has no state**, except the one that just created it — because the
  relay would emit state listing only what the command named, and everything
  filed in that Folder by `h` would stop being listed (peek#192).
*/
import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { planCreateFolder, planMoveFile, planPlaceFile, planRenameFolder, planUnlistFile } from '../dist/index.js'

const PUB = 'b'.repeat(64)
const MS = 1787142018561
const A = '24f5c271-3ed4-47f7-92e4-e9d6cf7f42d1'
const B = '6b1f0b4e-9a0c-4c43-8d1e-2f3a4b5c6d7e'
const FILE = `30840:${PUB}:t1`

type Shape = { kind: number; tags: string[][] }
const shape = (events: Shape[]) => events.map(({ kind, tags }) => ({ kind, tags }))
const commandsTo = (events: Shape[], folder: string) =>
  events.filter((e) => e.kind === 1852 && e.tags.some(([t, v]) => t === 'h' && v === folder))

describe('planCreateFolder', () => {
  it('creates the channel, then gives it state that names it and lists nothing', () => {
    const events = planCreateFolder(PUB, MS, { folder: A, name: 'Design' })
    assert.deepEqual(shape(events), [
      { kind: 9007, tags: [['h', A], ['name', 'Design']] },
      { kind: 1852, tags: [['h', A], ['op', 'add'], ['name', 'Design']] },
    ])
  })

  it('names both homes the same, canonical, name', () => {
    const [channel, command] = planCreateFolder(PUB, MS, { folder: A, name: '  # Design ' })
    assert.deepEqual(channel.tags.find(([t]) => t === 'name'), ['name', 'Design'])
    assert.deepEqual(command.tags.find(([t]) => t === 'name'), ['name', 'Design'])
  })

  it('passes visibility to the channel', () => {
    const [channel] = planCreateFolder(PUB, MS, { folder: A, name: 'Ops', visibility: 'private' })
    assert.deepEqual(channel.tags, [['h', A], ['name', 'Ops'], ['visibility', 'private']])
  })
})

describe('planRenameFolder', () => {
  it('renames the channel only, when the Folder has no state', () => {
    const events = planRenameFolder(PUB, MS, { folder: A, name: 'Renamed', hasState: false })
    assert.deepEqual(shape(events), [{ kind: 9002, tags: [['h', A], ['name', 'Renamed']] }])
  })

  it('renames the state too when it has one — add with no addresses, never set', () => {
    const events = planRenameFolder(PUB, MS, { folder: A, name: 'Renamed', hasState: true })
    assert.deepEqual(shape(events), [
      { kind: 9002, tags: [['h', A], ['name', 'Renamed']] },
      { kind: 1852, tags: [['h', A], ['op', 'add'], ['name', 'Renamed']] },
    ])
  })
})

describe('planPlaceFile and planUnlistFile', () => {
  it('plans nothing for a Folder read by containment', () => {
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

describe('planMoveFile', () => {
  it('adds to the target before removing from the source', () => {
    const plan = planMoveFile(PUB, MS, { address: FILE, from: { id: A, hasState: true }, to: { id: B, hasState: true } })
    assert.ok(plan.ok)
    assert.deepEqual(shape(plan.events), [
      { kind: 1852, tags: [['h', B], ['op', 'add'], ['a', FILE]] },
      { kind: 1852, tags: [['h', A], ['op', 'remove'], ['a', FILE]] },
    ])
  })

  it('refuses a move into a Folder with no state — its contents would disappear', () => {
    const plan = planMoveFile(PUB, MS, { address: FILE, from: { id: A, hasState: true }, to: { id: B, hasState: false } })
    assert.deepEqual(plan, { ok: false, reason: 'target-has-no-state' })
  })

  it('refuses a move out of a Folder with no state — the source would empty', () => {
    const plan = planMoveFile(PUB, MS, { address: FILE, from: { id: A, hasState: false }, to: { id: B, hasState: true } })
    assert.deepEqual(plan, { ok: false, reason: 'source-has-no-state' })
  })

  it('reports the source first when neither has state, since no target fixes it', () => {
    const plan = planMoveFile(PUB, MS, { address: FILE, from: { id: A, hasState: false }, to: { id: B, hasState: false } })
    assert.deepEqual(plan, { ok: false, reason: 'source-has-no-state' })
  })

  it('plans nothing for a move to the same Folder, whatever its state', () => {
    for (const hasState of [true, false]) {
      assert.deepEqual(planMoveFile(PUB, MS, { address: FILE, from: { id: A, hasState }, to: { id: A, hasState } }), {
        ok: true,
        events: [],
      })
    }
  })
})

describe('the invariant', () => {
  it('no plan but create sends a command to a Folder without state', () => {
    const plans: Shape[][] = [
      planRenameFolder(PUB, MS, { folder: A, name: 'x', hasState: false }),
      planPlaceFile(PUB, MS, { folder: A, address: FILE, hasState: false }),
      planUnlistFile(PUB, MS, { folder: A, address: FILE, hasState: false }),
    ]
    for (const [from, to] of [
      [false, true],
      [true, false],
      [false, false],
    ]) {
      const plan = planMoveFile(PUB, MS, { address: FILE, from: { id: A, hasState: from }, to: { id: B, hasState: to } })
      plans.push(plan.ok ? plan.events : [])
    }
    for (const events of plans) assert.deepEqual(commandsTo(events, A), [])
  })

  it('every event is unsigned and authored by the caller', () => {
    const events = [
      ...planCreateFolder(PUB, MS, { folder: A, name: 'x' }),
      ...planRenameFolder(PUB, MS, { folder: A, name: 'x', hasState: true }),
    ]
    for (const e of events) {
      assert.equal(e.pubkey, PUB)
      assert.equal(e.created_at, Math.floor(MS / 1000))
      assert.equal('sig' in e, false)
      assert.equal('id' in e, false)
    }
  })
})

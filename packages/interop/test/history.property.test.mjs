/**
 * The shared reads, on made-up histories (TES, milestone 1).
 *
 * Peek, Leaf and the agent read a file through `projectEvents`; Leaf and the
 * agent read lists of files through `filesOf`. Both must give the same file
 * for the same changes in whatever order they arrive, delivered once or twice,
 * and must give the same file as each other. Each rule is tried on thousands
 * of histories `@estiva-app/protocol/testing` makes up: projects, issues and
 * documents, renamed, moved, a status set, assigned, archived, deleted, by
 * several people, many in the same second.
 *
 * A failure prints the smallest history that breaks the rule and the seed
 * that replays it: `FC_SEED=<seed> npm test -w packages/interop`.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import fc from 'fast-check'
import { deliveryArb, historyArb, runSettings } from '@estiva-app/protocol/testing'
import { filesOf, historyOf, projectEvents } from '../dist/index.js'

// 1,000 histories a rule: about 0.3 s each, 1.5 s for the file (measured 20 Nov 2026).
const settings = runSettings(1000)
console.log(`fast-check seed ${settings.seed}, ${settings.numRuns} runs per rule`)

const APP = 'c'.repeat(64)
const slots = { title: { tag: 'title', fold: 'title' }, status: { fold: 'status' }, summary: { fold: 'summary' } }
/** A tracker's manifest in Ship's shape (estiva-ship src/nostr/manifest.ts): the raw values, no labels. */
const MANIFEST = {
  name: 'Tracker',
  records: { changeKind: 1851, targetTag: 'a', fieldTag: 'field', valueTag: 'value', order: ['ts', 'created_at', 'id'], rule: 'last-write-wins-per-field' },
  projections: {
    30850: { widget: 'card', slots: { ...slots, list: { children: { kind: 30851, via: 'a', limit: 200, movedBy: 'project' } } } },
    30851: { widget: 'row', slots: { ...slots, meta: [{ label: 'Assignee', fold: 'assignee', as: 'pubkey' }] } },
    30842: { widget: 'card', slots },
  },
  actions: [],
}
const resolved = { manifest: MANIFEST, address: `31990:${APP}:tracker`, viaRecommendation: false }
const manifestFor = () => resolved

const byAddress = (a, b) => (a.address < b.address ? -1 : a.address > b.address ? 1 : 0)

/** What `filesOf` says of each file: its record, and each field's value and the change it came from. */
function listed(events) {
  return filesOf(events)
    .sort(byAddress)
    .map((file) => ({
      address: file.address,
      root: file.root.id,
      fields: Object.fromEntries(Object.entries(file.fields).map(([field, f]) => [field, { value: f.value, change: f.id }]).sort()),
      events: file.events.map((e) => e.id).sort(),
    }))
}

/** What `projectEvents` says of each file, whole. */
function projected(events) {
  return projectEvents(events, manifestFor).sort(byAddress)
}

const historyAndTwoDeliveries = (options) =>
  historyArb(options).chain((history) => fc.tuple(fc.constant(history), deliveryArb(history.events), deliveryArb(history.events)))

test('the list read (filesOf) gives the same files for the same events in any order, some delivered twice', () => {
  fc.assert(
    fc.property(historyAndTwoDeliveries(), ([, first, second]) => {
      assert.deepEqual(listed(first), listed(second))
    }),
    settings,
  )
})

test('the shared read (projectEvents) gives the same files for the same events in any order, some delivered twice', () => {
  fc.assert(
    fc.property(historyAndTwoDeliveries(), ([, first, second]) => {
      assert.deepEqual(projected(first), projected(second))
    }),
    settings,
  )
})

/** The fields both reads give, as a person would see them on a card. */
function seenInList(file) {
  const tag = (name) => file.root.tags.find((t) => t[0] === name)?.[1]
  const value = (field) => file.fields[field]?.value
  return {
    address: file.address,
    record: file.root.id,
    title: value('title') ?? tag('title') ?? '',
    status: value('status') ?? '',
    summary: value('summary') ?? '',
    assignee: value('assignee') ?? '',
    parent: value('project') || tag('a') || '',
    archived: value('archived') === 'true',
    deleted: value('deleted') === 'true',
  }
}

function seenInSharedRead(object) {
  return {
    address: object.address,
    record: object.eventId,
    title: object.slots.title?.value ?? '',
    status: object.slots.status?.value ?? '',
    summary: object.slots.summary?.value ?? '',
    assignee: object.meta[0]?.value ?? '',
    parent: object.parentRef ?? '',
    archived: Boolean(object.archived),
    deleted: Boolean(object.deleted),
  }
}

// Also on ids with a colon: the shared read cut the id there when it read an
// archive, so a file archived by a change naming it in `O` read as live (TES-2,
// found by Ship's comparison with this read).
for (const [ids, options] of [['', {}], [', on file ids with a colon in them', { idsWithColons: true }]]) {
  test(`the list read and the shared read give the same title, status, summary, assignee, parent, archived and deleted${ids}`, () => {
    fc.assert(
      fc.property(historyArb(options).chain((history) => deliveryArb(history.events)), (events) => {
        const list = filesOf(events).sort(byAddress).map(seenInList)
        const shared = projected(events).map(seenInSharedRead)
        assert.deepEqual(list, shared)
      }),
      settings,
    )
  })
}

/** A file's history as a person would read it down a panel: each line's change, field, value, who and when. */
function lines(events) {
  return historyOf(events).map((line) => ({
    file: line.address,
    change: line.id,
    field: line.field,
    value: line.value,
    by: line.pubkey,
    at: line.at,
    stage: line.stage ?? '',
    format: line.format ?? '',
  }))
}

test('the history (historyOf) lists the same changes in the same order for the same events in any order, some delivered twice', () => {
  fc.assert(
    fc.property(historyAndTwoDeliveries(), ([history, first, second]) => {
      assert.deepEqual(lines(first), lines(second))
      assert.deepEqual(lines(first), lines(history.events))
    }),
    settings,
  )
})

const tagOf = (event, name) => event.tags.find((t) => t[0] === name && t[1])?.[1]

test("the history leaves out a change signed in another team than the file's", () => {
  let held = 0
  fc.assert(
    fc.property(historyArb().chain((history) => deliveryArb(history.events)), (events) => {
      const teamsOf = new Map(
        filesOf(events).map((file) => [file.address, file.root.tags.filter((t) => (t[0] === 'h' || t[0] === 'buzz-channel') && t[1]).map((t) => t[1])]),
      )
      const elsewhere = events.filter((e) => {
        const teams = e.kind === 1851 ? teamsOf.get(tagOf(e, 'a')) : undefined
        return teams?.length && !teams.includes(tagOf(e, 'h'))
      })
      if (elsewhere.length) held++
      const listed = new Set(historyOf(events).map((line) => line.id))
      for (const change of elsewhere) assert.equal(listed.has(change.id), false, `listed a change signed in ${tagOf(change, 'h')}`)
    }),
    settings,
  )
  // The rule is only shown by histories that hold such a change. A short run
  // (FC_RUNS, replaying one seed) may hold none, and that is not a failure.
  if (settings.numRuns >= 100) assert.ok(held > settings.numRuns / 10, `only ${held} of ${settings.numRuns} histories held a change signed in another team`)
})

test("the last line of each field in a file's history is the field's current change, with its value, who set it, when and its stage", () => {
  fc.assert(
    fc.property(historyArb().chain((history) => deliveryArb(history.events)), (events) => {
      const last = new Map()
      for (const line of historyOf(events)) {
        last.set(`${line.address} ${line.field}`, { value: line.value, change: line.id, by: line.pubkey, at: line.at, stage: line.stage ?? '', format: line.format ?? '' })
      }
      const current = new Map(
        filesOf(events, { withText: true }).flatMap((file) =>
          Object.entries(file.fields).map(([field, f]) => [
            `${file.address} ${field}`,
            { value: f.value, change: f.id, by: f.pubkey, at: f.at, stage: f.stage ?? '', format: f.format ?? '' },
          ]),
        ),
      )
      assert.deepEqual([...last].sort(), [...current].sort())
    }),
    settings,
  )
})

test('the shared read gives a status as stored beside its label, the same value the list read gives', () => {
  const labelled = {
    ...resolved,
    manifest: {
      ...MANIFEST,
      vocabularies: { status: [{ value: 'in_progress', label: 'In Progress', colour: 'blue' }] },
      projections: Object.fromEntries(
        Object.entries(MANIFEST.projections).map(([kind, p]) => [kind, { ...p, slots: { ...p.slots, status: { fold: 'status', map: 'status' } } }]),
      ),
    },
  }
  let labels = 0
  fc.assert(
    fc.property(historyArb().chain((history) => deliveryArb(history.events)), (events) => {
      const list = new Map(filesOf(events).map((file) => [file.address, file.fields.status?.value]))
      for (const object of projectEvents(events, () => labelled)) {
        const status = object.slots.status
        if (!status) continue
        assert.equal(status.stored, list.get(object.address))
        if (status.stored === 'in_progress') {
          assert.equal(status.value, 'In Progress')
          labels++
        }
      }
    }),
    settings,
  )
  if (settings.numRuns >= 100) assert.ok(labels > 0, 'no history set a status the list names')
})

test('the reads keep a file whose id has a colon in it whole', () => {
  fc.assert(
    fc.property(historyArb({ idsWithColons: true }), (history) => {
      assert.deepEqual(filesOf(history.events).map((f) => f.address).sort(), [...history.files].sort())
      assert.deepEqual(projected(history.events).map((o) => o.address).sort(), [...history.files].sort())
    }),
    settings,
  )
})

/** For each file, each field a change set: its value, that change, who made it, the second, and its stage. */
const whoSetWhat = (files) => Object.fromEntries(files.map(([address, fields]) => [address, Object.fromEntries(Object.entries(fields).sort())]))

test('the shared read asked for fields names, for each field, the same value, change, person, second and stage as the list read', () => {
  fc.assert(
    fc.property(historyArb().chain((history) => deliveryArb(history.events)), (events) => {
      const list = filesOf(events, { withText: true }).map((file) => [
        file.address,
        Object.fromEntries(Object.entries(file.fields).map(([field, f]) => [field, { value: f.value, change: f.id, by: f.pubkey, at: Math.floor(f.at / 1000), stage: f.stage ?? '' }])),
      ])
      const shared = projectEvents(events, manifestFor, { fields: true }).map((object) => [
        object.address,
        Object.fromEntries(Object.entries(object.fields).map(([field, f]) => [field, { value: f.value, change: f.id, by: f.by, at: f.at, stage: f.stage ?? '' }])),
      ])
      assert.deepEqual(whoSetWhat(shared), whoSetWhat(list))
    }),
    settings,
  )
})

test('the shared read asked to leave out links and actions gives the same files, each without its link, its address to open and its actions', () => {
  fc.assert(
    fc.property(historyArb().chain((history) => deliveryArb(history.events)), (events) => {
      const whole = projected(events).map(({ naddr, openUrl, actions, ...rest }) => rest)
      const bare = projectEvents(events, manifestFor, { bare: true }).sort(byAddress)
      for (const object of bare) {
        assert.equal('naddr' in object, false)
        assert.equal('openUrl' in object, false)
        assert.deepEqual(object.actions, [])
      }
      assert.deepEqual(bare.map(({ actions, ...rest }) => rest), whole)
    }),
    settings,
  )
})

test('a shared read that remembers gives, once more events arrive, the same files as a read of them all afresh', () => {
  let reused = 0
  fc.assert(
    fc.property(historyArb().chain((history) => fc.tuple(deliveryArb(history.events), fc.nat())), ([events, cut]) => {
      const earlier = events.slice(0, cut % (events.length + 1))
      const before = projectEvents(earlier, manifestFor, { fields: true, remember: true })
      const remembered = projectEvents(events, manifestFor, { fields: true, remember: true })
      if (remembered.some((object) => before.includes(object))) reused++
      assert.deepEqual(remembered.sort(byAddress), projectEvents(events, manifestFor, { fields: true }).sort(byAddress))
    }),
    settings,
  )
  if (settings.numRuns >= 100) assert.ok(reused > 0, 'no read handed back a file it had kept')
})

test('the changes the shared read counted for a file are the lines of its history, each with its time and stage', () => {
  let lines = 0
  fc.assert(
    fc.property(historyArb().chain((history) => deliveryArb(history.events)), (delivered) => {
      // The history lists a change delivered twice once; the shared read counts what it is handed.
      const events = [...new Map(delivered.map((event) => [event.id, event])).values()]
      // Not the format: the history names it on the text alone, a counted change on every field its event sets.
      const line = ({ id, field, value, at, stage }) => JSON.stringify([id, field, value, at, stage ?? null])
      const history = new Map()
      for (const change of historyOf(events)) history.set(change.address, [...(history.get(change.address) ?? []), line(change)])
      for (const object of projectEvents(events, manifestFor, { changes: true })) {
        const counted = object.changes.map((change) => line({ ...change, id: change.event.id, at: change.ms }))
        lines += counted.length
        assert.deepEqual(counted.sort(), (history.get(object.address) ?? []).sort())
      }
      // Asked for, they change nothing else about a file.
      assert.deepEqual(
        projectEvents(events, manifestFor, { changes: true }).map(({ changes, ...rest }) => rest).sort(byAddress),
        projected(events),
      )
    }),
    settings,
  )
  if (settings.numRuns >= 100) assert.ok(lines > 0, 'no history set a field')
})

test('who changed a file last is the same in whatever order its changes arrive, when two people changed it in the same second', () => {
  const [ANA, BEN] = ['1'.repeat(64), '2'.repeat(64)]
  const at = 1763000000
  const address = `30850:${BEN}:payments`
  const change = (id, pubkey, created_at, tags) => ({ id: id.repeat(64), pubkey, kind: 1851, created_at, content: '', sig: '', tags: [['a', address], ['h', 'team'], ...tags] })
  const record = { id: '0'.repeat(64), pubkey: BEN, kind: 30850, created_at: at, content: '', sig: '', tags: [['d', 'payments'], ['title', 'Payments'], ['h', 'team']] }
  // One change sets the status, then the title. A second later Ben sets the
  // status again and Ana the title: the status was set first, so its change is
  // the one a reader names (the first listed of two in the same second).
  const both = change('a', BEN, at, [['set', 'status', 'todo'], ['set', 'title', 'Payments']])
  const status = change('b', BEN, at + 1, [['field', 'status'], ['value', 'doing']])
  const title = change('c', ANA, at + 1, [['field', 'title'], ['value', 'Pay']])
  for (const changes of [[both, status, title], [both, title, status], [status, both, title], [status, title, both], [title, both, status], [title, status, both]]) {
    const [file] = projectEvents([record, ...changes], manifestFor)
    assert.equal(file.changedBy, BEN, `arriving as ${changes.map((c) => c.id[0]).join(', ')}`)
  }
})

test('an event with an empty tag is read past, and the file beside it is still read', () => {
  const BEN = '2'.repeat(64)
  const record = { id: '0'.repeat(64), pubkey: BEN, kind: 30850, created_at: 1763000000, content: '', sig: '', tags: [['d', 'payments'], ['title', 'Payments'], ['h', 'team']] }
  const odd = { id: 'e'.repeat(64), pubkey: BEN, kind: 1851, created_at: 1763000001, content: '', sig: '', tags: [[], ['a', `30850:${BEN}:payments`], ['h', 'team'], ['field', 'title'], ['value', 'Pay']] }
  const [file] = projectEvents([record, odd], manifestFor)
  assert.equal(file.slots.title.value, 'Pay')
})

test("an event of another kind that names a file and carries a change's tags changes nothing about the file", () => {
  const BEN = '2'.repeat(64)
  const address = `30850:${BEN}:payments`
  const record = { id: '0'.repeat(64), pubkey: BEN, kind: 30850, created_at: 1763000000, content: '', sig: '', tags: [['d', 'payments'], ['title', 'Payments'], ['h', 'team']] }
  const notAChange = (id, tags) => ({ id: id.repeat(64), pubkey: BEN, kind: 1111, created_at: 1763000005, content: '', sig: '', tags: [['a', address], ['h', 'team'], ...tags] })
  const events = [record, notAChange('a', [['field', 'title'], ['value', 'Renamed']]), notAChange('b', [['set', 'archived', 'true'], ['set', 'title', 'Renamed too']])]
  const [file] = projectEvents(events, manifestFor, { changes: true })
  assert.equal(file.slots.title.value, 'Payments')
  assert.equal(file.archived, undefined)
  assert.deepEqual(file.changes, [])
})

test('a shared read that remembers answers each way of asking with what was asked for, not with what the last read was given', () => {
  const ways = [{}, { changes: true }, { fields: true }, { bare: true }, { bare: true, fields: true, changes: true }]
  fc.assert(
    fc.property(historyArb().chain((history) => deliveryArb(history.events)), fc.constantFrom(...ways), fc.constantFrom(...ways), (events, first, second) => {
      projectEvents(events, manifestFor, { ...first, remember: true })
      const remembered = projectEvents(events, manifestFor, { ...second, remember: true }).sort(byAddress)
      // A fresh read of copies: nothing remembered can answer for it.
      const afresh = projectEvents(structuredClone(events), manifestFor, second).sort(byAddress)
      assert.deepEqual(remembered, afresh)
    }),
    settings,
  )
})

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
import { filesOf, projectEvents } from '../dist/index.js'

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

test('the list read and the shared read give the same title, status, summary, assignee, parent, archived and deleted', () => {
  fc.assert(
    fc.property(historyArb().chain((history) => deliveryArb(history.events)), (events) => {
      const list = filesOf(events).sort(byAddress).map(seenInList)
      const shared = projected(events).map(seenInSharedRead)
      assert.deepEqual(list, shared)
    }),
    settings,
  )
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

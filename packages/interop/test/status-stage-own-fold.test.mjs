/**
 * An app that folds its own changes counts a status as a card does — EAC-3.
 *
 * Ship and the agent fold projects and issues themselves, so they cannot read
 * a resolved slot's `stage`. They read the winning change's stage with
 * `stageTagOf` and count it with `statusStageOf` and `progressOfStages`. The
 * claim: for every case, those give exactly what `resolveForeignObject`'s
 * status slot and `progress` give for the same events, so Ship, the agent,
 * Peek and Leaf count one project the same way.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { resolveForeignObject, statusStageOf, stageTagOf, progressOfStages } from '../dist/index.js'
import { withListRead } from './list-read.mjs'

/** The fake relay, answering the list and open reads as the relay does (§6.13). */
function relay(events) {
  return withListRead(plainRelay(events), events)
}

const SHIP = 'a'.repeat(64)
const PROJECT = 30850
const ISSUE = 30851

let seq = 0
const event = (partial) => ({
  id: String(++seq).padStart(64, '0'),
  sig: '',
  pubkey: SHIP,
  created_at: 1_700_000_000 + seq,
  tags: [],
  content: '',
  ...partial,
})

const plainRelay = (events) => async (filters) =>
  events.filter((e) =>
    filters.some((f) => {
      if (f.kinds && !f.kinds.includes(e.kind)) return false
      if (f.authors && !f.authors.includes(e.pubkey)) return false
      if (f.ids && !f.ids.includes(e.id)) return false
      for (const [key, want] of Object.entries(f)) {
        if (!key.startsWith('#')) continue
        const held = e.tags.filter((t) => t[0] === key.slice(1)).map((t) => t[1])
        if (!want.some((v) => held.includes(v))) return false
      }
      return true
    }),
  )

const TRACKER = {
  name: 'Tracker',
  records: { changeKind: 1851, targetTag: 'a', fieldTag: 'field', valueTag: 'value' },
  vocabularies: {
    issueStatuses: [
      { value: 'todo', label: 'Todo', colour: 'neutral', stage: 'open' },
      { value: 'in_progress', label: 'In Progress', colour: 'blue', stage: 'started' },
      { value: 'done', label: 'Done', colour: 'green', stage: 'done' },
      { value: 'cancelled', label: 'Cancelled', colour: 'muted', stage: 'dropped' },
      { value: 'afgerond', label: 'Afgerond', colour: 'green', stage: 'done' },
    ],
  },
  projections: {
    [PROJECT]: { widget: 'card', slots: { title: { tag: 'title' }, list: { children: { kind: ISSUE, via: 'a', limit: 200 } } } },
    [ISSUE]: { widget: 'row', slots: { title: { tag: 'title' }, status: { fold: 'status', map: 'issueStatuses', default: 'todo' } } },
  },
}

const projectAddress = `${PROJECT}:${SHIP}:p1`
const issueAddress = (d) => `${ISSUE}:${SHIP}:${d}`
const issue = (d) => event({ kind: ISSUE, tags: [['d', d], ['title', d], ['a', projectAddress]] })
const status = (d, value, extra = []) => event({ kind: 1851, tags: [['a', issueAddress(d)], ['field', 'status'], ['value', value], ...extra] })

/** Each issue's status changes, oldest first; the last one wins, as in every fold. */
const CASES = {
  'a status no listing names, stage started': [status('blocked', 'blocked', [['stage', 'status', 'started']])],
  'a status no listing names, stage done': [status('shipped', 'shipped', [['stage', 'status', 'done']])],
  'a status no listing names, no stage': [status('waiting', 'waiting')],
  'Done, no stage': [status('d', 'done')],
  'Cancelled, no stage': [status('c', 'cancelled')],
  'In Progress, no stage': [status('i', 'in_progress')],
  'a listing that says done, no stage (the directory does not know it)': [status('af', 'afgerond')],
  'the change’s stage over the directory’s': [status('o', 'todo', [['stage', 'status', 'done']])],
  'a stage naming another field': [status('x', 'blocked', [['stage', 'title', 'done']])],
  'a stage outside the four': [status('y', 'blocked', [['stage', 'status', 'finished']])],
  'a later change with no stage leaves none': [status('l', 'blocked', [['stage', 'status', 'done']]), status('l', 'blocked')],
}

test('statusStageOf on the winning change gives the stage a resolved card counts by, case by case', async () => {
  const events = []
  const winning = {}
  for (const changes of Object.values(CASES)) {
    const d = changes[0].tags.find((t) => t[0] === 'a')[1].split(':')[2]
    events.push(issue(d), ...changes)
    winning[d] = changes.at(-1)
  }
  const manifest = event({ kind: 31990, tags: [['d', 'tracker'], ['k', String(PROJECT)], ['k', String(ISSUE)]], content: JSON.stringify(TRACKER) })
  const object = await resolveForeignObject(projectAddress, relay([manifest, event({ kind: PROJECT, tags: [['d', 'p1'], ['title', 'P']] }), ...events]))
  const card = Object.fromEntries(object.children.map((c) => [c.slots.title.value, c.slots.status.stage]))

  const own = Object.fromEntries(
    Object.entries(winning).map(([d, change]) => {
      const value = change.tags.find((t) => t[0] === 'value')[1]
      return [d, statusStageOf(ISSUE, value, stageTagOf(change, 'status'))]
    }),
  )
  assert.deepEqual(own, card)
  assert.deepEqual(own, {
    blocked: 'started', shipped: 'done', waiting: undefined, d: 'done', c: 'dropped', i: 'started',
    af: undefined, o: 'done', x: undefined, y: undefined, l: undefined,
  })
  assert.deepEqual(progressOfStages(Object.values(own)), object.progress, 'the same ring')
})

test('an issue that never had a status change counts by its default id, as the card’s default does', () => {
  assert.equal(statusStageOf(ISSUE, 'todo'), 'open')
  assert.equal(statusStageOf(PROJECT, 'planned'), 'open')
  assert.equal(statusStageOf(PROJECT, 'completed'), 'done')
})

test('a kind that is not a base type ignores a written stage and reads the words', () => {
  assert.equal(statusStageOf(30023, 'blocked', 'done'), undefined)
  assert.equal(statusStageOf(30023, 'Done', 'open'), 'done')
})

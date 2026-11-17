/**
 * An app that builds its own changes writes a status's stage as a declared
 * action does — EAC-4.
 *
 * Ship builds its project and issue changes itself, so it cannot lean on
 * `buildActionEvent` to put the stage on. It appends `stageTagFor`'s tag. The
 * claim: for every option and every edge, the tag is exactly the one
 * `buildActionEvent` writes last for the same choice, and none where a writer
 * would have to guess what a status means (SPEC §6.2, §7.3).
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { buildActionEvent, stageTagFor, stageTagOf } from '../dist/index.js'

const SHIP = 'a'.repeat(64)
const ISSUE = 30851
const FOLDER = 'f'.repeat(8) + '-0000-4000-8000-' + '0'.repeat(12)
const ADDRESS = `${ISSUE}:${SHIP}:issue-1`

const statuses = [
  { value: 'todo', label: 'Todo', colour: 'neutral', stage: 'open' },
  { value: 'in_progress', label: 'In Progress', colour: 'blue', stage: 'started' },
  { value: 'done', label: 'Done', colour: 'green', stage: 'done' },
  { value: 'cancelled', label: 'Cancelled', colour: 'muted', stage: 'dropped' },
  // A stage outside the four is absent (§6.2), never written as a fifth.
  { value: 'waiting', label: 'Waiting', colour: 'neutral', stage: 'paused' },
]
const archived = [{ value: 'true', label: 'Archived', colour: 'muted' }]

const manifest = {
  vocabularies: { issueStatuses: statuses, archived },
  records: { changeKind: 1851, order: ['a', 'field', 'value', 'h', 'ts'] },
  actions: [
    { id: 'set-issue-status', label: 'Change status', appliesTo: String(ISSUE), emits: { kind: 1851, field: 'status' }, input: { type: 'string', enum: 'issueStatuses' } },
    { id: 'archive-issue', label: 'Archive', appliesTo: String(ISSUE), emits: { kind: 1851, field: 'archived' }, input: { type: 'string', enum: 'archived' } },
    { id: 'create-issue', label: 'New issue', appliesTo: '30850', emits: { kind: ISSUE }, input: { type: 'object', properties: { title: { type: 'string' }, status: { type: 'string', enum: 'issueStatuses' } }, required: ['title'] } },
  ],
}

const declared = (actionId, value) => {
  const built = buildActionEvent({ manifest, kind: ISSUE, address: ADDRESS, objectAuthor: SHIP, folder: FOLDER, actionId, value, pubkey: SHIP, createdAtMs: 1_700_000_000_000 })
  assert.notEqual(typeof built, 'string', String(built))
  return built
}
const stageOn = (event) => event.tags.find((t) => t[0] === 'stage')

test('each offered status gets the stage a declared action writes last, and reads back as that stage', () => {
  for (const { value, stage } of statuses.slice(0, 4)) {
    const own = stageTagFor('status', value, statuses)
    assert.deepEqual(own, ['stage', 'status', stage], value)
    const event = declared('set-issue-status', value)
    assert.deepEqual(event.tags.at(-1), own, `${value}: buildActionEvent's last tag`)
    assert.equal(stageTagOf({ tags: [own] }, 'status'), stage)
  }
})

test('a cleared status carries no stage', () => {
  // A declared action refuses '' outside its enum; an app building its own change may clear one.
  assert.equal(stageTagFor('status', '', statuses), undefined)
})

test('an id the writer did not offer carries no stage: the writer never guesses one', () => {
  // `blocked` is a company's status this writer's list does not have; its words say nothing either.
  assert.equal(stageTagFor('status', 'blocked', statuses), undefined)
  // Words that would read as done are not a stage either.
  assert.equal(stageTagFor('status', 'completed', statuses), undefined)
  assert.equal(stageTagFor('status', 'done', undefined), undefined)
})

test('an option whose stage is outside the four carries none, here and on a declared action', () => {
  assert.equal(stageTagFor('status', 'waiting', statuses), undefined)
  assert.equal(stageOn(declared('set-issue-status', 'waiting')), undefined)
})

test('a field whose options carry no stage writes none', () => {
  assert.equal(stageTagFor('archived', 'true', archived), undefined)
  assert.equal(stageOn(declared('archive-issue', 'true')), undefined)
})

test('a creation that sets a status carries its stage on the root, last; one with no status carries none', () => {
  const create = (value) => {
    const built = buildActionEvent({ manifest, kind: 30850, address: `30850:${SHIP}:p1`, objectAuthor: SHIP, folder: FOLDER, actionId: 'create-issue', value, newId: 'new-issue', pubkey: SHIP, createdAtMs: 1_700_000_000_000 })
    assert.notEqual(typeof built, 'string', String(built))
    return built
  }
  const withStatus = create({ title: 'Ship it', status: 'in_progress' })
  assert.deepEqual(withStatus.tags.at(-1), ['stage', 'status', 'started'])
  assert.equal(stageTagOf(withStatus, 'status'), 'started')
  assert.equal(stageOn(create({ title: 'Ship it' })), undefined)
})

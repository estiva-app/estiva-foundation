/**
 * SHA-28 — a change or a creation that names a person carries `["p", <key>]`.
 *
 * SPEC §11.8 makes a person a member of a file when a change on it names them
 * in `p`, and `{"kinds":[1851],"#p":[me]}` is how every app finds those. Ship's
 * own builder added the `p` for `assignee` and `lead`; interop wrote neither,
 * so an assignment from Peek or the agent made nobody a member. The rule is
 * the manifest's: an input of `type: "pubkey"` names a person (SPEC §7.3).
 */
import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import { buildActionEvent, buildActionEvents } from '../dist/index.js'

const AUTHOR = 'a'.repeat(64)
const ACTOR = 'c'.repeat(64)
const PERSON = '3bb30d683788016b85c83604dd5660e4e172e95d46d4e3ebab623ff5847b1f71'
const OTHER = 'd'.repeat(64)
const ISSUE = 30851
const PROJECT = 30850
const FOLDER = '7b32200c-e4c0-4216-b79a-8490fc05e0bd'
const I1 = `${ISSUE}:${AUTHOR}:i1`
const P1 = `${PROJECT}:${AUTHOR}:p1`
const NOW = 1_700_000_000_000

// As Ship's live manifest declares them (src/nostr/manifest.ts).
const manifest = {
  records: {
    changeKind: 1851,
    targetTag: 'a',
    fieldTag: 'field',
    valueTag: 'value',
    order: ['ts', 'created_at', 'id'],
    rule: 'last-write-wins-per-field',
  },
  vocabularies: { status: [{ value: 'todo' }, { value: 'done' }] },
  actions: [
    { id: 'assign', label: 'Assign', appliesTo: String(ISSUE), emits: { kind: 1851, field: 'assignee' }, input: { type: 'pubkey' } },
    { id: 'set-lead', label: 'Set lead', appliesTo: String(PROJECT), emits: { kind: 1851, field: 'lead' }, input: { type: 'pubkey' } },
    { id: 'retitle', label: 'Rename', appliesTo: String(ISSUE), emits: { kind: 1851, field: 'title' }, input: { type: 'string' } },
    {
      id: 'add-project',
      label: 'Add project',
      appliesTo: String(PROJECT),
      emits: { kind: PROJECT },
      input: {
        type: 'object',
        properties: { title: { type: 'string' }, lead: { type: 'pubkey' }, owner: { type: 'pubkey' } },
        required: ['title'],
      },
    },
  ],
}

const change = (actionId, value, address = I1, kind = ISSUE) =>
  buildActionEvent({ manifest, kind, address, objectAuthor: AUTHOR, folder: FOLDER, actionId, value, pubkey: ACTOR, createdAtMs: NOW })

const create = (value) =>
  buildActionEvent({
    manifest,
    kind: PROJECT,
    address: P1,
    objectAuthor: AUTHOR,
    folder: FOLDER,
    actionId: 'add-project',
    value,
    newId: 'new-1',
    pubkey: ACTOR,
    createdAtMs: NOW,
  })

const ps = (event) => event.tags.filter((t) => t[0] === 'p')

describe('a change that names a person', () => {
  test('an assignment names the assignee in p, after ts, as Ship writes it', () => {
    const event = change('assign', PERSON)
    assert.deepEqual(event.tags, [
      ['a', I1],
      ['field', 'assignee'],
      ['value', PERSON],
      ['h', FOLDER],
      ['ts', String(NOW)],
      ['p', PERSON],
    ])
  })

  test('a lead is named the same way, because the type says so, not the field name', () => {
    assert.deepEqual(ps(change('set-lead', PERSON, P1, PROJECT)), [['p', PERSON]])
  })

  test('clearing an assignment names nobody', () => {
    const event = change('assign', '')
    assert.equal(typeof event, 'object')
    assert.deepEqual(ps(event), [])
  })

  test('a key that is not 64 lowercase hex is refused rather than written without p', () => {
    for (const bad of [PERSON.toUpperCase(), 'npub1xyz', PERSON.slice(1), ` ${PERSON}`]) {
      const result = change('assign', bad)
      assert.equal(typeof result, 'string', bad)
      assert.match(result, /64 lowercase hex/)
    }
  })

  test('a string field holding something key-shaped names nobody', () => {
    assert.deepEqual(ps(change('retitle', PERSON)), [])
  })

  test('buildActionEvents — what Peek and the agent call — carries the same p', () => {
    const built = buildActionEvents({
      manifest,
      kind: ISSUE,
      address: I1,
      objectAuthor: AUTHOR,
      folder: FOLDER,
      actionId: 'assign',
      value: PERSON,
      pubkey: ACTOR,
      createdAtMs: NOW,
    })
    assert.equal(built.length, 1)
    assert.deepEqual(ps(built[0]), [['p', PERSON]])
  })
})

describe('a creation that names a person', () => {
  test('each person property is named once in p, beside its own tag', () => {
    const event = create({ title: 'Launch', lead: PERSON, owner: OTHER })
    assert.deepEqual(
      event.tags.filter((t) => t[0] === 'lead' || t[0] === 'owner'),
      [
        ['lead', PERSON],
        ['owner', OTHER],
      ],
    )
    assert.deepEqual(ps(event), [
      ['p', PERSON],
      ['p', OTHER],
    ])
  })

  test('the same person in two properties is named once', () => {
    assert.deepEqual(ps(create({ title: 'Launch', lead: PERSON, owner: PERSON })), [['p', PERSON]])
  })

  test('an empty or absent person property names nobody', () => {
    assert.deepEqual(ps(create({ title: 'Launch', lead: '' })), [])
    assert.deepEqual(ps(create({ title: 'Launch' })), [])
  })

  test('a malformed key on a creation is refused', () => {
    assert.match(create({ title: 'Launch', lead: 'npub1xyz' }), /64 lowercase hex/)
  })

  test('a listed creation names the person on its root, not on the Folder command after it', () => {
    const listed = {
      ...manifest,
      actions: manifest.actions.map((a) => (a.id === 'add-project' ? { ...a, emits: { ...a.emits, listed: true } } : a)),
    }
    const built = buildActionEvents({
      manifest: listed,
      kind: PROJECT,
      address: P1,
      objectAuthor: AUTHOR,
      folder: FOLDER,
      actionId: 'add-project',
      value: { title: 'Launch', lead: PERSON },
      newId: 'new-1',
      folderHasState: true,
      pubkey: ACTOR,
      createdAtMs: NOW,
    })
    assert.equal(built.length, 2)
    assert.deepEqual(ps(built[0]), [['p', PERSON]])
    assert.deepEqual(ps(built[1]), [])
  })
})

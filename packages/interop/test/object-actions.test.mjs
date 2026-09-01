/**
 * PRO-4 — an object-creating action becomes renderable, and publishable.
 *
 * Ship has declared `add-issue` with a real input schema all along, and the
 * runtime skipped it, saying why: *"an action that creates a whole new object
 * needs a form and a parent, so it is skipped rather than drawn as a control
 * that cannot work."* True until something drew one. The consequence was that
 * the manifest could describe the single most useful cross-app action and no
 * app could offer it.
 *
 * The rule that makes construction possible, previously implicit: **a
 * property's name is the tag its value is written to.** It held for Ship by a
 * coincidence of naming and nothing said so.
 */
import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import { resolveForeignObject, buildActionEvent } from '../dist/index.js'

const AUTHOR = 'a'.repeat(64)
const PROJECT = 30850
const ISSUE = 30851
const FOLDER = '7b32200c-e4c0-4216-b79a-8490fc05e0bd'
const ADDRESS = `${PROJECT}:${AUTHOR}:p1`

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

/** Ship's own declaration, as production publishes it. */
const addIssue = {
  id: 'add-issue',
  label: 'Add issue',
  description: 'File a new issue under a project.',
  effect: 'writes',
  appliesTo: String(PROJECT),
  emits: { kind: ISSUE, setTag: 'a', toAddressOf: 'self' },
  input: { type: 'object', properties: { title: { type: 'string' } }, required: ['title'] },
}

const content = (actions, extra = {}) => ({
  name: 'Estiva Ship',
  records: { changeKind: 1851, targetTag: 'a', fieldTag: 'field', valueTag: 'value' },
  projections: {
    [PROJECT]: { widget: 'card', slots: { title: { tag: 'title' } } },
    [ISSUE]: { widget: 'row', slots: { title: { tag: 'title' } } },
  },
  actions,
  ...extra,
})

const manifest = (actions, extra) =>
  event({ kind: 31990, tags: [['d', 'estiva-ship'], ['k', String(PROJECT)]], content: JSON.stringify(content(actions, extra)) })

const object = event({ kind: PROJECT, tags: [['d', 'p1'], ['title', 'A project']] })

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

const build = (values, over = {}) =>
  buildActionEvent({
    manifest: content([addIssue]),
    kind: PROJECT,
    address: ADDRESS,
    objectAuthor: AUTHOR,
    folder: FOLDER,
    actionId: 'add-issue',
    value: values,
    newId: 'new-issue-id',
    pubkey: AUTHOR,
    createdAtMs: 1_700_000_000_000,
    ...over,
  })

const tag = (e, name) => e.tags.find((t) => t[0] === name)?.[1]

describe('an object-creating action is offered rather than skipped', () => {
  test('it resolves as a form, with its declared fields', async () => {
    const found = await resolveForeignObject(ADDRESS, relay([manifest([addIssue]), object]))
    const action = found.actions.find((a) => a.id === 'add-issue')

    assert.ok(action, 'the action is no longer dropped')
    assert.equal(action.control, 'form')
    assert.deepEqual(action.fields, [{ name: 'title', type: 'string', required: true }])
  })

  test('it says the new object hangs under this one', async () => {
    // The other half of "needs a form *and a parent*". A consumer drawing only
    // the properties would publish an orphan.
    const found = await resolveForeignObject(ADDRESS, relay([manifest([addIssue]), object]))
    assert.equal(found.actions.find((a) => a.id === 'add-issue').createsUnder, 'self')
  })

  test('a vocabulary on a property is looked up, as it is for a select', async () => {
    const withEnum = {
      ...addIssue,
      input: {
        type: 'object',
        properties: { title: { type: 'string' }, priority: { type: 'string', enum: 'priorities' } },
        required: ['title'],
      },
    }
    const vocab = { priorities: [{ value: 'high', label: 'High', colour: 'blue' }] }
    const found = await resolveForeignObject(
      ADDRESS,
      relay([manifest([withEnum], { vocabularies: vocab }), object]),
    )
    const field = found.actions.find((a) => a.id === 'add-issue').fields.find((f) => f.name === 'priority')
    assert.deepEqual(field.options, [{ value: 'high', label: 'High', colour: 'blue' }])
    assert.equal(field.required, false)
  })
})

describe('the event it builds is one the owning app will recognise', () => {
  test('a property writes the tag of its own name', async () => {
    const built = build({ title: 'Billing entry' })
    assert.equal(typeof built, 'object', built)
    assert.equal(built.kind, ISSUE)
    assert.equal(tag(built, 'title'), 'Billing entry')
  })

  test('it carries a `d`, because the kind is addressable', async () => {
    const built = build({ title: 'Billing entry' })
    assert.equal(tag(built, 'd'), 'new-issue-id')
  })

  test('refusing when no identifier was supplied, rather than publishing an unaddressable object', async () => {
    const refused = build({ title: 'Billing entry' }, { newId: undefined })
    assert.match(String(refused), /needs an identifier/)
  })

  test('the parent comes from emits, not from the form', async () => {
    const built = build({ title: 'Billing entry' })
    assert.equal(tag(built, 'a'), ADDRESS)
    assert.equal(tag(built, 'h'), FOLDER)
  })

  test('an empty optional value writes no tag at all', async () => {
    // A tag with an empty value is not the same as an absent one: `resolveSlot`
    // skips empties and falls through to the next spelling, so writing one
    // would shadow a fallback with nothing.
    const built = build({ title: 'Billing entry', note: '' }, {
      manifest: content([{ ...addIssue, input: { type: 'object', properties: { title: {}, note: {} }, required: ['title'] } }]),
    })
    assert.equal(tag(built, 'note'), undefined)
  })
})

describe('every refusal names what was allowed', () => {
  test('a field the action does not declare', async () => {
    const refused = build({ title: 'ok', saboteur: 'x' })
    assert.match(String(refused), /"saboteur" is not a field/)
    assert.match(String(refused), /it takes title/)
  })

  test('a required field left empty', async () => {
    assert.match(String(build({ title: '   ' })), /"title" is required/)
  })

  test('a value outside a declared vocabulary is refused BEFORE publishing', async () => {
    /*
      The done-when's own clause. The owning app cannot enforce this — anyone
      can publish anything — so a consumer that skips the check is the one
      putting junk in a shared record.
    */
    const withEnum = {
      ...addIssue,
      input: {
        type: 'object',
        properties: { title: { type: 'string' }, priority: { type: 'string', enum: 'priorities' } },
        required: ['title'],
      },
    }
    const refused = buildActionEvent({
      manifest: content([withEnum], { vocabularies: { priorities: [{ value: 'high', label: 'High' }, { value: 'low', label: 'Low' }] } }),
      kind: PROJECT,
      address: ADDRESS,
      objectAuthor: AUTHOR,
      folder: FOLDER,
      actionId: 'add-issue',
      value: { title: 'ok', priority: 'urgent' },
      newId: 'x',
      pubkey: AUTHOR,
      createdAtMs: 1_700_000_000_000,
    })
    assert.equal(typeof refused, 'string', 'it must refuse rather than build')
    assert.match(refused, /"urgent" is not one of high, low/)
  })

  test('a scalar handed to a form, and a form handed to a scalar', async () => {
    assert.match(String(build('just a string')), /takes a form: title/)

    const setStatus = {
      id: 'set-status',
      label: 'Change status',
      appliesTo: String(PROJECT),
      emits: { kind: 1851, field: 'status' },
      input: { type: 'string' },
    }
    const refused = buildActionEvent({
      manifest: content([setStatus]),
      kind: PROJECT,
      address: ADDRESS,
      objectAuthor: AUTHOR,
      folder: FOLDER,
      actionId: 'set-status',
      value: { status: 'done' },
      pubkey: AUTHOR,
      createdAtMs: 1_700_000_000_000,
    })
    assert.match(String(refused), /takes a single value, not a form/)
  })
})

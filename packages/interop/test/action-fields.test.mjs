/**
 * PRO-5 — two machine-facing fields on an action (RFC 0.4 §13.4).
 *
 * `description` is prose aimed at a machine, distinct from `label`, which is a
 * button caption. `effect` says whether invoking without asking is acceptable.
 *
 * **Nothing reads them yet, and that is the point.** They are here because
 * adding a field costs a line and adding one after several apps have published
 * manifests is a migration across every one of them — a manifest is republished
 * by its owner alone. So these tests pin the two properties that would make the
 * fields a trap rather than a seam: that they survive the trip from manifest to
 * resolved action, and that an effect nobody can interpret does not arrive
 * looking interpretable.
 */
import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import { resolveForeignObject, ACTION_EFFECTS } from '../dist/index.js'

const AUTHOR = 'a'.repeat(64)
const KIND = 30850
const ADDRESS = `${KIND}:${AUTHOR}:p1`

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

const manifestWith = (actions) =>
  event({
    kind: 31990,
    tags: [['d', 'some-app'], ['k', String(KIND)]],
    content: JSON.stringify({
      name: 'Some app',
      records: { changeKind: 1851, targetTag: 'a', fieldTag: 'f', valueTag: 'v' },
      projections: { [KIND]: { widget: 'card', slots: { title: { tag: 'title' } } } },
      actions,
    }),
  })

const object = event({ kind: KIND, tags: [['d', 'p1'], ['title', 'A project']] })

const resolveAction = async (action) => {
  const found = await resolveForeignObject(ADDRESS, relay([manifestWith([action]), object]))
  return found?.actions?.[0]
}

const setStatus = {
  id: 'set-status',
  label: 'Change status',
  appliesTo: [String(KIND)],
  emits: { kind: 1851, field: 'status' },
  input: { type: 'string' },
}

describe('the fields reach a consumer', () => {
  test('description survives, and is not the label', async () => {
    const found = await resolveAction({
      ...setStatus,
      description: 'Move the project between planned, in progress, completed and cancelled.',
      effect: 'writes',
    })
    assert.equal(found.label, 'Change status')
    assert.match(found.description, /^Move the project between planned/)
    assert.notEqual(found.description, found.label)
  })

  test('effect survives', async () => {
    const found = await resolveAction({ ...setStatus, effect: 'destructive' })
    assert.equal(found.effect, 'destructive')
  })

  test('an action that declares neither carries neither', async () => {
    // A manifest published before these existed, which is most of them.
    const found = await resolveAction(setStatus)
    assert.equal(found.description, undefined)
    assert.equal(found.effect, undefined)
    assert.equal(found.label, 'Change status', 'and is otherwise unaffected')
  })
})

describe('an effect nobody can interpret does not arrive looking interpretable', () => {
  test('an unrecognised value is dropped, not carried', async () => {
    /*
      Every way of reading `"nuke"` is a claim nobody made. Absent already means
      "unknown, be careful"; leaving it in place would let a consumer's
      `effect !== 'destructive'` answer *true* about an action whose own
      manifest was trying to warn it.
    */
    const found = await resolveAction({ ...setStatus, effect: 'nuke' })
    assert.equal(found.effect, undefined)
  })

  test('a future value is dropped by an older consumer, which is the safe direction', async () => {
    // Forward compatibility falls out of the same rule: a consumer that does
    // not know `reversible` treats it as unknown rather than as permission.
    const found = await resolveAction({ ...setStatus, effect: 'reversible' })
    assert.equal(found.effect, undefined)
  })

  test('dropping an effect leaves the rest of the action alone', async () => {
    const found = await resolveAction({
      ...setStatus,
      effect: 'nuke',
      description: 'still here',
    })
    assert.equal(found.effect, undefined)
    assert.equal(found.description, 'still here')
    assert.equal(found.id, 'set-status')
  })

  test('the closed set is exported, so no consumer has to spell it out', () => {
    assert.deepEqual([...ACTION_EFFECTS], ['safe', 'writes', 'destructive'])
  })
})

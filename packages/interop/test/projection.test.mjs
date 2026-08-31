/**
 * The package resolves a manifest with no app, no relay and no browser.
 *
 * That is the claim a third-party builder is being asked to trust, and it is
 * ADR 0002 §10 constraint 3 made literal: a test that needs a deployment cannot
 * travel with the package, and untested code does not travel.
 *
 * The exhaustive suite lives in `peek-app/interop/projection.test.ts` — 74
 * cases against the same source, kept there because that is where the code is
 * developed. This file is deliberately different in kind rather than a copy: it
 * exercises **the published artifact** through **the public entry point**, so
 * it catches the failures a source-level suite cannot see — a missing export, a
 * broken `exports` map, a `dist` that was never rebuilt.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  resolveForeignObject,
  pickWidget,
  widgetChainProblem,
  commentKindsOf,
  CLOSED_WIDGETS,
} from '../dist/index.js'

const AUTHOR = 'a'.repeat(64)
const FOLDER = '7b32200c-e4c0-4216-b79a-8490fc05e0bd'
const KIND = 30850

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

/** A relay that is an array. The point of `QueryFn` being a parameter. */
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

const manifest = event({
  kind: 31990,
  tags: [['d', 'some-app'], ['k', String(KIND)]],
  content: JSON.stringify({
    name: 'Some app',
    projections: {
      [KIND]: {
        widget: 'card',
        slots: { title: { tag: 'title' }, subtitle: { tag: 'about' } },
      },
    },
  }),
})

const object = event({
  kind: KIND,
  tags: [['d', 'p1'], ['title', 'Payment integration'], ['about', 'Stripe'], ['h', FOLDER]],
})

test('renders an object from an app it knows nothing about', async () => {
  const found = await resolveForeignObject(`${KIND}:${AUTHOR}:p1`, relay([manifest, object]))
  assert.equal(found.slots.title.value, 'Payment integration')
  assert.equal(found.slots.subtitle.value, 'Stripe')
  assert.equal(found.appName, 'Some app')
})

test('says an object is unreachable rather than returning nothing', async () => {
  // The relay answers "you may not read this" and "there is nothing here" the
  // same way. A consumer must be able to tell them apart, so the manifest
  // resolving without the object is a distinct, reported state.
  const found = await resolveForeignObject(`${KIND}:${AUTHOR}:missing`, relay([manifest]))
  assert.equal(found.unreachable, true)
  assert.equal(found.kind, KIND)
})

test('returns null when no app claims the kind', async () => {
  assert.equal(await resolveForeignObject(`39999:${AUTHOR}:x`, relay([manifest, object])), null)
})

test('walks a widget chain and always has something to draw', () => {
  assert.equal(pickWidget(['message', 'card'], CLOSED_WIDGETS, 'card'), 'card')
  assert.equal(pickWidget(['gantt', 'row'], CLOSED_WIDGETS, 'card'), 'row')
  assert.equal(pickWidget(['unknown-to-everyone'], CLOSED_WIDGETS, 'card'), 'card')
})

test('refuses a chain a conformant consumer could not draw', () => {
  assert.equal(widgetChainProblem(['message', 'card']), null)
  assert.match(widgetChainProblem(['message']), /must end in one of/)
})

test('reads the comment kinds an app has ever emitted', () => {
  assert.deepEqual(commentKindsOf({}), [1111])
})

test('the public entry point exports what the README tells a builder to import', () => {
  for (const name of [resolveForeignObject, pickWidget, widgetChainProblem, commentKindsOf]) {
    assert.equal(typeof name, 'function')
  }
  assert.ok(CLOSED_WIDGETS.includes('card'))
})

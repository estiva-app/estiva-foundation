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
  resolveForeignEvent,
} from '../dist/index.js'
import { encodeNevent } from '@estiva-app/protocol'

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
      // `ids` matters as much as `kinds` here: `resolveForeignEvent` fetches by
      // event id, and a relay that ignored the filter returned *the first event
      // in the array* — which happened to be the manifest, so the resolver
      // looked for a projection of kind:31990 and correctly found none. The
      // fixture was wrong and the code was right.
      if (f.ids && !f.ids.includes(e.id)) return false
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

// ── resolveForeignEvent (PRO-11) ────────────────────────────────────────────

const MESSAGE_KIND = 9
const messageManifest = event({
  kind: 31990,
  tags: [['d', 'peek'], ['k', String(MESSAGE_KIND)]],
  content: JSON.stringify({
    name: 'Peek',
    projections: {
      [MESSAGE_KIND]: {
        widget: ['message', 'card'],
        slots: { title: { field: 'pubkey', as: 'pubkey' }, body: { field: 'content' } },
      },
    },
  }),
})
const aMessage = event({ kind: MESSAGE_KIND, tags: [['h', 'chan']], content: 'hello from a message' })

test('resolves an event that has no address at all', async () => {
  // The whole point: a kind:9 has no `d`, so no naddr can name it and every
  // address-keyed resolver is blind to it.
  const found = await resolveForeignEvent(aMessage.id, relay([messageManifest, aMessage]))
  assert.equal(found.slots.body.value, 'hello from a message')
  assert.equal(found.kind, MESSAGE_KIND)
  assert.equal(found.appName, 'Peek')
})

test('identifies it by event id, with no address and no naddr', async () => {
  const found = await resolveForeignEvent(aMessage.id, relay([messageManifest, aMessage]))
  assert.equal(found.address, undefined)
  assert.equal(found.naddr, undefined)
  assert.equal(found.ref, found.eventId)
  assert.equal(found.eventId, aMessage.id)
})

test('offers no actions, because nothing can name it', async () => {
  // A change carries an `a` tag naming its target and a regular event cannot be
  // named that way. The absence is the model being honest.
  const found = await resolveForeignEvent(aMessage.id, relay([messageManifest, aMessage]))
  assert.deepEqual(found.actions, [])
})

test('accepts an nevent as well as a bare id', async () => {
  const nevent = encodeNevent({ id: aMessage.id, relays: [], kind: MESSAGE_KIND })
  const found = await resolveForeignEvent(nevent, relay([messageManifest, aMessage]))
  assert.equal(found.eventId, aMessage.id)
})

test('accepts the nostr: prefix a pasted reference carries', async () => {
  const nevent = `nostr:${encodeNevent({ id: aMessage.id, relays: [] })}`
  assert.equal((await resolveForeignEvent(nevent, relay([messageManifest, aMessage]))).eventId, aMessage.id)
})

test('returns null when the event cannot be read', async () => {
  // Unlike an addressable object there is no `unreachable` state to report:
  // without the event there is no kind, so no manifest, so nothing that could
  // name the app or offer a way in.
  assert.equal(await resolveForeignEvent('f'.repeat(64), relay([messageManifest])), null)
})

test('returns null when no app claims the kind', async () => {
  const orphan = event({ kind: 31234, tags: [], content: 'x' })
  assert.equal(await resolveForeignEvent(orphan.id, relay([messageManifest, orphan])), null)
})

test('returns null for a reference that is not one', async () => {
  assert.equal(await resolveForeignEvent('not-a-reference', relay([messageManifest])), null)
})

/**
 * Who is a member of a file, and your read state, on made-up inputs (TES,
 * milestone 1).
 *
 * The rules every app relies on: the same events in any order, or some of
 * them twice, give the same members; a file id's characters never change who
 * is a member; merging read state gives the same markers in any order, twice
 * is the same as once, and a read marker never moves back.
 *
 * A failure prints the smallest input that breaks the rule and the seed that
 * replays it: `FC_SEED=<seed> npm test -w packages/conversation`.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import fc from 'fast-check'
import { HISTORY_EPOCH, deliveryArb, hex64Arb, historyArb, runSettings } from '@estiva-app/protocol/testing'
import { REACTIONS_FLOOR_CONTEXT, REPLY_FLOOR_CONTEXT, advanceContexts, foldMemberships, membersOf, mergeSlots } from '../dist/index.js'

// 1,000 inputs a rule: 0.1–0.4 s each, 1.6 s for the file (measured 20 Nov 2026).
const settings = runSettings(1000)
console.log(`fast-check seed ${settings.seed}, ${settings.numRuns} runs per rule`)

const NOW = HISTORY_EPOCH + 60

const sorted = (map) => [...map].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))

/** Every file's members, as plain sorted data. */
const members = (history, events) => history.files.map((file) => [file, sorted(membersOf(file, events))])

/** One person's memberships, as plain sorted data. */
const memberships = (person, events) => {
  const read = foldMemberships(person, events, NOW)
  return { files: sorted(read.files), mentioned: [...read.mentioned].sort(), floor: read.floor }
}

const historyAndTwoDeliveries = (options) =>
  historyArb(options).chain((history) => fc.tuple(fc.constant(history), deliveryArb(history.events), deliveryArb(history.events)))

test("a file's members are the same for the same events in any order, some delivered twice", () => {
  fc.assert(
    fc.property(historyAndTwoDeliveries(), ([history, first, second]) => {
      assert.deepEqual(members(history, first), members(history, second))
    }),
    settings,
  )
})

test("each person's memberships are the same for the same events in any order, some delivered twice", () => {
  fc.assert(
    fc.property(historyAndTwoDeliveries(), ([history, first, second]) => {
      for (const person of history.people) assert.deepEqual(memberships(person, first), memberships(person, second), person)
    }),
    settings,
  )
})

/** The same history with every file id's `x:` taken out: the same files, ids without a colon. */
const withoutColons = (value) => JSON.parse(JSON.stringify(value).replaceAll(':x:', ':').replaceAll('"x:', '"'))

test("a file id with a colon in it gives the same memberships as one without, the creator's own file included", () => {
  fc.assert(
    fc.property(historyArb({ idsWithColons: true }), (history) => {
      const plain = withoutColons(history)
      for (const person of history.people) {
        const read = withoutColons(memberships(person, history.events))
        assert.deepEqual({ ...read, files: sorted(read.files) }, memberships(person, plain.events), person)
      }
    }),
    settings,
  )
})

// ── Read state ──────────────────────────────────────────────────────────────

const anyContextIdArb = fc.oneof(
  fc.uuid({ version: 4 }).map((id) => `file:${id}`),
  hex64Arb().map((id) => `thread:${id}`),
  hex64Arb().map((id) => `msg:${id}`),
  fc.uuid({ version: 4 }),
)
/** A few ids every slot and update draws from first, so two of them mark the same thing read. */
const SHARED_IDS = fc.sample(anyContextIdArb, { seed: 1, numRuns: 6 })
const contextIdArb = fc.oneof({ weight: 3, arbitrary: fc.constantFrom(...SHARED_IDS) }, { weight: 1, arbitrary: anyContextIdArb })
const secondsArb = fc.integer({ min: 1, max: 4_000_000_000 })
const contextsArb = fc.dictionary(contextIdArb, secondsArb, { maxKeys: 12 })
/** A slot as read from the relay: its markers, sometimes a floor, and when it was written. */
const slotArb = fc.record({
  blob: fc.record({
    v: fc.constant(1),
    client_id: fc.constantFrom('peek', 'ship', 'leaf'),
    contexts: fc
      .tuple(contextsArb, fc.option(fc.constantFrom(REPLY_FLOOR_CONTEXT, REACTIONS_FLOOR_CONTEXT)), secondsArb)
      .map(([contexts, floor, at]) => (floor ? { ...contexts, [floor]: at } : contexts)),
  }),
  createdAt: secondsArb,
})

test('merging read state gives the same markers in any order, and a slot read twice changes nothing', () => {
  fc.assert(
    fc.property(fc.array(slotArb, { maxLength: 5 }).chain((slots) => fc.tuple(deliveryArb(slots), deliveryArb(slots))), ([first, second]) => {
      assert.deepEqual(mergeSlots(first), mergeSlots(second))
    }),
    settings,
  )
})

test('merging read state never moves a marker back', () => {
  fc.assert(
    fc.property(fc.array(slotArb, { minLength: 1, maxLength: 5 }), (slots) => {
      const merged = mergeSlots(slots)
      for (const { blob } of slots) {
        for (const [id, seconds] of Object.entries(blob.contexts)) {
          if (id === REPLY_FLOOR_CONTEXT || id === REACTIONS_FLOOR_CONTEXT) continue
          assert.ok(merged[id] >= seconds, `${id}: ${merged[id]} < ${seconds}`)
        }
      }
    }),
    settings,
  )
})

test('marking things read never moves a marker back, in any order, and twice is the same as once', () => {
  fc.assert(
    fc.property(contextsArb, contextsArb, contextsArb, (current, first, second) => {
      const one = advanceContexts(advanceContexts(current, first).contexts, second).contexts
      const other = advanceContexts(advanceContexts(current, second).contexts, first).contexts
      assert.deepEqual(one, other)
      assert.deepEqual(advanceContexts(one, second).contexts, one)
      for (const [id, seconds] of Object.entries({ ...current })) assert.ok(one[id] >= seconds, `${id} moved back`)
      for (const updates of [first, second]) for (const [id, seconds] of Object.entries(updates)) assert.ok(one[id] >= seconds, `${id} not advanced`)
    }),
    settings,
  )
})

/**
 * What has been done to a comment since it was written — `commentDecorationsOf`.
 *
 * Against the published artifact through the public entry point, like
 * `projection.test.mjs`, and for the same reason: a consumer drawing a file's
 * conversation is the first thing that needs an edit, a reaction and a
 * resolution off a `kind:1111`, and every rule below was established by a
 * ticket in another app (CON-1, CON-8, PEEK-128) rather than here.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { commentDecorationsOf, REACTION_HORIZON } from '../dist/index.js'

const AUTHOR = 'a'.repeat(64)
const OTHER = 'b'.repeat(64)
const FOLDER = '7b32200c-e4c0-4216-b79a-8490fc05e0bd'

let seq = 0
const id = () => String(++seq).padStart(64, '0')
const event = (partial) => ({
  id: id(),
  sig: '',
  pubkey: AUTHOR,
  created_at: 1_700_000_000 + seq,
  tags: [],
  content: '',
  ...partial,
})

/** A relay that is an array, matching on `kinds` and on `#e` like the bridge. */
const relay = (events, calls = []) => async (filters) => {
  calls.push(filters)
  return events.filter((e) =>
    filters.some((f) => {
      if (f.kinds && !f.kinds.includes(e.kind)) return false
      for (const [key, want] of Object.entries(f)) {
        if (!key.startsWith('#')) continue
        const held = e.tags.filter((t) => t[0] === key.slice(1)).map((t) => t[1])
        if (!want.some((v) => held.includes(v))) return false
      }
      return true
    }),
  )
}

const comment = () => event({ kind: 1111, tags: [['h', FOLDER]], content: 'first' })

test('an untouched comment is present with nothing in it', async () => {
  const c = comment()
  const found = await commentDecorationsOf([{ id: c.id, at: c.created_at }], relay([]))
  assert.deepEqual(found, { byId: { [c.id]: { reactions: [], resolutions: [] } }, reactionTargetsOmitted: 0 })
})

test('asks nothing when given nothing', async () => {
  const calls = []
  await commentDecorationsOf([], relay([], calls))
  assert.equal(calls.length, 0)
})

test('the newest edit wins, and the original is kept beside it', async () => {
  const c = comment()
  const older = event({ kind: 40003, tags: [['h', FOLDER], ['e', c.id]], content: 'second' })
  const newer = event({ kind: 40003, tags: [['h', FOLDER], ['e', c.id]], content: 'third' })
  // Answered newest first, as a relay does — the fold must not trust the order.
  const found = await commentDecorationsOf([{ id: c.id, at: c.created_at }], relay([newer, older]))
  assert.deepEqual(found.byId[c.id].edit, { body: 'third', at: newer.created_at, by: AUTHOR })
})

test('two edits in the same second are ordered by their ts tag', async () => {
  const c = comment()
  const at = 1_700_009_000
  const a = event({ kind: 40003, created_at: at, tags: [['h', FOLDER], ['e', c.id], ['ts', String(at * 1000 + 900)]], content: 'later' })
  const b = event({ kind: 40003, created_at: at, tags: [['h', FOLDER], ['e', c.id], ['ts', String(at * 1000 + 100)]], content: 'earlier' })
  const found = await commentDecorationsOf([{ id: c.id, at: c.created_at }], relay([b, a]))
  assert.equal(found.byId[c.id].edit.body, 'later')
})

test('reactions are attributed to their target, oldest first', async () => {
  const c = comment()
  const d = comment()
  const r1 = event({ kind: 7, pubkey: OTHER, tags: [['e', c.id]], content: '👍' })
  const r2 = event({ kind: 7, tags: [['e', d.id]], content: '🎉' })
  const r3 = event({ kind: 7, tags: [['e', c.id]], content: '👍' })
  const found = await commentDecorationsOf(
    [{ id: c.id, at: c.created_at }, { id: d.id, at: d.created_at }],
    relay([r3, r2, r1]),
  )
  assert.deepEqual(
    found.byId[c.id].reactions.map((r) => [r.emoji, r.by, r.id]),
    [['👍', OTHER, r1.id], ['👍', AUTHOR, r3.id]],
  )
  assert.deepEqual(found.byId[d.id].reactions.map((r) => r.id), [r2.id])
})

test('resolutions come back oldest first with the current state last', async () => {
  const c = comment()
  const reply = event({ kind: 1111, tags: [['e', c.id]], content: 'done' })
  const resolved = event({
    kind: 9101,
    tags: [['h', FOLDER], ['e', c.id], ['t', 'resolution'], ['action', 'resolved'], ['e', reply.id, '', 'support']],
    content: 'shipped',
  })
  const reopened = event({ kind: 9101, tags: [['h', FOLDER], ['e', c.id], ['t', 'resolution'], ['action', 'reopened']] })
  const found = await commentDecorationsOf([{ id: c.id, at: c.created_at }], relay([reopened, resolved]))
  assert.deepEqual(found.byId[c.id].resolutions, [
    { id: resolved.id, action: 'resolved', by: AUTHOR, at: resolved.created_at, message: 'shipped', supportingEventId: reply.id },
    { id: reopened.id, action: 'reopened', by: AUTHOR, at: reopened.created_at },
  ])
})

test('a supporting reply is never mistaken for the target', async () => {
  // The assertion names the reply with a marked `e`; if the reply is also a
  // target (a thread pane asks about replies too) it must not collect the
  // resolution twice.
  const c = comment()
  const reply = event({ kind: 1111, tags: [['e', c.id]], content: 'done' })
  const resolved = event({
    kind: 9101,
    tags: [['h', FOLDER], ['e', c.id], ['t', 'resolution'], ['action', 'resolved'], ['e', reply.id, '', 'support']],
  })
  const found = await commentDecorationsOf(
    [{ id: c.id, at: c.created_at }, { id: reply.id, at: reply.created_at }],
    relay([resolved]),
  )
  assert.equal(found.byId[c.id].resolutions.length, 1)
  assert.equal(found.byId[reply.id].resolutions.length, 0)
})

test('an assertion that is not a resolution is ignored', async () => {
  const c = comment()
  const other = event({ kind: 9101, tags: [['h', FOLDER], ['e', c.id], ['t', 'something-else'], ['action', 'resolved']] })
  const found = await commentDecorationsOf([{ id: c.id, at: c.created_at }], relay([other]))
  assert.deepEqual(found.byId[c.id].resolutions, [])
})

test('reactions are asked for the newest targets only, and the rest is reported', async () => {
  const targets = []
  for (let i = 0; i < REACTION_HORIZON + 5; i++) {
    const c = comment()
    targets.push({ id: c.id, at: c.created_at })
  }
  const oldest = targets[0]
  const newest = targets[targets.length - 1]
  const onOldest = event({ kind: 7, tags: [['e', oldest.id]], content: '👍' })
  const onNewest = event({ kind: 7, tags: [['e', newest.id]], content: '👍' })
  const calls = []
  const found = await commentDecorationsOf(targets, relay([onOldest, onNewest], calls))
  assert.equal(found.reactionTargetsOmitted, 5)
  assert.equal(found.byId[newest.id].reactions.length, 1)
  // Not asked, so not reported — and never "0 reactions" on the strength of it.
  assert.equal(found.byId[oldest.id].reactions.length, 0)
  const reactionFilters = calls.flat().filter((f) => f.kinds.includes(7))
  const asked = new Set(reactionFilters.flatMap((f) => f['#e']))
  assert.equal(asked.size, REACTION_HORIZON)
  assert.ok(!asked.has(oldest.id))
  // Edits and resolutions have no horizon: every target is asked.
  const editFilters = calls.flat().filter((f) => f.kinds.includes(40003))
  assert.equal(new Set(editFilters.flatMap((f) => f['#e'])).size, targets.length)
})

test('one request for everything, and a duplicate id counts once', async () => {
  const c = comment()
  const calls = []
  const found = await commentDecorationsOf(
    [{ id: c.id, at: c.created_at }, { id: c.id, at: c.created_at }],
    relay([], calls),
  )
  assert.equal(calls.length, 1)
  assert.equal(Object.keys(found.byId).length, 1)
  assert.equal(found.reactionTargetsOmitted, 0)
})

/*
  A mention is not a comment — SPEC §6.4's two strengths, applied in the package
  rather than left to each app (CON-15).

  The object's `#a` read returns every event whose `a` names it, and the `a`
  tag is the index of every reference: a `kind:1111` rooted on another file
  that names this one, a `kind:9` in some topic whose body names it. Peek
  (`isCommentOn`, CON-14) and Ship (`anchorIndex`, CON-13) each split the two;
  `resolveForeignObject`'s `comments` and `conversationsOf` handed the raw
  union, so a widget said "3" beside an issue with one comment and two
  mentions — the merged list §6.4 says an app MUST NOT present.

  The fixture is production's issue `f79e754f`: three `#a` roots, one comment.
*/
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { encodeNaddr } from '@estiva-app/protocol'
import { conversationsOf, conversationCountsOf, resolveForeignObject } from '../dist/index.js'

const AUTHOR = 'a'.repeat(64)
const ISSUE = 30851
const FOLDER = '7b32200c-e4c0-4216-b79a-8490fc05e0bd'

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

function relay(events) {
  return async (filters) =>
    events.filter((e) =>
      filters.some((f) => {
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
}

// Ship's shape: a `1111` comment kind with the `kind:9` history read alongside
// (§7.3 `alsoRead`), which is exactly the pair a mention can arrive in.
const manifest = event({
  kind: 31990,
  tags: [['d', 'ship'], ['k', String(ISSUE)]],
  content: JSON.stringify({
    name: 'Ship',
    projections: { [ISSUE]: { widget: 'card', slots: { title: { tag: 'title' } } } },
    actions: [
      { id: 'comment', label: 'Comment', appliesTo: String(ISSUE), emits: { kind: 1111, scope: 'address', alsoRead: [9] } },
    ],
  }),
})

const THIS = `${ISSUE}:${AUTHOR}:f79e754f`
const OTHER = `${ISSUE}:${AUTHOR}:elsewhere`
const thisNaddr = encodeNaddr({ kind: ISSUE, pubkey: AUTHOR, identifier: 'f79e754f', relays: [] })
const issue = event({ kind: ISSUE, tags: [['d', 'f79e754f'], ['title', 'The issue'], ['h', FOLDER]] })
const otherIssue = event({ kind: ISSUE, tags: [['d', 'elsewhere'], ['title', 'Another issue'], ['h', FOLDER]] })

/** NIP-22: `A` is the object the thread is about, `a` the index of every reference. */
const comment = event({ kind: 1111, tags: [['A', THIS], ['a', THIS], ['h', FOLDER]], content: 'a comment on this issue' })
/** A comment on the other issue whose body names this one — this issue's *Mentioned in*. */
const mention1111 = event({
  kind: 1111,
  tags: [['A', OTHER], ['a', OTHER], ['a', THIS], ['h', FOLDER]],
  content: `on the other issue, see nostr:${thisNaddr}`,
})
/** A topic message naming this issue: Peek writes the `a` as the index of the `[`-menu reference. */
const mention9 = event({ kind: 9, tags: [['h', FOLDER], ['a', THIS]], content: `in a topic, see nostr:${thisNaddr}` })
/** A comment from before REW-10: a `kind:9` anchored by `a` whose body does not name the issue. */
const legacy9 = event({ kind: 9, tags: [['h', FOLDER], ['a', THIS]], content: 'an old comment' })
/** A `1111` with no `A` at all: malformed, and §6.4 says read its `a` as the root rather than drop it. */
const bareA = event({ kind: 1111, tags: [['a', THIS], ['h', FOLDER]], content: 'no uppercase A' })

const world = [manifest, issue, otherIssue, comment, mention1111, mention9, legacy9, bareA]

test('`comments` keeps the comment and drops both kinds of mention', async () => {
  const found = await resolveForeignObject(THIS, relay(world))
  assert.deepEqual(
    found.comments.map((c) => c.body).sort(),
    ['a comment on this issue', 'an old comment', 'no uppercase A'],
  )
})

test('the mention is the other issue\'s comment, not lost', async () => {
  // Excluded here because it belongs there: a `1111` has exactly one root.
  const found = await resolveForeignObject(OTHER, relay(world))
  assert.deepEqual(found.comments.map((c) => c.body), [`on the other issue, see nostr:${thisNaddr}`])
})

test('the widget count reads 1 for one comment and two mentions', async () => {
  // The done-when, in miniature: three `#a` roots, one of them a comment.
  const counts = await conversationCountsOf(
    [{ ref: THIS, address: THIS }],
    relay([manifest, issue, comment, mention1111, mention9]),
  )
  assert.equal(counts[THIS], 1)
})

test('`conversationsOf` attributes a message to the file it is a comment on, never the one it mentions', async () => {
  const conversations = await conversationsOf(
    [{ ref: THIS, address: THIS }, { ref: OTHER, address: OTHER }],
    relay(world),
  )
  assert.deepEqual(conversations[THIS].map((m) => m.id).sort(), [comment.id, legacy9.id, bareA.id].sort())
  assert.deepEqual(conversations[OTHER].map((m) => m.id), [mention1111.id])
})

test('a reply carries the root\'s `A` and stays in the conversation', async () => {
  // NIP-22: a reply repeats the uppercase root and names its parent in
  // lowercase. Reading the lowercase `a` as the root would drop every reply.
  const reply = event({
    kind: 1111,
    tags: [['A', THIS], ['a', THIS], ['E', comment.id], ['e', comment.id, '', 'reply']],
    content: 'a reply',
  })
  const counts = await conversationCountsOf([{ ref: THIS, address: THIS }], relay([manifest, issue, comment, reply]))
  assert.equal(counts[THIS], 2)
})

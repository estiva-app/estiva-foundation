/*
  One shape for a message and a thread (ONE-2): SPEC §6.4 "Resolving a
  thread", §6.5's three states of a top-level message, and C51.

  The first block folds **real events read back off production**
  (`production-threads.json`, written by QA-1 and QA-2 only, since this
  repository is public): their ids and signatures are the relay's. The second
  states C51's cases as fixtures an app that does not use this package can run
  against its own fold. If one fails, the package disagrees with the SPEC and
  the package is wrong: do not change an expectation without a SPEC PR.
*/
import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { encodeNaddr, linksAsReferences, toRenderTree, type SignedEvent } from '@estiva-app/protocol'
import { foldThreads, placeLines, resolutionOf, resolutionsByTarget, urlNames, writtenUrlOf, type Thread } from '../dist/index.js'

const production = JSON.parse(readFileSync(new URL('./production-threads.json', import.meta.url), 'utf8')) as Record<string, { note: string; events: SignedEvent[] }>
const QA1 = 'c562b90f36802f52e11bc6a3f2e7d9e59e86c76de212fe457dbc89bc273a9a25'
const QA2 = '3bb30d683788016b85c83604dd5660e4e172e95d46d4e3ebab623ff5847b1f71'
const QA_FOLDER = 'a78e60b1-a41f-48c9-bcb0-6ceacdee8c69'

const only = (threads: Thread[]): Thread => {
  assert.equal(threads.length, 1, `one thread, got ${threads.length}`)
  return threads[0]
}

describe('one shape, folded from production events', () => {
  it('a comment its author deleted keeps its replies, says it was deleted, and offers no Resolve', () => {
    const thread = only(foldThreads(production.deletedWithReplies.events))
    assert.equal(thread.id, 'f592a17107a1dbae04672809df3b442548888cbe555c14a4f17af06333a5c1bb')
    assert.equal(thread.state, 'deleted')
    assert.equal(thread.root, undefined)
    assert.deepEqual(
      thread.replies.map((r) => [r.author, r.body]),
      [[QA2, 'COMM-7 111802 reply from QA-2']],
    )
    assert.equal(thread.folder, QA_FOLDER)
    assert.equal(thread.resolvable, false)
  })

  it('the same replies without the deletion are a thread whose comment was not returned, never "deleted"', () => {
    const thread = only(foldThreads(production.deletedWithReplies.events.filter((e) => e.kind !== 5)))
    assert.equal(thread.state, 'missing')
    assert.equal(thread.replies.length, 1)
  })

  it('a resolve carried by a reply names that reply, and the thread reads resolved', () => {
    const thread = only(foldThreads(production.replyCarriesResolve.events))
    assert.equal(thread.state, 'present')
    assert.equal(thread.root?.id, '28c2eeb743b575766ebfb5fee622f03610e0fb297891ed469ec90ca9f907e9ed')
    assert.equal(thread.replies.length, 4)
    assert.deepEqual(thread.resolution && { action: thread.resolution.action, by: thread.resolution.by, note: thread.resolution.message, reply: thread.resolution.supportingEventId }, {
      action: 'resolved',
      by: QA1,
      note: 'PEEKM-3 resolve p1',
      reply: 'fb1eba4b50e2261aa487068b89ab252af8495093573699b160b9d62be51a37c9',
    })
  })

  it('a resolve and a reopen in the same second, by two people: the later ts counts, though its id sorts lower', () => {
    const events = production.sameSecond.events
    const [reopen, resolve] = ['reopened', 'resolved'].map((action) => events.find((e) => e.tags.some((t) => t[0] === 'action' && t[1] === action))!)
    // What makes the case: one second, and an id order that disagrees with `ts`.
    assert.equal(reopen.created_at, resolve.created_at)
    assert.ok(reopen.id < resolve.id)
    const thread = only(foldThreads(events))
    assert.equal(thread.resolution?.action, 'reopened')
    assert.equal(thread.resolution?.by, QA2)
    assert.equal(thread.resolvable, true)
  })

  it('an edited comment shows its latest words, marked edited when the words last changed, with the latest edit’s files', () => {
    const thread = only(foldThreads(production.edited.events))
    const root = thread.root!
    assert.equal(root.body, 'COMM-6 121723 files w075256 w092454')
    assert.equal(root.edited, true)
    // Two later edits changed only the files: the words last changed at 8f36f504's ts.
    assert.equal(root.editedAt, 1793089511997)
    // The latest edit lists no files, so the comment has none (§6.8).
    assert.deepEqual(root.files, [])
    assert.equal(root.at, 1792405070928)
  })

  it('a comment on quoted words carries its block run and its words', () => {
    const root = only(foldThreads(production.quoted.events)).root!
    assert.deepEqual(root.anchor, { blocks: ['8e9e47e4caf8'], quote: { start: 'Probe target' } })
  })
})

/* C51 and §6.5, as fixtures. */
const ALICE = 'a'.repeat(64)
const BOB = 'b'.repeat(64)
const FOLDER = '85db5b59-9e49-4ea1-8e93-3d2a2d78c048'
const ELSEWHERE = '0b7e2a4c-1111-4c3e-9d2f-2a1f0c9e8b7d'
const ISSUE = `30851:${ALICE}:d68a8c78-5ec7-4652-b236-89ab57ac5b1e`
let seq = 0
const event = (partial: Partial<SignedEvent> & { kind: number }): SignedEvent => ({
  id: (++seq).toString(16).padStart(64, '0'),
  sig: '',
  pubkey: ALICE,
  created_at: 1_700_000_000 + seq * 10,
  tags: [],
  content: '',
  ...partial,
})
const comment = () => event({ kind: 1111, content: 'a comment', tags: [['A', ISSUE], ['K', '30851'], ['P', ALICE], ['a', ISSUE], ['k', '30851'], ['p', ALICE], ['h', FOLDER]] })
const reply = (to: SignedEvent, by = BOB) =>
  event({ kind: 1111, pubkey: by, content: 'a reply', tags: [['A', ISSUE], ['K', '30851'], ['P', ALICE], ['e', to.id], ['k', '1111'], ['p', to.pubkey], ['h', FOLDER]] })
const resolution = (target: SignedEvent | string, action: string, extra: { h?: string; by?: string; at?: number; ts?: number; tags?: string[][] } = {}) =>
  event({
    kind: 9101,
    pubkey: extra.by ?? ALICE,
    ...(extra.at !== undefined ? { created_at: extra.at } : {}),
    tags: [
      ['h', extra.h ?? FOLDER],
      ...(extra.tags ?? []),
      ['e', typeof target === 'string' ? target : target.id],
      ['t', 'resolution'],
      ['action', action],
      ...(extra.ts !== undefined ? [['ts', String(extra.ts)]] : []),
    ],
  })

describe('C51 — resolving a thread', () => {
  it('the newest counts, whoever wrote it: a reopen by another person after a resolve', () => {
    const root = comment()
    const thread = only(foldThreads([root, resolution(root, 'resolved'), resolution(root, 'reopened', { by: BOB })]))
    assert.equal(thread.resolution?.action, 'reopened')
    assert.equal(thread.resolution?.by, BOB)
  })

  it('in one second with no ts, the higher id is the later write', () => {
    const root = comment()
    const at = 1_800_000_000
    const first = resolution(root, 'reopened', { at })
    const second = resolution(root, 'resolved', { at })
    assert.ok(first.id < second.id)
    assert.equal(only(foldThreads([root, second, first])).resolution?.action, 'resolved')
  })

  it('a resolve filed in another Folder changes nothing, even when it is the newest', () => {
    const root = comment()
    const thread = only(foldThreads([root, resolution(root, 'resolved'), resolution(root, 'reopened', { h: ELSEWHERE })]))
    assert.equal(thread.resolution?.action, 'resolved')
  })

  it('a resolve with no h changes nothing', () => {
    const root = comment()
    const stray = resolution(root, 'resolved')
    stray.tags = stray.tags.filter((t) => t[0] !== 'h')
    assert.equal(only(foldThreads([root, stray])).resolution, undefined)
  })

  it('a resolve on a reply is not walked to its thread', () => {
    const root = comment()
    const answer = reply(root)
    const thread = only(foldThreads([root, answer, resolution(answer, 'resolved')]))
    assert.equal(thread.resolution, undefined)
  })

  it('an action that is neither value changes nothing', () => {
    const root = comment()
    assert.equal(only(foldThreads([root, resolution(root, 'resolved'), resolution(root, 'closed')])).resolution?.action, 'resolved')
  })

  it('the target is the first unmarked e, not the first one a reader holds', () => {
    const root = comment()
    const stranger = 'c'.repeat(64)
    const aimed = resolution(stranger, 'resolved', { tags: [] })
    aimed.tags.push(['e', root.id])
    assert.equal(only(foldThreads([root, aimed])).resolution, undefined)
  })

  it('a support outside the thread is dropped and the resolve stands', () => {
    const root = comment()
    const elsewhere = reply(comment())
    const r = resolution(root, 'resolved')
    r.tags.push(['e', elsewhere.id, '', 'support'])
    const thread = foldThreads([root, elsewhere, r]).find((t) => t.id === root.id)!
    assert.equal(thread.resolution?.action, 'resolved')
    assert.equal(thread.resolution?.supportingEventId, undefined)
  })

  it('an untrusted ts (another second) is not read: created_at decides', () => {
    const root = comment()
    const at = 1_800_000_100
    const early = resolution(root, 'reopened', { at, ts: (at + 5) * 1000 })
    const late = resolution(root, 'resolved', { at: at + 1 })
    assert.equal(only(foldThreads([root, early, late])).resolution?.action, 'resolved')
  })

  it('resolutionOf weighs only what it is given: no Folder known, no state', () => {
    const root = comment()
    const list = resolutionsByTarget([resolution(root, 'resolved')])[root.id]
    assert.equal(resolutionOf(list, { folder: FOLDER, replies: [] })?.action, 'resolved')
    assert.equal(resolutionOf(list, { folder: undefined, replies: [] }), undefined)
  })
})

describe('§6.5 — a top-level message in three states', () => {
  it('deleted, it keeps the state its last resolve gave it, whatever its time, and offers neither', () => {
    const root = comment()
    const answer = reply(root)
    const resolve = resolution(root, 'resolved', { at: 1_900_000_000 })
    const thread = only(foldThreads([answer, resolve, event({ kind: 5, tags: [['e', root.id]] })]))
    assert.equal(thread.state, 'deleted')
    assert.equal(thread.resolution?.action, 'resolved')
    assert.equal(thread.resolvable, false)
  })

  it('a kind:5 by someone else hides nothing', () => {
    const root = comment()
    const thread = only(foldThreads([root, reply(root), event({ kind: 5, pubkey: BOB, tags: [['e', root.id]] })]))
    assert.equal(thread.state, 'present')
    assert.equal(thread.root?.id, root.id)
  })

  it('a reply its author deleted leaves the thread; one deleted by someone else stays', () => {
    const root = comment()
    const gone = reply(root, BOB)
    const kept = reply(root, BOB)
    const thread = only(foldThreads([root, gone, kept, event({ kind: 5, pubkey: BOB, tags: [['e', gone.id]] }), event({ kind: 5, pubkey: ALICE, tags: [['e', kept.id]] })]))
    assert.deepEqual(thread.replies.map((r) => r.id), [kept.id])
  })

  it('not returned, it is deleted only when every reply names the deletion’s signer as the comment’s author', () => {
    const gone = comment()
    const honest = reply(gone)
    // Bob answers too, naming himself as the comment's author, and asks the relay to delete it.
    const forged = event({ kind: 1111, pubkey: BOB, tags: [['A', ISSUE], ['e', gone.id], ['k', '1111'], ['p', BOB], ['h', FOLDER]] })
    const byBob = event({ kind: 5, pubkey: BOB, tags: [['e', gone.id]] })
    assert.equal(only(foldThreads([honest, forged, byBob])).state, 'missing')
    assert.equal(only(foldThreads([honest, forged, byBob, event({ kind: 5, pubkey: ALICE, tags: [['e', gone.id]] })])).state, 'missing')
    assert.equal(only(foldThreads([honest, event({ kind: 5, pubkey: ALICE, tags: [['e', gone.id]] })])).state, 'deleted')
  })

  it('not returned, its thread is in the Folder most replies were filed in, and none on a tie', () => {
    const gone = comment()
    const here = reply(gone)
    const there = event({ kind: 1111, pubkey: BOB, tags: [['A', ISSUE], ['e', gone.id], ['k', '1111'], ['p', ALICE], ['h', ELSEWHERE]] })
    const resolveThere = resolution(gone, 'resolved', { h: ELSEWHERE })
    assert.equal(only(foldThreads([here, resolution(gone, 'resolved')])).resolution?.action, 'resolved')
    const split = only(foldThreads([here, there, resolveThere]))
    assert.equal(split.folder, undefined)
    assert.equal(split.resolution, undefined)
    const most = only(foldThreads([here, reply(gone), there, resolveThere, resolution(gone, 'reopened')]))
    assert.equal(most.folder, FOLDER)
    assert.equal(most.resolution?.action, 'reopened')
  })

  it('a reply filed in another Folder cannot clear a deleted comment', () => {
    const gone = comment()
    const stray = event({ kind: 1111, pubkey: BOB, tags: [['A', ISSUE], ['e', gone.id], ['k', '1111'], ['p', BOB], ['h', ELSEWHERE]] })
    const thread = only(foldThreads([reply(gone), reply(gone), stray, event({ kind: 5, pubkey: ALICE, tags: [['e', gone.id]] })]))
    assert.equal(thread.state, 'deleted')
  })

  it('a deleted top-level message with no reply left draws nothing', () => {
    const root = comment()
    assert.deepEqual(foldThreads([root, event({ kind: 5, tags: [['e', root.id]] })]), [])
  })

  it('a reply to a reply is filed under the thread, not its parent', () => {
    const root = comment()
    const first = reply(root)
    const nested = event({ kind: 1111, pubkey: BOB, tags: [['A', ISSUE], ['e', first.id], ['k', '1111'], ['p', BOB], ['h', FOLDER]] })
    const thread = only(foldThreads([root, first, nested]))
    assert.deepEqual(thread.replies.map((r) => r.id), [first.id, nested.id])
  })
})

describe('a message’s reactions', () => {
  it('know each reactor by key, once per emoji, and the viewer’s own; a reaction its author took back is gone', () => {
    const root = comment()
    const mine = event({ kind: 7, pubkey: ALICE, content: '+', tags: [['e', root.id]] })
    const theirs = event({ kind: 7, pubkey: BOB, content: '+', tags: [['e', root.id]] })
    const again = event({ kind: 7, pubkey: BOB, content: '+', tags: [['e', root.id]] })
    const party = event({ kind: 7, pubkey: BOB, content: '🎉', tags: [['e', root.id]] })
    const back = event({ kind: 5, pubkey: BOB, tags: [['e', party.id]] })
    const reactions = only(foldThreads([root, mine, theirs, again, party, back], { viewer: ALICE })).root!.reactions
    assert.deepEqual(reactions, [{ emoji: '+', count: 2, by: [ALICE, BOB], mine: mine.id }])
  })

  it('one taken back and given again counts once, as the later one', () => {
    const root = comment()
    const first = event({ kind: 7, pubkey: BOB, content: '+', tags: [['e', root.id]] })
    const back = event({ kind: 5, pubkey: BOB, tags: [['e', first.id]] })
    const again = event({ kind: 7, pubkey: BOB, content: '+', tags: [['e', root.id]] })
    const reactions = only(foldThreads([root, first, back, again], { viewer: BOB })).root!.reactions
    assert.deepEqual(reactions, [{ emoji: '+', count: 1, by: [BOB], mine: again.id }])
  })
})

describe('an edited message’s cards', () => {
  it('are the latest edit carrying any: a later edit with none leaves them', () => {
    const root = comment()
    const A = `30851:${ALICE}:card-a`
    const B = `30851:${ALICE}:card-b`
    const first = event({ kind: 40003, content: 'one', tags: [['e', root.id], ['h', FOLDER], ['embed', A, 'detailed']] })
    const second = event({ kind: 40003, content: 'two', tags: [['e', root.id], ['h', FOLDER], ['embed', B, 'compact']] })
    const third = event({ kind: 40003, content: 'three', tags: [['e', root.id], ['h', FOLDER]] })
    assert.deepEqual(only(foldThreads([root, third, first, second])).root!.cards.map((c) => c.value), [B])
  })
})

describe('an edited message’s links', () => {
  it('are the latest edit’s: an edit that took a link out lists none', () => {
    const root = comment()
    root.tags.push(['a', `30851:${ALICE}:linked-issue`])
    const edit = event({ kind: 40003, content: 'no link now', tags: [['e', root.id], ['h', FOLDER]] })
    assert.deepEqual(only(foldThreads([root])).root!.links, [ISSUE, `30851:${ALICE}:linked-issue`])
    assert.deepEqual(only(foldThreads([root, edit])).root!.links, [])
  })
})

describe('the one line rule (§13.2, §13.6.2, C21)', () => {
  const naddr = `nostr:${encodeNaddr({ kind: 30851, pubkey: ALICE, identifier: 'd68a8c78-5ec7-4652-b236-89ab57ac5b1e', relays: [] })}`
  const URL = 'https://ship.example/issue/fix-it-d68a8c78-5ec7-4652-b236-89ab57ac5b1e'
  const resolveLink = (url: string) => (url === URL ? ISSUE : undefined)
  const tree = (body: string) => linksAsReferences(toRenderTree(body, 'marker'), resolveLink)

  it('a link alone on its line is its file’s row, opening the URL it was written as', () => {
    const placed = placeLines(tree(`see\n${URL}`), { resolveLink })
    const rows = placed.blocks.map((b) => placed.rowOf(b)).filter(Boolean)
    assert.deepEqual(rows, [{ reference: naddr, value: ISSUE, url: URL }])
  })

  it('the same line draws nothing when the file’s card is under the message', () => {
    const placed = placeLines(tree(`see\n${URL}`), { resolveLink, cards: [{ value: ISSUE, layout: 'detailed' }] })
    assert.equal(placed.blocks.some((b) => placed.rowOf(b)), false)
    assert.equal(placed.blocks.length, 1)
  })

  it('the file the message is shown on stays its chip, in a sentence', () => {
    const placed = placeLines(tree(`see\n${URL}`), { resolveLink, stayChip: (value) => value === ISSUE })
    assert.equal(placed.blocks.some((b) => placed.rowOf(b)), false)
  })

  it('a link in a sentence stays in the sentence', () => {
    const placed = placeLines(tree(`see ${URL} now`), { resolveLink })
    assert.equal(placed.blocks.some((b) => placed.rowOf(b)), false)
  })

  it('a URL set on another file’s reference opens nothing as written', () => {
    assert.equal(writtenUrlOf({ text: URL, reference: naddr }, resolveLink), URL)
    assert.equal(writtenUrlOf({ text: 'https://elsewhere.example/x-d68a8c78', reference: naddr }, resolveLink), undefined)
    assert.equal(writtenUrlOf({ text: URL, reference: naddr }, undefined), undefined)
  })

  it('a pasted app link names an address by the d its path ends in, never by a short one', () => {
    assert.equal(urlNames(URL, ISSUE), true)
    assert.equal(urlNames(`${URL}?x=1#block-a`, ISSUE), true)
    assert.equal(urlNames('https://ship.example/issue/other', ISSUE), false)
    assert.equal(urlNames('https://ship.example/issue/x-abc', `30851:${ALICE}:abc`), false)
  })
})

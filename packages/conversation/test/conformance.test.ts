/*
  SPEC §9's conversation checks, C10–C16, as fixtures.

  Each block is one row of the table, stated so an app that does not use this
  package can run the same fixture against its own code. If one of these fails,
  the package disagrees with the SPEC and the package is wrong: do not change
  the expectation without a SPEC PR.
*/
import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { encodeNaddr, imetaTag, type SignedEvent } from '@estiva-app/protocol'
import {
  buildReply,
  decorationsOf,
  foldEdits,
  foldReactions,
  isCommentOn,
  offersEditAndDelete,
  parentOf,
  reactionHorizon,
  REACTION_HORIZON,
  strengthOn,
  groupThreads,
  type QueryFn,
} from '../dist/index.js'

const ALICE = 'a'.repeat(64)
const BOB = 'b'.repeat(64)
const FOLDER = '85db5b59-9e49-4ea1-8e93-3d2a2d78c048'
const ISSUE = `30851:${ALICE}:d68a8c78-5ec7-4652-b236-89ab57ac5b1e`
const OTHER = `30851:${ALICE}:0b7e2a4c-1111-4c3e-9d2f-2a1f0c9e8b7d`
const naddrOf = (address: string) => {
  const [kind, pubkey, identifier] = address.split(':')
  return `nostr:${encodeNaddr({ kind: Number(kind), pubkey, identifier, relays: [] })}`
}

let seq = 0
const event = (partial: Partial<SignedEvent> & { kind: number }): SignedEvent => ({
  id: (++seq).toString(16).padStart(64, '0'),
  sig: '',
  pubkey: ALICE,
  created_at: 1_700_000_000 + seq,
  tags: [],
  content: '',
  ...partial,
})
const comment = (about: string, extra: string[][] = [], content = 'a comment') =>
  event({ kind: 1111, content, tags: [['A', about], ['K', '30851'], ['P', ALICE], ['a', about], ['k', '30851'], ['p', ALICE], ['h', FOLDER], ...extra] })

/** A relay that is an array, matching `ids`, `kinds` and `#…` like the bridge, honouring `limit`. */
const relay = (events: SignedEvent[], calls: Record<string, unknown>[][] = []): QueryFn => async (filters) => {
  calls.push(filters)
  const out = new Set<SignedEvent>()
  for (const f of filters) {
    const matched = events.filter((e) => {
      if (Array.isArray(f.ids) && !f.ids.includes(e.id)) return false
      if (Array.isArray(f.kinds) && !f.kinds.includes(e.kind)) return false
      for (const [key, want] of Object.entries(f)) {
        if (!key.startsWith('#')) continue
        const held = e.tags.filter((t) => t[0] === key.slice(1)).map((t) => t[1])
        if (!(want as string[]).some((v) => held.includes(v))) return false
      }
      return true
    })
    for (const e of matched.slice(0, typeof f.limit === 'number' ? f.limit : undefined)) out.add(e)
  }
  return [...out]
}

describe('C10 — both kinds', () => {
  it('a thread rooted in a kind:1111 on an object lists under that object', () => {
    const root = comment(ISSUE)
    assert.equal(isCommentOn(root, ISSUE), true)
    assert.equal(strengthOn(root, ISSUE), 'comment')
  })

  it("a channel's kind:9 chat lists under no object, whatever a it carries", () => {
    const chat = event({ kind: 9, content: 'chat', tags: [['h', FOLDER], ['a', ISSUE]] })
    assert.equal(isCommentOn(chat, ISSUE), false)
    assert.notEqual(strengthOn(chat, ISSUE), 'comment')
  })

  it("a kind:9 is a comment only when the object's owner declares kind:9 as a comment kind it has not migrated (§7.3)", () => {
    const legacy = event({ kind: 9, content: 'an old comment', tags: [['h', FOLDER], ['a', ISSUE]] })
    assert.equal(isCommentOn(legacy, ISSUE, [1111, 9]), true)
    // Declared, and still a mention when the body names it, and still no comment when it is a reply.
    const named = event({ kind: 9, content: `see ${naddrOf(ISSUE)}`, tags: [['h', FOLDER], ['a', ISSUE]] })
    assert.equal(isCommentOn(named, ISSUE, [1111, 9]), false)
    const reply = event({ kind: 9, tags: [['h', FOLDER], ['a', ISSUE], ['e', legacy.id, '', 'reply']] })
    assert.equal(isCommentOn(reply, ISSUE, [1111, 9]), false)
  })
})

describe('C11 — two strengths', () => {
  it("a 1111 whose A is the object is a comment", () => {
    assert.equal(strengthOn(comment(ISSUE), ISSUE), 'comment')
  })

  it("a 1111 whose A is another file but whose a names this one is a mention", () => {
    const elsewhere = comment(OTHER, [['a', ISSUE]], `see ${naddrOf(ISSUE)}`)
    assert.equal(isCommentOn(elsewhere, ISSUE), false)
    assert.equal(strengthOn(elsewhere, ISSUE), 'mention')
  })

  it('a kind:9 whose body names the object is a mention', () => {
    const chat = event({ kind: 9, content: `look at ${naddrOf(ISSUE)}`, tags: [['h', FOLDER], ['a', ISSUE]] })
    assert.equal(strengthOn(chat, ISSUE), 'mention')
    const untagged = event({ kind: 9, content: `look at ${naddrOf(ISSUE)}`, tags: [['h', FOLDER]] })
    assert.equal(strengthOn(untagged, ISSUE), 'mention')
  })

  it('a 1111 with no A is a comment on each of its a', () => {
    const malformed = event({ kind: 1111, tags: [['a', ISSUE], ['a', OTHER], ['h', FOLDER]] })
    assert.equal(isCommentOn(malformed, ISSUE), true)
    assert.equal(isCommentOn(malformed, OTHER), true)
  })

  it("a reply carrying the object's a lists as neither", () => {
    const root = comment(ISSUE)
    const reply1111 = event({ kind: 1111, tags: [['A', ISSUE], ['e', root.id], ['k', '1111'], ['a', ISSUE], ['h', FOLDER]] })
    const reply9 = event({ kind: 9, tags: [['h', FOLDER], ['e', root.id, '', 'reply'], ['a', ISSUE]] })
    for (const reply of [reply1111, reply9]) {
      assert.equal(isCommentOn(reply, ISSUE), false)
      assert.equal(strengthOn(reply, ISSUE), null)
    }
  })

  it('a top-level comment on an event root, E and e naming one event, is a comment', () => {
    const target = 'c'.repeat(64)
    const onEvent = event({ kind: 1111, tags: [['E', target], ['K', '9'], ['a', ISSUE], ['e', target], ['k', '9'], ['h', FOLDER]] })
    assert.equal(parentOf(onEvent), null)
  })
})

describe('C12 — edit fold', () => {
  const edit = (target: string, content: string, createdAt: number, ts?: number, extraE: string[][] = []) =>
    event({ kind: 40003, content, created_at: createdAt, tags: [['h', FOLDER], ...extraE, ['e', target], ...(ts !== undefined ? [['ts', String(ts)]] : [])] })

  it('three edits inside one second, carrying ts, fold to the last by ts', () => {
    const message = comment(ISSUE, [], 'original')
    const second = 1_700_100_000
    // Ids chosen so id order disagrees with ts order.
    const edits = [
      { ...edit(message.id, 'third', second, second * 1000 + 900), id: '1'.repeat(64) },
      { ...edit(message.id, 'first', second, second * 1000 + 100), id: '3'.repeat(64) },
      { ...edit(message.id, 'second', second, second * 1000 + 500), id: '2'.repeat(64) },
    ]
    const fold = foldEdits([message, ...edits])[message.id]
    assert.equal(fold.body, 'third')
    assert.equal(fold.edited, true)
    assert.equal(fold.editedAt, second * 1000 + 900)
  })

  it('one whose ts is off by a second folds by created_at', () => {
    const message = comment(ISSUE, [], 'original')
    const second = 1_700_200_000
    const honest = { ...edit(message.id, 'honest', second + 1), id: '1'.repeat(64) }
    // Claims to be later inside the neighbouring second; must be read as `second`.
    const liar = { ...edit(message.id, 'liar', second, (second + 1) * 1000 + 999), id: '2'.repeat(64) }
    assert.equal(foldEdits([message, honest, liar])[message.id].body, 'honest')
  })

  it('an edit whose first e is marked and names another message applies to that message, never the second e', () => {
    const own = comment(ISSUE, [], 'mine')
    const victim = event({ kind: 1111, pubkey: BOB, content: "bob's", tags: [['A', ISSUE], ['h', FOLDER]] })
    const forged = event({ kind: 40003, content: 'forged', tags: [['h', FOLDER], ['e', own.id, '', 'mention'], ['e', victim.id]] })
    const folds = foldEdits([own, victim, forged])
    assert.equal(folds[victim.id], undefined)
    assert.equal(folds[own.id].body, 'forged')
  })

  it('an edit byte-identical to the body does not mark the message edited, and the current text shows', () => {
    const message = comment(ISSUE, [], 'same')
    const identical = edit(message.id, 'same', message.created_at + 1)
    assert.deepEqual(foldEdits([message, identical])[message.id], { body: 'same', edited: false })
    const changed = edit(message.id, 'changed', message.created_at + 2)
    const fold = foldEdits([message, identical, changed])[message.id]
    assert.equal(fold.body, 'changed')
    assert.equal(fold.edited, true)
    assert.equal(fold.editedBy, ALICE)
  })

  it('an edit whose target is unseen is held, not dropped', () => {
    const missing = 'd'.repeat(64)
    const held = edit(missing, 'later', 1_700_300_000)
    assert.equal(foldEdits([held])[missing].body, 'later')
  })
})

describe('C13 — reaction horizon and count', () => {
  it('with 101 targets, the newest 100 are asked and the omission of 1 is reported', async () => {
    const targets = Array.from({ length: 101 }, (_, i) => ({ id: (i + 1).toString(16).padStart(64, '0'), at: 1_700_000_000 + i }))
    const { asked, omitted } = reactionHorizon(targets)
    assert.equal(REACTION_HORIZON, 100)
    assert.equal(asked.length, 100)
    assert.equal(omitted, 1)
    assert.equal(asked.includes(targets[0].id), false, 'the oldest is the one left out')

    const calls: Record<string, unknown>[][] = []
    const found = await decorationsOf(targets, relay([], calls))
    assert.equal(found.reactionTargetsOmitted, 1)
    const reactionIds = calls.flat().filter((f) => (f.kinds as number[]).includes(7)).flatMap((f) => f['#e'] as string[])
    assert.equal(reactionIds.length, 100)
    assert.equal(reactionIds.includes(targets[0].id), false)
  })

  it('ties at the cut break on the higher id', () => {
    const low = { id: '1'.repeat(64), at: 5 }
    const high = { id: '2'.repeat(64), at: 5 }
    assert.deepEqual(reactionHorizon([low, high], 1), { asked: [high.id], omitted: 1 })
  })

  it('+, empty and a duplicate from one pubkey count as one +', () => {
    const target = comment(ISSUE)
    const react = (content: string) => event({ kind: 7, pubkey: BOB, content, tags: [['e', target.id]] })
    const folded = foldReactions([react('+'), react(''), react('+')])
    assert.deepEqual(folded[target.id].map((r) => [r.emoji, r.count]), [['+', 1]])
  })

  it('an emoji is not trimmed', () => {
    const target = comment(ISSUE)
    const folded = foldReactions([event({ kind: 7, content: ' 👍', tags: [['e', target.id]] })])
    assert.equal(folded[target.id][0].emoji, ' 👍')
  })

  it('a reaction with two e counts against the last', () => {
    const first = comment(ISSUE)
    const last = comment(ISSUE)
    const folded = foldReactions([event({ kind: 7, content: '🚀', tags: [['e', first.id], ['e', last.id]] })])
    assert.equal(folded[first.id], undefined)
    assert.equal(folded[last.id][0].count, 1)
  })

  it('a reaction read at the page ceiling reports that events may be cut', async () => {
    const target = comment(ISSUE)
    const many = Array.from({ length: 1000 }, (_, i) =>
      event({ kind: 7, pubkey: i.toString(16).padStart(64, '0'), content: '👍', tags: [['e', target.id]] }),
    )
    const cut = await decorationsOf([{ id: target.id, at: target.created_at }], relay(many))
    assert.equal(cut.reactionEventsCut, true)
    const whole = await decorationsOf([{ id: target.id, at: target.created_at }], relay(many.slice(0, 10)))
    assert.equal(whole.reactionEventsCut, false)
  })
})

describe('C14 — deletion left to the relay; which controls are offered', () => {
  it('a kind:5 is not interpreted: what the relay returns is the conversation', async () => {
    // Deletion is the relay's (§6.5): after an accepted kind:5 the next read
    // does not hold the message, and a refused one changes nothing. So the
    // package applies no kind:5 itself, and a non-author's that a relay stored
    // anyway hides nothing.
    const kept = comment(ISSUE)
    const gone = comment(ISSUE)
    const forged = event({ kind: 5, pubkey: BOB, tags: [['e', kept.id]] })
    const before = groupThreads([kept, gone, forged].filter((e) => e.kind !== 5))
    assert.equal(before.roots.length, 2)
    const decorated = await decorationsOf([{ id: kept.id, at: kept.created_at }], relay([forged]))
    assert.deepEqual(decorated.byId[kept.id], { reactions: [], resolutions: [] })
    // The next read, after the author's deletion was accepted, simply lacks it.
    assert.deepEqual(groupThreads([kept]).roots.map((r) => r.id), [kept.id])
  })

  it('a deleted root with replies left is reported, not silently dropped with them', () => {
    const gone = 'f'.repeat(64)
    const reply = event({ kind: 1111, tags: [['A', ISSUE], ['e', gone], ['k', '1111'], ['h', FOLDER]] })
    const threaded = groupThreads([reply])
    assert.deepEqual(threaded.missingRoots, [gone])
    assert.deepEqual(threaded.replies[gone].map((r) => r.id), [reply.id])
  })

  it("Edit and Delete are offered only on the viewer's own message", () => {
    assert.equal(offersEditAndDelete({ viewer: ALICE, author: ALICE }), true)
    // Another person's or an agent's: the author is not the viewer either way.
    assert.equal(offersEditAndDelete({ viewer: ALICE, author: BOB }), false)
    // Nobody signed in is offered nothing.
    assert.equal(offersEditAndDelete({ viewer: null, author: BOB }), false)
    assert.equal(offersEditAndDelete({ viewer: undefined, author: '' }), false)
  })
})

describe('C15 — attachment fold', () => {
  const file = (x: string) => imetaTag({ url: `https://relay.example/${x}`, m: 'image/png', x: x.repeat(64), size: 1 })
  const edit = (target: string, createdAt: number, files: string[]) =>
    event({ kind: 40003, content: 'body', created_at: createdAt, tags: [['h', FOLDER], ['e', target], ...files.map(file)] })

  it('an edit carrying imeta replaces the set; a later one with none leaves it; one file on a message with two leaves one', () => {
    const message = event({ kind: 1111, content: 'body', tags: [['A', ISSUE], ['h', FOLDER], file('1'), file('2')] })
    const replaced = foldEdits([message, edit(message.id, message.created_at + 1, ['3'])])[message.id]
    assert.deepEqual(replaced.attachments?.map((f) => f.x[0]), ['3'])

    const left = foldEdits([message, edit(message.id, message.created_at + 1, ['3']), edit(message.id, message.created_at + 2, [])])[message.id]
    assert.deepEqual(left.attachments?.map((f) => f.x[0]), ['3'])

    const one = foldEdits([message, edit(message.id, message.created_at + 1, ['1'])])[message.id]
    assert.deepEqual(one.attachments?.map((f) => f.x[0]), ['1'])
  })

  it('no edit with imeta leaves the message its own set', () => {
    const message = event({ kind: 1111, content: 'body', tags: [['A', ISSUE], ['h', FOLDER], file('1')] })
    assert.equal(foldEdits([message, edit(message.id, message.created_at + 1, [])])[message.id].attachments, undefined)
  })
})

describe('C16 — reply shape', () => {
  it("a reply is a 1111 with the comment's A/K/P, e/k/p naming it, its h, and no lowercase a for the object", () => {
    const top = comment(ISSUE)
    const reply = buildReply(BOB, 1_700_400_000_123, { comment: { id: top.id, anchor: ISSUE, author: ALICE }, folder: FOLDER, body: 'yes' })
    assert.equal(reply.kind, 1111)
    assert.deepEqual(reply.tags, [
      ['A', ISSUE],
      ['K', '30851'],
      ['P', ALICE],
      ['e', top.id],
      ['k', '1111'],
      ['p', ALICE],
      ['h', FOLDER],
      ['ts', '1700400000123'],
    ])
    assert.equal(reply.created_at, 1_700_400_000)
  })

  it('a reply read back threads under that comment', () => {
    const top = comment(ISSUE)
    const unsigned = buildReply(BOB, (top.created_at + 5) * 1000, { comment: { id: top.id, anchor: ISSUE, author: ALICE }, folder: FOLDER, body: 'yes' })
    const reply = { ...unsigned, id: 'e'.repeat(64), sig: '' }
    const threaded = groupThreads([top, reply])
    assert.deepEqual(threaded.roots.map((r) => r.id), [top.id])
    assert.deepEqual(threaded.replies[top.id].map((r) => r.id), [reply.id])
    assert.equal(isCommentOn(reply, ISSUE), false)
  })

  it('a reply that names an address in its body keeps that a, and never the object', () => {
    const top = comment(ISSUE)
    const reply = buildReply(BOB, 1_700_400_000_000, {
      comment: { id: top.id, anchor: ISSUE },
      folder: FOLDER,
      body: 'x',
      tags: [['a', ISSUE], ['a', OTHER]],
    })
    assert.deepEqual(reply.tags.filter((t) => t[0] === 'a'), [['a', OTHER]])
    assert.equal(reply.tags.some((t) => t[0] === 'p'), false, 'no p when the comment is outside the read')
  })
})

/*
  SPEC §6.6 *Finding the reactions to a person* (ACT-6, ACT-7): the read that
  asks for them, and which of the reactions it returns a reader keeps.
*/
import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import type { SignedEvent } from '@estiva-app/protocol'
import { keepReactionToMe, reactionsToMe, reactionsToMeFilter, reactionTakeBackFilter, REACTIONS_TO_ME_FROM } from '../dist/index.js'

const ME = 'a'.repeat(64)
const KATERINA = 'b'.repeat(64)
const CAROL = 'c'.repeat(64)
const RELAY = 'f'.repeat(64)
const FROM = REACTIONS_TO_ME_FROM

let seq = 0
const event = (partial: Partial<SignedEvent> & { kind: number }): SignedEvent => ({
  id: (++seq).toString(16).padStart(64, '0'),
  sig: '',
  pubkey: ME,
  created_at: FROM + seq,
  tags: [],
  content: '',
  ...partial,
})
const message = (partial: Partial<SignedEvent> = {}) => event({ kind: 9, tags: [['h', '85db5b59-9e49-4ea1-8e93-3d2a2d78c048']], ...partial })
const react = (target: SignedEvent, partial: Partial<SignedEvent> = {}) =>
  event({ kind: 7, pubkey: KATERINA, content: '👍', tags: [['e', target.id], ['p', ME]], ...partial })

describe('§6.6 the read for the reactions to P', () => {
  it('asks for kind 7 naming P, never from before reactions carried a name', () => {
    assert.deepEqual(reactionsToMeFilter(ME), { kinds: [7], '#p': [ME], since: FROM })
    assert.deepEqual(reactionsToMeFilter(ME, FROM - 86_400), { kinds: [7], '#p': [ME], since: FROM })
    assert.deepEqual(reactionsToMeFilter(ME, FROM + 60), { kinds: [7], '#p': [ME], since: FROM + 60 })
  })

  it('watches deletions of the reactions drawn and of the messages they react to', () => {
    assert.deepEqual(reactionTakeBackFilter(['1'.repeat(64), '2'.repeat(64), '1'.repeat(64)]), { kinds: [5], '#e': ['1'.repeat(64), '2'.repeat(64)] })
  })
})

describe('§6.6 a reader keeps a reaction only when it is to P’s message', () => {
  const mine = message()
  const theirs = message({ pubkey: CAROL })
  const relaySignedForMe = message({ pubkey: RELAY, tags: [['h', '85db5b59-9e49-4ea1-8e93-3d2a2d78c048'], ['actor', ME]] })
  const myComment = event({ kind: 1111, tags: [['A', `30851:${CAROL}:x`], ['a', `30851:${CAROL}:x`], ['p', CAROL]] })
  const myIssue = event({ kind: 30851, tags: [['d', 'x']] })
  const cases: [string, SignedEvent, SignedEvent | undefined, string | undefined, boolean][] = [
    ['a reaction to my message by someone else', react(mine), mine, undefined, true],
    ['a reaction to my comment', react(myComment), myComment, undefined, true],
    ['a last p that is not me', react(mine, { tags: [['e', mine.id], ['p', ME], ['p', CAROL]] }), mine, undefined, false],
    ['me named beside someone else, not last', react(mine, { tags: [['p', ME], ['e', mine.id], ['p', KATERINA]] }), mine, undefined, false],
    ['a target by someone else that names me falsely', react(theirs), theirs, undefined, false],
    ['a relay-signed target whose actor is me, with the relay key', react(relaySignedForMe), relaySignedForMe, RELAY, true],
    ['a relay-signed target whose actor is me, without the relay key', react(relaySignedForMe), relaySignedForMe, undefined, false],
    ['my own reaction', react(mine, { pubkey: ME }), mine, undefined, false],
    ['a relay-signed reaction whose actor is me', react(mine, { pubkey: RELAY, tags: [['e', mine.id], ['actor', ME], ['p', ME]] }), mine, RELAY, false],
    ['a reaction from before the name was written', react(mine, { created_at: FROM - 1 }), mine, undefined, false],
    ['a target that is not a message or a comment', react(myIssue), myIssue, undefined, false],
    ['a target that is deleted or unreadable', react(mine), undefined, undefined, false],
    ['a target that is not the reaction’s last e', react(mine, { tags: [['e', mine.id], ['e', theirs.id], ['p', ME]] }), mine, undefined, false],
  ]
  for (const [name, reaction, target, relayKey, kept] of cases) {
    it(`${kept ? 'keeps' : 'drops'} ${name}`, () => assert.equal(keepReactionToMe(reaction, target, ME, relayKey), kept))
  }
})

describe('reactionsToMe: the reactions kept, newest first', () => {
  const mine = message()
  const other = message()
  const targets = new Map([mine, other].map((m) => [m.id, m]))

  it('drops a reaction taken back and one on a message deleted later, and counts one per person, message and emoji', () => {
    const first = react(mine)
    const again = react(mine)
    const takenBack = react(other, { pubkey: CAROL })
    const onDeleted = react(other, { content: '🎉' })
    const fresh = react(mine, { pubkey: CAROL, content: '🚀' })
    const got = reactionsToMe([first, again, takenBack, onDeleted, fresh], targets, ME, { gone: new Set([takenBack.id]) })
    assert.deepEqual(got.map((r) => r.id), [fresh.id, onDeleted.id, first.id])
    assert.deepEqual(got[0], { id: fresh.id, by: CAROL, at: fresh.created_at, emoji: '🚀', target: mine.id })
    const deleted = reactionsToMe([first, onDeleted], targets, ME, { gone: new Set([other.id]) })
    assert.deepEqual(deleted.map((r) => r.id), [first.id])
  })

  it('names the person who reacted, not the relay that signed for them', () => {
    const forKaterina = react(mine, { pubkey: RELAY, tags: [['e', mine.id], ['actor', KATERINA], ['p', ME]] })
    assert.deepEqual(reactionsToMe([forKaterina], targets, ME, { relayKey: RELAY }).map((r) => r.by), [KATERINA])
  })
})

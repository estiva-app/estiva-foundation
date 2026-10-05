/*
  SPEC §11.8 — membership, the mute list, and the unread judge — as fixtures.
  C17 and C18 in §9 are the first two describes.
*/
import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { encodeNpub, type SignedEvent } from '@estiva-app/protocol'
import {
  buildMembershipChange,
  candidateFilesOf,
  membersOf,
  membershipFilters,
  membershipOf,
  mutedFromFollowed,
  parseMutedBlob,
  serializeMutedBlob,
  streamOf,
  unreadIn,
} from '../dist/index.js'

const ALICE = 'a'.repeat(64)
const BOB = 'b'.repeat(64)
const CAROL = 'c'.repeat(64)
const FOLDER = '85db5b59-9e49-4ea1-8e93-3d2a2d78c048'
const D = 'd68a8c78-5ec7-4652-b236-89ab57ac5b1e'
const ISSUE = `30851:${ALICE}:${D}`
const OTHER = `30851:${ALICE}:0b7e2a4c-1111-4c3e-9d2f-2a1f0c9e8b7d`
const T0 = 1_700_000_000
const mention = (pubkey: string) => `nostr:${encodeNpub(pubkey)}`

let seq = 0
const event = (partial: Partial<SignedEvent> & { kind: number }): SignedEvent => ({
  id: (++seq).toString(16).padStart(64, '0'),
  sig: '',
  pubkey: ALICE,
  created_at: T0 + seq,
  tags: [],
  content: '',
  ...partial,
})
const root = (at = T0) => event({ kind: 30851, pubkey: ALICE, created_at: at, tags: [['d', D], ['h', FOLDER]] })
const comment = (by: string, at: number, content = '') =>
  event({ kind: 1111, pubkey: by, created_at: at, content, tags: [['A', ISSUE], ['K', '30851'], ['P', ALICE], ['a', ISSUE], ['k', '30851'], ['p', ALICE], ['h', FOLDER]] })
const reply = (by: string, top: SignedEvent, at: number, content = '') =>
  event({ kind: 1111, pubkey: by, created_at: at, content, tags: [['A', ISSUE], ['K', '30851'], ['P', ALICE], ['e', top.id], ['k', '1111'], ['p', top.pubkey], ['h', FOLDER]] })
const change = (by: string, at: number, field: string, value: string, extra: string[][] = []) =>
  event({ kind: 1851, pubkey: by, created_at: at, tags: [['a', ISSUE], ['field', field], ['value', value], ['h', FOLDER], ['ts', String(at * 1000)], ...extra] })
const member = (by: string, at: number, person: string, value: boolean) => {
  const unsigned = buildMembershipChange(by, at * 1000, { file: ISSUE, folder: FOLDER, person, member: value })
  return event({ ...unsigned, created_at: at })
}

describe('C17 — membership fold', () => {
  it('the author joins at the earliest root version held', () => {
    const later = root(T0 + 50)
    const first = root(T0 + 10)
    assert.deepEqual(membershipOf(ISSUE, ALICE, [later, first]), { member: true, since: T0 + 10 })
  })

  it('writing, a body mention, a placement and an add each join', () => {
    const events = [
      root(),
      comment(BOB, T0 + 100),
      comment(BOB, T0 + 110, `over to ${mention(CAROL)}`),
    ]
    assert.deepEqual(membershipOf(ISSUE, BOB, events), { member: true, since: T0 + 100 })
    assert.deepEqual(membershipOf(ISSUE, CAROL, events), { member: true, since: T0 + 110 })
    const dave = 'd'.repeat(64)
    assert.deepEqual(membershipOf(ISSUE, dave, [change(ALICE, T0 + 200, 'assignee', dave, [['p', dave]])]), { member: true, since: T0 + 200 })
    assert.equal(membershipOf(ISSUE, dave, [change(ALICE, T0 + 200, 'assignee', dave)]).member, false, 'a placement without a p does not count')
    assert.deepEqual(membershipOf(ISSUE, dave, [change(ALICE, T0 + 210, 'lead', dave, [['p', dave]])]), { member: true, since: T0 + 210 })
    assert.deepEqual(membershipOf(ISSUE, dave, [member(ALICE, T0 + 220, dave, true)]), { member: true, since: T0 + 220 })
  })

  it('a p tag alone is not a mention: a comment re-tagging the author does not re-join her', () => {
    const events = [root(), member(ALICE, T0 + 100, ALICE, false), comment(BOB, T0 + 200)]
    assert.equal(membershipOf(ISSUE, ALICE, events).member, false)
  })

  it('a leave counts only when the person signs it', () => {
    const events = [root(), comment(BOB, T0 + 100)]
    assert.equal(membershipOf(ISSUE, BOB, [...events, member(ALICE, T0 + 200, BOB, false)]).member, true)
    assert.equal(membershipOf(ISSUE, BOB, [...events, member(BOB, T0 + 200, BOB, false)]).member, false)
  })

  it('a later trigger rejoins, and since is the first join after the last leave; others talking does not', () => {
    const left = [root(), comment(BOB, T0 + 100), member(BOB, T0 + 200, BOB, false)]
    assert.equal(membershipOf(ISSUE, BOB, [...left, comment(CAROL, T0 + 300)]).member, false)
    const back = [...left, comment(CAROL, T0 + 300, mention(BOB)), comment(BOB, T0 + 400)]
    assert.deepEqual(membershipOf(ISSUE, BOB, back), { member: true, since: T0 + 300 })
  })

  it('an edit of the root after the author left does not make her a member again', () => {
    const events = [comment(ALICE, T0 + 50), member(ALICE, T0 + 100, ALICE, false), root(T0 + 500)]
    assert.equal(membershipOf(ISSUE, ALICE, events).member, false)
    assert.deepEqual(membershipOf(ISSUE, ALICE, [root(T0 + 500), comment(ALICE, T0 + 50)]), { member: true, since: T0 + 50 })
  })

  it('an unassign places nobody, whatever p it carries', () => {
    assert.equal(membershipOf(ISSUE, BOB, [change(ALICE, T0 + 10, 'assignee', '', [['p', BOB]])]).member, false)
  })

  it('orders by trusted ts inside one second', () => {
    const at = T0 + 500
    const join = event({ ...buildMembershipChange(BOB, at * 1000 + 100, { file: ISSUE, folder: FOLDER, person: BOB, member: true }), created_at: at })
    const leave = event({ ...buildMembershipChange(BOB, at * 1000 + 900, { file: ISSUE, folder: FOLDER, person: BOB, member: false }), created_at: at })
    assert.equal(membershipOf(ISSUE, BOB, [leave, join]).member, false)
  })

  it('another file’s events and a chat kind:9 with an a do not count', () => {
    const elsewhere = event({ kind: 1111, pubkey: BOB, tags: [['A', OTHER], ['a', OTHER], ['h', FOLDER]] })
    const chat = event({ kind: 9, pubkey: CAROL, tags: [['a', ISSUE], ['h', FOLDER]] })
    assert.equal(membershipOf(ISSUE, BOB, [elsewhere]).member, false)
    assert.equal(membershipOf(ISSUE, CAROL, [chat]).member, false)
  })

  it('a reply joins its author, and membersOf lists everyone who has not left', () => {
    const top = comment(BOB, T0 + 100)
    const events = [root(), top, reply(CAROL, top, T0 + 150), member(BOB, T0 + 200, BOB, false)]
    assert.deepEqual([...membersOf(ISSUE, events).keys()].sort(), [ALICE, CAROL])
    assert.equal(streamOf(ISSUE, events).length, 2)
  })
})

describe('C18 — unread for a member', () => {
  const merged = (contexts: Record<string, number> = {}) => contexts
  const judge = (me: string, events: SignedEvent[], extra: { muted?: boolean } = {}) => {
    const m = membershipOf(ISSUE, me, events)
    return { stream: ISSUE, me, member: m.member, since: m.since, ...extra }
  }

  it('a year-old issue: the mention is unread, the year is not', () => {
    const history = [root(T0), comment(ALICE, T0 + 10), comment(ALICE, T0 + 20)]
    const call = comment(ALICE, T0 + 400 * 86_400, `${mention(BOB)} can you look`)
    const events = [...history, call]
    const unread = unreadIn(streamOf(ISSUE, events), merged(), judge(BOB, events))
    assert.deepEqual(unread.map((e) => e.id), [call.id])
  })

  it('own messages, a marker, a thread marker and a non-member are judged as §11.8 says', () => {
    const top = comment(BOB, T0 + 100)
    const r1 = reply(CAROL, top, T0 + 200)
    const r2 = reply(CAROL, top, T0 + 300)
    const events = [root(), top, r1, r2]
    const stream = streamOf(ISSUE, events)
    assert.deepEqual(unreadIn(stream, merged(), judge(BOB, events)).map((e) => e.id), [r1.id, r2.id])
    assert.deepEqual(unreadIn(stream, merged({ [ISSUE]: T0 + 200 }), judge(BOB, events)).map((e) => e.id), [r2.id])
    assert.deepEqual(unreadIn(stream, merged({ [`thread:${top.id}`]: T0 + 300 }), judge(BOB, events)), [])
    const dave = 'd'.repeat(64)
    assert.deepEqual(unreadIn(stream, merged(), judge(dave, events)), [])
  })

  it('the reply floor reads replies at or before it, and alone never replaces the absent-marker rule (CON-34)', () => {
    const top = comment(BOB, T0 + 100)
    const r1 = reply(CAROL, top, T0 + 200)
    const r2 = reply(CAROL, top, T0 + 300)
    const events = [root(), top, r1, r2]
    const stream = streamOf(ISSUE, events)
    assert.deepEqual(unreadIn(stream, merged({ 'reply-floor': T0 + 200 }), judge(BOB, events)).map((e) => e.id), [r2.id])
    // A channel with no marker counts from the app's floor; a reply floor below it must not light what that rule leaves quiet.
    const general = [comment(CAROL, T0 + 50)]
    const old = reply(BOB, general[0], T0 + 60)
    const channel = { stream: FOLDER, me: CAROL, member: true, floor: T0 + 80 }
    assert.deepEqual(unreadIn([...general, old], { 'reply-floor': T0 + 10 }, channel), [])
  })

  it('the channel marker does not reach into a file stream', () => {
    const events = [root(), comment(BOB, T0 + 100), comment(CAROL, T0 + 200)]
    assert.equal(unreadIn(streamOf(ISSUE, events), merged({ [FOLDER]: T0 + 999 }), judge(BOB, events)).length, 1)
  })

  it('a mute silences all but mentions', () => {
    const events = [root(), comment(BOB, T0 + 100), comment(CAROL, T0 + 200), comment(CAROL, T0 + 300, mention(BOB))]
    const unread = unreadIn(streamOf(ISSUE, events), merged(), judge(BOB, events, { muted: true }))
    assert.deepEqual(unread.map((e) => e.content), [mention(BOB)])
  })

  it('a general stream has no since; floor is the app’s choice there', () => {
    const chat = [event({ kind: 9, pubkey: CAROL, created_at: T0 + 10, tags: [['h', FOLDER]] }), event({ kind: 9, pubkey: CAROL, created_at: T0 + 90, tags: [['h', FOLDER]] })]
    const roster = { stream: FOLDER, me: BOB, member: true }
    assert.equal(unreadIn(chat, merged(), roster).length, 2)
    assert.equal(unreadIn(chat, merged(), { ...roster, floor: T0 + 50 }).length, 1)
    assert.equal(unreadIn(chat, merged({ [FOLDER]: T0 + 90 }), roster).length, 0)
  })
})

describe('membership change, discovery and the mute list', () => {
  it('the change has the SPEC’s tag order and refuses a bad Folder', () => {
    const unsigned = buildMembershipChange(ALICE, 1_700_000_000_123, { file: ISSUE, folder: FOLDER, person: BOB, member: true })
    assert.deepEqual(unsigned.tags, [['a', ISSUE], ['field', `member:${BOB}`], ['value', 'true'], ['h', FOLDER], ['ts', '1700000000123'], ['p', BOB]])
    assert.equal(unsigned.created_at, 1_700_000_000)
    assert.equal(unsigned.content, 'Add')
    assert.equal(buildMembershipChange(BOB, 0, { file: ISSUE, folder: FOLDER, person: BOB, member: true }).content, 'Join')
    assert.equal(buildMembershipChange(BOB, 0, { file: ISSUE, folder: FOLDER, person: BOB, member: false }).content, 'Leave')
    assert.throws(() => buildMembershipChange(ALICE, 0, { file: ISSUE, folder: 'nope', person: BOB, member: true }))
  })

  it('discovery is three filters on the person, and candidates come from a and A', () => {
    assert.deepEqual(membershipFilters(BOB, 5), [
      { kinds: [1851], '#p': [BOB], since: 5 },
      { kinds: [1111, 9], authors: [BOB], since: 5 },
      { kinds: [1111, 9], '#p': [BOB], since: 5 },
    ])
    assert.deepEqual(candidateFilesOf(change(ALICE, T0, 'assignee', BOB)), [ISSUE])
    assert.deepEqual(candidateFilesOf(comment(BOB, T0)), [ISSUE])
    assert.deepEqual(candidateFilesOf(event({ kind: 9, tags: [['a', ISSUE]] })), [])
  })

  it('the mute list round-trips, sorted, dropping what is not a stream', () => {
    const text = serializeMutedBlob([ISSUE, FOLDER, 'junk', ISSUE], 42)
    assert.deepEqual(parseMutedBlob(text), { v: 1, updatedAt: 42, keys: [ISSUE, FOLDER].sort() })
    assert.equal(parseMutedBlob('{"v":2,"updatedAt":1,"keys":[]}'), undefined)
  })

  it('migration carries muted keys in either shape and never the follows', () => {
    const followed = JSON.stringify({ v: 1, updatedAt: 1, keys: [OTHER, FOLDER], muted: { [ISSUE]: 5 } })
    assert.deepEqual(mutedFromFollowed(followed), [ISSUE])
    assert.deepEqual(mutedFromFollowed(JSON.stringify({ v: 1, muted: [ISSUE, FOLDER] })), [ISSUE, FOLDER].sort())
    assert.deepEqual(mutedFromFollowed('not json'), [])
  })
})

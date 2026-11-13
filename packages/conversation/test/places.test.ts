/*
  SPEC §11.8 *Places and following* — who is in a place, at what level, since
  when, and what lights for them there — as fixtures. And the F2 guard: a
  level's `p` places nobody on today's file fold.
*/
import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { encodeNpub, type SignedEvent } from '@estiva-app/protocol'
import {
  buildLevelChange,
  buildMembershipChange,
  buildPlaceAdd,
  followingOf,
  placeListing,
  switchStateOf,
  switchWrites,
  withPlaceOff,
  foldMemberships,
  membershipJudges,
  membershipOf,
  parseTeamsBlob,
  placeFilters,
  serializeTeamsBlob,
  teamMembersOf,
  unreadOnPlace,
  unreadOnListedFile,
  unreadReasons,
  whatLitPlace,
  whatLitListedFile,
  whatLitStream,
  mergeLitLines,
  newReactionsIn,
  reactionStreamOf,
  reactionsSeenWrites,
  REACTIONS_TO_ME_FROM,
  type ReactionToMe,
  unreadIn,
  type LitLine,
  threadContext,
  type Following,
  type PlaceFacts,
  type TeamsList,
} from '../dist/index.js'

const ALICE = 'a'.repeat(64)
const BOB = 'b'.repeat(64)
const CAROL = 'c'.repeat(64)
const RELAY = 'e'.repeat(64)
const TEAM = '85db5b59-9e49-4ea1-8e93-3d2a2d78c048'
const D = 'd68a8c78-5ec7-4652-b236-89ab57ac5b1e'
const TOPIC = `30840:${ALICE}:${D}`
const CHAT = `39000:${RELAY}:${TEAM}`
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
const root = (at = T0) => event({ kind: 30840, pubkey: ALICE, created_at: at, tags: [['d', D], ['h', TEAM]] })
const member = (by: string, at: number, person: string, value: boolean, place = TOPIC) =>
  event({ ...buildMembershipChange(by, at * 1000, { file: place, folder: TEAM, person, member: value }), created_at: at })
const level = (by: string, at: number, value: 'all' | 'important' | '', place = TOPIC) =>
  event({ ...buildLevelChange(by, at * 1000, { place, folder: TEAM, level: value }), created_at: at })
/** A level change written by someone other than the person it names — every reader ignores it. */
const forgedLevel = (by: string, person: string, at: number, value: string) =>
  event({ kind: 1851, pubkey: by, created_at: at, tags: [['a', TOPIC], ['field', `follow:${person}`], ['value', value], ['h', TEAM], ['ts', String(at * 1000)], ['p', person]] })
const roster = (at: number, ...people: string[]) => event({ kind: 39002, pubkey: RELAY, created_at: at, tags: [['d', TEAM], ...people.map((p) => ['p', p])] })
const joinTeam = (who: string, at: number) => event({ kind: 9021, pubkey: who, created_at: at, tags: [['h', TEAM]] })
const leaveTeam = (who: string, at: number) => event({ kind: 9022, pubkey: who, created_at: at, tags: [['h', TEAM]] })
const createTeam = (who: string, at: number) => event({ kind: 9007, pubkey: who, created_at: at, tags: [['h', TEAM]] })
const markSpace = (at: number, space = true) =>
  event({ kind: 1852, pubkey: ALICE, created_at: at, tags: [['h', TEAM], ['op', 'add'], space ? ['a', TOPIC, '', 'space'] : ['a', TOPIC]] })
const teamList = (at: number, space = true) =>
  event({ kind: 30890, pubkey: RELAY, created_at: at, tags: [['d', TEAM], space ? ['a', TOPIC, '', 'space'] : ['a', TOPIC]] })
const teams = (entries: Record<string, number>, off: string[] = []): TeamsList => ({ v: 1, updatedAt: 0, teams: entries, off })
const comment = (by: string, at: number, content = '') =>
  event({ kind: 1111, pubkey: by, created_at: at, content, tags: [['A', TOPIC], ['K', '30840'], ['P', ALICE], ['a', TOPIC], ['k', '30840'], ['p', ALICE], ['h', TEAM]] })
const reply = (by: string, top: SignedEvent, at: number, content = '') =>
  event({ kind: 1111, pubkey: by, created_at: at, content, tags: [['A', TOPIC], ['K', '30840'], ['P', ALICE], ['e', top.id], ['k', '1111'], ['p', top.pubkey], ['h', TEAM]] })

const topicPlace = { address: TOPIC, team: TEAM }
const following = (person: string, facts: Partial<PlaceFacts> & Pick<PlaceFacts, 'events'>, place = topicPlace) => followingOf(place, person, facts)
const brief = (f: Following) => ({ in: f.in, level: f.level, since: f.since })

describe('F2 — a level on the file fold', () => {
  it('a follow:<P> chosen by P does not make P a member of the topic, so Important never lights every message', () => {
    assert.deepEqual(membershipOf(TOPIC, BOB, [root(), level(BOB, T0 + 10, 'important')]), { member: false })
    assert.deepEqual(membershipOf(TOPIC, BOB, [root(), level(BOB, T0 + 10, 'all')]), { member: false })
  })

  it('a level alone is no word on file membership, so an app still reads full history for someone who joined before the horizon', () => {
    const read = foldMemberships(BOB, [level(BOB, T0 + 10, 'all')], T0 + 100)
    assert.equal(membershipJudges(TOPIC, read, BOB), false)
  })

  it('a follow:<P> inside a several-field change places nobody either', () => {
    const several = event({ kind: 1851, pubkey: BOB, created_at: T0 + 10, tags: [['a', TOPIC], ['set', `follow:${BOB}`, 'all'], ['h', TEAM], ['p', BOB]] })
    assert.deepEqual(membershipOf(TOPIC, BOB, [root(), several]), { member: false })
  })
})

describe('§11.8 ways in — a level, an Add, the author', () => {
  it('an Add puts P in at Important from the Add, and chooses no level', () => {
    assert.deepEqual(brief(following(BOB, { events: [root(), member(ALICE, T0 + 10, BOB, true)] })), { in: true, level: 'important', since: T0 + 10 })
  })

  it('a level P chose puts P in at that level; one signed by someone else changes nothing', () => {
    assert.deepEqual(brief(following(BOB, { events: [root(), level(BOB, T0 + 10, 'all')] })), { in: true, level: 'all', since: T0 + 10 })
    assert.deepEqual(brief(following(BOB, { events: [root(), forgedLevel(ALICE, BOB, T0 + 10, 'all')] })), { in: false, level: undefined, since: undefined })
  })

  it('changing the level keeps its start; an empty level is no choice and leaves P in by the Add at Important', () => {
    const events = [root(), member(ALICE, T0 + 5, BOB, true), level(BOB, T0 + 10, 'important'), level(BOB, T0 + 20, 'all')]
    assert.deepEqual(brief(following(BOB, { events })), { in: true, level: 'all', since: T0 + 5 })
    assert.deepEqual(brief(following(BOB, { events: [...events, level(BOB, T0 + 30, '')] })), { in: true, level: 'important', since: T0 + 5 })
    assert.equal(following(BOB, { events: [root(), level(BOB, T0 + 10, 'all'), level(BOB, T0 + 30, '')] }).in, false)
  })

  it('P own leave, from any app, ends a level chosen before it and the Add; an Add after it puts P back at Important', () => {
    const before = [root(), member(ALICE, T0 + 5, BOB, true), level(BOB, T0 + 10, 'all'), member(BOB, T0 + 20, BOB, false)]
    assert.equal(following(BOB, { events: before }).in, false)
    assert.deepEqual(brief(following(BOB, { events: [...before, member(ALICE, T0 + 30, BOB, true)] })), { in: true, level: 'important', since: T0 + 30 })
  })

  it('an Add naming P leave with prev puts P back in even when the adder clock is behind the leave', () => {
    const leave = member(BOB, T0 + 20, BOB, false)
    const add = member(ALICE, T0 + 10, BOB, true)
    add.tags.push(['prev', leave.id])
    assert.deepEqual(brief(following(BOB, { events: [root(), member(ALICE, T0 + 5, BOB, true), leave, add] })), { in: true, level: 'important', since: T0 + 10 })
  })

  it('an Add filed in another Folder does not put P in the place', () => {
    const elsewhere = event({ ...buildMembershipChange(CAROL, (T0 + 10) * 1000, { file: TOPIC, folder: 'f1e2d3c4-b5a6-4978-8a9b-0c1d2e3f4a5b', person: BOB, member: true }), created_at: T0 + 10 })
    assert.equal(following(BOB, { events: [root(), elsewhere] }).in, false)
  })

  it('a leave signed by someone else is ignored', () => {
    assert.equal(following(BOB, { events: [root(), member(ALICE, T0 + 5, BOB, true), member(ALICE, T0 + 20, BOB, false)] }).in, true)
  })

  it('the author is in at Important from the first record, and a leave ends it for good', () => {
    assert.deepEqual(brief(following(ALICE, { events: [root(T0 + 50), root(T0 + 3)] })), { in: true, level: 'important', since: T0 + 3 })
    assert.equal(following(ALICE, { events: [root(T0 + 50), member(ALICE, T0 + 20, ALICE, false)] }).in, false)
  })

  it('writing in the topic or being mentioned there does not put P in the place', () => {
    const events = [root(), comment(BOB, T0 + 10, 'hi'), comment(ALICE, T0 + 11, `${mention(CAROL)} see`)]
    assert.equal(following(BOB, { events }).in, false)
    assert.equal(following(CAROL, { events }).in, false)
  })
})

describe('§11.8 ways in — a team default', () => {
  const spaceListing = [markSpace(T0 + 100), teamList(T0 + 100)]

  it('a space reaches a team member at Important from the later of their join and the space mark', () => {
    const facts = { events: [root()], roster: [roster(T0 + 60, BOB), joinTeam(BOB, T0 + 50)], listing: spaceListing }
    const f = following(BOB, facts)
    assert.equal(f.kind, 'space')
    assert.deepEqual(brief(f), { in: true, level: 'important', since: T0 + 100 })
    const joinedLater = { ...facts, roster: [roster(T0 + 210, BOB), joinTeam(BOB, T0 + 200)] }
    assert.equal(following(BOB, joinedLater).since, T0 + 200)
  })

  it('a member who left the team and joined again is reached from the rejoin', () => {
    const rosterEvents = [roster(T0 + 400, BOB), joinTeam(BOB, T0 + 150), leaveTeam(BOB, T0 + 250), joinTeam(BOB, T0 + 300)]
    assert.equal(following(BOB, { events: [root()], roster: rosterEvents, listing: spaceListing }).since, T0 + 300)
  })

  it('a topic the team leads reaches nobody by default', () => {
    const facts = { events: [root()], roster: [roster(T0 + 60, BOB), joinTeam(BOB, T0 + 50)], listing: [markSpace(T0 + 100, false), teamList(T0 + 100, false)] }
    const f = following(BOB, facts)
    assert.equal(f.kind, 'topic')
    assert.equal(f.in, false)
  })

  it('a space re-marked after being unmarked starts at the re-mark', () => {
    const listing = [markSpace(T0 + 100), markSpace(T0 + 150, false), markSpace(T0 + 180), teamList(T0 + 180)]
    assert.equal(following(BOB, { events: [root()], roster: [roster(T0 + 60, BOB), joinTeam(BOB, T0 + 50)], listing }).since, T0 + 180)
  })

  it('a follower of the team is reached by its spaces from when they followed, not by its chat', () => {
    const list = teams({ [TEAM]: (T0 + 120) * 1000 })
    assert.deepEqual(brief(following(BOB, { events: [root()], listing: spaceListing, teams: list })), { in: true, level: 'important', since: T0 + 120 })
    assert.equal(following(BOB, { events: [], teams: list }, { address: CHAT, team: TEAM }).in, false)
  })

  it('the team chat reaches its members, from their join', () => {
    const f = following(BOB, { events: [], roster: [createTeam(ALICE, T0 + 1), roster(T0 + 60, ALICE, BOB), joinTeam(BOB, T0 + 50)] }, { address: CHAT, team: TEAM })
    assert.deepEqual({ kind: f.kind, ...brief(f) }, { kind: 'chat', in: true, level: 'important', since: T0 + 50 })
  })

  it('the private off list turns the default off, by the space d or the team uuid for its chat; a leave does not', () => {
    const facts = { events: [root(), member(BOB, T0 + 300, BOB, false)], roster: [createTeam(ALICE, T0 + 1), roster(T0 + 60, BOB), joinTeam(BOB, T0 + 50)], listing: spaceListing }
    assert.equal(following(BOB, facts).in, true)
    assert.equal(following(BOB, { ...facts, teams: teams({}, [D]) }).in, false)
    assert.equal(following(BOB, { ...facts, events: [], teams: teams({}, [TEAM]) }, { address: CHAT, team: TEAM }).in, false)
  })

  it('an archived team holds nobody, a chosen level included', () => {
    const facts = { events: [root(), level(BOB, T0 + 10, 'all')], roster: [roster(T0 + 60, BOB), joinTeam(BOB, T0 + 50)], listing: spaceListing, archived: true }
    assert.equal(following(BOB, facts).in, false)
  })
})

describe('§11.8 what is unread on a place', () => {
  const inAt = (level: 'all' | 'important', since = T0): Following => ({ kind: 'space', in: true, level, since, ways: ['team'] })
  const notIn: Following = { kind: 'space', in: false, ways: [] }
  const judge = (f: Following, muted = false) => ({ stream: TOPIC, me: BOB, following: f, muted })
  const ids = (list: SignedEvent[]) => list.map((e) => e.id)

  it('at Important a new conversation lights, a reply in a conversation P is not in does not, and at All it does', () => {
    const top = comment(ALICE, T0 + 10, 'new')
    const r = reply(CAROL, top, T0 + 11, 'reply')
    assert.deepEqual(ids(unreadOnPlace([top, r], {}, judge(inAt('important')))), [top.id])
    assert.deepEqual(ids(unreadOnPlace([top, r], {}, judge(inAt('all')))), [top.id, r.id])
  })

  it('at Important a reply lights once P wrote in that conversation or was mentioned there, not before', () => {
    const top = comment(ALICE, T0 + 10, 'new')
    const early = reply(CAROL, top, T0 + 11)
    const mine = reply(BOB, top, T0 + 12)
    const late = reply(CAROL, top, T0 + 13)
    assert.deepEqual(ids(unreadOnPlace([top, early, mine, late], {}, judge(inAt('important')))), [top.id, late.id])
  })

  it('at Important a reply to P own comment lights even when the reader does not hold that comment (its p names P)', () => {
    const top = comment(BOB, T0 + 10, 'my question')
    const answer = reply(CAROL, top, T0 + 11, 'an answer')
    assert.deepEqual(ids(unreadOnPlace([answer], {}, judge(inAt('important')))), [answer.id])
  })

  it('choosing All lights replies P is not in from that moment, never the older ones', () => {
    const top = comment(ALICE, T0 + 10, 'new')
    const before = reply(CAROL, top, T0 + 11, 'before All')
    const after = reply(CAROL, top, T0 + 30, 'after All')
    const events = [root(), member(ALICE, T0 + 5, BOB, true), level(BOB, T0 + 20, 'all')]
    const f = following(BOB, { events })
    assert.deepEqual(ids(unreadOnPlace([top, before, after], {}, judge(f))), [top.id, after.id])
  })

  it('not in the place: only a message that mentions P lights', () => {
    const top = comment(ALICE, T0 + 10, 'new')
    const named = reply(CAROL, top, T0 + 11, `${mention(BOB)} look`)
    assert.deepEqual(ids(unreadOnPlace([top, named], {}, judge(notIn))), [named.id])
  })

  it('a mute already kept lights only mentions, whatever the level', () => {
    const top = comment(ALICE, T0 + 10, 'new')
    const named = comment(CAROL, T0 + 11, `${mention(BOB)} look`)
    assert.deepEqual(ids(unreadOnPlace([top, named], {}, judge(inAt('all'), true))), [named.id])
  })

  it('nothing from before P was in lights, P own messages never do, and a read marker clears', () => {
    const old = comment(ALICE, T0 + 10, 'old')
    const own = comment(BOB, T0 + 30, 'mine')
    const fresh = comment(ALICE, T0 + 40, 'fresh')
    assert.deepEqual(ids(unreadOnPlace([old, own, fresh], {}, judge(inAt('all', T0 + 20)))), [fresh.id])
    assert.deepEqual(ids(unreadOnPlace([old, own, fresh], { [`file:${D}`]: T0 + 40 }, judge(inAt('all', T0 + 20)))), [])
  })
})

describe('§11.8 what names you on a file a place lists (ACT-2)', () => {
  const ISSUE_D = '5b7c1a52-9a9e-4d0e-8f4c-2b8f2b2f6a10'
  const ISSUE = `30851:${CAROL}:${ISSUE_D}`
  const stream = `file:${ISSUE_D}`
  const onIssue = (by: string, at: number, content = '') =>
    event({ kind: 1111, pubkey: by, created_at: at, content, tags: [['A', ISSUE], ['K', '30851'], ['P', CAROL], ['a', ISSUE], ['k', '30851'], ['p', CAROL], ['h', TEAM]] })
  const answer = (by: string, top: SignedEvent, at: number, content = '') =>
    event({ kind: 1111, pubkey: by, created_at: at, content, tags: [['A', ISSUE], ['K', '30851'], ['P', CAROL], ['e', top.id], ['k', '1111'], ['p', top.pubkey], ['h', TEAM]] })
  const inAt = (level: 'all' | 'important', since = T0, allSince?: number): Following => ({ kind: 'topic', in: true, level, since, ways: ['level'], ...(allSince !== undefined ? { allSince } : {}) })
  const judge = (f: Following, opts: { muted?: boolean; under?: boolean } = {}) => ({ stream, me: BOB, following: f, ...opts })
  const ids = (list: SignedEvent[]) => list.map((e) => e.id)

  it('at Important a mention of P lights the place, a new conversation naming nobody does not, and at All it does', () => {
    const named = onIssue(ALICE, T0 + 10, `${mention(BOB)} can you look?`)
    const plain = onIssue(ALICE, T0 + 11, 'looks good')
    assert.deepEqual(ids(unreadOnListedFile([named, plain], {}, judge(inAt('important')))), [named.id])
    assert.deepEqual(ids(unreadOnListedFile([named, plain], {}, judge(inAt('all', T0, T0)))), [named.id, plain.id])
  })

  it('a reply in a conversation P started lights at Important, held root or not, and one in a conversation P is not in does not', () => {
    const mine = onIssue(BOB, T0 + 10, 'my question')
    const toMe = answer(ALICE, mine, T0 + 11, 'an answer')
    const theirs = onIssue(ALICE, T0 + 12, 'their note')
    const toThem = answer(CAROL, theirs, T0 + 13, 'agreed')
    assert.deepEqual(ids(unreadOnListedFile([mine, toMe, theirs, toThem], {}, judge(inAt('important')))), [toMe.id])
    assert.deepEqual(ids(unreadOnListedFile([toMe, toThem], {}, judge(inAt('important')))), [toMe.id])
  })

  it('a reply lights once P replied in someone else conversation, never the ones before', () => {
    const theirs = onIssue(ALICE, T0 + 10, 'their note')
    const early = answer(CAROL, theirs, T0 + 11)
    const mine = answer(BOB, theirs, T0 + 12, 'me too')
    const late = answer(CAROL, theirs, T0 + 13)
    assert.deepEqual(ids(unreadOnListedFile([theirs, early, mine, late], {}, judge(inAt('important')))), [late.id])
  })

  it('an older mention stays lit under newer comments naming nobody, until the file or its thread is read', () => {
    const named = onIssue(ALICE, T0 + 10, `${mention(BOB)} please`)
    const later = [onIssue(CAROL, T0 + 11, 'one'), onIssue(CAROL, T0 + 12, 'two')]
    assert.deepEqual(ids(unreadOnListedFile([named, ...later], {}, judge(inAt('important')))), [named.id])
    assert.deepEqual(ids(unreadOnListedFile([named, ...later], { [stream]: T0 + 12 }, judge(inAt('important')))), [])
    const mine = onIssue(BOB, T0 + 20, 'mine')
    const toMe = answer(ALICE, mine, T0 + 21)
    assert.deepEqual(ids(unreadOnListedFile([mine, toMe], { [threadContext(mine.id)!]: T0 + 21 }, judge(inAt('important')))), [])
  })

  it('a mute keeps only the mentions, and when P is not in the place nothing on its files lights', () => {
    const named = onIssue(ALICE, T0 + 10, `${mention(BOB)} please`)
    const mine = onIssue(BOB, T0 + 11, 'mine')
    const toMe = answer(ALICE, mine, T0 + 12)
    assert.deepEqual(ids(unreadOnListedFile([named, mine, toMe], {}, judge(inAt('all', T0, T0), { muted: true }))), [named.id])
    assert.deepEqual(ids(unreadOnListedFile([named, mine, toMe], {}, judge({ kind: 'topic', in: false, ways: [] }))), [])
  })

  it('on a file one level under a listed one only what names P lights, at All too', () => {
    const named = onIssue(ALICE, T0 + 10, `${mention(BOB)} please`)
    const plain = onIssue(ALICE, T0 + 11, 'looks good')
    assert.deepEqual(ids(unreadOnListedFile([named, plain], {}, judge(inAt('all', T0, T0), { under: true }))), [named.id])
  })

  it('nothing from before P started on the place lights, and at All only what came after choosing All beyond what names P', () => {
    const old = onIssue(ALICE, T0 + 5, `${mention(BOB)} old`)
    const before = onIssue(ALICE, T0 + 15, 'before All')
    const after = onIssue(ALICE, T0 + 25, 'after All')
    assert.deepEqual(ids(unreadOnListedFile([old, before, after], {}, judge(inAt('all', T0 + 10, T0 + 20)))), [after.id])
  })
})

describe('the level change, the teams list and the reads', () => {
  it('a level change goes on the wire signed by P, for P, beside the place', () => {
    const e = buildLevelChange(BOB, (T0 + 1) * 1000 + 250, { place: TOPIC, folder: TEAM, level: 'all' })
    assert.equal(e.kind, 1851)
    assert.equal(e.pubkey, BOB)
    assert.deepEqual(e.tags, [['a', TOPIC], ['O', D], ['field', `follow:${BOB}`], ['value', 'all'], ['h', TEAM], ['ts', String((T0 + 1) * 1000 + 250)], ['p', BOB]])
    assert.throws(() => buildLevelChange(BOB, 0, { place: TOPIC, folder: TEAM, level: 'none' as 'all' }))
    assert.throws(() => buildLevelChange(BOB.toUpperCase(), 0, { place: TOPIC, folder: TEAM, level: 'all' }))
  })

  it('the teams list round-trips sorted, and drops what is not a team or a place id', () => {
    const text = serializeTeamsBlob({ teams: { [TEAM]: 5, 'not-a-team': 6 }, off: [D, D, 'has space', TEAM] }, 7)
    assert.deepEqual(parseTeamsBlob(text), { v: 1, updatedAt: 7, teams: { [TEAM]: 5 }, off: [TEAM, D].sort() })
    assert.equal(parseTeamsBlob('{"v":2,"updatedAt":1,"teams":{},"off":[]}'), undefined)
    assert.equal(parseTeamsBlob('nope'), undefined)
  })

  it('the reads for a place ask for its changes, the roster, the space marks and the teams list', () => {
    const filters = placeFilters(topicPlace, BOB)
    assert.deepEqual(filters[0], { kinds: [1851], '#a': [TOPIC] })
    assert.ok(filters.some((f) => JSON.stringify(f) === JSON.stringify({ kinds: [1852], '#a': [TOPIC] })))
    assert.ok(filters.some((f) => JSON.stringify(f) === JSON.stringify({ kinds: [30078], authors: [BOB], '#d': ['estiva:teams:v1'], limit: 1 })))
  })
})

describe('§11.8 who a place lists (TEA-6)', () => {
  const DAVE = 'd'.repeat(64)
  const EVE = 'f'.repeat(64)
  const spaceListing = [markSpace(T0 + 100), teamList(T0 + 100)]
  const rosterOf = (...people: string[]) => [roster(T0 + 60, ...people), createTeam(ALICE, T0)]

  it('a space lists who chose a level, who was added, its author and the team members at Important, All first', () => {
    const events = [root(), level(BOB, T0 + 200, 'all'), member(ALICE, T0 + 210, EVE, true)]
    const listed = placeListing(topicPlace, { events, roster: rosterOf(ALICE, CAROL), listing: spaceListing })
    assert.deepEqual(
      listed.map((l) => [l.pubkey, l.level, l.addedBy]),
      [
        [BOB, 'all', undefined],
        [ALICE, 'important', undefined],
        [CAROL, 'important', undefined],
        [EVE, 'important', ALICE],
      ],
    )
  })

  it('someone in a space only through a team they follow is not listed until they choose a level, and a forged level for them lists nobody', () => {
    const events = [root(), forgedLevel(ALICE, DAVE, T0 + 200, 'all')]
    assert.ok(!placeListing(topicPlace, { events, roster: rosterOf(ALICE), listing: spaceListing }).some((l) => l.pubkey === DAVE))
    const chose = placeListing(topicPlace, { events: [...events, level(DAVE, T0 + 300, 'important')], roster: rosterOf(ALICE), listing: spaceListing })
    assert.deepEqual(chose.find((l) => l.pubkey === DAVE)?.level, 'important')
  })

  it('the viewer who turned a space off is gone from their own list but still shown to others; one following through a team sees themselves', () => {
    const facts = { events: [root()], roster: rosterOf(ALICE, CAROL), listing: spaceListing }
    const offList = { v: 1 as const, updatedAt: 0, teams: {}, off: [D] }
    assert.ok(!placeListing(topicPlace, facts, { pubkey: CAROL, teams: offList }).some((l) => l.pubkey === CAROL))
    assert.ok(placeListing(topicPlace, facts, { pubkey: ALICE }).some((l) => l.pubkey === CAROL))
    const follower = { v: 1 as const, updatedAt: 0, teams: { [TEAM]: (T0 + 10) * 1000 }, off: [] }
    assert.ok(placeListing(topicPlace, facts, { pubkey: DAVE, teams: follower }).some((l) => l.pubkey === DAVE))
    assert.ok(!placeListing(topicPlace, facts, { pubkey: ALICE }).some((l) => l.pubkey === DAVE))
  })

  it('a topic the team leads lists no team member by default, nor anyone who left it', () => {
    const events = [root(), member(ALICE, T0 + 5, BOB, true), member(BOB, T0 + 20, BOB, false)]
    assert.deepEqual(
      placeListing(topicPlace, { events, roster: rosterOf(ALICE, CAROL) }).map((l) => l.pubkey),
      [ALICE],
    )
  })

  it("a team's chat lists its members, and an archived team's places list nobody", () => {
    const chat = { address: CHAT, team: TEAM }
    assert.deepEqual(placeListing(chat, { events: [], roster: rosterOf(ALICE, CAROL) }).map((l) => l.pubkey), [ALICE, CAROL].sort())
    assert.deepEqual(placeListing(chat, { events: [], roster: rosterOf(ALICE, CAROL), archived: true }), [])
  })
})

describe('§11.8 Add and the switch (TEA-6)', () => {
  const spaceListing = [markSpace(T0 + 100), teamList(T0 + 100)]
  const memberRoster = [roster(T0 + 60, BOB), joinTeam(BOB, T0 + 50)]
  const signed = (u: { pubkey: string; created_at: number; kind: number; tags: string[][]; content: string }) => event({ ...u })

  it('an Add after the person left names the leave with prev and, from an adder whose clock is behind, is stamped 1 ms after it so the relay takes it', () => {
    const leave = member(BOB, T0 + 20, BOB, false)
    const events = [root(), member(ALICE, T0 + 5, BOB, true), leave]
    const add = buildPlaceAdd(CAROL, (T0 + 10) * 1000, { place: topicPlace, folder: TEAM, person: BOB, events })
    const after = (T0 + 20) * 1000 + 1
    assert.equal(add.pubkey, CAROL)
    assert.equal(add.created_at, T0 + 20)
    assert.deepEqual(add.tags, [['a', TOPIC], ['O', D], ['field', `member:${BOB}`], ['value', 'true'], ['h', TEAM], ['ts', String(after)], ['prev', leave.id], ['p', BOB]])
    assert.equal(following(BOB, { events: [...events, signed(add)] }).in, true)
    const onTime = buildPlaceAdd(CAROL, (T0 + 90) * 1000, { place: topicPlace, folder: TEAM, person: BOB, events })
    assert.deepEqual(onTime.tags.find((t) => t[0] === 'ts'), ['ts', String((T0 + 90) * 1000)])
  })

  it('an Add of someone who never left carries no prev', () => {
    const add = buildPlaceAdd(ALICE, (T0 + 10) * 1000, { place: topicPlace, folder: TEAM, person: BOB, events: [root()] })
    assert.ok(!add.tags.some((t) => t[0] === 'prev'))
    assert.deepEqual(add.tags.at(-1), ['p', BOB])
  })

  it('Not following in a space reached only by the team default writes nothing public, only the private off entry', () => {
    const facts = { events: [root()], roster: memberRoster, listing: spaceListing }
    const w = switchWrites(BOB, (T0 + 300) * 1000, { place: topicPlace, folder: TEAM, choice: 'not-following', following: following(BOB, facts) })
    assert.deepEqual(w.changes, [])
    assert.deepEqual(w.off, { id: D, off: true })
    const list = withPlaceOff(undefined, w.off!)
    assert.equal(following(BOB, { ...facts, teams: { v: 1, updatedAt: 0, ...list } }).in, false)
  })

  it('Not following after an Add and a level writes P own leave, which takes P out; with a default it also turns it off', () => {
    const topicFacts = { events: [root(), member(ALICE, T0 + 5, BOB, true), level(BOB, T0 + 10, 'all')] }
    const w = switchWrites(BOB, (T0 + 300) * 1000, { place: topicPlace, folder: TEAM, choice: 'not-following', following: following(BOB, topicFacts) })
    assert.equal(w.changes.length, 1)
    assert.equal(w.changes[0].pubkey, BOB)
    assert.deepEqual(w.changes[0].tags.filter((t) => t[0] === 'field' || t[0] === 'value'), [['field', `member:${BOB}`], ['value', 'false']])
    assert.equal(w.off, undefined)
    assert.equal(following(BOB, { events: [...topicFacts.events, signed(w.changes[0])] }).in, false)

    const spaceFacts = { ...topicFacts, roster: memberRoster, listing: spaceListing }
    const both = switchWrites(BOB, (T0 + 300) * 1000, { place: topicPlace, folder: TEAM, choice: 'not-following', following: following(BOB, spaceFacts) })
    assert.equal(both.changes.length, 1)
    assert.deepEqual(both.off, { id: D, off: true })
  })

  it('Not following a topic someone else added P to, with no level chosen, writes P own leave and takes P out', () => {
    const facts = { events: [root(), member(ALICE, T0 + 5, BOB, true)] }
    const w = switchWrites(BOB, (T0 + 300) * 1000, { place: topicPlace, folder: TEAM, choice: 'not-following', following: following(BOB, facts) })
    assert.equal(w.changes.length, 1)
    assert.equal(w.changes[0].pubkey, BOB)
    assert.deepEqual(w.changes[0].tags.filter((t) => t[0] === 'field' || t[0] === 'value'), [['field', `member:${BOB}`], ['value', 'false']])
    assert.equal(following(BOB, { events: [...facts.events, signed(w.changes[0])] }).in, false)
  })

  it('Not following a space whose default reaches P and where P only chose a level clears the level and turns the default off, with no public leave', () => {
    const facts = { events: [root(), level(BOB, T0 + 200, 'all')], roster: memberRoster, listing: spaceListing }
    const w = switchWrites(BOB, (T0 + 300) * 1000, { place: topicPlace, folder: TEAM, choice: 'not-following', following: following(BOB, facts) })
    assert.deepEqual(w.changes.map((c) => c.tags.filter((t) => t[0] === 'field' || t[0] === 'value')), [[['field', `follow:${BOB}`], ['value', '']]])
    assert.deepEqual(w.off, { id: D, off: true })
    const after = { ...facts, events: [...facts.events, signed(w.changes[0])], teams: { v: 1 as const, updatedAt: 0, ...withPlaceOff(undefined, w.off!) } }
    assert.equal(following(BOB, after).in, false)
  })

  it('choosing a level writes follow:<P> and clears a mute; going back to the default empties it and turns the default back on', () => {
    const facts = { events: [root()], roster: memberRoster, listing: spaceListing, teams: teams({}, [D]) }
    const pick = switchWrites(BOB, (T0 + 300) * 1000, { place: topicPlace, folder: TEAM, choice: 'all', following: following(BOB, facts), teams: facts.teams })
    assert.deepEqual(pick.changes[0].tags.filter((t) => t[0] === 'field' || t[0] === 'value'), [['field', `follow:${BOB}`], ['value', 'all']])
    assert.equal(pick.clearsMute, true)
    const after = { ...facts, events: [...facts.events, signed(pick.changes[0])] }
    assert.equal(following(BOB, after).level, 'all')

    const back = switchWrites(BOB, (T0 + 400) * 1000, { place: topicPlace, folder: TEAM, choice: 'default', following: following(BOB, after), teams: facts.teams })
    assert.deepEqual(back.changes[0].tags.find((t) => t[0] === 'value'), ['value', ''])
    assert.deepEqual(back.off, { id: D, off: false })
    const restored = { ...after, events: [...after.events, signed(back.changes[0])], teams: { v: 1 as const, updatedAt: 0, ...withPlaceOff(facts.teams, back.off!) } }
    assert.deepEqual(brief(following(BOB, restored)), { in: true, level: 'important', since: T0 + 100 })
  })

  it('the switch shows a kept mute and a turned-off default as Not following, and offers the default back when All or off was chosen against it', () => {
    const facts = { events: [root()], roster: memberRoster, listing: spaceListing }
    assert.deepEqual(switchStateOf(topicPlace, BOB, facts), { shown: 'important', defaultReaches: true, againstDefault: false })
    assert.deepEqual(switchStateOf(topicPlace, BOB, facts, { muted: true }).shown, 'not-following')
    assert.deepEqual(switchStateOf(topicPlace, BOB, { ...facts, teams: teams({}, [D]) }), { shown: 'not-following', defaultReaches: true, againstDefault: true })
    assert.deepEqual(switchStateOf(topicPlace, BOB, { ...facts, events: [root(), level(BOB, T0 + 200, 'all')] }).againstDefault, true)
    assert.deepEqual(switchStateOf(topicPlace, BOB, { ...facts, events: [root(), level(BOB, T0 + 200, 'important')] }).againstDefault, true)
    assert.deepEqual(switchStateOf(topicPlace, CAROL, { events: [root(), level(CAROL, T0 + 200, 'all')] }), { shown: 'all', defaultReaches: false, againstDefault: false })
  })
})

describe('teamMembersOf', () => {
  it('lists who the current roster names, each since they last joined, never a follower (TEA-5)', () => {
    const rosterEvents = [roster(T0 + 400, ALICE, BOB), createTeam(ALICE, T0), joinTeam(BOB, T0 + 150), leaveTeam(BOB, T0 + 250), joinTeam(BOB, T0 + 300), joinTeam(CAROL, T0 + 100), leaveTeam(CAROL, T0 + 120)]
    assert.deepEqual(teamMembersOf(TEAM, rosterEvents), [
      { pubkey: ALICE, since: T0 },
      { pubkey: BOB, since: T0 + 300 },
    ])
  })

  it('lists nobody for a team whose roster it has not read (TEA-5)', () => {
    assert.deepEqual(teamMembersOf(TEAM, [joinTeam(BOB, T0)]), [])
  })

  it('lists only this team’s people when another team’s newer roster was read with it (TEA-5)', () => {
    const otherTeam = event({ kind: 39002, pubkey: RELAY, created_at: T0 + 500, tags: [['d', '0e5d8c1f-2b7a-4c3e-9f6d-1a2b3c4d5e6f'], ['p', CAROL]] })
    assert.deepEqual(teamMembersOf(TEAM, [roster(T0 + 400, ALICE), createTeam(ALICE, T0), otherTeam]), [{ pubkey: ALICE, since: T0 }])
  })
})

describe('§11.8 why a message is unread (ACT-3)', () => {
  const reasons = (list: SignedEvent[]) => [...unreadReasons(list, BOB).entries()].map(([id, why]) => [list.findIndex((e) => e.id === id), why])

  it('a message that meets several reasons takes the first: a mention, then a new conversation, then a reply in yours', () => {
    const startsAndNames = comment(ALICE, T0 + 10, `${mention(BOB)} have a look`)
    const mine = comment(BOB, T0 + 11, 'my question')
    const answersAndNames = reply(ALICE, mine, T0 + 12, `${mention(BOB)} here`)
    const answers = reply(CAROL, mine, T0 + 13, 'an answer')
    assert.deepEqual(reasons([startsAndNames, mine, answersAndNames, answers]), [
      [0, 'mention'],
      [1, 'new-conversation'],
      [2, 'mention'],
      [3, 'reply-in-yours'],
    ])
  })

  it('a new conversation naming nobody is a new conversation, never a plain message, whatever level lit it', () => {
    assert.deepEqual(reasons([comment(ALICE, T0 + 10, 'news')]), [[0, 'new-conversation']])
  })

  it('a reply in a conversation P is not in is a message, and becomes a reply in yours only after P wrote there', () => {
    const theirs = comment(ALICE, T0 + 10, 'their note')
    const before = reply(CAROL, theirs, T0 + 11, 'agreed')
    const mine = reply(BOB, theirs, T0 + 12, 'me too')
    const after = reply(CAROL, theirs, T0 + 13, 'thanks')
    const got = new Map(reasons([theirs, before, mine, after]) as [number, string][])
    assert.equal(got.get(1), 'message')
    assert.equal(got.get(3), 'reply-in-yours')
  })

  it('a reply answering P by its lowercase p is a reply in yours even when P’s own message is not held', () => {
    const mine = comment(BOB, T0 + 10, 'my question')
    assert.deepEqual(reasons([reply(ALICE, mine, T0 + 11, 'an answer')]), [[0, 'reply-in-yours']])
  })

  it('in a DM a message starts no conversation: it is a mention or a message, a reply included', () => {
    const first = comment(ALICE, T0 + 10, 'are you around?')
    const naming = comment(ALICE, T0 + 11, `${mention(BOB)} look`)
    const mine = comment(BOB, T0 + 12, 'yes')
    const answer = reply(ALICE, mine, T0 + 13, 'great')
    const got = [...unreadReasons([first, naming, mine, answer], BOB, { dm: true }).values()]
    assert.deepEqual(got, ['message', 'mention', 'message', 'message'])
  })
})

describe('§11.8 what lit a stream, new and seen (ACT-4)', () => {
  const allIn: Following = { kind: 'space', in: true, level: 'all', since: T0, ways: ['team'] }
  const onPlace = { stream: TOPIC, me: BOB, following: allIn }
  const read = (at: number) => ({ [`file:${D}`]: at })
  /** Each line as [index in `list`, reason, seen]. */
  const shown = (lines: LitLine<SignedEvent>[], list: SignedEvent[]) =>
    lines.map((l) => (l.type === 'message' ? [list.indexOf(l.message), l.reason, l.seen] : ['reaction']))

  it('once read, a mention of P and a reply in P conversation stay as seen lines, and a plain message leaves the list', () => {
    const plain = comment(ALICE, T0 + 10, 'looks good')
    const named = comment(CAROL, T0 + 11, `${mention(BOB)} can you look?`)
    const mine = comment(BOB, T0 + 12, 'my question')
    const toMe = reply(CAROL, mine, T0 + 13, 'an answer')
    const fresh = comment(ALICE, T0 + 20, 'new today')
    const list = [plain, named, mine, toMe, fresh]
    assert.deepEqual(shown(whatLitPlace(list, read(T0 + 15), onPlace), list), [
      [4, 'new-conversation', false],
      [3, 'reply-in-yours', true],
      [1, 'mention', true],
    ])
  })

  it('the unseen lines are exactly what is unread on the place, so the list and the dot never disagree', () => {
    const top = comment(ALICE, T0 + 10, 'new')
    const r = reply(CAROL, top, T0 + 11, 'reply')
    const named = reply(CAROL, top, T0 + 30, `${mention(BOB)} see this`)
    const important: Following = { ...allIn, level: 'important' }
    for (const following of [allIn, important]) {
      const judge = { ...onPlace, following }
      const unseen = whatLitPlace([top, r, named], read(T0 + 10), judge).filter((l) => !l.seen).map((l) => (l.type === 'message' ? l.message.id : ''))
      assert.deepEqual(unseen.sort(), unreadOnPlace([top, r, named], read(T0 + 10), judge).map((e) => e.id).sort())
    }
  })

  it('a listed file keeps a read mention of P on the place and drops a read comment naming nobody, and lists nothing when P is not in', () => {
    const ISSUE_D = '5b7c1a52-9a9e-4d0e-8f4c-2b8f2b2f6a10'
    const ISSUE = `30851:${CAROL}:${ISSUE_D}`
    const onIssue = (by: string, at: number, content = '') =>
      event({ kind: 1111, pubkey: by, created_at: at, content, tags: [['A', ISSUE], ['K', '30851'], ['P', CAROL], ['a', ISSUE], ['k', '30851'], ['p', CAROL], ['h', TEAM]] })
    const named = onIssue(ALICE, T0 + 10, `${mention(BOB)} please`)
    const plain = onIssue(ALICE, T0 + 11, 'looks good')
    const judge = { stream: `file:${ISSUE_D}`, me: BOB, following: { ...allIn, kind: 'topic' as const, allSince: T0 } }
    const merged = { [`file:${ISSUE_D}`]: T0 + 11 }
    assert.deepEqual(shown(whatLitListedFile([named, plain], merged, judge), [named, plain]), [[0, 'mention', true]])
    assert.deepEqual(whatLitListedFile([named, plain], merged, { ...judge, following: { kind: 'topic', in: false, ways: [] } }), [])
  })

  it('a DM keeps a read mention and drops a read message, and its unseen lines are what is unread in it', () => {
    const DM = 'dm-context'
    const dmMessage = (by: string, at: number, content = '') => event({ kind: 9, pubkey: by, created_at: at, content, tags: [['h', DM]] })
    const old = dmMessage(ALICE, T0 + 10, 'hi')
    const named = dmMessage(ALICE, T0 + 11, `${mention(BOB)} ping`)
    const fresh = dmMessage(ALICE, T0 + 20, 'still there?')
    const judge = { stream: DM, me: BOB, member: true }
    const merged = { [DM]: T0 + 11 }
    const list = [old, named, fresh]
    assert.deepEqual(shown(whatLitStream(list, merged, judge, { dm: true }), list), [
      [2, 'message', false],
      [1, 'mention', true],
    ])
    assert.deepEqual(unreadIn(list, merged, judge).map((e) => e.id), [fresh.id])
  })

  it('a limit keeps every new line, an older unread mention included, and bounds only the seen ones', () => {
    // The stream is read only to T0 + 2, so the mention at T0 + 5 is unread; P's own thread is read to T0 + 40, so the
    // two replies in it are seen, and newer than the unread mention.
    const mine = comment(BOB, T0 + 1, 'my question')
    const named = comment(CAROL, T0 + 5, `${mention(BOB)} still needs you`)
    const seenOne = reply(CAROL, mine, T0 + 30, 'one')
    const seenTwo = reply(CAROL, mine, T0 + 31, 'two')
    const fresh = comment(ALICE, T0 + 50, 'three')
    const list = [mine, named, seenOne, seenTwo, fresh]
    const merged = { ...read(T0 + 2), [threadContext(mine.id)!]: T0 + 40 }
    assert.deepEqual(shown(whatLitPlace(list, merged, onPlace, { limit: 3 }), list), [
      [4, 'new-conversation', false],
      [1, 'mention', false],
      [3, 'reply-in-yours', true],
    ])
  })

  it('a team list from places that list the same file gives that file one line, every new line above every seen one, and a limit keeps every new line', () => {
    const ISSUE_D = '7c1e2f30-4a5b-4c6d-8e7f-901a2b3c4d5e'
    const ISSUE = `30851:${CAROL}:${ISSUE_D}`
    const onIssue = (by: string, at: number, content = '') =>
      event({ kind: 1111, pubkey: by, created_at: at, content, tags: [['A', ISSUE], ['K', '30851'], ['P', CAROL], ['a', ISSUE], ['k', '30851'], ['p', CAROL], ['h', TEAM]] })
    // The issue: a mention of P read at T0 + 15 (seen), and a newer comment not yet read (new).
    const issueNamed = onIssue(ALICE, T0 + 10, `${mention(BOB)} please`)
    const issueFresh = onIssue(ALICE, T0 + 20, 'new on the issue')
    // The topic: a reply in P's conversation read at T0 + 40 (seen, and newer than the issue's new line), and a new comment.
    const mine = comment(BOB, T0 + 1, 'my question')
    const toMe = reply(CAROL, mine, T0 + 30, 'an answer')
    const topicFresh = comment(ALICE, T0 + 50, 'new on the topic')
    const merged = { ...read(T0 + 40), [`file:${ISSUE_D}`]: T0 + 15 }
    const issueLines = whatLitListedFile([issueNamed, issueFresh], merged, { stream: `file:${ISSUE_D}`, me: BOB, following: { ...allIn, kind: 'topic', allSince: T0 } })
    const topicLines = whatLitPlace([mine, toMe, topicFresh], merged, onPlace)
    // Place A is the topic, which lists the issue; place B lists the issue too. The team's list is the two places'.
    const placeA = mergeLitLines([topicLines, issueLines])
    const placeB = mergeLitLines([issueLines])
    const said = (lines: LitLine<SignedEvent>[]) => lines.map((l) => (l.type === 'message' ? [l.message.content, l.seen] : ['reaction']))
    assert.deepEqual(said(mergeLitLines([placeA, placeB])), [
      ['new on the topic', false],
      ['new on the issue', false],
      ['an answer', true],
      [`${mention(BOB)} please`, true],
    ])
    assert.deepEqual(said(mergeLitLines([placeA, placeB], { limit: 1 })), [
      ['new on the topic', false],
      ['new on the issue', false],
    ])
  })
})

describe('§11.8 a reaction to your message turns the place orange (ACT-7)', () => {
  const R0 = REACTIONS_TO_ME_FROM
  const inAt = (since: number): Following => ({ kind: 'topic', in: true, level: 'important', since, ways: ['level'] })
  const BY_ID = `file:${D}`
  const reaction = (id: number, at: number): ReactionToMe => ({ id: id.toString(16).padStart(64, '0'), by: ALICE, at, emoji: '👍', target: '9'.repeat(64) })
  const ids = (list: ReactionToMe[]) => list.map((r) => r.at - R0)

  it('a reaction is in its message’s conversation: a chat message’s channel, a comment’s or a reply’s file both ways', () => {
    const chat = event({ kind: 9, tags: [['h', TEAM]] })
    const top = comment(BOB, T0)
    const answer = reply(ALICE, top, T0 + 1)
    const byIdOnly = event({ kind: 1111, tags: [['O', D], ['K', '30840'], ['h', TEAM]] })
    assert.deepEqual(reactionStreamOf(chat), [TEAM])
    assert.deepEqual(reactionStreamOf(top), [TOPIC, BY_ID])
    assert.deepEqual(reactionStreamOf(answer), [TOPIC, BY_ID])
    assert.deepEqual(reactionStreamOf(byIdOnly), [BY_ID])
    assert.deepEqual(reactionStreamOf(event({ kind: 30840, tags: [['d', D]] })), [])
  })

  const reactions = [reaction(4, R0 + 400), reaction(3, R0 + 300), reaction(2, R0 + 200), reaction(1, R0 + 100)]
  const judged: [string, Record<string, number>, Parameters<typeof newReactionsIn>[2], number[]][] = [
    ['all new with no key, from P’s start', {}, { contexts: [TOPIC, BY_ID], following: inAt(R0 + 150) }, [400, 300, 200]],
    ['new only past the key, written by id and read by address', { [`reactions:${BY_ID}`]: R0 + 300 }, { contexts: [TOPIC], following: inAt(R0) }, [400]],
    ['new only past the reactions floor', { 'reactions-floor': R0 + 200 }, { contexts: [TOPIC, BY_ID], following: inAt(R0) }, [400, 300]],
    ['not cleared by opening the file, its threads or the reply floor', { [BY_ID]: R0 + 999, [TOPIC]: R0 + 999, 'reply-floor': R0 + 999 }, { contexts: [TOPIC, BY_ID], following: inAt(R0) }, [400, 300, 200, 100]],
    ['not cleared by another conversation’s key', { [`reactions:${TEAM}`]: R0 + 999 }, { contexts: [TOPIC, BY_ID], following: inAt(R0) }, [400, 300, 200, 100]],
    ['none when P is not in the place', {}, { contexts: [TOPIC], following: { kind: 'topic', in: false, ways: [] } }, []],
    ['none when P muted it', {}, { contexts: [TOPIC], following: inAt(R0), muted: true }, []],
    ['a DM from when P came in', {}, { contexts: [TEAM], following: null, since: R0 + 250 }, [400, 300]],
  ]
  for (const [name, merged, judge, want] of judged) {
    it(`new reactions: ${name}`, () => assert.deepEqual(ids(newReactionsIn(reactions, merged, judge)), want))
  }

  it('the list shows a new reaction among the new lines and a seen one under Earlier, and none from before P came in', () => {
    const merged = { [BY_ID]: R0 + 360, [`reactions:${BY_ID}`]: R0 + 300 }
    const judge = { stream: TOPIC, me: BOB, following: inAt(R0 + 150) }
    const lines = whatLitPlace([comment(ALICE, R0 + 500, 'newest')], merged, judge, { reactions })
    const said = lines.map((l) => (l.type === 'message' ? [l.message.content, l.seen] : [l.reaction.at - R0, l.seen]))
    assert.deepEqual(said, [
      ['newest', false],
      [400, false],
      [300, true],
      [200, true],
    ])
    assert.deepEqual(whatLitListedFile([], merged, { ...judge, following: { kind: 'topic', in: false, ways: [] } }, { reactions }), [])
    const dm = whatLitStream([], { [`reactions:${TEAM}`]: R0 + 300 }, { stream: TEAM, me: BOB, member: true, since: R0 }, { reactions })
    assert.deepEqual(dm.map((l) => l.seen), [false, true, true, true])
    assert.deepEqual(whatLitStream([], {}, { stream: TEAM, me: BOB, member: false }, { reactions }), [])
  })

  it('seeing them writes the newest shown reaction per conversation, under file:<d> for a file and the uuid for a chat', () => {
    const writes = reactionsSeenWrites([
      { reaction: reaction(1, R0 + 100), contexts: [TOPIC, BY_ID] },
      { reaction: reaction(2, R0 + 300), contexts: [TOPIC] },
      { reaction: reaction(3, R0 + 200), contexts: [TEAM] },
      { reaction: reaction(4, R0 + 50), contexts: [`30851:${CAROL}:not-an-id`] },
    ], (R0 + 1000) * 1000)
    assert.deepEqual(writes, [
      { context: `reactions:${BY_ID}`, atMs: (R0 + 300) * 1000 },
      { context: `reactions:${TEAM}`, atMs: (R0 + 200) * 1000 },
      { context: `reactions:30851:${CAROL}:not-an-id`, atMs: (R0 + 50) * 1000 },
    ])
  })

  it('a reaction dated ahead of the clock is written as seen only up to now, so a later one still turns the place orange', () => {
    const nowMs = (R0 + 100) * 1000
    assert.deepEqual(reactionsSeenWrites([{ reaction: reaction(1, R0 + 5000), contexts: [TEAM] }], nowMs), [{ context: `reactions:${TEAM}`, atMs: nowMs }])
  })
})

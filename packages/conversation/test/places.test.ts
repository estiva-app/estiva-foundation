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
  followingOf,
  foldMemberships,
  membershipJudges,
  membershipOf,
  parseTeamsBlob,
  placeFilters,
  serializeTeamsBlob,
  unreadOnPlace,
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

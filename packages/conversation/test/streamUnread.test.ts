/*
  A list row's dot — SPEC §11.8 over a stream's bodiless messages, and the
  membership read it is gated by. Moved with the code from Peek (SHIPS-2).
*/
import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { encodeNpub, type SignedEvent } from '@estiva-app/protocol'
import {
  authorOfAddress,
  foldMemberships,
  membershipJudges,
  membershipQueries,
  streamHasUnread,
  streamTermsOf,
  type StreamMessage,
} from '../dist/index.js'

const ME = 'c'.repeat(64)
const THEM = 'd'.repeat(64)
const FOLDER = '11111111-1111-4111-8111-111111111111'
const FILE = `30851:${'b'.repeat(64)}:file`
const THEIRS = `30851:${THEM}:theirs`
const MINE = `30851:${ME}:mine`
const NOW = 1_800_000_000
const DAY = 24 * 60 * 60
const HORIZON = 90 * DAY

const said = (id: string, at: number, by = THEM, root = id): StreamMessage => ({ id, at, by, root })
const frontier = (merged: Record<string, number> = {}) => ({ merged, me: ME, nowSeconds: NOW, horizonSeconds: HORIZON })
const never = () => false

describe('streamHasUnread — SPEC §11.8 over a list’s message projection', () => {
  it('lights for a member when somebody else said something newer than the marker', () => {
    const terms = { member: true, muted: false }
    assert.equal(streamHasUnread([said('m', NOW - 10)], FILE, terms, frontier({ [FILE]: NOW - 20 }), never), true)
    assert.equal(streamHasUnread([said('m', NOW - 10)], FILE, terms, frontier({ [FILE]: NOW }), never), false)
  })

  it('a message by the viewer’s own agent lights no dot for them, and does for another member (PEE-79)', () => {
    const terms = { member: true, muted: false }
    const agentSaid = [said('m', NOW - 10, THEM)]
    assert.equal(streamHasUnread(agentSaid, FILE, terms, { ...frontier(), mine: new Set([THEM]) }, never), false)
    assert.equal(streamHasUnread(agentSaid, FILE, terms, frontier(), never), true)
  })

  it('reading the file’s marker puts the dot out', () => {
    const terms = { member: true, muted: false }
    const messages = [said('m', NOW - 10)]
    assert.equal(streamHasUnread(messages, FILE, terms, frontier(), never), true)
    assert.equal(streamHasUnread(messages, FILE, terms, frontier({ [FILE]: NOW - 10 }), never), false)
  })

  it('never lights for a person who is not a member', () => {
    assert.equal(streamHasUnread([said('m', NOW - 10)], FILE, { member: false, muted: false }, frontier(), never), false)
  })

  it('counts only what was said from the second the person joined', () => {
    const terms = { member: true, since: NOW - 50, muted: false }
    assert.equal(streamHasUnread([said('old', NOW - 60)], FILE, terms, frontier(), never), false)
    assert.equal(streamHasUnread([said('at', NOW - 50)], FILE, terms, frontier(), never), true)
  })

  it('never counts the viewer’s own message', () => {
    assert.equal(streamHasUnread([said('m', NOW - 10, ME)], FILE, { member: true, muted: false }, frontier(), never), false)
  })

  it('lets a mention through a mute and through a missing membership, and nothing else', () => {
    const messages = [said('quiet', NOW - 20), said('named', NOW - 10)]
    const mentioned = (id: string) => id === 'named'
    assert.equal(streamHasUnread([messages[0]], FILE, { member: true, muted: true }, frontier(), mentioned), false)
    assert.equal(streamHasUnread(messages, FILE, { member: true, muted: true }, frontier(), mentioned), true)
    assert.equal(streamHasUnread(messages, FILE, { member: false, muted: false }, frontier(), mentioned), true)
  })

  it('judges a reply against its thread’s marker as well as the stream’s', () => {
    const terms = { member: true, muted: false }
    const root = 'a'.repeat(64)
    const thread = [said(root, NOW - 100), said('reply', NOW - 10, THEM, root)]
    assert.equal(streamHasUnread(thread, FILE, terms, frontier({ [FILE]: NOW - 100 }), never), true)
    assert.equal(streamHasUnread(thread, FILE, terms, frontier({ [FILE]: NOW - 100, [`thread:${root}`]: NOW }), never), false)
  })

  it('lights nothing without a viewer', () => {
    const terms = { member: true, muted: false }
    assert.equal(streamHasUnread([said('m', NOW - 10)], FILE, terms, { ...frontier(), me: undefined }, never), false)
  })
})

let n = 0
const event = (over: Partial<SignedEvent> & Pick<SignedEvent, 'kind' | 'pubkey'>): SignedEvent => ({
  id: `e${++n}`.padEnd(64, '0'),
  created_at: NOW - 1000,
  tags: [],
  content: '',
  sig: '',
  ...over,
})
const comment = (file: string, pubkey: string, over: Partial<SignedEvent> = {}) =>
  event({ kind: 1111, pubkey, tags: [['A', file], ['a', file]], ...over })
const change = (file: string, field: string, value: string, pubkey: string, p: string, at = NOW - 1000) =>
  event({
    kind: 1851,
    pubkey,
    created_at: at,
    tags: [['a', file], ['field', field], ['value', value], ['h', FOLDER], ['ts', String(at * 1000)], ['p', p]],
  })

describe('membershipQueries — the three filters, bounded by the horizon', () => {
  it('asks for the changes that name the viewer, what they wrote, and what mentions them, from 90 days back', () => {
    const filters = membershipQueries(ME, NOW)
    assert.equal(filters.length, 3)
    assert.deepEqual(filters[0], { kinds: [1851], '#p': [ME], since: NOW - HORIZON, limit: 1000 })
    assert.deepEqual(filters[1].authors, [ME])
    assert.deepEqual(filters[2]['#p'], [ME])
  })
})

describe('foldMemberships — SPEC §11.8 over what the relay returned', () => {
  it('a comment of the viewer’s makes them a member from that second', () => {
    const { files } = foldMemberships(ME, [comment(THEIRS, ME, { created_at: NOW - 500 })], NOW)
    assert.deepEqual(files.get(THEIRS), { member: true, since: NOW - 500 })
  })

  it('a placement carrying the viewer’s p makes them a member, and one without does not', () => {
    const placed = change(THEIRS, 'assignee', ME, THEM, ME)
    const unplaced = event({ kind: 1851, pubkey: THEM, tags: [['a', `30851:${THEM}:other`], ['field', 'assignee'], ['value', ME]] })
    const { files } = foldMemberships(ME, [placed, unplaced], NOW)
    assert.equal(files.get(THEIRS)?.member, true)
    assert.equal(files.get(`30851:${THEM}:other`)?.member, false)
  })

  it('being added by somebody else counts, and leaving is the viewer’s own', () => {
    const added = change(THEIRS, `member:${ME}`, 'true', THEM, ME, NOW - 300)
    const leftByThem = change(THEIRS, `member:${ME}`, 'false', THEM, ME, NOW - 200)
    assert.equal(foldMemberships(ME, [added, leftByThem], NOW).files.get(THEIRS)?.member, true)
    const leftByMe = change(THEIRS, `member:${ME}`, 'false', ME, ME, NOW - 200)
    assert.deepEqual(foldMemberships(ME, [added, leftByMe], NOW).files.get(THEIRS), { member: false })
  })

  it('a comment that only tags the viewer is not a mention, and one that names them is', () => {
    const tagged = comment(THEIRS, THEM, { tags: [['A', THEIRS], ['p', ME]], content: 'hello' })
    const named = comment(THEIRS, THEM, { tags: [['A', THEIRS], ['p', ME]], content: `hi nostr:${encodeNpub(ME)}` })
    assert.ok(!foldMemberships(ME, [tagged], NOW).files.get(THEIRS)?.member)
    const read = foldMemberships(ME, [tagged, named], NOW)
    assert.equal(read.files.get(THEIRS)?.member, true)
    assert.deepEqual(read.mentioned, new Set([named.id]))
  })

  it('a file the viewer created is theirs, from the horizon, unless they left it', () => {
    const talk = comment(MINE, THEM, { tags: [['A', MINE], ['p', ME]] })
    assert.deepEqual(foldMemberships(ME, [talk], NOW).files.get(MINE), { member: true, since: NOW - HORIZON })
    const left = change(MINE, `member:${ME}`, 'false', ME, ME)
    assert.deepEqual(foldMemberships(ME, [talk, left], NOW).files.get(MINE), { member: false })
  })
})

describe('streamTermsOf — what a stream is judged on', () => {
  const read = foldMemberships(ME, [comment(THEIRS, ME, { created_at: NOW - 500 })], NOW)

  it('a file is the fold’s, with its join time, and muted when the muted set names it', () => {
    assert.deepEqual(streamTermsOf(THEIRS, read, ME, new Set()), { member: true, since: NOW - 500, muted: false })
    assert.deepEqual(streamTermsOf(THEIRS, read, ME, new Set([THEIRS])), { member: true, since: NOW - 500, muted: true })
  })

  it('a file the viewer joined and then left is not theirs, and its new talk lights nothing', () => {
    const joined = change(THEIRS, `member:${ME}`, 'true', THEM, ME, NOW - 300)
    const left = change(THEIRS, `member:${ME}`, 'false', ME, ME, NOW - 200)
    const after = foldMemberships(ME, [joined, left], NOW)
    const terms = streamTermsOf(THEIRS, after, ME, new Set())
    assert.equal(terms.member, false)
    assert.equal(streamHasUnread([said('later', NOW - 10)], THEIRS, terms, frontier(), never), false)
  })

  it('a file the viewer created and the read holds nothing about is theirs from the horizon', () => {
    assert.deepEqual(streamTermsOf(MINE, read, ME, new Set()), { member: true, since: NOW - HORIZON, muted: false })
  })

  it('a file somebody else created with nothing in the read is not the viewer’s, and the read has no word on it', () => {
    const other = `30840:${THEM}:quiet`
    assert.deepEqual(streamTermsOf(other, read, ME, new Set()), { member: false, muted: false })
    assert.equal(membershipJudges(other, read, ME), false)
    assert.equal(membershipJudges(THEIRS, read, ME), true)
    assert.equal(membershipJudges(MINE, read, ME), true)
  })

  it('a Folder’s own chat has no members', () => {
    assert.deepEqual(streamTermsOf(FOLDER, read, ME, new Set()), { member: false, muted: false })
    assert.equal(authorOfAddress(FOLDER), undefined)
    assert.equal(authorOfAddress(MINE), ME)
  })
})

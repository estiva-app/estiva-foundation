/*
  Every topic, read once (SHIPS-2): what each lists, whether it is archived
  (its own, or with its parent), whether it is the viewer's, what Add to topic
  offers, and each topic's conversations and dot as Peek's Topics shows them.
*/
import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { addableTopics, planListInTopic, readTopics, topicConversations } from '../dist/index.js'
import { buildComment, buildLevelChange, buildMembershipChange, buildReply, memberField, THREAD_RULE_FROM } from '@estiva-app/conversation'
import { encodeNpub, type SignedEvent, type UnsignedEvent } from '@estiva-app/protocol'

const ME = 'a'.repeat(64)
const THEM = 'b'.repeat(64)
const FOLDER = '7b32200c-e4c0-4216-b79a-8490fc05e0bd'
const OTHER_FOLDER = '0e2f4c1a-5b6d-4e7f-8a9b-0c1d2e3f4a5b'
const NOW = 1_793_700_000
const DAY = 24 * 60 * 60

let seq = 0
const signed = (event: UnsignedEvent): SignedEvent => ({ ...event, id: (++seq).toString(16).padStart(64, '0'), sig: '' })

const topicOf = (pubkey: string, d: string, title: string, folder = FOLDER, parent?: string) => ({
  address: `30840:${pubkey}:${d}`,
  root: signed({
    pubkey,
    created_at: NOW - 300 * DAY,
    kind: 30840,
    tags: [['d', d], ['title', title], ['h', folder], ...(parent ? [['a', parent]] : [])],
    content: '',
  }),
})
const archive = (topic: { address: string }, folder = FOLDER) =>
  signed({
    pubkey: topic.address.split(':')[1],
    created_at: NOW - 20 * DAY,
    kind: 1851,
    tags: [['a', topic.address], ['O', topic.address.split(':')[2]], ['field', 'archived'], ['value', 'true'], ['h', folder]],
    content: '',
  })
const comment = (by: string, topic: { address: string }, at: number) =>
  signed(buildComment(by, at * 1000, { about: topic.address, folder: FOLDER, body: 'hello' }))
const reply = (by: string, root: SignedEvent, at: number) =>
  signed(buildReply(by, at * 1000, { comment: { anchor: root.tags.find((t) => t[0] === 'A')![1], id: root.id, author: root.pubkey }, folder: FOLDER, body: 'yes' }))
const level = (topic: { address: string }, value: 'all' | 'important' | '', at: number) =>
  signed(buildLevelChange(ME, at * 1000, { place: topic.address, folder: FOLDER, level: value }))
const added = (topic: { address: string }, by: string, at: number) =>
  signed(buildMembershipChange(by, at * 1000, { file: topic.address, folder: FOLDER, person: ME, member: true }))
/** A comment naming the viewer, as a composer writes it: the npub in the body and a `p` tag. */
const naming = (by: string, topic: { address: string }, at: number) => {
  const event = buildComment(by, at * 1000, { about: topic.address, folder: FOLDER, body: `look, nostr:${encodeNpub(ME)}` })
  return signed({ ...event, tags: [...event.tags, ['p', ME]] })
}
const leave = (topic: { address: string }, at: number) =>
  signed({
    pubkey: ME,
    created_at: at,
    kind: 1851,
    tags: [['a', topic.address], ['field', memberField(ME)], ['value', 'false'], ['h', FOLDER], ['ts', String(at * 1000)], ['p', ME]],
    content: '',
  })

type Filter = { ids?: string[]; kinds?: number[]; authors?: string[]; since?: number } & Record<string, unknown>

/** A relay answering NIP-01 filters, `since` included, and remembering what it was asked. */
function relay(events: SignedEvent[]) {
  const asked: Filter[] = []
  const matches = (e: SignedEvent, filter: Filter) => {
    if (filter.ids && !filter.ids.includes(e.id)) return false
    if (filter.kinds && !filter.kinds.includes(e.kind)) return false
    if (filter.authors && !filter.authors.includes(e.pubkey)) return false
    if (filter.since !== undefined && e.created_at < filter.since) return false
    for (const [key, values] of Object.entries(filter)) {
      if (!key.startsWith('#')) continue
      const held = e.tags.filter((t) => t[0] === key.slice(1)).map((t) => t[1])
      if (!held.some((v) => (values as string[]).includes(v))) return false
    }
    return true
  }
  const query = async (filters: Record<string, unknown>[]) => {
    asked.push(...(filters as Filter[]))
    return events.filter((e) => filters.some((f) => matches(e, f as Filter)))
  }
  return { query, asked }
}

// Mine; one I wrote in long before the horizon; one I wrote in, then left; one I never touched; one in a Folder I am not in.
const alpha = topicOf(ME, 'alpha', 'Alpha')
const bravo = topicOf(THEM, 'bravo', 'Bravo')
const charlie = topicOf(THEM, 'charlie', 'Charlie')
const delta = topicOf(THEM, 'delta', 'Delta')
const echo = topicOf(ME, 'echo', 'Echo', OTHER_FOLDER)
// Archived itself; and one archived with the topic it sits under.
const foxtrot = topicOf(ME, 'foxtrot', 'Foxtrot')
const golf = topicOf(THEM, 'golf', 'Golf')
const hotel = topicOf(ME, 'hotel', 'Hotel', FOLDER, golf.address)
const topics = [alpha, bravo, charlie, delta, echo, foxtrot, golf, hotel]

const doc = signed({ pubkey: THEM, created_at: NOW - 30 * DAY, kind: 30842, tags: [['d', 'doc'], ['title', 'Plan'], ['h', OTHER_FOLDER]], content: '' })
const listed = signed(planListInTopic(ME, (NOW - 5 * DAY) * 1000, { topic: { address: alpha.address, folder: FOLDER }, file: 'doc' })[0])

const world = [
  ...topics.map((t) => t.root),
  archive(foxtrot),
  archive(golf),
  doc,
  listed,
  comment(ME, bravo, NOW - 200 * DAY),
  comment(ME, charlie, NOW - 200 * DAY),
  leave(charlie, NOW - 10 * DAY),
]

describe('readTopics — every topic the viewer can read, once', () => {
  it('reads each topic’s list, Folder and archive, its own or with its parent', async () => {
    const read = await readTopics(relay(world).query, ME, { nowSeconds: NOW })
    const by = new Map(read.topics.map((t) => [t.address, t]))
    assert.equal(by.size, topics.length)
    assert.deepEqual(by.get(alpha.address)!.listed.map((f) => f.address), [`30842:${THEM}:doc`])
    assert.equal(by.get(echo.address)!.folder, OTHER_FOLDER)
    assert.equal(by.get(alpha.address)!.object.archived, undefined)
    assert.ok(by.get(foxtrot.address)!.object.archived)
    assert.equal(by.get(hotel.address)!.object.archived?.with, golf.address)
  })

  it('says whose a topic is by the shared fold: made it, chose a level or was added, and never by writing in it', async () => {
    const read = await readTopics(relay(world).query, ME, { nowSeconds: NOW })
    const yours = read.topics.filter((t) => t.yours).map((t) => t.object.slots.title?.value).sort()
    // Bravo and Charlie: only written in, long ago (record writing-in-a-place-never-follows-it).
    assert.deepEqual(yours, ['Alpha', 'Echo', 'Foxtrot', 'Hotel'])
    const chose = await readTopics(relay([...world, level(bravo, 'all', NOW - 400 * DAY), added(delta, THEM, NOW - 3 * DAY)]).query, ME, { nowSeconds: NOW })
    const by = new Map(chose.topics.map((t) => [t.address, t]))
    // A level chosen before the horizon still holds; someone else's Add puts the viewer in at Important.
    assert.deepEqual([by.get(bravo.address)!.following.level, by.get(bravo.address)!.yours], ['all', true])
    assert.deepEqual([by.get(delta.address)!.following.level, by.get(delta.address)!.following.addedBy], ['important', THEM])
  })

  it('takes a topic off the viewer’s when they leave it, and gives it back when they choose a level after', async () => {
    const left = await readTopics(relay([...world, level(bravo, 'all', NOW - 5 * DAY), leave(bravo, NOW - 2 * DAY)]).query, ME, { nowSeconds: NOW })
    assert.equal(left.topics.find((t) => t.address === bravo.address)!.yours, false)
    const back = await readTopics(relay([...world, leave(bravo, NOW - 2 * DAY), level(bravo, 'important', NOW - DAY)]).query, ME, { nowSeconds: NOW })
    const again = back.topics.find((t) => t.address === bravo.address)!
    assert.equal(again.yours, true)
    assert.equal(again.following?.since, NOW - DAY)
  })

  it('marks a topic a space only where a team’s list gives its entry the role, by address or by id', async () => {
    const teamList = (folder: string, tags: string[][]) =>
      signed({ pubkey: 'c'.repeat(64), created_at: NOW - DAY, kind: 30890, tags: [['d', folder], ...tags], content: '' })
    const lists = [
      teamList(FOLDER, [['a', bravo.address, '', 'space'], ['a', charlie.address]]),
      // A list naming its topic only by id: found only by reading the lists by `#o`.
      teamList('7e3f4a5b-6c7d-4e8f-9a0b-1c2d3e4f5a6b', [['o', 'delta', '', 'space']]),
      // A relay hint in the third place, with or without the role, and an unknown role leave the entry a plain listing.
      teamList(OTHER_FOLDER, [['a', echo.address, 'wss://relay.example', 'space'], ['a', alpha.address, '', 'pinned']]),
      // Left on a second list without the role, as a move that failed halfway would: not a space.
      teamList('5c1d2e3f-4a5b-4c6d-8e7f-9a0b1c2d3e4f', [['a', foxtrot.address, '', 'space']]),
      teamList('6d2e3f4a-5b6c-4d7e-8f9a-0b1c2d3e4f5a', [['a', foxtrot.address]]),
    ]
    const read = await readTopics(relay([...world, ...lists]).query, ME, { nowSeconds: NOW })
    const spaces = read.topics.filter((t) => t.space).map((t) => t.object.slots.title?.value).sort()
    assert.deepEqual(spaces, ['Bravo', 'Delta'])
  })
})

describe('addableTopics — what Add to topic offers', () => {
  it('offers the open topics in the viewer’s Folders, theirs first, each A–Z, and no archived one', async () => {
    const read = await readTopics(relay(world).query, ME, { nowSeconds: NOW })
    const { yours, others } = addableTopics(read, new Set([FOLDER]))
    assert.deepEqual(yours.map((t) => t.object.slots.title?.value), ['Alpha'])
    assert.deepEqual(others.map((t) => t.object.slots.title?.value), ['Bravo', 'Charlie', 'Delta'])
  })
})

describe('topicConversations — each topic’s conversations and Peek’s dot', () => {
  const first = comment(THEM, alpha, NOW - 1000)
  const second = comment(THEM, alpha, NOW - 500)
  const talk = [first, second, comment(THEM, delta, NOW - 100)]
  const merged = { [alpha.address]: NOW - 200, 'reply-floor': NOW - 300 }

  it('counts each topic’s comments, not their replies, and lights no dot when everything is read', async () => {
    const { query } = relay([...world, ...talk, reply(ME, first, NOW - 50)])
    const read = await readTopics(query, ME, { nowSeconds: NOW })
    const out = await topicConversations(read, query, { merged, muted: new Set(), nowSeconds: NOW })
    assert.deepEqual(out.get(alpha.address), { conversations: 2, unread: false, fresh: 0 })
    assert.deepEqual(out.get(bravo.address), { conversations: 1, unread: false, fresh: 0 })
  })

  it('says how many of a topic’s conversations are new: each thread judged alone, a read one not counted', async () => {
    const third = comment(THEM, alpha, NOW - 150)
    const { query } = relay([...world, ...talk, third, reply(ME, first, NOW - 120), reply(THEM, first, NOW - 100), reply(THEM, first, NOW - 90)])
    const read = await readTopics(query, ME, { nowSeconds: NOW })
    // `first` has two new replies and `third` is new itself: two conversations, not three messages.
    assert.deepEqual(await topicConversations(read, query, { merged, muted: new Set(), nowSeconds: NOW }).then((out) => out.get(alpha.address)), { conversations: 3, unread: true, fresh: 2 })
    const firstRead = { ...merged, [`thread:${first.id}`]: NOW }
    assert.deepEqual(await topicConversations(read, query, { merged: firstRead, muted: new Set(), nowSeconds: NOW }).then((out) => out.get(alpha.address)), { conversations: 3, unread: true, fresh: 1 })
  })
  it('lights a topic of the viewer’s for a new reply in a conversation they wrote in, until its thread is read', async () => {
    const { query } = relay([...world, ...talk, reply(ME, first, NOW - 400), reply(THEM, first, NOW - 100)])
    const read = await readTopics(query, ME, { nowSeconds: NOW })
    assert.equal((await topicConversations(read, query, { merged, muted: new Set(), nowSeconds: NOW })).get(alpha.address)?.unread, true)
    const threadRead = { ...merged, [`thread:${first.id}`]: NOW }
    assert.equal((await topicConversations(read, query, { merged: threadRead, muted: new Set(), nowSeconds: NOW })).get(alpha.address)?.unread, false)
  })

  it('does not put the viewer in a thread of one topic by a comment on another that names that thread as its root', async () => {
    const mine = comment(ME, delta, NOW - 400)
    // Filed on Delta, its `E` naming Alpha's `first`: it says nothing about Alpha's thread.
    const stray = signed({ ...mine, tags: [...mine.tags.filter((t) => t[0] !== 'E' && t[0] !== 'e'), ['E', first.id]] })
    const { query } = relay([...world, ...talk, stray, reply(THEM, first, NOW - 100)])
    const read = await readTopics(query, ME, { nowSeconds: NOW })
    assert.equal((await topicConversations(read, query, { merged, muted: new Set(), nowSeconds: NOW })).get(alpha.address)?.unread, false)
  })

  it('at Important lights no reply in a conversation the viewer is not in; at All, one since they chose it', async () => {
    const before = reply(THEM, first, NOW - 150)
    const after = reply(THEM, first, NOW - 100)
    const important = relay([...world, ...talk, before, after])
    const read = await readTopics(important.query, ME, { nowSeconds: NOW })
    assert.equal((await topicConversations(read, important.query, { merged, muted: new Set(), nowSeconds: NOW })).get(alpha.address)?.unread, false)
    const all = relay([...world, ...talk, before, after, level(alpha, 'all', NOW - 120)])
    const atAll = await readTopics(all.query, ME, { nowSeconds: NOW })
    assert.deepEqual((await topicConversations(atAll, all.query, { merged, muted: new Set(), nowSeconds: NOW })).get(alpha.address), { conversations: 2, unread: true, fresh: 1 })
    // Only the reply before All: nothing lights.
    const early = relay([...world, ...talk, before, level(alpha, 'all', NOW - 120)])
    const earlyRead = await readTopics(early.query, ME, { nowSeconds: NOW })
    assert.equal((await topicConversations(earlyRead, early.query, { merged, muted: new Set(), nowSeconds: NOW })).get(alpha.address)?.unread, false)
  })

  it('lights no new conversation once the viewer left a topic they had set to All', async () => {
    const { query } = relay([...world, level(delta, 'all', NOW - 2 * DAY), leave(delta, NOW - DAY), comment(THEM, delta, NOW - 100)])
    const read = await readTopics(query, ME, { nowSeconds: NOW })
    assert.equal((await topicConversations(read, query, { merged: {}, muted: new Set(), nowSeconds: NOW })).get(delta.address)?.unread, false)
    const stayed = relay([...world, level(delta, 'all', NOW - 2 * DAY), comment(THEM, delta, NOW - 100)])
    const stayedRead = await readTopics(stayed.query, ME, { nowSeconds: NOW })
    assert.equal((await topicConversations(stayedRead, stayed.query, { merged: {}, muted: new Set(), nowSeconds: NOW })).get(delta.address)?.unread, true)
  })

  it('lights a mention of the viewer on a topic they are not in, a reply naming them too, until read', async () => {
    const root = comment(THEM, delta, NOW - 1000)
    const replyNaming = signed({ ...reply(THEM, root, NOW - 100), content: `you, nostr:${encodeNpub(ME)}`, tags: [...reply(THEM, root, NOW - 100).tags, ['p', ME]] })
    const { query, asked } = relay([...world, root, replyNaming])
    const read = await readTopics(query, ME, { nowSeconds: NOW })
    asked.length = 0
    const out = await topicConversations(read, query, { merged: {}, muted: new Set(), nowSeconds: NOW })
    assert.deepEqual(out.get(delta.address), { conversations: 1, unread: true, fresh: 1 })
    assert.ok(asked.some((f) => '#A' in f && (f['#A'] as string[]).includes(delta.address)))
    const named = relay([...world, naming(THEM, charlie, NOW - 100)])
    const namedRead = await readTopics(named.query, ME, { nowSeconds: NOW })
    const lit = await topicConversations(namedRead, named.query, { merged: {}, muted: new Set(), nowSeconds: NOW })
    assert.equal(lit.get(charlie.address)?.unread, true)
    const seen = await topicConversations(namedRead, named.query, { merged: { [charlie.address]: NOW }, muted: new Set(), nowSeconds: NOW })
    assert.equal(seen.get(charlie.address)?.unread, false)
  })

  it('lights nothing on a topic that is not the viewer’s, or that they muted, however new its talk', async () => {
    const { query } = relay([...world, ...talk, reply(THEM, first, NOW - 100)])
    const read = await readTopics(query, ME, { nowSeconds: NOW })
    const out = await topicConversations(read, query, { merged, muted: new Set([alpha.address]), nowSeconds: NOW })
    assert.deepEqual(out.get(delta.address), { conversations: 1, unread: false, fresh: 0 })
    assert.equal(out.get(alpha.address)?.unread, false)
  })

  it('lights nothing on an archived topic of the viewer’s, however new its talk', async () => {
    const { query } = relay([...world, ...talk, comment(THEM, foxtrot, NOW - 100)])
    const read = await readTopics(query, ME, { nowSeconds: NOW })
    const out = await topicConversations(read, query, { merged, muted: new Set(), nowSeconds: NOW })
    assert.deepEqual(out.get(foxtrot.address), { conversations: 1, unread: false, fresh: 0 })
  })

  it('asks for replies only on the viewer’s open topics, from the reply floor or the thread rule’s cut-over', async () => {
    const { query, asked } = relay([...world, ...talk])
    const read = await readTopics(query, ME, { nowSeconds: NOW })
    asked.length = 0
    await topicConversations(read, query, { merged, muted: new Set(), nowSeconds: NOW })
    const replies = asked.filter((f) => '#A' in f && !('authors' in f))
    assert.deepEqual(replies.map((f) => (f['#A'] as string[])[0]).sort(), [alpha.address, echo.address].sort())
    assert.ok(replies.every((f) => f.since === NOW - 300))
    const noFloor = relay([...world, ...talk])
    const again = await readTopics(noFloor.query, ME, { nowSeconds: NOW })
    noFloor.asked.length = 0
    await topicConversations(again, noFloor.query, { merged: {}, muted: new Set(), nowSeconds: NOW })
    const since = noFloor.asked.find((f) => '#A' in f && (f['#A'] as string[])[0] === alpha.address)?.since
    assert.equal(since, THREAD_RULE_FROM)
  })
})

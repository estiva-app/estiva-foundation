/*
  Every topic, read once (SHIPS-2): what each lists, whether it is archived
  (its own, or with its parent), whether it is the viewer's, what Add to topic
  offers, and each topic's conversations and dot as Peek's Topics shows them.
*/
import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { addableTopics, planListInTopic, readTopics, topicConversations } from '../dist/index.js'
import { buildComment, buildReply, memberField, THREAD_RULE_FROM } from '@estiva-app/conversation'
import type { SignedEvent, UnsignedEvent } from '@estiva-app/protocol'

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

  it('says whose a topic is: created, or joined before the horizon with nothing since, and not after a leave', async () => {
    const read = await readTopics(relay(world).query, ME, { nowSeconds: NOW })
    const yours = read.topics.filter((t) => t.yours).map((t) => t.object.slots.title?.value).sort()
    assert.deepEqual(yours, ['Alpha', 'Bravo', 'Echo', 'Foxtrot', 'Hotel'])
  })

  it('marks a topic a space only where a team’s list gives its entry the role, by address or by id', async () => {
    const teamList = (folder: string, tags: string[][]) =>
      signed({ pubkey: 'c'.repeat(64), created_at: NOW - DAY, kind: 30890, tags: [['d', folder], ...tags], content: '' })
    const lists = [
      teamList(FOLDER, [['a', bravo.address, '', 'space'], ['a', charlie.address], ['o', 'delta', '', 'space']]),
      // A relay hint in the third place and an unknown role leave the entry a plain listing.
      teamList(OTHER_FOLDER, [['a', echo.address, 'wss://relay.example'], ['a', alpha.address, '', 'pinned']]),
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
    assert.deepEqual(yours.map((t) => t.object.slots.title?.value), ['Alpha', 'Bravo'])
    assert.deepEqual(others.map((t) => t.object.slots.title?.value), ['Charlie', 'Delta'])
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
    assert.deepEqual(out.get(alpha.address), { conversations: 2, unread: false })
    assert.deepEqual(out.get(bravo.address), { conversations: 1, unread: false })
  })

  it('lights a topic of the viewer’s for a new reply until its thread is read', async () => {
    const { query } = relay([...world, ...talk, reply(THEM, first, NOW - 100)])
    const read = await readTopics(query, ME, { nowSeconds: NOW })
    assert.equal((await topicConversations(read, query, { merged, muted: new Set(), nowSeconds: NOW })).get(alpha.address)?.unread, true)
    const threadRead = { ...merged, [`thread:${first.id}`]: NOW }
    assert.equal((await topicConversations(read, query, { merged: threadRead, muted: new Set(), nowSeconds: NOW })).get(alpha.address)?.unread, false)
  })

  it('lights nothing on a topic that is not the viewer’s, or that they muted, however new its talk', async () => {
    const { query } = relay([...world, ...talk, reply(THEM, first, NOW - 100)])
    const read = await readTopics(query, ME, { nowSeconds: NOW })
    const out = await topicConversations(read, query, { merged, muted: new Set([alpha.address]), nowSeconds: NOW })
    assert.deepEqual(out.get(delta.address), { conversations: 1, unread: false })
    assert.equal(out.get(alpha.address)?.unread, false)
  })

  it('asks for replies only on the viewer’s open topics, from the reply floor or the thread rule’s cut-over', async () => {
    const { query, asked } = relay([...world, ...talk])
    const read = await readTopics(query, ME, { nowSeconds: NOW })
    asked.length = 0
    await topicConversations(read, query, { merged, muted: new Set(), nowSeconds: NOW })
    const replies = asked.filter((f) => '#A' in f && !('authors' in f))
    assert.deepEqual(replies.map((f) => (f['#A'] as string[])[0]).sort(), [alpha.address, bravo.address, echo.address].sort())
    assert.ok(replies.every((f) => f.since === NOW - 300))
    const noFloor = relay([...world, ...talk])
    const again = await readTopics(noFloor.query, ME, { nowSeconds: NOW })
    noFloor.asked.length = 0
    await topicConversations(again, noFloor.query, { merged: {}, muted: new Set(), nowSeconds: NOW })
    const since = noFloor.asked.find((f) => '#A' in f && (f['#A'] as string[])[0] === bravo.address)?.since
    assert.equal(since, THREAD_RULE_FROM)
  })
})

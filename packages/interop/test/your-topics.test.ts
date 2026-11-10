/*
  Your topics, lean (ALO-17): the topics the viewer is in, not archived (their
  own or with a parent), not muted and not a space, newest activity first —
  read in a few requests where every topic and the viewer's whole part in each
  take twenty.

  The claim under test: readYourTopics answers what readTopics, the filter
  every app applies to it and readTopicActivity answer together, on the same
  relay, with and without the list read — the same topics, how the viewer is
  in each, each list, each archive and the order — and it asks one request a
  round, a list read always alone.
*/
import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import {
  activityTopics,
  byActivity,
  filesOf,
  isArchived,
  planListInTopic,
  readTopicActivity,
  readTopics,
  readYourTopics,
  type ReadTopic,
} from '../dist/index.js'
import { buildLevelChange, buildMembershipChange, buildMutedEvent, memberField, serializeMutedBlob } from '@estiva-app/conversation'
import type { SignedEvent, UnsignedEvent } from '@estiva-app/protocol'

const ME = 'a'.repeat(64)
const THEM = 'b'.repeat(64)
const SHIP = 'c'.repeat(64)
const RELAY = 'f'.repeat(64)
const TEAM = '7b32200c-e4c0-4216-b79a-8490fc05e0bd'
const SHIP_TEAM = '85db5b59-9e49-4ea1-8e93-3d2a2d78c048'
const LEAF_TEAM = '0e2f4c1a-5b6d-4e7f-8a9b-0c1d2e3f4a5b'
const T0 = 1_787_000_000
const NOW = T0 + 100_000

let seq = 0
const signed = (event: UnsignedEvent): SignedEvent => ({ ...event, id: (++seq).toString(16).padStart(64, '0'), sig: '' })
const addressOf = (e: SignedEvent) => `${e.kind}:${e.pubkey}:${e.tags.find((t) => t[0] === 'd')![1]}`

const root = (kind: number, pubkey: string, d: string, team: string, parent?: string) =>
  signed({ pubkey, created_at: T0, kind, tags: [['d', d], ['title', d], ['h', team], ...(parent ? [['a', parent]] : [])], content: '' })
const change = (file: SignedEvent, field: string, value: string, at: number, by = file.pubkey) =>
  signed({
    pubkey: by,
    created_at: at,
    kind: 1851,
    tags: [['a', addressOf(file)], ['O', file.tags.find((t) => t[0] === 'd')![1]], ['field', field], ['value', value], ['h', file.tags.find((t) => t[0] === 'h')![1]], ['ts', String(at * 1000)]],
    content: '',
  })
const message = (topic: SignedEvent, at: number) =>
  signed({ pubkey: THEM, created_at: at, kind: 1111, tags: [['A', addressOf(topic)], ['K', '30840'], ['h', TEAM]], content: 'hi' })
const listIn = (topic: SignedEvent, file: string, at: number) =>
  signed(planListInTopic(topic.pubkey, at * 1000, { topic: { address: addressOf(topic), folder: TEAM }, file })[0])
const added = (topic: SignedEvent, at: number) =>
  signed(buildMembershipChange(THEM, at * 1000, { file: addressOf(topic), folder: TEAM, person: ME, member: true }))
const left = (topic: SignedEvent, at: number) =>
  signed({ pubkey: ME, created_at: at, kind: 1851, tags: [['a', addressOf(topic)], ['field', memberField(ME)], ['value', 'false'], ['h', TEAM], ['ts', String(at * 1000)], ['p', ME]], content: '' })

// Ship draws projects and issues; the projects' author recommends it.
const PROJECT = 30850
const ISSUE = 30851
const shipManifest = signed({
  pubkey: SHIP,
  created_at: T0 - 1000,
  kind: 31990,
  tags: [['d', 'ship'], ['k', String(PROJECT)], ['k', String(ISSUE)]],
  content: JSON.stringify({
    name: 'Ship',
    records: { changeKind: 1851, targetTag: 'a', fieldTag: 'field', valueTag: 'value', order: ['ts', 'created_at', 'id'], rule: 'last-write-wins-per-field' },
    projections: {
      [PROJECT]: { widget: 'card', slots: { title: { fold: 'title', tag: 'title' } } },
      [ISSUE]: { widget: 'row', slots: { title: { fold: 'title', tag: 'title' } } },
    },
  }),
})
const recommendation = signed({ pubkey: THEM, created_at: T0 - 900, kind: 31989, tags: [['d', String(PROJECT)], ['a', `31990:${SHIP}:ship`]], content: '' })

const openProject = root(PROJECT, THEM, 'open-p', SHIP_TEAM)
const shelvedProject = root(PROJECT, THEM, 'shelved-p', SHIP_TEAM)
const issue = root(ISSUE, THEM, 'issue-d', SHIP_TEAM, addressOf(openProject))
const doc = root(30842, THEM, 'doc-d', LEAF_TEAM)

const alpha = root(30840, ME, 'alpha', TEAM) // made it; lists the open project and a page
const bravo = root(30840, THEM, 'bravo', TEAM) // somebody else added the viewer: their change names them; lists the issue
const charlie = root(30840, ME, 'charlie', TEAM) // archived itself
const delta = root(30840, THEM, 'delta', TEAM, addressOf(shelvedProject)) // added; archived with its project
const echo = root(30840, ME, 'echo', TEAM) // muted
const foxtrot = root(30840, ME, 'foxtrot', TEAM) // a team's space
const golf = root(30840, ME, 'golf', TEAM) // made it, then left
const hotel = root(30840, THEM, 'hotel', TEAM) // not the viewer's: their comment in it follows nothing
const india = root(30840, ME, 'india', TEAM, addressOf(openProject)) // under a project that is open
const juliet = root(30840, THEM, 'juliet', TEAM) // the viewer chose a level
const kilo = root(30840, ME, 'kilo', TEAM) // deleted: the list read leaves it out
const topicRoots = [alpha, bravo, charlie, delta, echo, foxtrot, golf, hotel, india, juliet, kilo]

const world: SignedEvent[] = [
  shipManifest,
  recommendation,
  openProject,
  shelvedProject,
  issue,
  doc,
  ...topicRoots,
  change(shelvedProject, 'archived', 'true', T0 + 30),
  change(charlie, 'archived', 'true', T0 + 30),
  listIn(alpha, 'open-p', T0 + 10),
  listIn(alpha, 'doc-d', T0 + 11),
  listIn(bravo, 'issue-d', T0 + 12),
  added(bravo, T0 + 13),
  added(delta, T0 + 13),
  left(golf, T0 + 14),
  signed(buildLevelChange(ME, (T0 + 15) * 1000, { place: addressOf(juliet), folder: TEAM, level: 'all' })),
  signed({ pubkey: ME, created_at: T0 + 16, kind: 1111, tags: [['A', addressOf(hotel)], ['K', '30840'], ['h', TEAM]], content: 'me too' }),
  change(kilo, 'deleted', 'true', T0 + 17),
  // The team marks foxtrot one of its spaces.
  signed({ pubkey: RELAY, created_at: T0, kind: 30890, tags: [['d', TEAM], ['a', addressOf(foxtrot), '', 'space']], content: '' }),
  // Activity: india newest, then bravo by a comment on the issue it lists, then alpha by a change on its project.
  message(india, T0 + 500),
  signed({ pubkey: THEM, created_at: T0 + 400, kind: 1111, tags: [['A', addressOf(issue)], ['K', String(ISSUE)], ['h', SHIP_TEAM]], content: 'done?' }),
  change(openProject, 'status', 'started', T0 + 200),
  message(echo, T0 + 600),
  message(charlie, T0 + 700),
  // A title saved many times: the text the list read leaves out.
  ...Array.from({ length: 5 }, (_, i) => change(alpha, 'description', `Plan ${i}`, T0 + 20 + i)),
]

/** The mute list is encrypted to self; here its content is the plaintext. */
const mutedList = (keys: string[]) => signed(buildMutedEvent(ME, (T0 + 1) * 1000, serializeMutedBlob(keys, T0)))
const decrypt = async (content: string) => content

type Filter = { kinds?: number[]; authors?: string[]; since?: number; until?: number; limit?: number; fields?: string } & Record<string, unknown>
const matches = (e: SignedEvent, f: Filter) => {
  if (f.kinds && !f.kinds.includes(e.kind)) return false
  if (f.authors && !f.authors.includes(e.pubkey)) return false
  if (f.since !== undefined && e.created_at < f.since) return false
  if (f.until !== undefined && e.created_at > f.until) return false
  for (const [key, want] of Object.entries(f)) {
    if (!key.startsWith('#')) continue
    const held = e.tags.filter((t) => t[0] === key.slice(1)).map((t) => t[1])
    if (!(want as string[]).some((v) => held.includes(v))) return false
  }
  return true
}

/**
 * A relay as one request answers: each filter its newest `limit` events, and
 * §6.13's list read (`fields`), alone in its request, each picked file's
 * first record and current fields, a deleted file left out. Every request is
 * kept, as it was asked.
 */
function relay(events: SignedEvent[]) {
  const calls: Filter[][] = []
  const query = async (filters: Record<string, unknown>[]) => {
    calls.push(filters as Filter[])
    const byFields = (filters as Filter[]).filter((f) => f.fields)
    if (byFields.length > 0) {
      if (byFields.length !== filters.length) throw new Error('fields: a list read goes alone in its request')
      const picked = events.filter((e) => e.kind !== 1851 && byFields.some((f) => matches(e, f)))
      return filesOf(events)
        .filter((file) => picked.includes(file.root) && file.fields.deleted?.value !== 'true')
        .flatMap((file) => file.events)
    }
    const out = new Map<string, SignedEvent>()
    for (const f of filters as Filter[]) {
      const hit = events.filter((e) => matches(e, f)).sort((a, b) => b.created_at - a.created_at || (a.id < b.id ? -1 : 1))
      for (const e of typeof f.limit === 'number' ? hit.slice(0, f.limit) : hit) out.set(e.id, e)
    }
    return [...out.values()]
  }
  return { query, calls }
}

/** What an app gets today: every topic, the filter it applies, then the activity of what is left. */
async function readTheLongWay(events: SignedEvent[], listRead: boolean, muted: ReadonlySet<string> | undefined, spaces = false) {
  const { query, calls } = relay(events)
  const read = await readTopics(query, ME, { listRead, parentsListRead: listRead, nowSeconds: NOW })
  const yours = read.topics.filter((t) => t.yours && (spaces || !t.space) && !isArchived(t.object) && !muted?.has(t.address))
  const activity = await readTopicActivity(query, activityTopics(yours), { nowSeconds: NOW })
  const newest = byActivity(activity.at)
  yours.sort((a, b) => newest(a.address, b.address))
  return { topics: yours, at: new Map(yours.map((t) => [t.address, activity.at.get(t.address)])), calls }
}

/** What both reads must agree on, topic by topic. */
const drawn = (topic: ReadTopic) => ({
  address: topic.address,
  folder: topic.folder,
  createdAt: topic.createdAt,
  title: topic.object.slots.title?.value,
  archived: topic.object.archived,
  deleted: topic.object.deleted,
  parentRef: topic.object.parentRef,
  following: topic.following,
  yours: topic.yours,
  space: topic.space,
  listed: topic.listed,
})

for (const listRead of [true, false]) {
  describe(`readYourTopics ${listRead ? 'by the list read' : 'on a relay without the list read'}`, () => {
    it('answers the topics, how the viewer is in each, their lists, archives and order that readTopics, the filter and readTopicActivity do', async () => {
      const events = [...world, mutedList([addressOf(echo)])]
      const lean = await readYourTopics(relay(events).query, ME, { listRead, decrypt, nowSeconds: NOW })
      const long = await readTheLongWay(events, listRead, new Set([addressOf(echo)]))
      // In it, made or added or a level chosen; not archived, muted, a space, left, or somebody else's.
      // Alpha and bravo both last moved by the comment on the issue (alpha lists its project): equal, by address.
      assert.deepEqual(
        lean.topics.map((t) => t.address),
        [india, alpha, bravo, kilo, juliet].map(addressOf),
      )
      assert.deepEqual(lean.topics.map(drawn), long.topics.map(drawn))
      assert.deepEqual(lean.at, long.at)
      assert.deepEqual([...(lean.muted ?? [])], [addressOf(echo)])
      // The viewer is in bravo by somebody else's change naming them, with what it lists resolved.
      const b = lean.topics.find((t) => t.address === addressOf(bravo))!
      assert.deepEqual(b.following.ways, ['added'])
      assert.deepEqual(b.listed.map((f) => f.address), [addressOf(issue)])
      assert.deepEqual(lean.topics.find((t) => t.address === addressOf(alpha))!.listed.map((f) => f.address), [addressOf(openProject), addressOf(doc)])
    })

    it('keeps a space when asked, and a muted topic when the mute list does not open', async () => {
      const events = [...world, mutedList([addressOf(echo)])]
      const lean = await readYourTopics(relay(events).query, ME, { listRead, decrypt: async () => undefined, spaces: true, nowSeconds: NOW })
      const long = await readTheLongWay(events, listRead, undefined, true)
      assert.equal(lean.muted, undefined)
      assert.ok(lean.topics.some((t) => t.address === addressOf(foxtrot)))
      assert.ok(lean.topics.some((t) => t.address === addressOf(echo)))
      assert.deepEqual(lean.topics.map(drawn), long.topics.map(drawn))
      assert.deepEqual(lean.at, long.at)
    })

    it('leaves out a topic archived with its project, and keeps one under an open project', async () => {
      const lean = await readYourTopics(relay([...world]).query, ME, { listRead, decrypt, nowSeconds: NOW })
      assert.ok(!lean.topics.some((t) => t.address === addressOf(delta)))
      assert.ok(lean.topics.some((t) => t.address === addressOf(india)), 'a topic under an open project stays')
    })

    if (listRead) {
      it('by the list read, never asks for a parent project’s every change to see it archived', async () => {
        const { query, calls } = relay([...world])
        await readYourTopics(query, ME, { listRead, decrypt, nowSeconds: NOW })
        const byA = calls.flat().filter((f) => f.kinds?.includes(1851) && !f['#p'] && !f.fields).flatMap((f) => (f['#a'] as string[]) ?? [])
        assert.ok(!byA.includes(addressOf(shelvedProject)), `read by #a: ${byA}`)
      })
    }
  })
}

describe('readYourTopics: the requests it makes', () => {
  /**
   * A workspace shaped like Miky's (ALO-17's measure): 53 topics, 12 of them
   * his, each listing a project with issues filed in it or a page with pages
   * under it; some under a project; the rest other people's.
   */
  const workspace = () => {
    const events: SignedEvent[] = [shipManifest, recommendation, openProject, shelvedProject, change(shelvedProject, 'archived', 'true', T0 + 30)]
    for (let i = 0; i < 53; i++) {
      const mine = i < 12
      const topic = root(30840, mine ? ME : THEM, `topic-${i}`, TEAM, i % 4 === 0 ? addressOf(openProject) : undefined)
      events.push(topic, message(topic, T0 + 1000 + i))
      if (i % 2 === 0) {
        const project = root(PROJECT, THEM, `project-${i}`, SHIP_TEAM)
        events.push(project, listIn(topic, `project-${i}`, T0 + 10), ...[0, 1, 2].map((n) => root(ISSUE, THEM, `issue-${i}-${n}`, SHIP_TEAM, addressOf(project))))
      } else {
        const page = root(30842, THEM, `page-${i}`, LEAF_TEAM)
        events.push(page, listIn(topic, `page-${i}`, T0 + 10), root(30842, THEM, `subpage-${i}`, LEAF_TEAM, addressOf(page)))
      }
    }
    return events
  }

  it('reads 12 of 53 topics in one request a round, a list read always alone, fewer than the long way asks', async () => {
    const events = workspace()
    const { query, calls } = relay(events)
    const lean = await readYourTopics(query, ME, { listRead: true, decrypt, nowSeconds: NOW })
    const long = await readTheLongWay(events, true, new Set())
    assert.equal(lean.topics.length, 12)
    assert.deepEqual(lean.topics.map(drawn), long.topics.map(drawn))
    assert.deepEqual(lean.at, long.at)
    for (const request of calls) {
      const lists = request.filter((f) => f.fields).length
      assert.ok(lists === 0 || lists === request.length, 'a list read goes alone')
    }
    // At most: 1 roots and mute list · 2 changes naming me and team lists, beside the topics' list read · 3 listed
    // ids and parents' manifests · 4 the parents by the list read (one level: a project has none), beside activity's
    // two ticks (the files under the listed ones, then what is under those with the found files' first pages).
    assert.ok(calls.length <= 7, `${calls.length} requests`)
    assert.ok(long.calls.length > calls.length, `the long way: ${long.calls.length}`)
  })
})

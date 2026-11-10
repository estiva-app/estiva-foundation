/*
  Your topics, newest activity first (TOPI-10): the rule every app orders by.

  Three topics. Widgets lists a project (with an issue under it) and a Leaf
  page (with a page under it, and one under that). Onboarding lists nothing.
  Testing lists the same page as Widgets. What moves a topic up is anything
  that happened in it or in a file on it, deep; what does not is tidying the
  topic (arranging, a row/card switch, a rename, taking a file off), who is
  on something, and read state.
*/
import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { byActivity, readTopicActivity, relayNamesTeams, watchTopicActivity, type ActivityTopic, type TopicActivity } from '../dist/index.js'
import type { SignedEvent } from '@estiva-app/protocol'

const MIKY = 'a'.repeat(64)
const QA2 = 'b'.repeat(64)
const SHIP = 'c'.repeat(64)
const TEAM = '7b32200c-e4c0-4216-b79a-8490fc05e0bd'
const SHIP_TEAM = '85db5b59-9e49-4ea1-8e93-3d2a2d78c048'
const LEAF_TEAM = '0e2f4c1a-5b6d-4e7f-8a9b-0c1d2e3f4a5b'
const T0 = 1_787_000_000
const NOW = T0 + 10_000

const WIDGETS = `30840:${MIKY}:widgets-d`
const ONBOARDING = `30840:${MIKY}:onboarding-d`
const TESTING = `30840:${MIKY}:testing-d`
const PROJECT_ID = '4f1c2b3a-9d8e-4c7b-a6f5-0e1d2c3b4a59'
const PAGE_ID = '8a7b6c5d-4e3f-4a1b-9c8d-7e6f5a4b3c2d'
const PROJECT = `30850:${SHIP}:${PROJECT_ID}`
const ISSUE = `30851:${SHIP}:issue-d`
const PAGE = `30842:${MIKY}:${PAGE_ID}`
const SUBPAGE = `30842:${MIKY}:subpage-d`
const SUBSUBPAGE = `30842:${MIKY}:subsubpage-d`

let seq = 0
const event = (partial: Partial<SignedEvent> & { kind: number; created_at: number }): SignedEvent => ({
  id: (++seq).toString(16).padStart(64, '0'),
  sig: '',
  pubkey: QA2,
  tags: [],
  content: '',
  ...partial,
})
const root = (address: string, at: number, team: string, parent?: string) => {
  const [kind, pubkey, d] = address.split(':')
  return event({ kind: Number(kind), pubkey, created_at: at, tags: [['d', d!], ['h', team], ...(parent ? [['a', parent]] : [])] })
}
const change = (file: string, field: string, value: string, at: number, team = TEAM) =>
  event({ kind: 1851, created_at: at, tags: [['a', file], ['O', file.split(':')[2]!], ['field', field], ['value', value], ['h', team]], content: value.length > 20 ? value : '' })
const message = (topic: string, at: number) => event({ kind: 1111, created_at: at, tags: [['A', topic], ['K', '30840'], ['h', TEAM]], content: 'hi' })

const topics: ActivityTopic[] = [
  { address: WIDGETS, createdAt: T0, folder: TEAM, files: [{ address: PROJECT, folder: SHIP_TEAM }, { address: PAGE, folder: LEAF_TEAM }] },
  { address: ONBOARDING, createdAt: T0 + 1, folder: TEAM, files: [] },
  { address: TESTING, createdAt: T0 + 2, folder: TEAM, files: [{ address: PAGE, folder: LEAF_TEAM }] },
]
const fileRoots = [
  root(PROJECT, T0 - 500, SHIP_TEAM),
  root(ISSUE, T0 - 400, SHIP_TEAM, PROJECT),
  root(PAGE, T0 - 300, LEAF_TEAM),
  root(SUBPAGE, T0 - 200, LEAF_TEAM, PAGE),
  root(SUBSUBPAGE, T0 - 100, LEAF_TEAM, SUBPAGE),
]

type Filter = Record<string, unknown>
const matches = (e: SignedEvent, f: Filter) => {
  if (f.kinds && !(f.kinds as number[]).includes(e.kind)) return false
  if (typeof f.since === 'number' && e.created_at < f.since) return false
  if (typeof f.until === 'number' && e.created_at > f.until) return false
  for (const [key, want] of Object.entries(f)) {
    if (!key.startsWith('#')) continue
    const held = e.tags.filter((t) => t[0] === key.slice(1)).map((t) => t[1])
    if (!(want as string[]).some((v) => held.includes(v))) return false
  }
  return true
}
/** A relay as one request answers: each filter its newest `limit` events, newest first. */
function relayOver(events: SignedEvent[]) {
  const calls: Filter[][] = []
  const query = async (filters: Filter[]) => {
    calls.push(filters)
    const out = new Map<string, SignedEvent>()
    for (const f of filters) {
      const hit = events.filter((e) => matches(e, f)).sort((a, b) => b.created_at - a.created_at)
      for (const e of typeof f.limit === 'number' ? hit.slice(0, f.limit) : hit) out.set(e.id, e)
    }
    return [...out.values()]
  }
  return { query, calls }
}
const order = (activity: TopicActivity) => [...activity.at.keys()].sort(byActivity(activity.at))

describe('topics come newest activity first', () => {
  it('a message in a topic puts it first; with nothing, a topic keeps its own time', async () => {
    const { query } = relayOver([...fileRoots, message(ONBOARDING, T0 + 50)])
    const activity = await readTopicActivity(query, topics, { nowSeconds: NOW })
    assert.deepEqual(order(activity), [ONBOARDING, TESTING, WIDGETS])
    assert.equal(activity.at.get(ONBOARDING), T0 + 50)
  })

  it('arranging, a row/card switch, a rename and taking a file off do not move a topic; adding a file does', async () => {
    const tidy = [
      change(WIDGETS, `order:${PAGE.split(':')[2]}`, 'a0', T0 + 60),
      change(WIDGETS, `look:${PAGE.split(':')[2]}`, 'card', T0 + 61),
      change(WIDGETS, 'title', 'Widgets 2', T0 + 62),
      change(WIDGETS, 'lists:gone-d', 'false', T0 + 63),
      change(WIDGETS, `member:${QA2}`, 'true', T0 + 64),
      event({ kind: 30078, created_at: T0 + 65, tags: [['a', WIDGETS]] }),
    ]
    const { query } = relayOver([...fileRoots, message(ONBOARDING, T0 + 50), ...tidy])
    const tidied = await readTopicActivity(query, topics, { nowSeconds: NOW })
    assert.deepEqual(order(tidied), [ONBOARDING, TESTING, WIDGETS])

    const added = relayOver([...fileRoots, message(ONBOARDING, T0 + 50), ...tidy, change(WIDGETS, 'lists:new-d', 'true', T0 + 55)])
    const now = await readTopicActivity(added.query, topics, { nowSeconds: NOW })
    assert.equal(now.at.get(WIDGETS), T0 + 55)
    assert.deepEqual(order(now), [WIDGETS, ONBOARDING, TESTING])
  })

  it('a change on an issue under a listed project moves its topic up; who is on the issue does not', async () => {
    const { query } = relayOver([
      ...fileRoots,
      message(ONBOARDING, T0 + 50),
      change(ISSUE, 'status', 'done', T0 + 70, SHIP_TEAM),
      change(ISSUE, `member:${MIKY}`, 'true', T0 + 90, SHIP_TEAM),
    ])
    const activity = await readTopicActivity(query, topics, { nowSeconds: NOW })
    assert.equal(activity.at.get(WIDGETS), T0 + 70)
    assert.deepEqual(order(activity), [WIDGETS, ONBOARDING, TESTING])
  })

  it('a comment on a page two levels under a listed page moves every topic listing it', async () => {
    const comment = event({ kind: 1111, created_at: T0 + 80, tags: [['A', SUBSUBPAGE], ['h', LEAF_TEAM]] })
    const { query } = relayOver([...fileRoots, message(ONBOARDING, T0 + 50), comment])
    const activity = await readTopicActivity(query, topics, { nowSeconds: NOW })
    assert.equal(activity.at.get(WIDGETS), T0 + 80)
    assert.equal(activity.at.get(TESTING), T0 + 80)
    assert.equal(activity.at.get(ONBOARDING), T0 + 50)
  })

  it('says which file each found file sits directly under, so a listed project\'s issue is told from a page two levels down', async () => {
    const { query } = relayOver([...fileRoots, message(ONBOARDING, T0 + 50)])
    const activity = await readTopicActivity(query, topics, { nowSeconds: NOW })
    assert.equal(activity.parents?.get(ISSUE), PROJECT)
    assert.equal(activity.parents?.get(SUBPAGE), PAGE)
    assert.equal(activity.parents?.get(SUBSUBPAGE), SUBPAGE)
    assert.equal(activity.parents?.get(PROJECT), undefined)
  })

  it('an issue listed on one topic still counts for the topic that lists its project', async () => {
    const both: ActivityTopic[] = [
      { address: WIDGETS, createdAt: T0, folder: TEAM, files: [{ address: PROJECT, folder: SHIP_TEAM }] },
      { address: ONBOARDING, createdAt: T0 + 1, folder: TEAM, files: [{ address: ISSUE, folder: SHIP_TEAM }] },
    ]
    const { query } = relayOver([...fileRoots, change(ISSUE, 'status', 'done', T0 + 70, SHIP_TEAM)])
    const activity = await readTopicActivity(query, both, { nowSeconds: NOW })
    assert.equal(activity.at.get(ONBOARDING), T0 + 70)
    assert.equal(activity.at.get(WIDGETS), T0 + 70)
  })

  it('a comment in its newer form, by the file id alone, counts', async () => {
    const comment = event({ kind: 1111, created_at: T0 + 85, tags: [['O', PROJECT_ID], ['K', '30850'], ['h', SHIP_TEAM]] })
    const { query } = relayOver([...fileRoots, comment])
    const activity = await readTopicActivity(query, topics, { nowSeconds: NOW })
    assert.equal(activity.at.get(WIDGETS), T0 + 85)
  })

  it('a topic whose newest changes are all tidying is read further back, to the last real one', async () => {
    const real = change(WIDGETS, 'summary', 'What Widgets is about', T0 + 40)
    const tidy = Array.from({ length: 20 }, (_, i) => change(WIDGETS, `order:f${i}`, `a${i}`, T0 + 100 + i))
    const { query, calls } = relayOver([...fileRoots, real, ...tidy])
    const activity = await readTopicActivity(query, topics, { nowSeconds: NOW })
    assert.equal(activity.at.get(WIDGETS), T0 + 40)
    assert.ok(calls.length > 2, 'asked again, older')
  })

  it('an event that only tags a file, without being on it, moves no topic; nor does renaming a listed file', async () => {
    const elsewhere = `30851:${QA2}:elsewhere-d`
    const strays = [
      // A change to another file that also tags the topic and the issue.
      event({ kind: 1851, created_at: T0 + 90, tags: [['a', elsewhere], ['a', WIDGETS], ['a', ISSUE], ['field', 'status'], ['value', 'done'], ['h', TEAM]] }),
      // A change on the issue, signed into a team that is not the issue's.
      change(ISSUE, 'status', 'done', T0 + 91, TEAM),
      // A comment whose root is another author's file with the project's id: crossed, on neither.
      event({ kind: 1111, created_at: T0 + 92, tags: [['A', `30850:${QA2}:${PROJECT_ID}`], ['O', PROJECT_ID], ['h', TEAM]] }),
      // A comment rooted elsewhere that also names the topic.
      event({ kind: 1111, created_at: T0 + 93, tags: [['A', elsewhere], ['A', WIDGETS], ['h', TEAM]] }),
      // An issue whose parent is another project, also tagging the listed one.
      event({ kind: 30851, pubkey: QA2, created_at: T0 + 94, tags: [['d', 'stray-d'], ['h', TEAM], ['a', `30850:${QA2}:other-d`], ['a', PROJECT]] }),
      // A rename of a listed file.
      change(PAGE, 'title', 'Page 2', T0 + 95, LEAF_TEAM),
    ]
    const { query } = relayOver([...fileRoots, message(ONBOARDING, T0 + 50), ...strays])
    const activity = await readTopicActivity(query, topics, { nowSeconds: NOW })
    assert.deepEqual(order(activity), [ONBOARDING, TESTING, WIDGETS])
    assert.equal(activity.at.get(WIDGETS), T0)
    assert.ok(!activity.files.get(WIDGETS)!.some((file) => file.address.endsWith(':stray-d')))
  })

  it('reads the newest 500 files under one parent, however many are filed in it', async () => {
    const many = Array.from({ length: 520 }, (_, i) => root(`30851:${QA2}:bulk-${i}`, T0 - 1000 + i, SHIP_TEAM, PROJECT))
    const { query } = relayOver([...fileRoots, ...many])
    const activity = await readTopicActivity(query, topics, { nowSeconds: NOW })
    const issues = activity.files.get(WIDGETS)!.filter((file) => file.address.startsWith('30851:'))
    assert.equal(issues.length, 500)
    assert.ok(!issues.some((file) => file.address.endsWith(':bulk-0')), 'the oldest are left out')
  })

  it('finds every issue under listed projects when one filter fills its page and another in the same request brings back an older one of them', async () => {
    // 101 listed projects: two filters for the files under them, the first 100 and the last one.
    const projects = Array.from({ length: 101 }, (_, i) => `30850:${SHIP}:bulk-project-${i}`)
    const bulk: ActivityTopic = { address: `30840:${MIKY}:bulk-d`, createdAt: T0, folder: TEAM, files: projects.map((address) => ({ address, folder: SHIP_TEAM })) }
    // 1005 issues in the first three projects: the first filter's page (1000) fills. The oldest also names the
    // last project, so the second filter brings it back, older than the first filter's page.
    const issues = Array.from({ length: 1005 }, (_, i) => {
      const issue = root(`30851:${QA2}:bulk-issue-${i}`, T0 + 10 + i, SHIP_TEAM, projects[i % 3])
      if (i === 0) issue.tags.push(['a', projects[100]!])
      return issue
    })
    const { query } = relayOver(issues)
    const activity = await readTopicActivity(query, [bulk], { nowSeconds: NOW })
    const found = new Set(activity.files.get(bulk.address)!.map((file) => file.address))
    const missing = issues.map((issue) => `30851:${QA2}:${issue.tags[0]![1]}`).filter((address) => !found.has(address))
    assert.deepEqual(missing, [])
  })

  it('hands back the comments it read about each listed file, in either form, none about a file under one or tagging one, with no request added', async () => {
    // Both forms at once: the `#A` and `#O` probes each return it, and it is kept once.
    const onPage = event({ kind: 1111, created_at: T0 + 80, tags: [['A', PAGE], ['O', PAGE_ID], ['K', '30842'], ['h', LEAF_TEAM]], content: 'on the page' })
    const onProject = event({ kind: 1111, created_at: T0 + 85, tags: [['O', PROJECT_ID], ['K', '30850'], ['h', SHIP_TEAM]], content: 'on the project' })
    const onSubpage = event({ kind: 1111, created_at: T0 + 90, tags: [['A', SUBPAGE], ['h', LEAF_TEAM]], content: 'under the page' })
    // Rooted on another author's file with the page's id: the `#O` probe fetches it, the fold does not read it on the page.
    const crossed = event({ kind: 1111, created_at: T0 + 95, tags: [['A', `30842:${QA2}:${PAGE_ID}`], ['O', PAGE_ID], ['h', LEAF_TEAM]] })
    const { query, calls } = relayOver([...fileRoots, message(ONBOARDING, T0 + 50), onPage, onProject, onSubpage, crossed])
    const activity = await readTopicActivity(query, topics, { nowSeconds: NOW })
    // No more requests than the read makes without keeping comments (one a level: three with this relay; 0.95.0 made five), each comment filter one page.
    assert.ok(calls.length <= 3, `${calls.length} requests`)
    for (const f of calls.flat()) if ((f.kinds as number[]).includes(1111)) assert.ok(typeof f.limit === 'number' && f.limit <= 2, JSON.stringify(f))
    assert.equal(activity.at.get(WIDGETS), T0 + 90)
    assert.deepEqual(activity.comments?.get(PAGE)?.map((e) => e.content), ['on the page'])
    assert.deepEqual(activity.comments?.get(PROJECT)?.map((e) => e.content), ['on the project'])
    // One level under a listed page its comments are kept (ACT-2), two levels under they are not.
    assert.deepEqual(activity.comments?.get(SUBPAGE)?.map((e) => e.content), ['under the page'])
    assert.equal(activity.comments?.has(SUBSUBPAGE), false)
  })

  it('asks one request a level of files under the listed ones, each holding every target still open, however many targets', async () => {
    // 70 more topics, each with a message: with the three above, 152 targets in the first request.
    const more: ActivityTopic[] = Array.from({ length: 70 }, (_, i) => ({ address: `30840:${MIKY}:more-${i}-d`, createdAt: T0, folder: TEAM, files: [] }))
    const messages = more.map((topic, i) => message(topic.address, T0 + 100 + i))
    // Widgets' newest changes are tidying: its last real one is three pages back, asked beside the levels below.
    const tidy = [0, 1, 2].map((i) => change(WIDGETS, `order:f${i}`, `a${i}`, T0 + 300 + i))
    const real = change(WIDGETS, 'summary', 'What Widgets is about', T0 + 250)
    // Two levels under the listed page: read only once the level above is.
    const deep = event({ kind: 1111, created_at: T0 + 30, tags: [['A', SUBSUBPAGE], ['h', LEAF_TEAM]] })
    const { query, calls } = relayOver([...fileRoots, ...messages, ...tidy, real, deep])
    const activity = await readTopicActivity(query, [...topics, ...more], { nowSeconds: NOW })
    // Level 0 and every first page; level 1, the found issue's and subpage's first pages and Widgets' second;
    // level 2, the found sub-subpage's first page and Widgets' third. Before 0.96.0: eight.
    assert.ok(calls.length <= 3, `${calls.length} requests`)
    assert.ok(calls[0]!.length > 128, `${calls[0]!.length} filters in the first request`)
    assert.equal(activity.at.get(WIDGETS), T0 + 250)
    assert.equal(activity.at.get(TESTING), T0 + 30)
    for (const [i, topic] of more.entries()) assert.equal(activity.at.get(topic.address), T0 + 100 + i)
  })

  it('an event dated ahead of the reader is taken at the reader\'s clock, so it cannot pin a topic first', async () => {
    const { query } = relayOver([...fileRoots, message(TESTING, NOW + 900), message(ONBOARDING, NOW - 1)])
    const activity = await readTopicActivity(query, topics, { nowSeconds: NOW })
    assert.equal(activity.at.get(TESTING), NOW)
  })
})

/** A live relay: holds every REQ, delivers each published event to the open ones whose filters match it. */
function liveRelay() {
  const open = new Map<number, { filters: Filter[]; onEvent: (e: SignedEvent) => void }>()
  const reqs: Filter[][] = []
  let next = 0
  return {
    reqs,
    subscribe(filters: Filter[], onEvent: (e: SignedEvent) => void) {
      const id = next++
      reqs.push(filters)
      open.set(id, { filters, onEvent })
      return { close: () => void open.delete(id) }
    },
    publish(e: SignedEvent) {
      for (const sub of [...open.values()]) if (sub.filters.some((f) => matches(e, f))) sub.onEvent(e)
    },
  }
}
function manualTimers() {
  let pending: (() => void) | null = null
  return {
    setTimer: (run: () => void) => ((pending = run), 1),
    clearTimer: () => void (pending = null),
    fire: () => {
      const run = pending
      pending = null
      run?.()
    },
  }
}

describe('topics reorder live', () => {
  const start = async (options: { namesTeams?: boolean | Promise<boolean> } = {}) => {
    const { query } = relayOver([...fileRoots, message(ONBOARDING, T0 + 50)])
    const activity = await readTopicActivity(query, topics, { nowSeconds: NOW })
    const relay = liveRelay()
    const timers = manualTimers()
    const heard: [string, number][] = []
    const said: [string, string][] = []
    const watch = watchTopicActivity(relay, activity, (topic, at) => heard.push([topic, at]), {
      since: NOW - 10,
      now: () => (NOW + 100) * 1000,
      setTimer: timers.setTimer,
      clearTimer: timers.clearTimer,
      onComment: (file: string, e: SignedEvent) => said.push([file, e.content]),
      ...options,
    })
    return { activity, relay, timers, heard, said, watch }
  }

  it('a new comment on a listed file is kept and said even when no topic moves; one under it, or tagging it, is not', async () => {
    const { activity, relay, heard, said, watch } = await start()
    const reqsBefore = relay.reqs.flat().length
    // The same filters 0.92.0's watch opens with.
    assert.equal(reqsBefore, 5)
    relay.publish(message(WIDGETS, NOW + 50))
    relay.publish(message(TESTING, NOW + 50))
    heard.length = 0
    // Older than both topics' times: moves neither, still reaches the sidebar.
    const onPage = event({ kind: 1111, created_at: NOW + 5, tags: [['A', PAGE], ['K', '30842'], ['h', LEAF_TEAM]], content: 'on the page' })
    relay.publish(onPage)
    relay.publish(onPage)
    relay.publish(event({ kind: 1111, created_at: NOW + 6, tags: [['O', PROJECT_ID], ['K', '30850'], ['h', SHIP_TEAM]], content: 'on the project' }))
    relay.publish(event({ kind: 1111, created_at: NOW + 7, tags: [['A', ISSUE], ['h', SHIP_TEAM]], content: 'on an issue under it' }))
    relay.publish(event({ kind: 1111, created_at: NOW + 8, tags: [['A', `30842:${QA2}:${PAGE_ID}`], ['O', PAGE_ID], ['h', LEAF_TEAM]], content: 'crossed' }))
    // A rename of the page is not a comment on it.
    relay.publish(change(PAGE, 'title', 'Renamed', NOW + 9, LEAF_TEAM))
    // Heard after a newer one, it is kept before it.
    relay.publish(event({ kind: 1111, created_at: NOW + 3, tags: [['A', PAGE], ['K', '30842'], ['h', LEAF_TEAM]], content: 'earlier' }))
    assert.deepEqual(heard, [])
    assert.deepEqual(said, [[PAGE, 'on the page'], [PROJECT, 'on the project'], [ISSUE, 'on an issue under it'], [PAGE, 'earlier']])
    assert.deepEqual(activity.comments?.get(PAGE)?.slice(-2).map((e) => e.content), ['earlier', 'on the page'])
    assert.ok(activity.comments?.get(PAGE)?.every((e) => e.kind === 1111))
    assert.equal(activity.comments?.get(PAGE)?.filter((e) => e.id === onPage.id).length, 1)
    assert.deepEqual(activity.comments?.get(PROJECT)?.map((e) => e.content), ['on the project'])
    // One level under a listed project, its issue's comments are kept too (ACT-2: what names you there lights the topic).
    assert.deepEqual(activity.comments?.get(ISSUE)?.map((e) => e.content), ['on an issue under it'])
    // Nothing more asked: no REQ opened since.
    assert.equal(relay.reqs.flat().length, reqsBefore)
    watch.stop()
  })

  it('a new comment on a listed file that moves its topics is said as well', async () => {
    const { relay, heard, said, watch } = await start()
    relay.publish(event({ kind: 1111, created_at: NOW + 5, tags: [['A', PAGE], ['K', '30842'], ['h', LEAF_TEAM]], content: 'on the page' }))
    assert.deepEqual(heard.map(([topic]) => topic).sort(), [TESTING, WIDGETS].sort())
    assert.deepEqual(said, [[PAGE, 'on the page']])
    watch.stop()
  })

  it('someone writing in a topic moves it to the top; a rename of it does not', async () => {
    const { activity, relay, heard, watch } = await start()
    relay.publish(change(TESTING, 'title', 'Testing 2', NOW + 1))
    assert.deepEqual(heard, [])
    relay.publish(message(TESTING, NOW + 2))
    assert.deepEqual(heard, [[TESTING, NOW + 2]])
    assert.equal(order(activity)[0], TESTING)
    watch.stop()
  })

  it('a new issue filed in a listed project moves its topic, and a change to that issue is heard after', async () => {
    const { activity, relay, timers, heard, watch } = await start()
    const fresh = `30851:${SHIP}:fresh-d`
    relay.publish(root(fresh, NOW + 3, SHIP_TEAM, PROJECT))
    assert.deepEqual(heard, [[WIDGETS, NOW + 3]])
    timers.fire()
    relay.publish(change(fresh, 'status', 'done', NOW + 4, SHIP_TEAM))
    assert.deepEqual(heard.at(-1), [WIDGETS, NOW + 4])
    assert.ok(activity.files.get(WIDGETS)!.some((file) => file.address === fresh))
    assert.equal(activity.parents?.get(fresh), PROJECT)
    watch.stop()
  })

  it('hears nothing from an event that only tags a file or topic it is not on', async () => {
    const { relay, heard, watch } = await start()
    const elsewhere = `30851:${QA2}:elsewhere-d`
    relay.publish(event({ kind: 1851, created_at: NOW + 1, tags: [['a', elsewhere], ['a', TESTING], ['a', PAGE], ['field', 'status'], ['value', 'done'], ['h', TEAM]] }))
    relay.publish(change(PAGE, 'summary', 'x', NOW + 2, TEAM))
    relay.publish(change(PAGE, 'title', 'Page 2', NOW + 3, LEAF_TEAM))
    relay.publish(event({ kind: 1111, created_at: NOW + 4, tags: [['A', `30842:${QA2}:${PAGE_ID}`], ['O', PAGE_ID], ['h', TEAM]] }))
    relay.publish(event({ kind: 1111, created_at: NOW + 5, tags: [['A', elsewhere], ['A', TESTING], ['h', TEAM]] }))
    relay.publish(event({ kind: 30851, pubkey: QA2, created_at: NOW + 6, tags: [['d', 'stray-d'], ['h', TEAM], ['a', `30850:${QA2}:other-d`], ['a', PROJECT]] }))
    // A chat message rooted on a listed file, also naming a topic: on neither, as the read has it.
    relay.publish(event({ kind: 9, created_at: NOW + 6, tags: [['A', PAGE], ['A', ONBOARDING], ['h', TEAM]] }))
    assert.equal(heard.length, 0, `heard ${JSON.stringify(heard)}`)
    relay.publish(change(PAGE, 'summary', 'x', NOW + 7, LEAF_TEAM))
    assert.deepEqual(heard.map(([topic]) => topic).sort(), [TESTING, WIDGETS].sort())
    watch.stop()
  })

  it('asks for every topic and file with their teams named, in REQs our relay takes', async () => {
    const { relay, watch } = await start()
    for (const req of relay.reqs) assert.ok(req.length <= 10)
    const teams = new Set(relay.reqs.flat().flatMap((f) => (f['#h'] as string[] | undefined) ?? []))
    assert.deepEqual([...teams].sort(), [LEAF_TEAM, SHIP_TEAM, TEAM].sort())
    watch.stop()
  })

  it('names no team on a relay whose NIP-11 lists buzz-live-as-stored, once it has answered', async () => {
    const namesTeams = relayNamesTeams({ info: async () => ({ supported_extensions: ['buzz-live-as-stored'] }) })
    const { relay, watch } = await start({ namesTeams })
    await namesTeams
    await Promise.resolve()
    assert.ok(relay.reqs.length > 0)
    for (const f of relay.reqs.flat()) assert.equal(f['#h'], undefined)
    watch.stop()
  })
})

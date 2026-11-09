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
import { byActivity, readTopicActivity, watchTopicActivity, type ActivityTopic, type TopicActivity } from '../dist/index.js'
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
const PROJECT = `30850:${SHIP}:project-d`
const ISSUE = `30851:${SHIP}:issue-d`
const PAGE = `30842:${MIKY}:page-d`
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
    const comment = event({ kind: 1111, created_at: T0 + 85, tags: [['O', 'project-d'], ['K', '30850'], ['h', SHIP_TEAM]] })
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
  const start = async () => {
    const { query } = relayOver([...fileRoots, message(ONBOARDING, T0 + 50)])
    const activity = await readTopicActivity(query, topics, { nowSeconds: NOW })
    const relay = liveRelay()
    const timers = manualTimers()
    const heard: [string, number][] = []
    const watch = watchTopicActivity(relay, activity, (topic, at) => heard.push([topic, at]), {
      since: NOW - 10,
      now: () => (NOW + 100) * 1000,
      setTimer: timers.setTimer,
      clearTimer: timers.clearTimer,
    })
    return { activity, relay, timers, heard, watch }
  }

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
    watch.stop()
  })

  it('asks for every topic and file with their teams named, in REQs our relay takes', async () => {
    const { relay, watch } = await start()
    for (const req of relay.reqs) assert.ok(req.length <= 10)
    const teams = new Set(relay.reqs.flat().flatMap((f) => (f['#h'] as string[] | undefined) ?? []))
    assert.deepEqual([...teams].sort(), [LEAF_TEAM, SHIP_TEAM, TEAM].sort())
    watch.stop()
  })
})

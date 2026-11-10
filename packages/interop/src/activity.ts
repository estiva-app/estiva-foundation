/**
 * Your topics, newest activity first: the one shared rule Peek, Ship and Leaf
 * order topics by (TOPI-10; Miky, 2026-11-06, "Where anything moved").
 *
 * A topic's time is when anything last happened in it, deep:
 *
 * - a message or reply in its own conversation (`kind:1111`/`9` with its `A`);
 * - a change to the topic itself, except tidying it: its `order:<d>` and
 *   `look:<d>` (arranging, a row/card switch), a file taken off its list
 *   (`lists:<d>` = `false`) — a file put on it counts;
 * - a change to, or a comment on, any file its list holds, and on every file
 *   under one: a listed project's issues, a listed document's pages, any depth
 *   (the newest {@link MAX_CHILDREN} under each);
 * - a new file under one (an issue filed in a listed project).
 *
 * Never, anywhere: a rename (`title`, on the topic or any file; Miky,
 * 2026-11-09), who is on a file or at what level (`member:<P>`, `follow:<P>`,
 * §11.8) — joining would move a topic up for everyone — and read state
 * (`kind:30078`). The agent's own writes count like anyone's.
 *
 * An event counts only on the file it is on as the fold reads it, never by a
 * tag alone: a change by its first `a`, in its file's own team (`h`); a
 * comment by its root, never a crossed one; a new file by its one `a`.
 * With nothing else, a topic's time is its first record's.
 *
 * Every `created_at` is the author's to write, and the relay takes one up to
 * 15 minutes ahead: each time is capped at the reader's clock, so a
 * future-dated event cannot pin a topic to the top.
 *
 * Two people's orders may differ where a listed file sits in a team only one
 * of them reads; nothing unreadable is revealed, since each reads as itself.
 *
 * The rule takes any set of topics, so an Explore page orders every topic the
 * reader can open with the same read ({@link readTopicActivity}), and a live
 * app keeps it current with {@link watchTopicActivity}.
 *
 * No decision record states this order of topics: the rule lives here, and
 * writing it up as SPEC §6.14 text is on the project's Later list.
 */
import { fileIdOf, type LiveRelay, type SignedEvent } from '@estiva-app/protocol'
import { isAbout, KIND_COMMENT } from '@estiva-app/conversation'
import { folderOf, KIND_MESSAGE, type QueryFn } from './projection.js'
import { answeredBy, answers, firstPages, nextPages, type ReadTopic } from './topics.js'
import { LISTED_WATCH_REBUILD_MS, MAX_FILTERS_PER_REQ, openWhenKnown } from './listedConversations.js'

const KIND_CHANGE = 1851
const KIND_READ_STATE = 30078
const KIND_PROJECT = 30850
const KIND_ISSUE = 30851
const KIND_DOCUMENT = 30842
/** What may sit under a file, by the file's kind: a project's issues, a document's pages (§6.7). */
const CHILD_KINDS: Readonly<Record<number, readonly number[]>> = {
  [KIND_PROJECT]: [KIND_ISSUE],
  [KIND_DOCUMENT]: [KIND_DOCUMENT],
}
/** How deep the pages under a listed document are walked. */
const MAX_DEPTH = 8
/** The newest files under one parent that are read and listened to: a team member filing thousands cannot multiply the reads. */
const MAX_CHILDREN = 500
/** Newest events asked per target in the first round; a target whose page holds only what does not count is asked again, older. */
const FIRST_PAGE = 1
const MAX_ROUNDS = 6
const ADDRESS = /^(\d+):([0-9a-f]{64}):(.+)$/
/** Values per tag in one live filter: the watch's filters stay small whatever the number of files. */
const VALUES_PER_FILTER = 100

/** A file whose activity is a topic's: on its list, or under a file on it. */
export interface ActivityFile {
  /** Its address, `<kind>:<pubkey>:<d>`. */
  address: string
  /** Its team, from its root (§6.2), when the reader holds it: a live watch names it. */
  folder: string | null
}

/** A topic to order, as the reader holds it. */
export interface ActivityTopic {
  /** Its address. */
  address: string
  /** Its first record's time (Unix seconds): its time, when nothing has happened in it since. */
  createdAt?: number
  /** Its team, from its root: a change to it counts only in it, and a live watch names it. */
  folder?: string | null
  /** The files its list holds. A file under one of them is found by the read. */
  files: readonly ActivityFile[]
}

/** {@link readTopicActivity}'s answer, and what {@link watchTopicActivity} keeps current. */
export interface TopicActivity {
  /** Each topic asked for, by address: Unix seconds of the newest thing that happened in it, capped at the reader's clock; 0 when nothing is known. */
  at: Map<string, number>
  /** Each topic's files, by address: the listed ones and every file under them. */
  files: Map<string, ActivityFile[]>
  /** Each topic's team, as asked. */
  folders: Map<string, string | null>
  /**
   * Each file a topic lists directly (not a file under one), by address: the
   * comments about it (`kind:1111`, on it as the fold reads it, never by a
   * crossed tag) that the read already fetched to time its topics, oldest
   * first. The read asks nothing more for them, so a file holds its newest
   * comment or few, and none when it has none. {@link watchTopicActivity}
   * appends each new one in place (TOPI-3).
   */
  comments: Map<string, SignedEvent[]>
}

/** {@link ActivityTopic}s from {@link readTopics}' answer: each topic with its resolved list. */
export function activityTopics(topics: readonly ReadTopic[]): ActivityTopic[] {
  return topics.map((topic) => ({
    address: topic.address,
    createdAt: topic.createdAt,
    folder: topic.folder,
    files: topic.listed.flatMap((listed) => (listed.address ? [{ address: listed.address, folder: listed.folder }] : [])),
  }))
}

/** The fields a change sets: `field`, or one `set` per field. */
function fieldsOf(event: SignedEvent): { field: string; value: string | undefined }[] {
  const out: { field: string; value: string | undefined }[] = []
  for (const tag of event.tags) {
    if (tag[0] === 'set' && tag[1]) out.push({ field: tag[1], value: tag[2] })
  }
  const field = event.tags.find((tag) => tag[0] === 'field')?.[1]
  if (field) out.push({ field, value: event.tags.find((tag) => tag[0] === 'value')?.[1] })
  return out
}

/**
 * Whether an event is news for the topic it is read for: the rule above,
 * event by event. `topic` is the address of the topic being ordered, so a
 * change to the topic itself is judged as tidying or not.
 */
export function countsAsActivity(event: SignedEvent, topic: string): boolean {
  if (event.kind === KIND_READ_STATE) return false
  if (event.kind !== KIND_CHANGE) return true
  // A change's file is its first `a` (§6.10); any later one is no target.
  const own = tagValues(event, 'a')[0] === topic
  return fieldsOf(event).some(({ field, value }) => {
    // A rename moves nothing, on the topic or on any file (Miky, 2026-11-09).
    if (field.startsWith('member:') || field.startsWith('follow:') || field === 'title') return false
    if (!own) return true
    if (field.startsWith('order:') || field.startsWith('look:')) return false
    if (field.startsWith('lists:')) return value === 'true'
    return true
  })
}

/** Newest first, then by address: the order of a set of topics, from {@link TopicActivity.at}. */
export function byActivity(at: ReadonlyMap<string, number>): (a: string, b: string) => number {
  return (a, b) => (at.get(b) ?? 0) - (at.get(a) ?? 0) || (a < b ? -1 : a > b ? 1 : 0)
}

function idOf(address: string): string | undefined {
  return ADDRESS.exec(address)?.[3]
}
function kindOf(address: string): number | undefined {
  const m = ADDRESS.exec(address)
  return m ? Number(m[1]) : undefined
}
function tagValues(event: SignedEvent, name: string): string[] {
  return event.tags.filter((tag) => tag[0] === name && tag[1]).map((tag) => tag[1]!)
}

/**
 * Whether an event is on the file at `address` (whose root names `folder`),
 * as the fold reads it, rather than merely tagging it: a change by its first
 * `a`, its `O` when it carries one, and its file's own team in `h` (§6.10); a
 * comment by its root (`isAbout`: its one `A`, or its `O` when it has no root,
 * never a crossed one, §6.4); a message by its first `A`. Anybody may tag any
 * file, so a tag alone would let a write in one team move a topic in another.
 */
function isOn(event: SignedEvent, address: string, folder: string | null): boolean {
  if (event.kind === KIND_CHANGE) {
    const id = tagValues(event, 'O')[0]
    return tagValues(event, 'a')[0] === address && (id === undefined || id === idOf(address)) && tagValues(event, 'h')[0] === (folder ?? undefined)
  }
  if (event.kind === KIND_COMMENT) return isAbout(event, address)
  return tagValues(event, 'A')[0] === address
}

/**
 * The files under the given ones, a level at a time: a project's issues, a
 * document's pages, each by its root's `a` (§6.7), to {@link MAX_DEPTH}
 * levels. The caller sends {@link FilesUnder.asking} in its request (every
 * one, however many: paged past the relay's cap rather than cut at it) and
 * hands the answer to {@link FilesUnder.heard}, which says the files a level
 * held once its last page is in, each with its root's team and time.
 */
interface FilesUnder {
  asking: (Record<string, unknown> & { limit: number })[]
  heard(events: readonly SignedEvent[]): { parent: string; file: ActivityFile; at: number }[]
}

function filesUnder(parents: readonly string[]): FilesUnder {
  // Each file under one is answered once per parent, even when it is listed itself (on another topic, say);
  // each parent is walked once.
  const found = new Set<string>()
  let level = parents.filter((address) => CHILD_KINDS[kindOf(address) ?? -1])
  const walked = new Set(level)
  let depth = 0
  let roots = new Map<string, SignedEvent>()
  const ask = (): (Record<string, unknown> & { limit: number })[] => {
    if (depth >= MAX_DEPTH || level.length === 0) return []
    const kinds = [...new Set(level.flatMap((address) => CHILD_KINDS[kindOf(address)!]!))]
    const filters: Record<string, unknown>[] = []
    for (let i = 0; i < level.length; i += VALUES_PER_FILTER) filters.push({ kinds, '#a': level.slice(i, i + VALUES_PER_FILTER) })
    return firstPages(filters)
  }
  const walk: FilesUnder = {
    asking: ask(),
    heard(events) {
      if (walk.asking.length === 0) return []
      for (const event of events) if (walk.asking.some((filter) => answers(event, filter))) roots.set(event.id, event)
      walk.asking = nextPages(walk.asking, events)
      if (walk.asking.length > 0) return []
      const out: { parent: string; file: ActivityFile; at: number }[] = []
      const asked = new Set(level)
      const next: string[] = []
      // A replaceable root the relay still holds twice is one file: its newest names its team.
      const newest = new Map<string, { root: SignedEvent; parent: string }>()
      for (const root of roots.values()) {
        const d = tagValues(root, 'd')[0]
        // A root's parent is its one `a` (§6.7): a later one is no parent.
        const parent = tagValues(root, 'a')[0]
        if (!d || !parent || !asked.has(parent) || !(CHILD_KINDS[kindOf(parent)!] ?? []).includes(root.kind)) continue
        const address = `${root.kind}:${root.pubkey}:${d}`
        const held = newest.get(address)
        if (!held || root.created_at > held.root.created_at) newest.set(address, { root, parent })
      }
      const perParent = new Map<string, number>()
      for (const [address, { root, parent }] of [...newest].sort((a, b) => b[1].root.created_at - a[1].root.created_at)) {
        const count = perParent.get(parent) ?? 0
        if (count >= MAX_CHILDREN) continue
        perParent.set(parent, count + 1)
        if (found.has(`${parent} ${address}`)) continue
        found.add(`${parent} ${address}`)
        out.push({ parent, file: { address, folder: folderOf(root) }, at: root.created_at })
        if (CHILD_KINDS[root.kind] && !walked.has(address)) {
          walked.add(address)
          next.push(address)
        }
      }
      level = next
      depth++
      roots = new Map()
      walk.asking = ask()
      return out
    },
  }
  return walk
}

/** One thing to find the newest counting event of: a filter, the file it is on, and the topics its answer is news for. */
interface Probe {
  filter: Record<string, unknown>
  target: ActivityFile
  topics: string[]
  /** A listed file's comment probe: the comments it answers are kept in {@link TopicActivity.comments}. */
  keepsComments?: boolean
}

/**
 * Each topic's newest activity (the rule above), for any set of topics the
 * reader holds — theirs, or every one they can open.
 *
 * Reads, whatever the number of topics, one request a tick: the newest few
 * events of each topic's conversation and own changes and of each listed
 * file's changes and comments, every target one filter, beside the first
 * level of files under the listed ones (a project's issues, a document's
 * pages); then each tick the next level, the first page of each file the
 * level before found, and every target still open, from older events. A
 * target whose newest events are all tidying is asked again from older ones,
 * up to a few pages. No filter names a team (`#h`), the only values a relay
 * caps per request, so however many filters a tick holds it is one request:
 * a topic list with one level of files under it is about four.
 *
 * Measured 9 Nov 2026 on production over the 47 topics the agent can read
 * (Miky is in 24 of them): about 1.9 MB in 7 requests, 1 s. Most of it is the
 * newest text save of a file, which carries the whole text, and the roots of
 * the issues under listed projects.
 *
 * `query` answers each filter as one request would, honouring `limit` and
 * `until` (the apps' viewer query does). A failed read rejects.
 */
export async function readTopicActivity(
  query: QueryFn,
  topics: readonly ActivityTopic[],
  options: { nowSeconds?: number } = {},
): Promise<TopicActivity> {
  const now = options.nowSeconds ?? Math.floor(Date.now() / 1000)
  const capped = (at: number) => Math.min(at, now)
  const at = new Map<string, number>()
  const files = new Map<string, ActivityFile[]>()
  const folders = new Map<string, string | null>()
  const comments = new Map<string, SignedEvent[]>()
  for (const topic of topics) {
    at.set(topic.address, topic.createdAt ? capped(topic.createdAt) : 0)
    files.set(topic.address, [...topic.files])
    folders.set(topic.address, topic.folder ?? null)
    for (const file of topic.files) if (!comments.has(file.address)) comments.set(file.address, [])
  }
  if (topics.length === 0) return { at, files, folders, comments }
  const bump = (topic: string, when: number) => {
    if (capped(when) > (at.get(topic) ?? 0)) at.set(topic, capped(when))
  }

  // Which topics each file is on (a file can be on several), then the files under them.
  const topicsOf = new Map<string, Set<string>>()
  const onTopic = (file: string, topic: string) => {
    const set = topicsOf.get(file) ?? new Set<string>()
    set.add(topic)
    topicsOf.set(file, set)
  }
  for (const topic of topics) for (const file of topic.files) onTopic(file.address, topic.address)
  const listed = new Map([...topicsOf].map(([file, on]) => [file, new Set(on)]))

  // Each listed file's team, from its root, for the changes' `h`.
  const folderOfFile = new Map<string, string | null>()
  for (const topic of topics) for (const file of topic.files) if (!folderOfFile.get(file.address)) folderOfFile.set(file.address, file.folder)

  const fileProbes = (target: ActivityFile, list: string[], keepsComments = false): Probe[] => {
    const file = target.address
    const id = fileIdOf(file)
    // Every change carries the file's `a`; its `O` only since 30 Oct 2026. A comment carries `A`, or `O` in its newer form (§6.4).
    return [
      { filter: { kinds: [KIND_CHANGE], '#a': [file] }, target, topics: list },
      { filter: { kinds: [KIND_COMMENT], '#A': [file] }, target, topics: list, keepsComments },
      ...(id ? [{ filter: { kinds: [KIND_COMMENT], '#O': [id] }, target, topics: list, keepsComments }] : []),
    ]
  }
  const first: Probe[] = []
  for (const topic of topics) {
    const target = { address: topic.address, folder: topic.folder ?? null }
    first.push({ filter: { kinds: [KIND_COMMENT, KIND_MESSAGE], '#A': [topic.address] }, target, topics: [topic.address] })
    first.push({ filter: { kinds: [KIND_CHANGE], '#a': [topic.address] }, target, topics: [topic.address] })
  }
  for (const [file, on] of listed) first.push(...fileProbes({ address: file, folder: folderOfFile.get(file) ?? null }, [...on], true))

  // One request a tick: the next level of files under the listed ones, the
  // first page of each file found by the level before, and every probe still
  // open, a page further back. No filter here names a team (`#h`), the only
  // values a relay caps per request, so none is split across requests.
  const under = filesUnder([...listed.keys()])
  // Each file found under a listed one, as last found, and the topics it has been read for.
  const asFound = new Map<string, ActivityFile>()
  const readFor = new Map<string, Set<string>>()
  type Open = { probe: Probe; filter: Record<string, unknown>; round: number }
  const opened = (probes: readonly Probe[]): Open[] => probes.map((probe) => ({ probe, filter: { ...probe.filter, limit: FIRST_PAGE }, round: 0 }))
  let open = opened(first)
  while (under.asking.length > 0 || open.length > 0) {
    const asked = [...under.asking, ...open.map((o) => o.filter)]
    const events = await query(asked)
    const found = under.heard(events)
    // Parents come before their children in a level, so a page two levels down inherits its topics.
    for (const { parent, file, at: created } of found) {
      for (const topic of topicsOf.get(parent) ?? []) {
        if (!topicsOf.get(file.address)?.has(topic)) files.get(topic)!.push(file)
        onTopic(file.address, topic)
        // A new issue filed in a listed project is news.
        bump(topic, created)
      }
      asFound.set(file.address, file)
    }
    open = stillOpen(open, events)
    const then: Probe[] = []
    for (const [file, target] of asFound) {
      // Only for the topics it was not already read for, as a listed file or found before.
      const done = readFor.get(file) ?? new Set(listed.get(file))
      const fresh = [...(topicsOf.get(file) ?? [])].filter((topic) => !done.has(topic))
      if (fresh.length === 0) continue
      for (const topic of fresh) done.add(topic)
      readFor.set(file, done)
      then.push(...fileProbes(target, fresh))
    }
    open.push(...opened(then))
  }
  for (const list of comments.values()) list.sort(oldestFirst)
  return { at, files, folders, comments }

  /**
   * Per probe, the newest event that counts for one of its topics, from the
   * page this tick answered it: the probes still open, each a page further
   * back, up to {@link MAX_ROUNDS} pages each.
   */
  function stillOpen(open: readonly Open[], events: readonly SignedEvent[]): Open[] {
    const still: Open[] = []
    for (const o of open) {
      // Only what this filter alone would have been answered: the request holds every other probe's answer too.
      const page = answeredBy(events, o.filter)
      if (o.probe.keepsComments) {
        const kept = comments.get(o.probe.target.address)
        for (const event of page) {
          if (!kept || event.kind !== KIND_COMMENT || !isOn(event, o.probe.target.address, o.probe.target.folder)) continue
          if (!kept.some((held) => held.id === event.id)) kept.push(event)
        }
      }
      const left = new Set(o.probe.topics)
      for (const event of page) {
        if (!isOn(event, o.probe.target.address, o.probe.target.folder)) continue
        for (const topic of [...left]) {
          if (!countsAsActivity(event, topic)) continue
          bump(topic, event.created_at)
          left.delete(topic)
        }
        if (left.size === 0) break
      }
      const limit = o.filter.limit as number
      if (left.size === 0 || page.length < limit || o.round + 1 >= MAX_ROUNDS) continue
      const until = page[page.length - 1]!.created_at
      // A second holding a whole page on its own: ask a bigger page of it rather than step past it.
      const same = until === (o.filter.until as number | undefined)
      still.push({ probe: { ...o.probe, topics: [...left] }, filter: { ...o.probe.filter, until, limit: same ? limit * 4 : limit * 2 }, round: o.round + 1 })
    }
    return still
  }
}

/** A live watch's handle. */
export interface ActivityWatch {
  /** Idempotent. Closes its subscriptions. */
  stop(): void
}

/** Oldest first, ties by id: the order {@link TopicActivity.comments} keeps. */
function oldestFirst(a: SignedEvent, b: SignedEvent): number {
  return a.created_at - b.created_at || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0)
}

function chunked<T>(list: readonly T[], size: number): T[][] {
  const out: T[][] = []
  for (let i = 0; i < list.length; i += size) out.push(list.slice(i, i + size))
  return out
}

/**
 * Keep {@link TopicActivity} current, live: hear every new event that is news
 * for a topic it holds (the rule above), raise that topic's time, and say so.
 * A new file under a listed one (an issue filed in a listed project) is news,
 * and its own activity is heard from then on.
 *
 * One REQ for every topic (another per {@link MAX_FILTERS_PER_REQ} filters).
 * `onActivity` is called with the topic and its new time, after `activity.at`
 * is raised in place; an event that is not news, or older than what is held,
 * says nothing.
 *
 * A new comment about a file a topic lists directly (one of
 * `activity.comments`' keys, by the same rule the read uses) is appended to
 * that file's list in place, and `onComment` is called with the file and the
 * comment, whether or not it raised a topic's time: an older-dated one, or
 * one on a topic already newer, still reaches it. One heard twice is kept
 * and said once. It adds no filter: the watch already asks for them (TOPI-3).
 *
 * As {@link watchListedConversations} does, it asks by file alone when given
 * `namesTeams: relayNamesTeams(relay)` on a relay that lists
 * `buzz-live-as-stored` (ours), opening once that answer is in. Otherwise
 * (the default) every filter also names the teams of the topics and their
 * files, and a file whose team is unknown is not heard from its team.
 *
 * why: https://github.com/estiva-app/estiva-docs/blob/main/decisions/a-request-kept-open-hears-what-asking-again-would-return.md
 */
export function watchTopicActivity(
  relay: Pick<LiveRelay, 'subscribe'>,
  activity: TopicActivity,
  onActivity: (topic: string, at: number) => void,
  options: {
    /** Unix seconds to hear from. Defaults to now. */
    since?: number
    /** Whether to name teams; a promise ({@link relayNamesTeams}) holds the REQ until it settles. Defaults to true. */
    namesTeams?: boolean | Promise<boolean>
    /** A new comment about a listed file, after it is appended to `activity.comments`. */
    onComment?: (file: string, event: SignedEvent) => void
    onClosed?: (reason: string) => void
    now?: () => number
    setTimer?: (run: () => void, ms: number) => unknown
    clearTimer?: (timer: unknown) => void
  } = {},
): ActivityWatch {
  const timers = globalThis as unknown as { setTimeout(run: () => void, ms: number): unknown; clearTimeout(timer: unknown): void }
  const setTimer = options.setTimer ?? ((run: () => void, ms: number) => timers.setTimeout(run, ms))
  const clearTimer = options.clearTimer ?? ((timer: unknown) => timers.clearTimeout(timer))
  const nowSeconds = () => Math.floor((options.now ?? Date.now)() / 1000)
  let namesTeams = typeof options.namesTeams === 'boolean' ? options.namesTeams : true
  let since = Math.min(options.since ?? nowSeconds(), nowSeconds())

  // Which topics each file is news for; each file's team; the files by id, for a comment's `O`.
  const byAddress = new Map<string, Set<string>>()
  const folderOfFile = new Map<string, string | null>()
  const byId = new Map<string, Set<string>>()
  const teams = new Set<string>()
  const add = (file: ActivityFile, topic: string) => {
    const set = byAddress.get(file.address) ?? new Set<string>()
    set.add(topic)
    byAddress.set(file.address, set)
    if (!folderOfFile.get(file.address)) folderOfFile.set(file.address, file.folder)
    const id = fileIdOf(file.address)
    if (id) byId.set(id, (byId.get(id) ?? new Set<string>()).add(file.address))
    if (file.folder) teams.add(file.folder)
  }
  for (const [topic, list] of activity.files) for (const file of list) add(file, topic)
  // Files heard under each parent since the watch began, beside those read: capped as the read is.
  const children = new Map<string, number>()
  for (const folder of activity.folders.values()) if (folder) teams.add(folder)
  const topicSet = new Set(activity.at.keys())

  let subs: { close(): void }[] = []
  let timer: unknown = null
  let stopped = false

  const filtersNow = (): Record<string, unknown>[] => {
    const topicAddresses = [...topicSet]
    const fileAddresses = [...byAddress.keys()]
    const parents = fileAddresses.filter((address) => CHILD_KINDS[kindOf(address) ?? -1])
    const childKinds = [...new Set(parents.flatMap((address) => CHILD_KINDS[kindOf(address)!]!))]
    const base: Record<string, unknown>[] = [
      ...chunked(topicAddresses, VALUES_PER_FILTER).map((values) => ({ kinds: [KIND_COMMENT, KIND_MESSAGE], '#A': values })),
      ...chunked([...topicAddresses, ...fileAddresses], VALUES_PER_FILTER).map((values) => ({ kinds: [KIND_CHANGE], '#a': values })),
      ...chunked(fileAddresses, VALUES_PER_FILTER).map((values) => ({ kinds: [KIND_COMMENT], '#A': values })),
      ...chunked([...byId.keys()], VALUES_PER_FILTER).map((values) => ({ kinds: [KIND_COMMENT], '#O': values })),
      ...chunked(parents, VALUES_PER_FILTER).map((values) => ({ kinds: childKinds, '#a': values })),
    ]
    const teamChunks = namesTeams && teams.size > 0 ? chunked([...teams], 128) : [undefined]
    return teamChunks.flatMap((h) => base.map((f) => ({ ...f, ...(h ? { '#h': h } : {}), since })))
  }

  const open = () => {
    for (const sub of subs) sub.close()
    subs = chunked(filtersNow(), MAX_FILTERS_PER_REQ).map((filters) =>
      relay.subscribe(filters, hear, options.onClosed ? { onClosed: options.onClosed } : undefined),
    )
  }
  const reopenSoon = () => {
    if (stopped || timer !== null) return
    timer = setTimer(() => {
      timer = null
      if (!stopped) open()
    }, LISTED_WATCH_REBUILD_MS)
  }

  function raise(topic: string, created: number) {
    const when = Math.min(created, nowSeconds())
    if (when <= (activity.at.get(topic) ?? 0)) return
    activity.at.set(topic, when)
    onActivity(topic, when)
  }

  function hear(event: SignedEvent) {
    if (stopped) return
    since = Math.max(since, Math.min(event.created_at, nowSeconds()))
    // A new file under a listed one: news, and listened to from now on.
    const d = tagValues(event, 'd')[0]
    // Its parent is its one `a` (§6.7), a held file whose kind holds this kind (a project its issue, a page its page).
    const first = tagValues(event, 'a')[0]
    const parent = d && first && byAddress.has(first) && CHILD_KINDS[kindOf(first) ?? -1]?.includes(event.kind) ? first : undefined
    if (parent && d) {
      const file = { address: `${event.kind}:${event.pubkey}:${d}`, folder: folderOf(event) }
      const fresh = !byAddress.has(file.address)
      const listen = fresh && (children.get(parent) ?? 0) < MAX_CHILDREN
      if (listen) children.set(parent, (children.get(parent) ?? 0) + 1)
      for (const topic of byAddress.get(parent)!) {
        if (listen) {
          activity.files.get(topic)?.push(file)
          add(file, topic)
        }
        raise(topic, event.created_at)
      }
      if (listen) reopenSoon()
      return
    }
    // The files and topics it may be on, then only those it is on as the read judges it.
    const names = new Set<string>()
    if (event.kind === KIND_CHANGE) {
      if (first) names.add(first)
    } else if (event.kind === KIND_COMMENT) {
      const root = tagValues(event, 'A')[0] ?? first
      if (root) names.add(root)
      for (const id of tagValues(event, 'O')) for (const address of byId.get(id) ?? []) names.add(address)
    } else {
      // A chat message is a topic's only, as the read asks for it: none lists under a file.
      const root = tagValues(event, 'A')[0]
      if (root && topicSet.has(root)) names.add(root)
    }
    const topics = new Set<string>()
    const listedOn: string[] = []
    for (const name of names) {
      if (topicSet.has(name) && isOn(event, name, activity.folders.get(name) ?? null)) topics.add(name)
      if (byAddress.has(name) && isOn(event, name, folderOfFile.get(name) ?? null)) {
        for (const topic of byAddress.get(name)!) topics.add(topic)
        if (event.kind === KIND_COMMENT) listedOn.push(name)
      }
    }
    // A comment on a listed file is kept, and said, whether or not it moves a topic.
    for (const file of listedOn) {
      const kept = activity.comments.get(file)
      if (!kept || kept.some((held) => held.id === event.id)) continue
      // Kept oldest first, as the read hands them: one heard late lands in its place.
      const later = kept.findIndex((held) => oldestFirst(held, event) > 0)
      kept.splice(later < 0 ? kept.length : later, 0, event)
      options.onComment?.(file, event)
    }
    for (const topic of topics) if (countsAsActivity(event, topic)) raise(topic, event.created_at)
  }

  openWhenKnown(options.namesTeams, (names) => (namesTeams = names), () => !stopped && open())
  return {
    stop() {
      if (stopped) return
      stopped = true
      if (timer !== null) clearTimer(timer)
      for (const sub of subs) sub.close()
      subs = []
    },
  }
}

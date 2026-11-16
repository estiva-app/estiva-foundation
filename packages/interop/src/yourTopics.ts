/**
 * Your topics, lean: only the topics the viewer is in, newest activity first —
 * what a sidebar draws (ALO-17), where {@link readTopics} reads every topic the
 * viewer can open, the viewer's whole part in each and their text.
 *
 * The same answer as {@link readTopics}, the filter every app applies (in it,
 * not archived, its own or with a parent, not muted, not a space) and
 * {@link readTopicActivity} over what is left, for fewer requests and bytes:
 *
 * 1. every topic's root, and the viewer's mute list, in one request;
 * 2. the changes naming the viewer on any topic and the team lists naming
 *    them, in one request: whether the viewer is in a topic does not depend on
 *    its fields, so this says which topics could be theirs;
 * 3. only those topics' current fields, by the list read (alone: a relay
 *    refuses a list read mixed with other filters) — each topic's title,
 *    archive and parent come from that answer, and only the topics the viewer
 *    is in are read further. Every topic's fields were 0.13 MB of Ship's
 *    sidebar on Miky's workspace, 64 topics for the 25 he is in (ALO-22);
 * 4. their listed ids, what the list read skipped and the manifests of their
 *    parents, in one request;
 * 5. their parents, a level a request by the list read, to see whether one is
 *    archived, while their activity is read.
 *
 * Without the list read (the relay does not advertise it), round 2 reads each
 * topic's changes plain, as {@link readTopics} does. A topic the list read
 * does not answer (deleted) is read plain, as a parent is.
 */
import { mutedFilter, parseMutedBlob, MUTED_D_TAG } from '@estiva-app/conversation'
import { FILE_KINDS, type SignedEvent } from '@estiva-app/protocol'
import {
  addressPointerOf,
  createProjectionCache,
  isArchived,
  markTopicsArchivedWith,
  projectTopics,
  seedManifests,
  type ForeignObject,
  type ProjectionCache,
  type QueryFn,
} from './projection.js'
import {
  answeredBy,
  changesNamingFilter,
  eventsByTopic,
  listReadPlan,
  listsFrom,
  newestChanges,
  readAll,
  readTopicOf,
  resolveIds,
  spacesOf,
  teamListFilters,
  topicListFilter,
  topicRoots,
  type ListReadOptions,
  type ReadTopic,
} from './topics.js'
import { activityTopics, byActivity, readTopicActivity, type TimesFn } from './activity.js'

const KIND_TOPIC = 30840
const KIND_CHANGE = 1851
const KIND_APP_DATA = 30078
/** As {@link resolveForeignRoots} reads a file's changes when it reads them plain. */
const PLAIN_CHANGES_LIMIT = 500

/** {@link readYourTopics}' answer. */
export interface YourTopicsRead {
  me: string
  /**
   * The viewer's topics: in it (`following.in`), not archived (its own, or
   * with a parent), not muted, and not a space unless `spaces` was asked.
   * Newest activity first ({@link byActivity} over `at`). Each as
   * {@link readTopics} reads it, its `object` without its text when read by
   * the list read and without `openUrl`.
   */
  topics: ReadTopic[]
  /** {@link readTopicActivity}'s `at` for exactly these topics. */
  at: Map<string, number>
  /** The viewer's muted keys, from their mute list; empty with none; `undefined` when it would not decrypt (then nothing is left out as muted). */
  muted: ReadonlySet<string> | undefined
}

/**
 * The viewer's topics, newest activity first, in about ten requests on a
 * workspace like Miky's (53 topics, 12 his): see the module's rounds.
 *
 * `listRead`, where the relay advertises the list read (NIP-11
 * `file_list.newest`): the topics and their parents are read as their
 * current fields (§6.13); `readTopics(query, me, { listRead, parentsListRead:
 * listRead })` reads the same. `decrypt` opens the mute list (NIP-44 to
 * self); `cache` keeps the parents' manifests between reads.
 */
export async function readYourTopics(
  query: QueryFn,
  me: string,
  options: ListReadOptions & {
    decrypt: (ciphertext: string) => Promise<string | undefined>
    spaces?: boolean
    cache?: ProjectionCache
    nowSeconds?: number
    /** The relay's times read, where NIP-11 says `file_list.times`: the order is then learnt as times ({@link readTopicActivity}). */
    times?: TimesFn
  },
): Promise<YourTopicsRead> {
  const listRead = options.listRead ?? false
  const cache = options.cache ?? createProjectionCache()

  // 1. Every topic's root, and the mute list.
  const first = gathered(query)
  const rootsRead = readAll(first.query, [{ kinds: [KIND_TOPIC] }])
  const mutedOpened = first.query([mutedFilter(me)]).then((events) => mutedOf(events, me, options.decrypt))
  // Its failure is the roots' too, and said by them.
  mutedOpened.catch(() => {})
  first.send()
  const roots = topicRoots(await rootsRead)
  const addresses = [...roots.keys()]
  if (addresses.length === 0) return { me, topics: [], at: new Map(), muted: await mutedOpened }

  // 2. How the viewer is in each, which are spaces, and (without the list read) each topic's fields.
  const second = gathered(query)
  const partRead = readAll(second.query, [changesNamingFilter(me, addresses)])
  const statesRead = readAll(second.query, teamListFilters(roots))
  // Without the list read: each topic's changes as `resolveForeignRoots` and `topicLists` read them.
  const objectChangesRead = listRead ? Promise.resolve([]) : second.query(addresses.map(plainChangesFilter))
  const listChangesRead = listRead ? Promise.resolve([]) : readAll(second.query, addresses.map(topicListFilter))
  second.send()
  const [part, states, objectChanges, listChanges] = await Promise.all([partRead, statesRead, objectChangesRead, listChangesRead])
  const spaces = spacesOf(states, addresses)
  const byTopic = eventsByTopic(part)
  const facts = { roots, byTopic, states, spaces }
  const inIt = (object: ForeignObject) => {
    const topic = readTopicOf(object, me, facts)
    return topic && topic.yours && (options.spaces || !topic.space) ? topic : undefined
  }
  let objects: ForeignObject[]
  let listed: SignedEvent[] = []
  if (listRead) {
    // 3. Whether the viewer is in a topic does not depend on its fields, so its root alone says which could be theirs:
    // only those are read as their current fields, not every topic in the workspace (ALO-22: 25 of Miky's 64). The
    // mute list is not waited for: muting leaves out a topic below, and decides nothing here.
    const maybe = projectTopics([...roots.values()], false).flatMap((object) => (inIt(object) ? [object.address!] : []))
    listed = maybe.length > 0 ? await newestChanges(query, maybe) : []
    const answered = new Set(topicRoots(listed).keys())
    objects = projectTopics([...maybe.filter((address) => answered.has(address)).map((address) => roots.get(address)!), ...listed], true)
    // A topic the list read did not answer (deleted) is read plain, as a parent is.
    const unanswered = maybe.filter((address) => !answered.has(address))
    if (unanswered.length > 0) objects.push(...projectTopics([...unanswered.map((address) => roots.get(address)!), ...(await query(unanswered.map(plainChangesFilter)))], false))
  } else objects = projectTopics([...roots.values(), ...objectChanges], false)
  const muted = await mutedOpened
  const mine = (object: ForeignObject) => {
    const topic = inIt(object)
    return topic && !muted?.has(topic.address) ? topic : undefined
  }
  const candidates: Omit<ReadTopic, 'listed'>[] = []
  for (const object of objects) {
    const topic = mine(object)
    if (topic && !isArchived(topic.object)) candidates.push(topic)
  }
  if (candidates.length === 0) return { me, topics: [], at: new Map(), muted }

  // 4. Their listed ids, what the list read skipped, and their parents' manifests.
  const asked = candidates.map((topic) => topic.address)
  const listEvents = listRead ? listed : listChanges
  const plan = listReadPlan(asked, roots, listEvents, listRead)
  const parents = candidates.flatMap((topic) => {
    const parent = topic.object.parentRef ? addressPointerOf(topic.object.parentRef) : null
    return parent ? [parent] : []
  })
  const third = gathered(query)
  const resolvedRead = plan.ids.length ? resolveIds(third.query, plan.ids, options.fileKinds) : Promise.resolve(new Map())
  const againRead = readAll(third.query, plan.again)
  const seeded = seedManifests(parents, third.query, cache)
  third.send()
  const [resolved, again] = await Promise.all([resolvedRead, againRead, seeded])
  const lists = listsFrom(asked, roots, [...listEvents, ...again], resolved)
  const topics: ReadTopic[] = candidates.map((topic) => ({ ...topic, listed: lists.get(topic.address) ?? [] }))

  // 5. Their parents, while their activity is read: one archived with a parent is left out after.
  const [activity] = await Promise.all([
    readTopicActivity(query, activityTopics(topics), { nowSeconds: options.nowSeconds, times: options.times }),
    markTopicsArchivedWith(
      topics.map((topic) => topic.object),
      query,
      cache,
      listRead ? FILE_KINDS : [],
    ),
  ])
  const open = topics.filter((topic) => !isArchived(topic.object))
  const newest = byActivity(activity.at)
  open.sort((a, b) => newest(a.address, b.address))
  return { me, topics: open, at: new Map(open.map((topic) => [topic.address, activity.at.get(topic.address) ?? 0])), muted }
}

/** A topic's changes as {@link resolveForeignRoots} reads them plain: the newest 500 naming it by `a`. */
function plainChangesFilter(address: string): Record<string, unknown> {
  return { kinds: [KIND_CHANGE], '#a': [address], limit: PLAIN_CHANGES_LIMIT }
}

/** The viewer's muted keys from a read of their mute list: none without one, `undefined` when it does not open. */
async function mutedOf(
  events: readonly SignedEvent[],
  me: string,
  decrypt: (ciphertext: string) => Promise<string | undefined>,
): Promise<ReadonlySet<string> | undefined> {
  const list = events
    .filter((e) => e.pubkey === me && e.kind === KIND_APP_DATA && e.tags.some((t) => t[0] === 'd' && t[1] === MUTED_D_TAG))
    .sort((a, b) => b.created_at - a.created_at)[0]
  if (!list) return new Set()
  const parsed = parseMutedBlob((await decrypt(list.content).catch(() => undefined)) ?? '')
  return parsed ? new Set(parsed.keys) : undefined
}

/**
 * A query that holds every request made through it until {@link send}, then
 * asks them all as one request and hands each caller what its own filters
 * would have been answered alone ({@link answeredBy}). A request made after
 * `send` (a later page), and a list read, which a relay takes only alone, go
 * straight through.
 */
function gathered(query: QueryFn): { query: QueryFn; send(): void } {
  let held: { filters: Record<string, unknown>[]; resolve: (events: SignedEvent[]) => void; reject: (error: unknown) => void }[] | null = []
  return {
    query: (filters) => {
      if (!held || filters.some((filter) => 'fields' in filter)) return query(filters)
      const asks = held
      return new Promise((resolve, reject) => asks.push({ filters, resolve, reject }))
    },
    send() {
      const asks = held ?? []
      held = null
      if (asks.length === 0) return
      query(asks.flatMap((ask) => ask.filters)).then(
        (events) => {
          for (const ask of asks) {
            const page = new Map<string, SignedEvent>()
            for (const filter of ask.filters) for (const event of answeredBy(events, filter)) page.set(event.id, event)
            ask.resolve([...page.values()])
          }
        },
        (error: unknown) => {
          for (const ask of asks) ask.reject(error)
        },
      )
    },
  }
}

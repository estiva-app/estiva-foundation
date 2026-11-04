/**
 * A topic's list of files — SPEC §6.14 "A file's list of other files"; record
 * why: https://github.com/estiva-app/estiva-docs/blob/main/decisions/a-topic-keeps-its-own-list-of-files.md
 *
 * A topic lists files from any Folder, one entry per file, by the file's id.
 * An entry is a `kind:1851` change on the topic: `a` and `O` name the topic,
 * `field` is `lists:<d>`, `value` is `true` or `false`, `h` is the topic's
 * Folder, then `ts`, then `["o", <d>]` naming the listed file. The newest
 * entry per topic and file counts (§6.3).
 *
 * `O` is the file the change is about and `o` another file it points at
 * (why: https://github.com/estiva-app/estiva-docs/blob/main/decisions/a-change-is-about-its-file-as-a-comment-is.md),
 * so `#o` asks which topics list a file and `#O` asks what changed on a topic,
 * and a file's own changes never include a topic's entry about it.
 *
 * Here rather than in each app because Peek, Ship and Leaf all add, remove
 * and read entries, and a reader rule kept in one of them only is a list that
 * reads differently in the next.
 *
 * ## What a listing is not
 *
 * It grants nothing: who reads the listed file is its own Folder's rule. It is
 * not a mention, not a parent and not a Folder's listing, so Mentioned in, the
 * archive chain and a Folder move all ignore it. It carries no `p`, so it adds
 * nobody to the file (§11.8).
 */
import { type SignedEvent, type UnsignedEvent } from '@estiva-app/protocol'
import { RELAY_PAGE_CEILING } from '@estiva-app/protocol'
import {
  byOrder,
  candidateFilesOf,
  fileContext,
  foldMemberships,
  HORIZON_SECONDS,
  membersOf,
  membershipJudges,
  REPLY_FLOOR_CONTEXT,
  streamHasUnread,
  streamTermsOf,
  THREAD_RULE_FROM,
  type MembershipRead,
} from '@estiva-app/conversation'
import {
  conversationsOf,
  folderOf,
  isArchived,
  KIND_FOLDER_STATE,
  resolveForeignRoots,
  type ForeignObject,
  type ProjectionCache,
  type QueryFn,
} from './projection.js'

const KIND_CHANGE = 1851
/** The topic (bare file) kind: the only lists this stage reads (Miky, 2026-10-30). */
const KIND_TOPIC = 30840
const KIND_FOLDER = 39000
const KIND_COMMENT = 1111
/** Listed ids resolved per request: 2 × this stays under a relay's usual `limit` cap. */
const RESOLVE_BATCH = 100
/**
 * The file kinds a listed id is looked for under by default: topic, document,
 * project, issue. Never a bare `#d`, since a Folder's `kind:39000` shares its
 * uuid (§11.1). An app that knows more kinds from manifests passes them.
 */
export const LISTED_FILE_KINDS: readonly number[] = [30840, 30842, 30850, 30851]

const ADDRESS = /^(\d+):([0-9a-f]{64}):(.+)$/
const FIELD_PREFIX = 'lists:'

/** The field an entry for `file` sets: `lists:<d>`. */
export function listsField(file: string): string {
  return `${FIELD_PREFIX}${file}`
}

/** The file a list carries entries on, as a write needs it. */
export interface ListHolder {
  /** Its address, `<kind>:<pubkey>:<d>`. */
  address: string
  /** Its Folder, read from its root (`folderOf`), never the Folder it was opened from (§6.2). */
  folder: string
}

function entry(
  pubkey: string,
  createdAtMs: number,
  args: { list: ListHolder; file: string; listed: boolean; note?: string },
): UnsignedEvent {
  const holder = ADDRESS.exec(args.list.address)
  if (!holder) throw new Error(`not a file address: ${JSON.stringify(args.list.address)}`)
  if (!args.list.folder) throw new Error('a list entry names the team of the file that keeps the list')
  if (!args.file || /\s/.test(args.file)) throw new Error(`not a file id: ${JSON.stringify(args.file)}`)
  // A reader ignores a file on its own list (§6.14): refuse it here rather than publish an entry that shows nothing.
  if (args.file === holder[3]) throw new Error('a file is not on its own list')
  if (!Number.isSafeInteger(createdAtMs) || createdAtMs < 0) throw new Error(`not epoch milliseconds: ${createdAtMs}`)
  return {
    pubkey,
    created_at: Math.floor(createdAtMs / 1000),
    kind: KIND_CHANGE,
    tags: [
      ['a', args.list.address],
      ['O', holder[3]],
      ['field', listsField(args.file)],
      ['value', args.listed ? 'true' : 'false'],
      ['h', args.list.folder],
      ['ts', String(createdAtMs)],
      ['o', args.file],
    ],
    // Empty unless the person wrote a note: each app says "added" and "removed" in its own words (§6.14).
    content: args.note ?? '',
  }
}

/**
 * Put a file on a topic's list: `[kind:1851 lists:<d> = true]`, signed by
 * whoever adds it. `file` is the listed file's id (its `d`), from any Folder.
 */
export function planListInTopic(
  pubkey: string,
  createdAtMs: number,
  args: { topic: ListHolder; file: string; note?: string },
): UnsignedEvent[] {
  return [entry(pubkey, createdAtMs, { list: args.topic, file: args.file, listed: true, note: args.note })]
}

/** Take a file off a topic's list: `[kind:1851 lists:<d> = false]`. {@link planListInTopic} in reverse. */
export function planRemoveFromTopic(
  pubkey: string,
  createdAtMs: number,
  args: { topic: ListHolder; file: string; note?: string },
): UnsignedEvent[] {
  return [entry(pubkey, createdAtMs, { list: args.topic, file: args.file, listed: false, note: args.note })]
}

/** Which topics list a file: every entry naming its id in `o`. Fold with {@link listEntries}. */
export function topicsOfFileFilter(file: string): Record<string, unknown> {
  return { kinds: [KIND_CHANGE], '#o': [file] }
}

/** A topic's changes, its list entries among them: `#O` on its id. Fold with {@link listEntries}. */
export function topicListFilter(topic: string): Record<string, unknown> {
  const holder = ADDRESS.exec(topic)
  return { kinds: [KIND_CHANGE], '#O': [holder ? holder[3] : topic] }
}

/** The newest entry for one list and one file. */
export interface ListEntry {
  /** The address of the file keeping the list (a topic). */
  list: string
  /** The listed file's id. */
  file: string
  /** The entry's Folder: its first `h` with a value. */
  folder: string
  /** `true` when the newest entry lists the file. */
  listed: boolean
  event: SignedEvent
}

const tagOf = (event: Pick<SignedEvent, 'tags'>, name: string): string | undefined =>
  event.tags.find((t) => t[0] === name && t[1])?.[1]

/** The file an entry lists: the `<d>` of its `lists:<d>` field, or `null` for any other change. */
const listedIn = (event: Pick<SignedEvent, 'tags'>): string | null => {
  const field = tagOf(event, 'field')
  return field?.startsWith(FIELD_PREFIX) ? field.slice(FIELD_PREFIX.length) || null : null
}

/**
 * The newest entry per list and file, from any mix of changes: the reader
 * rules of §6.14. A change counts as an entry only when its field is
 * `lists:<d>`, one of its `o` tags is that same `<d>` (an `o` the field does
 * not name is some other relation, a move's new parent for one), its `a`
 * names a file whose `d` is its `O`, `<d>` is not that file itself, and it
 * names a Folder. Anything else is skipped, not folded, so a malformed entry
 * never hides a good one. A `value` other than exactly `true` does not list
 * the file.
 *
 * `folderOfList` is §6.2's Folder check against each list's root, applied
 * before the fold: an entry filed in any other Folder must not become the
 * newest and hide the good one before it. A list it answers no Folder for (an
 * unread root, or one naming none) keeps no entry. Without it the check is the
 * caller's; {@link topicsOfFile} and {@link topicList} pass it.
 */
export function listEntries(
  events: readonly SignedEvent[],
  folderOfList?: (list: string) => string | null | undefined,
): ListEntry[] {
  const newest = new Map<string, { event: SignedEvent; file: string }>()
  for (const event of events) {
    if (event.kind !== KIND_CHANGE) continue
    const file = listedIn(event)
    if (!file || !event.tags.some((t) => t[0] === 'o' && t[1] === file)) continue
    const list = tagOf(event, 'a')
    const holder = list ? ADDRESS.exec(list) : null
    const folder = tagOf(event, 'h')
    if (!holder || tagOf(event, 'O') !== holder[3] || file === holder[3] || !folder) continue
    if (folderOfList && folderOfList(list!) !== folder) continue
    const key = `${list}\n${file}`
    const seen = newest.get(key)
    if (!seen || byOrder(seen.event, event) < 0) newest.set(key, { event, file })
  }
  return [...newest.values()].map(({ event, file }) => ({
    list: tagOf(event, 'a')!,
    file,
    folder: tagOf(event, 'h')!,
    listed: event.tags.find((t) => t[0] === 'value')?.[1] === 'true',
    event,
  }))
}

/** The roots of the given list addresses that the reader can read, by address. */
async function rootsOf(query: QueryFn, addresses: readonly string[]): Promise<Map<string, SignedEvent>> {
  const byKindAuthor = new Map<string, { kind: number; pubkey: string; ds: string[] }>()
  for (const address of addresses) {
    const [, kind, pubkey, d] = ADDRESS.exec(address) ?? []
    if (!d) continue
    const key = `${kind}:${pubkey}`
    const group = byKindAuthor.get(key) ?? { kind: Number(kind), pubkey, ds: [] }
    group.ds.push(d)
    byKindAuthor.set(key, group)
  }
  if (byKindAuthor.size === 0) return new Map()
  const filters = [...byKindAuthor.values()].map(({ kind, pubkey, ds }) => ({ kinds: [kind], authors: [pubkey], '#d': ds, limit: ds.length }))
  const roots = new Map<string, SignedEvent>()
  for (const root of await query(filters)) {
    const address = `${root.kind}:${root.pubkey}:${tagOf(root, 'd') ?? ''}`
    const held = roots.get(address)
    // Two versions of one record: NIP-01's later created_at, then the lower id (§6.3).
    if (!held || root.created_at > held.created_at || (root.created_at === held.created_at && root.id < held.id)) roots.set(address, root)
  }
  return roots
}

/** A topic that lists a file. */
export interface FileTopic {
  /** The topic's address. */
  address: string
  /** The topic's root, as the reader read it. */
  root: SignedEvent
  entry: ListEntry
}

/**
 * Which topics list a file — `{kinds:[1851], "#o":[<d>]}`, folded per topic.
 *
 * Keeps an entry only when its newest value lists the file, it is on a topic
 * (only topics' lists are read, Miky 2026-10-30), the topic's root is one the
 * reader can read (a deleted or unreadable topic drops out), and the entry is
 * filed in the topic's own Folder (§6.2). Two reads: the entries, then the
 * topics' roots.
 */
export async function topicsOfFile(query: QueryFn, file: string): Promise<FileTopic[]> {
  const isTopic = (entry: ListEntry) => entry.file === file && entry.list.startsWith(`${KIND_TOPIC}:`)
  const events = await query([topicsOfFileFilter(file)])
  const lists = [...new Set(listEntries(events).filter(isTopic).map((entry) => entry.list))]
  if (lists.length === 0) return []
  const roots = await rootsOf(query, lists)
  const folderOfList = (list: string) => {
    const root = roots.get(list)
    return root ? folderOf(root) : null
  }
  return listEntries(events, folderOfList)
    .filter((entry) => entry.listed && isTopic(entry))
    .map((entry) => ({ address: entry.list, root: roots.get(entry.list)!, entry }))
}

/** A file on a topic's list. */
export interface ListedFile {
  /** The listed file's id. */
  file: string
  /** Its address when exactly one file the reader can read holds the id, else `null`: not drawn, not counted. */
  address: string | null
  entry: ListEntry
}

/**
 * A topic's list, by the topic's address: its entries whose newest value
 * lists the file, filed in the Folder the topic's root names (§6.2; read here,
 * never taken from the caller), in no promised order (sort as the design
 * says; `entry.event` carries the time), each id resolved over `fileKinds` by
 * `#d`. A topic the reader cannot read, or whose root names no Folder, lists
 * nothing. An id held by none the reader can read, or by two, resolves to
 * `null`: a consumer draws and counts only the resolved ones (§3.2, the count
 * is the disclosure).
 */
export async function topicList(
  query: QueryFn,
  topic: string,
  options: { fileKinds?: readonly number[] } = {},
): Promise<ListedFile[]> {
  return (await topicLists(query, [topic], options)).get(topic) ?? []
}

/**
 * Many topics' lists at once, by address (TOP-4, Peek's Topics screen): the
 * rules of {@link topicList} for each, in three requests whatever the number
 * of topics (one more per 100 listed files): the roots, every topic's changes
 * (one `#O` filter per topic) and the batched `#d` resolve, where one
 * `topicList` per topic would be three requests each and trips a relay's rate
 * limit at a few dozen topics. Every address asked for is a key; one that
 * lists nothing, or that the reader cannot read, maps to `[]`.
 */
export async function topicLists(
  query: QueryFn,
  topics: readonly string[],
  options: { fileKinds?: readonly number[] } = {},
): Promise<Map<string, ListedFile[]>> {
  const asked = [...new Set(topics)]
  if (asked.length === 0) return new Map()
  return listsOf(query, asked, rootsOf(query, asked), options)
}

/** {@link topicLists} with the roots already asked for: {@link readTopics} reads them once for everything. */
async function listsOf(
  query: QueryFn,
  asked: readonly string[],
  rootsRead: Promise<ReadonlyMap<string, SignedEvent>>,
  options: { fileKinds?: readonly number[] },
): Promise<Map<string, ListedFile[]>> {
  const out = new Map<string, ListedFile[]>(asked.map((topic) => [topic, []]))
  // One filter per topic in one request, so a relay's cap on an answer cuts no more than it would for that topic alone.
  const [roots, events] = await Promise.all([rootsRead, query(asked.map(topicListFilter))])
  const folderOfList = (list: string) => {
    const root = out.has(list) ? roots.get(list) : undefined
    return root ? folderOf(root) : null
  }
  const entries = listEntries(events, folderOfList)
    .filter((entry) => entry.listed)
    .sort((a, b) => byOrder(a.event, b.event))
  if (entries.length === 0) return out
  const resolved = await resolveIds(query, [...new Set(entries.map((entry) => entry.file))], options.fileKinds)
  for (const entry of entries) out.get(entry.list)!.push({ file: entry.file, address: resolved.get(entry.file) ?? null, entry })
  return out
}

/** A topic as {@link readTopics} reads it. */
export interface ReadTopic {
  address: string
  /** As its roots and changes draw it: its title and summary slots, and `archived`, its own or its parent's (§6.5). */
  object: ForeignObject
  /** Its Folder, from its root (§6.2): where an entry on its list is filed. */
  folder: string
  /** Its list, as {@link topicLists} reads it. */
  listed: ListedFile[]
  /**
   * The viewer is a member (§11.8): by the horizon's membership read, or,
   * where that read has no word on them, over all history — a topic joined
   * before the horizon with nothing since is still theirs, as Peek's Topics
   * says.
   */
  yours: boolean
  /**
   * A team marks it one of its spaces (§3.3): its entry on a team's
   * relay-signed list carries the role `space`. Ship's Topics never draws one.
   * why: https://github.com/estiva-app/estiva-docs/blob/main/decisions/a-space-is-the-teams-own-mark-on-a-topic-it-lists.md
   */
  space: boolean
}

/** The role on a team list's entry that marks a topic one of the team's spaces (§3.3). */
const SPACE_ROLE = 'space'

/**
 * The topics a team's list marks as its spaces: an `a` entry naming the
 * topic, or an `o` entry naming its id, with the role after an empty third
 * element (§3.3). A topic is listed by one team, so a list that names it
 * without the role — one left behind by a move that failed halfway — keeps it
 * a plain topic: no team's people follow a space nobody there chose. An id
 * two topics hold names neither (C31).
 */
function spacesOf(states: readonly SignedEvent[], addresses: readonly string[]): Set<string> {
  const known = new Set(addresses)
  const holders = new Map<string, string[]>()
  for (const address of addresses) {
    const id = address.split(':').slice(2).join(':')
    holders.set(id, [...(holders.get(id) ?? []), address])
  }
  const marked = new Set<string>()
  const plain = new Set<string>()
  for (const state of states) {
    if (state.kind !== KIND_FOLDER_STATE) continue
    for (const [name, value, third, role] of state.tags) {
      const held = name === 'o' ? holders.get(value) : undefined
      const address = name === 'a' && known.has(value) ? value : held?.length === 1 ? held[0] : undefined
      if (!address) continue
      if (role === SPACE_ROLE && !third) marked.add(address)
      else plain.add(address)
    }
  }
  return new Set([...marked].filter((address) => !plain.has(address)))
}

/** Every topic the viewer can read, and the membership read that judges their dots. */
export interface TopicsRead {
  me: string
  topics: ReadTopic[]
  membership: MembershipRead
}

/** The filters for a person's part in some files over all history: the changes naming them, what they wrote, what names them. */
function personInFilesFilters(person: string, files: readonly string[]): Record<string, unknown>[] {
  return [
    { kinds: [KIND_CHANGE], '#a': files, '#p': [person] },
    { kinds: [KIND_COMMENT], '#A': files, authors: [person] },
    { kinds: [KIND_COMMENT], '#a': files, authors: [person] },
    { kinds: [KIND_COMMENT], '#A': files, '#p': [person] },
    { kinds: [KIND_COMMENT], '#a': files, '#p': [person] },
  ]
}

/** Whether an event answers a filter, as NIP-01 reads it: kinds, authors, `#x` tags, `since` and `until`. */
function answers(event: SignedEvent, filter: Record<string, unknown>): boolean {
  const { kinds, authors, since, until } = filter as { kinds?: number[]; authors?: string[]; since?: number; until?: number }
  if (kinds && !kinds.includes(event.kind)) return false
  if (authors && !authors.includes(event.pubkey)) return false
  if (since !== undefined && event.created_at < since) return false
  if (until !== undefined && event.created_at > until) return false
  return Object.entries(filter).every(
    ([key, values]) => !key.startsWith('#') || event.tags.some((t) => t[0] === key.slice(1) && (values as string[]).includes(t[1])),
  )
}

/**
 * Everything the filters match, however many: each asked with a page's
 * `limit`, and a filter whose answer filled it asked again from its oldest
 * second down (`until`), until a page comes back short. One request when
 * nothing fills a page, as at Miky's scale; never a silent cut at the relay's
 * cap. A second holding a page's worth on its own ends the walk there.
 */
async function readAll(query: QueryFn, filters: readonly Record<string, unknown>[]): Promise<SignedEvent[]> {
  const out = new Map<string, SignedEvent>()
  let open = filters.map((filter) => ({ ...filter, limit: RELAY_PAGE_CEILING }))
  while (open.length) {
    const events = await query(open)
    for (const event of events) out.set(event.id, event)
    open = open.flatMap((filter) => {
      const page = events.filter((event) => answers(event, filter))
      if (page.length < filter.limit) return []
      const until = Math.min(...page.map((event) => event.created_at))
      return until === (filter as { until?: number }).until ? [] : [{ ...filter, until }]
    })
  }
  return [...out.values()]
}

/** Whether the person is a member of the file over all history, folded as its own page folds it. */
function memberOverAllHistory(person: string, file: string, events: readonly SignedEvent[]): boolean {
  const [kind, pubkey, ...d] = file.split(':')
  // The root, dated before everything: its author is a member unless a leave of theirs says otherwise.
  const root = { id: '0'.repeat(64), pubkey: pubkey ?? '', kind: Number(kind), created_at: 0, tags: [['d', d.join(':')]], content: '', sig: '' }
  return membersOf(file, [root, ...events]).has(person)
}

/**
 * Every topic the viewer can read, once (SHIPS-2): each with its list, its
 * archive (its own, or with its project), its Folder, whether it is the
 * viewer's and whether a team marks it a space (SHIPS-3) — the one read Ship's
 * Topics, a topic's page and Add to topic draw from, and Leaf's Add to topic too.
 *
 * Three rounds whatever the number of topics: every `kind:30840` root; then
 * the topics as drawn, their lists, the viewer's part in them and the team
 * lists naming them; then the
 * listed ids and archived parents. No conversation is read here:
 * {@link topicConversations} is for a page that draws them.
 *
 * The viewer's part is one read over all history, narrowed to the topics —
 * the changes naming them, what they wrote, what names them — and the
 * horizon's membership is folded from the part of it inside the horizon, as
 * {@link membershipQueries} would have read it for these files. On
 * production, QA-2's horizon read over every file was 500 KB; over the topics
 * it is a few.
 *
 * "Yours" is today's membership fold (§11.8); following replaces it in this
 * same function (Teams and following, milestone 5).
 * why: https://github.com/estiva-app/estiva-docs/blob/main/decisions/a-topic-keeps-its-own-list-of-files.md
 */
export async function readTopics(
  query: QueryFn,
  me: string,
  options: { cache?: ProjectionCache; fileKinds?: readonly number[]; nowSeconds?: number } = {},
): Promise<TopicsRead> {
  const nowSeconds = options.nowSeconds ?? Math.floor(Date.now() / 1000)
  const rootEvents = await readAll(query, [{ kinds: [KIND_TOPIC] }])
  const roots = new Map<string, SignedEvent>()
  for (const root of rootEvents) {
    if (root.kind !== KIND_TOPIC) continue
    const address = `${root.kind}:${root.pubkey}:${tagOf(root, 'd') ?? ''}`
    const held = roots.get(address)
    // Two versions of one record: NIP-01's later created_at, then the lower id (§6.3).
    if (!held || root.created_at > held.created_at || (root.created_at === held.created_at && root.id < held.id)) roots.set(address, root)
  }
  const addresses = [...roots.keys()]
  if (addresses.length === 0) return { me, topics: [], membership: foldMemberships(me, [], nowSeconds) }
  const [objects, lists, part, states] = await Promise.all([
    resolveForeignRoots(addresses, query, options.cache, { archivedWith: true }),
    listsOf(query, addresses, Promise.resolve(roots), options),
    // Held once each, though one comment can answer two of the filters: the folds count events.
    readAll(query, personInFilesFilters(me, addresses)),
    // The team lists naming a topic, for which of them are spaces.
    readAll(query, [
      { kinds: [KIND_FOLDER_STATE], '#a': addresses },
      { kinds: [KIND_FOLDER_STATE], '#o': [...roots.values()].map((root) => tagOf(root, 'd') ?? '') },
    ]),
  ])
  const spaces = spacesOf(states, addresses)
  const membership = foldMemberships(me, part.filter((e) => e.created_at >= nowSeconds - HORIZON_SECONDS), nowSeconds)
  // Each topic's own events, so each is folded over its own and not over all of them.
  const byTopic = new Map<string, SignedEvent[]>()
  for (const event of part) for (const file of candidateFilesOf(event)) byTopic.set(file, [...(byTopic.get(file) ?? []), event])
  const none = new Set<string>()
  const topics = objects.flatMap((object): ReadTopic[] => {
    const root = object.address ? roots.get(object.address) : undefined
    const folder = root ? folderOf(root) : null
    if (!root || !folder || object.unreachable) return []
    const address = object.address!
    const yours =
      streamTermsOf(address, membership, me, none).member || (!membershipJudges(address, membership, me) && memberOverAllHistory(me, address, byTopic.get(address) ?? []))
    return [{ address, object, folder, listed: lists.get(address) ?? [], yours, space: spaces.has(address) }]
  })
  return { me, topics, membership }
}

// An untitled topic sorts where the apps' "Untitled topic" would.
const titleOf = (topic: ReadTopic) => topic.object.slots.title?.value || 'Untitled topic'

/**
 * What Add to topic offers: the open topics in a Folder the viewer is in —
 * `folders`, the Folders the relay lists for them, where it accepts their
 * entry — theirs first, then the rest, each A–Z. An archived topic, its own
 * or with its project, is read-only and is not offered.
 */
export function addableTopics(read: TopicsRead, folders: ReadonlySet<string>): { yours: ReadTopic[]; others: ReadTopic[] } {
  const open = read.topics
    .filter((topic) => !isArchived(topic.object) && folders.has(topic.folder))
    .sort((a, b) => titleOf(a).localeCompare(titleOf(b)))
  return { yours: open.filter((topic) => topic.yours), others: open.filter((topic) => !topic.yours) }
}

/** A topic's conversations in Peek: how many, and whether one has something new for the viewer. */
export interface TopicConversation {
  /** Thread roots addressed to the topic, as Peek's Topics badge counts them. */
  conversations: number
  /** Peek's dot: only on an open topic of the viewer's. */
  unread: boolean
  /** How many of its conversations have something new for the viewer, judged as the dot is: `unread` is `fresh > 0`. */
  fresh: number
}

/**
 * Each topic's conversations and dot, as Peek's Topics shows them (SHIPS-2):
 * the count is the thread roots addressed to the topic (`conversationsOf`),
 * the dot is {@link streamHasUnread} on the topic's own marker, gated by
 * membership (§11.8), on the viewer's open topics only. `fresh` is the same
 * judge over each thread alone (a root and its replies), so Ship's Topics can
 * say how many of them are new where Peek shows the dot (SHIPS-3).
 *
 * The read state and the muted list are encrypted, so the app hands in what
 * it holds: `merged` (the merged markers, once the first merge has landed)
 * and `muted`. Replies are read only for the topics a dot is judged on, and
 * only from the latest second before which none can be unread: the thread
 * rule's cut-over, the reply floor, and when the viewer joined (§11.3: a
 * reply is read by its thread's marker or the floor, never the topic's).
 */
export async function topicConversations(
  read: TopicsRead,
  query: QueryFn,
  state: { merged: Readonly<Record<string, number>>; muted: ReadonlySet<string>; nowSeconds?: number },
  options: { cache?: ProjectionCache } = {},
): Promise<Map<string, TopicConversation>> {
  const nowSeconds = state.nowSeconds ?? Math.floor(Date.now() / 1000)
  const terms = (address: string) => streamTermsOf(address, read.membership, read.me, state.muted)
  const judged = new Set(read.topics.filter((topic) => topic.yours && !isArchived(topic.object)).map((topic) => topic.address))
  const repliesSince = (address: string) => {
    if (!judged.has(address)) return null
    const floor = state.merged[REPLY_FLOOR_CONTEXT]
    return Math.max(THREAD_RULE_FROM, floor ?? 0, terms(address).since ?? 0)
  }
  const files = read.topics.map((topic) => ({ ...topic.object, ref: topic.address }))
  const held = await conversationsOf(files, query, options.cache, { replies: true, repliesSince })
  const out = new Map<string, TopicConversation>()
  for (const topic of read.topics) {
    const messages = held[topic.address]
    if (!messages) continue
    const context = fileContext(topic.address)
    let fresh = 0
    if (context && judged.has(topic.address)) {
      // A reply from before the thread rule's cut-over never lit a row (CON-34).
      const threads = new Map<string, (typeof messages)[number][]>()
      for (const m of messages) {
        if (m.root !== m.id && m.at < THREAD_RULE_FROM) continue
        const thread = threads.get(m.root)
        if (thread) thread.push(m)
        else threads.set(m.root, [m])
      }
      const topicTerms = terms(topic.address)
      const frontier = { merged: state.merged, me: read.me, nowSeconds, horizonSeconds: HORIZON_SECONDS }
      // Every thread here is one of the topic's: `conversationsOf` keeps a reply only under a root of this file.
      for (const thread of threads.values()) {
        if (streamHasUnread(thread, context, topicTerms, frontier, (id) => read.membership.mentioned.has(id))) fresh++
      }
    }
    out.set(topic.address, { conversations: messages.filter((m) => m.root === m.id).length, unread: fresh > 0, fresh })
  }
  return out
}

/** Each id's address when exactly one file of `fileKinds` the reader can read holds it; an id held by none or by two is left out. */
async function resolveIds(query: QueryFn, ids: readonly string[], fileKinds?: readonly number[]): Promise<Map<string, string>> {
  // Never a Folder's `39000`, which shares its uuid (§11.1): an id only a Folder holds resolves to nothing.
  const kinds = (fileKinds ?? LISTED_FILE_KINDS).filter((kind) => kind !== KIND_FOLDER)
  // Room for a second holder of every id, so two holders are seen as two; in
  // batches, so a relay's cap on `limit` cannot cut a long list short.
  const batches: string[][] = []
  for (let i = 0; i < ids.length; i += RESOLVE_BATCH) batches.push(ids.slice(i, i + RESOLVE_BATCH))
  const answers = await Promise.all(batches.map((batch) => query([{ kinds, '#d': batch, limit: batch.length * 2 }])))
  // An answer that filled its limit may have cut a second holder (newest
  // first), and one holder would then pass for the only one: every id of that
  // batch stays unresolved rather than drawn as somebody else's file.
  const unsure = new Set(batches.flatMap((batch, i) => (answers[i].length >= batch.length * 2 ? batch : [])))
  const holders = new Map<string, Set<string>>()
  for (const event of answers.flat()) {
    const d = tagOf(event, 'd')
    if (!d || !kinds.includes(event.kind)) continue
    const set = holders.get(d) ?? new Set<string>()
    set.add(`${event.kind}:${event.pubkey}`)
    holders.set(d, set)
  }
  const out = new Map<string, string>()
  for (const [d, set] of holders) if (set.size === 1 && !unsure.has(d)) out.set(d, `${[...set][0]}:${d}`)
  return out
}

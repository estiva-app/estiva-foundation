/**
 * The conversations of every file a topic lists, read in one go and kept live
 * — the read behind a topic's All (SPEC §11.8).
 *
 * All reads the files on the topic's list and nothing under them: a listed
 * project's issues, a listed Folder's files and a listed page's sub-pages are
 * not here (Miky, 2026-11-06). Each file's events are returned as the shared
 * fold's input (`foldThreads`, `@estiva-app/conversation`), so the app folds
 * each file as its own pane would and every app draws the same threads.
 *
 * why: https://github.com/estiva-app/estiva-docs/blob/main/decisions/a-topic-keeps-its-own-list-of-files.md
 * why: https://github.com/estiva-app/estiva-docs/blob/main/decisions/what-belongs-to-a-file-is-stored-with-it.md
 * why: https://github.com/estiva-app/estiva-docs/blob/main/decisions/a-conversation-is-one-shared-thing-and-only-its-colours-are-the-apps.md
 *
 * ## The cold read
 *
 * 1. Every listed file's comments and replies: `kind:1111` by `#A` (its
 *    address) and by `#O` (its id), always both (§6.4: a comment may carry
 *    either form). The A/O rules decide which file each one is about
 *    (`isAbout`), so a comment whose `A` and `O` name different files is about
 *    neither. An owning app's older comment kinds (`emits.alsoRead`, Ship's
 *    `kind:9`) are read by `#a` when its manifest resolves; a file whose
 *    manifest does not resolve still has its `1111`s read.
 * 2. One `#e` read on what those name: edits (`40003`), resolve and reopen
 *    (`9101`), deletions (`5`), the older kinds' replies, and reactions (`7`)
 *    on each file's newest 100 messages (`REACTION_HORIZON`), as each file's
 *    own pane asks (§6.6) — the cut is reported per file.
 *
 * About three requests for a topic of eight files, whatever their number up to
 * `MAX_FILTERS_PER_QUERY / 2`. A listed id the reader cannot resolve is left
 * out, not returned as an unreachable entry: the count is the disclosure
 * (§6.14, §3.2).
 */
import { MAX_FILTERS_PER_QUERY, RELAY_PAGE_CEILING, referenceToPointer, type LiveRelay, type SignedEvent } from '@estiva-app/protocol'
import {
  editTargetOf,
  groupThreads,
  isAbout,
  isCommentOn,
  isReply,
  KIND_ASSERTION,
  KIND_COMMENT,
  KIND_DELETION,
  KIND_EDIT,
  KIND_REACTION,
  parentOf,
  reactionHorizon,
  reactionTargetOf,
  resolutionTargetOf,
} from '@estiva-app/conversation'
import { commentKindsOf, resolveManifest, type ProjectionCache, type QueryFn } from './projection.js'
import { topicList, type ListedFile } from './topics.js'

/** The bare file has no owner, so no older comment kinds: its comments are `kind:1111` (§6.4). */
const KIND_BARE_FILE = 30840
/** Ids per `#e` filter: a comfortable fraction of the relay's page, as `decorationsOf` asks. */
const IDS_PER_FILTER = 100

/** One listed file's conversation, as the shared fold takes it. */
export interface ListedConversation {
  /** The listed file's id. */
  file: string
  address: string
  /** Its Folder, from its root, or `null` when the root names none. */
  folder: string | null
  /**
   * Every event its threads need, unordered: its comments and their replies,
   * and what the `#e` read returned on them. Pass to `foldThreads`.
   */
  events: SignedEvent[]
  /** A comment read for it came back at the relay's page ceiling: its oldest comments may be missing. */
  commentsCut: boolean
  /** Its messages past the reaction horizon, not asked about reactions (§6.6: a cap is reported). */
  reactionTargetsOmitted: number
  /** Its reaction read came back at the page ceiling, so some reactions may be missing. */
  reactionEventsCut: boolean
  /** Its edit, resolution and deletion read came back at the page ceiling. */
  editEventsCut: boolean
  /** @internal The comment kinds its owning app used to publish, read by `#a` (`emits.alsoRead`). */
  olderKinds: readonly number[]
}

/** What {@link listedConversations} read. */
export interface ListedConversations {
  /** The listed files the reader can resolve, in the list's order. */
  files: ListedConversation[]
}

/** The conversations of every file the topic at `topic` lists: its list read, then {@link listedConversationsOf}. */
export async function listedConversations(
  query: QueryFn,
  topic: string,
  options: { cache?: ProjectionCache; fileKinds?: readonly number[] } = {},
): Promise<ListedConversations> {
  return listedConversationsOf(query, await topicList(query, topic, options.fileKinds ? { fileKinds: options.fileKinds } : {}), options)
}

/**
 * The conversations of `listed`, a topic's list already read (`topicList`,
 * `readTopics`). Files left unresolved are left out. A refused read is
 * whatever `query` does with one.
 */
export async function listedConversationsOf(
  query: QueryFn,
  listed: readonly ListedFile[],
  options: { cache?: ProjectionCache } = {},
): Promise<ListedConversations> {
  const unique = new Map<string, ListedFile & { address: string }>()
  for (const entry of listed) if (entry.address && !unique.has(entry.address)) unique.set(entry.address, { ...entry, address: entry.address })
  const files = [...unique.values()]
  if (files.length === 0) return { files: [] }

  const olderKinds = await olderKindsOf(files.map((f) => f.address), query, options.cache)

  // 1. Comments and replies, two filters per file (three with older kinds), so one busy file cannot starve another.
  const filters = files.flatMap((f) => {
    const older = olderKinds.get(f.address) ?? []
    return [
      { kinds: [KIND_COMMENT], '#A': [f.address], limit: RELAY_PAGE_CEILING },
      { kinds: [KIND_COMMENT], '#O': [f.file], limit: RELAY_PAGE_CEILING },
      ...(older.length > 0 ? [{ kinds: older, '#a': [f.address], limit: RELAY_PAGE_CEILING }] : []),
    ]
  })
  const comments = await readAll(query, filters)

  const out: ListedConversation[] = files.map((f) => ({
    file: f.file,
    address: f.address,
    folder: f.folder,
    events: [],
    commentsCut: false,
    reactionTargetsOmitted: 0,
    reactionEventsCut: false,
    editEventsCut: false,
    olderKinds: olderKinds.get(f.address) ?? [],
  }))
  for (const conversation of out) {
    const byA = comments.filter((e) => e.kind === KIND_COMMENT && e.tags.some((t) => t[0] === 'A' && t[1] === conversation.address))
    const byO = comments.filter((e) => e.kind === KIND_COMMENT && e.tags.some((t) => t[0] === 'O' && t[1] === conversation.file))
    const byOlder = comments.filter((e) => conversation.olderKinds.includes(e.kind) && e.tags.some((t) => t[0] === 'a' && t[1] === conversation.address))
    conversation.commentsCut = [byA, byO, byOlder].some((answer) => answer.length >= RELAY_PAGE_CEILING)
    conversation.events = comments.filter((e) => belongsAsComment(e, conversation))
  }

  // 2. What names them by `#e`, one request for every file.
  const targetsOf = out.map((conversation) => {
    const { missingRoots, replies } = groupThreads(conversation.events)
    return [
      ...conversation.events.map((e) => ({ id: e.id, at: e.created_at })),
      ...missingRoots.map((id) => ({ id, at: replies[id]?.[0]?.created_at ?? 0 })),
    ]
  })
  const fileOf = new Map<string, number>()
  targetsOf.forEach((targets, i) => targets.forEach((t) => fileOf.set(t.id, i)))
  const inHorizon = new Set<string>()
  targetsOf.forEach((targets, i) => {
    const { asked, omitted } = reactionHorizon(targets)
    out[i].reactionTargetsOmitted = omitted
    for (const id of asked) inHorizon.add(id)
  })
  const allOlder = [...new Set(out.flatMap((c) => c.olderKinds))]
  const editChunks = chunked([...fileOf.keys()])
  const reactionChunks = chunked([...inHorizon])
  const named = await readAll(query, [
    ...editChunks.map((ids) => ({ kinds: [KIND_EDIT, KIND_ASSERTION, KIND_DELETION, ...allOlder], '#e': ids, limit: RELAY_PAGE_CEILING })),
    ...reactionChunks.map((ids) => ({ kinds: [KIND_REACTION], '#e': ids, limit: RELAY_PAGE_CEILING })),
  ])

  const have = out.map((c) => new Set(c.events.map((e) => e.id)))
  const answered = { edit: new Array<number>(editChunks.length).fill(0), reaction: new Array<number>(reactionChunks.length).fill(0) }
  const chunkOf = (chunks: string[][]) => new Map(chunks.flatMap((ids, i) => ids.map((id) => [id, i] as const)))
  const editChunkOf = chunkOf(editChunks)
  const reactionChunkOf = chunkOf(reactionChunks)
  for (const event of named) {
    for (const i of filesNamedBy(event, (id) => fileOf.get(id), inHorizon, (i, kind) => out[i].olderKinds.includes(kind))) {
      if (have[i].has(event.id)) continue
      have[i].add(event.id)
      out[i].events.push(event)
    }
    const target = event.kind === KIND_REACTION ? reactionTargetOf(event) : firstNamed(event, editChunkOf)
    const chunk = target === undefined ? undefined : (event.kind === KIND_REACTION ? reactionChunkOf : editChunkOf).get(target)
    if (chunk !== undefined) (event.kind === KIND_REACTION ? answered.reaction : answered.edit)[chunk] += 1
  }
  answered.edit.forEach((n, chunk) => {
    if (n >= RELAY_PAGE_CEILING) for (const id of editChunks[chunk]) out[fileOf.get(id)!].editEventsCut = true
  })
  answered.reaction.forEach((n, chunk) => {
    if (n >= RELAY_PAGE_CEILING) for (const id of reactionChunks[chunk]) out[fileOf.get(id)!].reactionEventsCut = true
  })

  return { files: out }
}

/** A comment or reply about the file (§6.4's A/O rules), or a root of an older kind the owner declared. */
function belongsAsComment(event: SignedEvent, conversation: Pick<ListedConversation, 'address' | 'olderKinds'>): boolean {
  if (event.kind === KIND_COMMENT) return isAbout(event, conversation.address)
  return conversation.olderKinds.includes(event.kind) && isCommentOn(event, conversation.address, conversation.olderKinds)
}

/**
 * Which files an event read by `#e` belongs to, by the id it names: an edit's
 * and a resolution's target, a reaction's (only inside its file's horizon), a
 * deletion's every `e`, an older-kind reply's parent.
 */
function filesNamedBy(
  event: SignedEvent,
  fileOf: (id: string) => number | undefined,
  inHorizon: ReadonlySet<string>,
  olderKindOf: (file: number, kind: number) => boolean,
): number[] {
  const one = (id: string | null | undefined) => {
    const i = id ? fileOf(id.toLowerCase()) ?? fileOf(id) : undefined
    return i === undefined ? [] : [i]
  }
  switch (event.kind) {
    case KIND_REACTION: {
      const target = reactionTargetOf(event)
      return target && inHorizon.has(target) ? one(target) : []
    }
    case KIND_EDIT:
      return one(editTargetOf(event))
    case KIND_ASSERTION:
      return one(resolutionTargetOf(event))
    case KIND_DELETION:
      return [...new Set(event.tags.filter((t) => t[0] === 'e' && t[1]).flatMap((t) => one(t[1])))]
    default: {
      if (!isReply(event)) return []
      return one(parentOf(event)).filter((i) => olderKindOf(i, event.kind))
    }
  }
}

/** The first `e` an event names that a chunk holds — what counts it against that chunk's page. */
function firstNamed(event: SignedEvent, chunkOf: ReadonlyMap<string, number>): string | undefined {
  return event.tags.find((t) => t[0] === 'e' && t[1] && chunkOf.has(t[1]))?.[1]
}

/** Each owned file's older comment kinds, one manifest per app; a manifest that cannot be read declares none. */
async function olderKindsOf(addresses: readonly string[], query: QueryFn, cache?: ProjectionCache): Promise<Map<string, number[]>> {
  const byApp = new Map<string, string[]>()
  for (const address of addresses) {
    const [kind, pubkey] = address.split(':')
    if (Number(kind) === KIND_BARE_FILE) continue
    const key = `${kind}:${pubkey}`
    byApp.set(key, [...(byApp.get(key) ?? []), address])
  }
  const out = new Map<string, number[]>()
  await Promise.all(
    [...byApp.values()].map(async (owned) => {
      let kinds: number[] = []
      try {
        const resolved = await resolveManifest(referenceToPointer(owned[0]), query, cache)
        kinds = resolved ? commentKindsOf(resolved.manifest).filter((kind) => kind !== KIND_COMMENT) : []
      } catch {
        kinds = []
      }
      for (const address of owned) out.set(address, kinds)
    }),
  )
  return out
}

/** Every filter answered, `MAX_FILTERS_PER_QUERY` per request, each event once. */
async function readAll(query: QueryFn, filters: Record<string, unknown>[]): Promise<SignedEvent[]> {
  const seen = new Map<string, SignedEvent>()
  for (let start = 0; start < filters.length; start += MAX_FILTERS_PER_QUERY) {
    for (const event of await query(filters.slice(start, start + MAX_FILTERS_PER_QUERY))) if (!seen.has(event.id)) seen.set(event.id, event)
  }
  return [...seen.values()]
}

function chunked<T>(list: readonly T[], size = IDS_PER_FILTER): T[][] {
  const out: T[][] = []
  for (let i = 0; i < list.length; i += size) out.push(list.slice(i, i + size))
  return out
}

/** A live watch's handle. */
export interface ListedWatch {
  /** Idempotent. Closes its subscriptions. */
  stop(): void
}

/**
 * The most filters one live `REQ` may carry on our relay. Over it, the relay
 * answers only a `NOTICE` ("REQ contains 14 filters, maximum is 10", measured
 * 6 Nov) — no `CLOSED`, no `EOSE` — so a watch past it hears nothing and says
 * nothing. `POST /query` takes 128 (`MAX_FILTERS_PER_QUERY`); a socket does not.
 */
export const MAX_FILTERS_PER_REQ = 10

/** Wait before a watch that has learnt a new id asks again, so a burst of messages costs one new REQ. */
export const LISTED_WATCH_REBUILD_MS = 250

/**
 * Hear, live, every new event on the files `read` holds, each handed to its
 * file: a new comment or reply about one (`#A`, `#O`, and `#a` for an owner's
 * older kinds), and an edit, resolution, reaction or deletion naming any
 * message the watch knows (`#e`). One REQ for all of them (another per
 * {@link MAX_FILTERS_PER_REQ} filters, past about 700 messages), asked again — a
 * moment later, from the newest second it has seen — whenever a new message
 * or reaction gives it another id to listen for, so a reaction to a comment
 * written a second ago is heard. Each event is handed over once; the cold
 * read's are never handed over.
 *
 * ## Naming the files' teams (`namesTeams`, on by default)
 *
 * The decided shape asks by file alone (Miky, 2026-11-06). Our relay does not
 * yet deliver a team's event live to a subscription that names no team
 * (buzz `fan_out_scoped`; measured 6 Nov: by `#A` or `#e` alone, nothing), so
 * until it does every filter also carries the `#h` of each listed file's team
 * and of every team a comment on them was filed in. Turn it off once the
 * relay delivers by file — the Ship issue on the relay in "Topics: Main and
 * All" — and the filters are the decided ones unchanged.
 */
export function watchListedConversations(
  relay: Pick<LiveRelay, 'subscribe'>,
  read: ListedConversations,
  onEvent: (file: string, event: SignedEvent) => void,
  options: {
    /** Unix seconds to hear from. Defaults to the newest event the read holds, else now. */
    since?: number
    namesTeams?: boolean
    onClosed?: (reason: string) => void
    now?: () => number
    setTimer?: (run: () => void, ms: number) => unknown
    clearTimer?: (timer: unknown) => void
  } = {},
): ListedWatch {
  const files = read.files.map((c) => ({ ...c, ids: new Set(c.events.map((e) => e.id)) }))
  // This package assumes no environment's typings; every JS runtime has both.
  const timers = globalThis as unknown as { setTimeout(run: () => void, ms: number): unknown; clearTimeout(timer: unknown): void }
  const setTimer = options.setTimer ?? ((run: () => void, ms: number) => timers.setTimeout(run, ms))
  const clearTimer = options.clearTimer ?? ((timer: unknown) => timers.clearTimeout(timer))
  const seen = new Set(files.flatMap((f) => [...f.ids]))
  const teams = new Set<string>()
  for (const f of read.files) {
    if (f.folder) teams.add(f.folder)
    for (const e of f.events) if (e.kind !== KIND_REACTION && e.kind !== KIND_DELETION) addTeam(teams, e)
  }
  const newest = Math.max(0, ...read.files.flatMap((f) => f.events.map((e) => e.created_at)))
  let since = options.since ?? (newest > 0 ? newest : Math.floor((options.now ?? Date.now)() / 1000))
  const namesTeams = options.namesTeams ?? true

  let subs: { close(): void }[] = []
  let timer: unknown = null
  let stopped = false

  const filtersNow = (): Record<string, unknown>[] => {
    const older = [...new Set(files.flatMap((f) => f.olderKinds))]
    const byFile: Record<string, unknown>[] = [
      { kinds: [KIND_COMMENT], '#A': files.map((f) => f.address) },
      { kinds: [KIND_COMMENT], '#O': files.map((f) => f.file) },
      ...(older.length > 0 ? [{ kinds: older, '#a': files.filter((f) => f.olderKinds.length > 0).map((f) => f.address) }] : []),
      ...chunked([...new Set(files.flatMap((f) => [...f.ids]))]).map((ids) => ({
        kinds: [KIND_REACTION, KIND_DELETION, KIND_EDIT, KIND_ASSERTION, ...older],
        '#e': ids,
      })),
    ]
    const teamChunks = namesTeams && teams.size > 0 ? chunked([...teams], 128) : [undefined]
    return teamChunks.flatMap((h) => byFile.map((f) => ({ ...f, ...(h ? { '#h': h } : {}), since })))
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

  function hear(event: SignedEvent) {
    if (stopped || seen.has(event.id)) return
    const fileOf = (id: string) => {
      const i = files.findIndex((f) => f.ids.has(id) || f.ids.has(id.toLowerCase()))
      return i === -1 ? undefined : i
    }
    const everyId = new Set(files.flatMap((f) => [...f.ids]))
    const owners =
      event.kind === KIND_COMMENT || files.some((f) => f.olderKinds.includes(event.kind) && !isReply(event))
        ? files.flatMap((f, i) => (belongsAsComment(event, f) ? [i] : []))
        : filesNamedBy(event, fileOf, everyId, (i, kind) => files[i].olderKinds.includes(kind))
    if (owners.length === 0) return
    seen.add(event.id)
    since = Math.max(since, event.created_at)
    let learnt = false
    for (const i of owners) {
      if (event.kind !== KIND_DELETION && !files[i].ids.has(event.id)) {
        files[i].ids.add(event.id)
        learnt = true
      }
      onEvent(files[i].file, event)
    }
    if (event.kind !== KIND_REACTION && event.kind !== KIND_DELETION) {
      const before = teams.size
      addTeam(teams, event)
      if (teams.size !== before) learnt = true
    }
    if (learnt) reopenSoon()
  }

  open()
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

function addTeam(teams: Set<string>, event: SignedEvent): void {
  const h = event.tags.find((t) => t[0] === 'h' && t[1])?.[1]
  if (h) teams.add(h)
}

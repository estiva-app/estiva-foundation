/**
 * One load's reads, each asked of the relay once (APP-2).
 *
 * A screen that lists the workspace reads it in two steps: `listFolders`, which
 * reads every change naming every listed file to learn what is archived, and
 * then `resolveFolderContents` once per Folder, which reads the same changes
 * again to build each file. Measured on production 26 Oct: Leaf's Weekly Plans
 * load read 79 MB, 78 MB of it changes, while 36.9 MB of changes existed.
 *
 * {@link createLoadQuery} wraps the caller's query for the length of one load:
 *
 * - **A read that came back complete is not asked again.** A filter asking for
 *   every event of one kind naming any of a list of values in one tag — the
 *   shape every change read uses — is complete for each of those values when
 *   the relay's answer did not fill the page. A later filter in the same load
 *   naming such a value gets the events already read, and asks only for the
 *   rest.
 * - **A read of a whole kind answers every later read of that kind** (APP-6).
 *   The agent's workspace reads every change with `{ kinds: [1851] }`, and
 *   `listFolders` beside it read the same changes again by `#a`: 37.6 MB, then
 *   23.6 MB more, on production 27 Oct. A filter naming only kinds is complete
 *   on the same terms as one naming values, and a later filter of one of its
 *   kinds, by any one tag, is answered from it.
 * - **A read in flight is joined, not repeated.** A value still being read is
 *   waited for, and an identical request still in flight shares its answer.
 *
 * **A query that pages every filter to its end** (`Relay.queryAll`, the
 * agent's) says so with `{ paged: true }`. Its answer is whole whatever its
 * size and whatever `limit` the filter carried, so every such read counts;
 * counting the page would never count a read past one page, which every
 * workspace read is.
 *
 * **One load, never longer.** What it holds is the relay's answer at the moment
 * of the load: a refresh, a live update, or the next screen must read afresh,
 * so the caller makes one per load and drops it after. Caching changes across
 * loads is how a live list becomes a screenshot (`ProjectionCache` keeps only
 * manifests for that reason).
 *
 * A refused read fails every call waiting on it, and is forgotten, so a retry
 * asks again: a listing missing what it should have read must still fail
 * loudly (`placeRecordChannels`, 2026-09-22).
 */
import { RELAY_PAGE_CEILING, type SignedEvent } from '@estiva-app/protocol'
import type { QueryFn } from './projection.js'

type Filter = Record<string, unknown>

/** `{ kinds: [kind], '#<tag>': values, limit }` and nothing else. */
interface ByTag {
  kind: number
  tag: string
  values: string[]
  limit: number
}

function byTagOf(filter: Filter): ByTag | null {
  const keys = Object.keys(filter)
  const tagKeys = keys.filter((key) => key.startsWith('#'))
  if (keys.length !== 3 || tagKeys.length !== 1 || tagKeys[0].length !== 2) return null
  const { kinds, limit } = filter
  const values = filter[tagKeys[0]]
  if (!Array.isArray(kinds) || kinds.length !== 1 || typeof kinds[0] !== 'number') return null
  if (typeof limit !== 'number' || !Array.isArray(values) || values.length === 0) return null
  if (!values.every((value) => typeof value === 'string')) return null
  return { kind: kinds[0], tag: tagKeys[0].slice(1), values, limit }
}

/** `{ kinds: [...] }`, with or without a `limit`, and nothing else: every event of those kinds. */
interface WholeKinds {
  kinds: number[]
  limit: number
}

function wholeKindsOf(filter: Filter, paged: boolean): WholeKinds | null {
  const { kinds, limit, ...rest } = filter
  if (Object.keys(rest).length !== 0 || !Array.isArray(kinds) || kinds.length === 0) return null
  if (!kinds.every((kind) => typeof kind === 'number')) return null
  // A relay may give a filter with no limit a smaller page than its ceiling, so
  // through one page only a stated limit says when the answer was cut short.
  if (typeof limit !== 'number' && !(paged && limit === undefined)) return null
  return { kinds, limit: limit ?? RELAY_PAGE_CEILING }
}

/** The events of a whole read naming each value of one tag, indexed once per read and tag. */
const indexes = new WeakMap<SignedEvent[], Map<string, Map<string, SignedEvent[]>>>()
function naming(events: SignedEvent[], tag: string, value: string): SignedEvent[] {
  let byTag = indexes.get(events)
  if (!byTag) indexes.set(events, (byTag = new Map()))
  let byValue = byTag.get(tag)
  if (!byValue) {
    byTag.set(tag, (byValue = new Map()))
    for (const event of events) {
      for (const [name, held] of event.tags) {
        if (name !== tag) continue
        const list = byValue.get(held) ?? []
        if (!list.includes(event)) list.push(event)
        byValue.set(held, list)
      }
    }
  }
  return byValue.get(value) ?? []
}

/** Every event of the read's kinds, if this answer holds them all: see {@link completeByValue}. */
function completeWhole(shape: WholeKinds, answer: SignedEvent[], paged: boolean): SignedEvent[] | null {
  const held = answer.filter((event) => shape.kinds.includes(event.kind))
  return paged || held.length < Math.min(shape.limit, RELAY_PAGE_CEILING) ? held : null
}

/**
 * The events naming each of the filter's values, if this answer holds them
 * all: fewer came back for the filter than its page, or the query pages to the
 * end. The count is of everything in the pooled answer the filter matches,
 * which can only overcount — so a page is never taken as complete when it was
 * full.
 */
function completeByValue(shape: ByTag, answer: SignedEvent[], paged: boolean): Map<string, SignedEvent[]> | null {
  const byValue = new Map<string, SignedEvent[]>(shape.values.map((value) => [value, []]))
  let matched = 0
  for (const event of answer) {
    if (event.kind !== shape.kind) continue
    let hit = false
    for (const [name, value] of event.tags) {
      const held = name === shape.tag ? byValue.get(value) : undefined
      if (held && !held.includes(event)) {
        held.push(event)
        hit = true
      }
    }
    if (hit) matched++
  }
  return !paged && matched >= Math.min(shape.limit, RELAY_PAGE_CEILING) ? null : byValue
}

export interface LoadQueryOptions {
  /** The query answers every filter in full, paging past the relay's page (`Relay.queryAll`): see the module's note. */
  paged?: boolean
}

/** A read held for the load: what it found, `null` when its page was full, or the read still in flight — and the limit it was read with. */
interface Held {
  limit: number
  events: Promise<SignedEvent[] | null>
}

/** A query for one load: see the module's note. Make one per load and drop it after. */
export function createLoadQuery(query: QueryFn, options: LoadQueryOptions = {}): QueryFn {
  const paged = options.paged === true
  // Only an ask with as large a limit as a held read would have got all it holds,
  // so a smaller page goes to the relay. A paged read holds everything whatever its limit.
  const answers = (held: Held | undefined, limit: number): held is Held => !!held && (paged || held.limit <= limit)
  // Per `<kind>:<tag>:<value>`: the events naming it.
  const known = new Map<string, Held>()
  // Per kind: every event of it, read by a filter naming only kinds.
  const wholes = new Map<number, Held>()
  const flights = new Map<string, Promise<SignedEvent[]>>()

  const remember = <K>(memo: Map<K, Held>, key: K, entry: Held) => {
    // A larger read of the same, in flight or done, is kept.
    if ((memo.get(key)?.limit ?? -1) > entry.limit) return
    memo.set(key, entry)
    // Forget a refused read, and a page that came back full, so the next ask goes to the relay.
    const forget = () => {
      if (memo.get(key) === entry) memo.delete(key)
    }
    entry.events.then((events) => events ?? forget(), forget)
  }

  const ask = (filters: Filter[]): Promise<SignedEvent[]> => {
    const key = JSON.stringify(filters)
    const held = flights.get(key)
    if (held) return held
    const flight = query(filters).finally(() => flights.delete(key))
    flights.set(key, flight)
    return flight
  }

  return async (filters) => {
    const send: Filter[] = []
    const asked: ByTag[] = []
    const askedWhole: WholeKinds[] = []
    // Answered from a held read; `again` is what to ask if that read's page came back full.
    const joined: { again: Filter; entry: Promise<SignedEvent[] | null> }[] = []
    const joinedByTag: { shape: ByTag; value: string; entry: Promise<SignedEvent[] | null> }[] = []
    for (const filter of filters) {
      const whole = wholeKindsOf(filter, paged)
      if (whole) {
        const held = whole.kinds.map((kind) => wholes.get(kind))
        if (held.every((entry) => answers(entry, whole.limit))) {
          const parts = Promise.all(held.map((entry) => entry!.events))
          joined.push({ again: filter, entry: parts.then((all) => (all.includes(null) ? null : all.flat() as SignedEvent[])) })
        } else {
          send.push(filter)
          askedWhole.push(whole)
        }
        continue
      }
      const shape = byTagOf(filter)
      if (!shape) {
        send.push(filter)
        continue
      }
      const fresh: string[] = []
      const read = wholes.get(shape.kind)
      for (const value of new Set(shape.values)) {
        const entry = known.get(`${shape.kind}:${shape.tag}:${value}`)
        if (answers(read, shape.limit)) {
          const events = read.events.then((all) => all && naming(all, shape.tag, value))
          joinedByTag.push({ shape, value, entry: events })
        } else if (answers(entry, shape.limit)) joinedByTag.push({ shape, value, entry: entry.events })
        else fresh.push(value)
      }
      if (fresh.length === 0) continue
      send.push({ ...filter, [`#${shape.tag}`]: fresh })
      asked.push({ ...shape, values: fresh })
    }

    const answer = send.length ? ask(send) : Promise.resolve([])
    for (const shape of askedWhole) {
      const split = answer.then((events) => completeWhole(shape, events, paged))
      for (const kind of shape.kinds) {
        remember(wholes, kind, { limit: shape.limit, events: split.then((events) => events && events.filter((event) => event.kind === kind)) })
      }
    }
    for (const shape of asked) {
      const split = answer.then((events) => completeByValue(shape, events, paged))
      for (const value of shape.values) {
        remember(known, `${shape.kind}:${shape.tag}:${value}`, { limit: shape.limit, events: split.then((byValue) => byValue?.get(value) ?? null) })
      }
    }

    const out = [...(await answer)]
    const again: Filter[] = []
    for (const { again: filter, entry } of joined) {
      const events = await entry
      if (events) out.push(...events)
      else again.push(filter)
    }
    // Per filter of the caller's, so a re-ask keeps the grouping it chose.
    const unknown = new Map<ByTag, string[]>()
    for (const { shape, value, entry } of joinedByTag) {
      const events = await entry
      if (events) out.push(...events)
      // That read's page was full: ask for this value here, as the caller would have.
      else unknown.set(shape, [...(unknown.get(shape) ?? []), value])
    }
    for (const [shape, values] of unknown) again.push({ kinds: [shape.kind], [`#${shape.tag}`]: values, limit: shape.limit })
    if (again.length) out.push(...(await ask(again)))

    // One copy of each event, as one request to the relay answers.
    const seen = new Set<string>()
    return out.filter((e) => !seen.has(e.id) && !!seen.add(e.id))
  }
}

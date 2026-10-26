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
 * - **A read in flight is joined, not repeated.** A value still being read is
 *   waited for, and an identical request still in flight shares its answer.
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

const names = (event: SignedEvent, tag: string, value: string) => event.tags.some((t) => t[0] === tag && t[1] === value)

/**
 * Every event naming `value`, if this answer holds them all: fewer came back
 * for the filter than its page. The count is of everything in the pooled answer
 * the filter matches, which can only overcount — so a page is never taken as
 * complete when it was full.
 */
function completeFor(shape: ByTag, value: string, answer: SignedEvent[]): SignedEvent[] | null {
  const page = Math.min(shape.limit, RELAY_PAGE_CEILING)
  const matched = answer.filter((e) => e.kind === shape.kind && shape.values.some((v) => names(e, shape.tag, v)))
  if (matched.length >= page) return null
  return matched.filter((e) => names(e, shape.tag, value))
}

/** A query for one load: see the module's note. Make one per load and drop it after. */
export function createLoadQuery(query: QueryFn): QueryFn {
  // Per `<kind>:<tag>:<value>`: the events naming it, `null` while unknown
  // (the page was full), or the read still in flight.
  const known = new Map<string, Promise<SignedEvent[] | null>>()
  const flights = new Map<string, Promise<SignedEvent[]>>()

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
    const asked: { shape: ByTag; key: string; value: string }[] = []
    const joined: { shape: ByTag; value: string; entry: Promise<SignedEvent[] | null> }[] = []
    for (const filter of filters) {
      const shape = byTagOf(filter)
      if (!shape) {
        send.push(filter)
        continue
      }
      const fresh: string[] = []
      for (const value of new Set(shape.values)) {
        const entry = known.get(`${shape.kind}:${shape.tag}:${value}`)
        if (entry) joined.push({ shape, value, entry })
        else fresh.push(value)
      }
      if (fresh.length === 0) continue
      const narrowed = { ...shape, values: fresh }
      send.push({ ...filter, [`#${shape.tag}`]: fresh })
      for (const value of fresh) asked.push({ shape: narrowed, key: `${shape.kind}:${shape.tag}:${value}`, value })
    }

    const answer = send.length ? ask(send) : Promise.resolve([])
    for (const { shape, key, value } of asked) {
      const entry = answer.then((events) => completeFor(shape, value, events))
      known.set(key, entry)
      // Forget a refused read, and a page that came back full, so the next ask goes to the relay.
      const forget = () => {
        if (known.get(key) === entry) known.delete(key)
      }
      entry.then((events) => events ?? forget(), forget)
    }

    const out = [...(await answer)]
    // Per filter of the caller's, so a re-ask keeps the grouping it chose.
    const unknown = new Map<ByTag, string[]>()
    for (const { shape, value, entry } of joined) {
      const events = await entry
      if (events) out.push(...events)
      // That read's page was full: ask for this value here, as the caller would have.
      else unknown.set(shape, [...(unknown.get(shape) ?? []), value])
    }
    if (unknown.size) {
      out.push(
        ...(await ask(
          [...unknown].map(([shape, values]) => ({ kinds: [shape.kind], [`#${shape.tag}`]: values, limit: shape.limit })),
        )),
      )
    }

    // One copy of each event, as one request to the relay answers.
    const seen = new Set<string>()
    return out.filter((e) => !seen.has(e.id) && !!seen.add(e.id))
  }
}

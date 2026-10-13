/**
 * A copy of what the relay told one person, kept on the device (PEE-2).
 *
 * The copy holds **signed events**, the stores' raw input, never a folded view:
 * a fold can change shape in any release, an event cannot. So an app draws
 * from the copy by running the reads it would have sent, against the copy, and
 * folding the answer exactly as it folds the relay's — and then sends the same
 * reads to the relay and folds again. Nothing here knows which app or store it
 * feeds.
 *
 * ## What the copy may answer
 *
 * A read whose every filter has been answered by the relay before, on this
 * device, for this person. Its key leaves out `since` and `until`, which are
 * usually a clock: "the last 30 days" asked yesterday is the same question.
 * A filter never asked, or a `search`, is not answered — an empty answer from
 * a copy that simply never saw the question would draw "nothing here", which
 * is a claim, where no answer draws today's placeholder.
 *
 * A filter asked about a different set is answered too, when the relay has
 * answered every value in it whole. Apps pool a set of files into lists —
 * `'#a': [25 addresses]`, `authors: [everyone named]` — and the list changes
 * whenever the set does, so a reload asked lists the relay never saw, though
 * it had answered each file in them (Miky's Screener, 13 Oct). A filter is
 * covered when, for one of its list fields, filters the same in every other
 * field (`limit` aside) were answered whole and their lists hold every value
 * it asks. Whole means not cut by a `limit`: below it, or past the most events
 * the filter can match — one version of each replaceable event per author, of
 * each addressable one per author and `d`, one event per id.
 *
 * ## Keeping it honest without a sequence number
 *
 * The relay has no change feed to replay, so every answer it gives is also a
 * correction: an event the copy holds that matches a filter the relay just
 * answered, and is not in that answer, is gone (deleted, or in a Folder this
 * person has lost — Buzz answers lost access with an empty list). When the
 * answer was cut by its `limit`, only the window it covers is judged: below
 * its oldest event the relay said nothing. A `kind:5` drops the events it
 * names that its own author signed. A replaceable event keeps only its newest.
 *
 * ## Plaintexts
 *
 * An app's own blob is ciphertext on the wire; decrypting it is a round trip
 * the relay's signer meters. The plaintext is the person's own data, so it is
 * kept beside the event that carried it and handed back for the same
 * ciphertext — which always decrypts to the same text, so it is never stale.
 */
import type { SignedEvent } from '@estiva-app/protocol'

/** A Nostr filter as an app sends it: `ids`, `kinds`, `authors`, `#x`, `since`, `until`, `limit`. */
export type SnapshotFilter = Record<string, unknown>

/** One event in storage, with the plaintext of its content when the app kept one. */
export interface StoredSnapshotEvent {
  event: SignedEvent
  plaintext?: string
  /** Epoch ms of the last answer that carried it: the oldest go first past the cap. */
  seenAt: number
}

/** What a scope holds in storage. */
export interface SnapshotRecord {
  version: number
  events: StoredSnapshotEvent[]
  /** The keys of every filter the relay has answered (see {@link snapshotFilterKey}). */
  filters: string[]
  /** Those of them whose last answer was whole, not cut by its `limit`; absent in a copy written before 0.6. */
  whole?: string[]
}

/** What changed since the last save. */
export interface SnapshotChange {
  version: number
  /** The storage's sign-out count when the copy was read: a save from before a sign-out is refused. */
  epoch: number
  put: StoredSnapshotEvent[]
  remove: string[]
  filters: string[]
  whole: string[]
}

/** Where a copy lives between page loads. {@link indexedDbSnapshotStorage} is the browser's. */
export interface SnapshotStorage {
  /** A scope's record, or null; and the storage's sign-out count, which every save names. */
  load(scope: string): Promise<{ epoch: number; record: SnapshotRecord | null }>
  /** Writes nothing when `change.epoch` is not the current count: somebody signed out since. */
  save(scope: string, change: SnapshotChange): Promise<void>
  /**
   * Remove every scope and count a sign-out, so a copy still open — in this
   * tab or another — can never write the person's data back afterwards.
   */
  clear(): Promise<void>
}

export interface SnapshotTimers {
  setTimeout(run: () => void, ms: number): unknown
  clearTimeout(handle: unknown): void
}

const host = globalThis as unknown as SnapshotTimers

export interface EventSnapshotOptions {
  storage: SnapshotStorage
  /** Whose blobs' plaintexts are kept; defaults to the pubkey in `scope`. */
  owner?: string
  /** One person on one relay: {@link snapshotScope}. */
  scope: string
  /** The app's schema version. A copy written under another one is dropped unread. */
  version: number
  /** Past this many events the least recently seen are dropped. */
  maxEvents?: number
  /** How long after a change the copy is written. */
  saveAfterMs?: number
  now?: () => number
  timers?: SnapshotTimers
}

export interface EventSnapshot {
  /** Settles once the stored copy has been read, or found unusable. Never rejects. */
  ready: Promise<void>
  /** The events the copy holds for these filters, as the relay would order them; `null` when it cannot answer. */
  answer(filters: SnapshotFilter[]): SignedEvent[] | null
  /** Take in the relay's answer to these filters: add what it sent, drop what it no longer has. */
  absorb(filters: SnapshotFilter[], events: SignedEvent[]): void
  /** The kept plaintext of a ciphertext this copy holds, if any. */
  plaintextOf(content: string): string | undefined
  keepPlaintext(content: string, plaintext: string): void
  size(): number
  /** Write what changed now, rather than after `saveAfterMs`. */
  flush(): Promise<void>
  /** Stop, writing what changed first; nothing more is written after. */
  close(): void
  /** Stop and write nothing: the copy is about to be cleared (sign-out). */
  discard(): void
}

export const SNAPSHOT_MAX_EVENTS = 10_000
export const SNAPSHOT_SAVE_AFTER_MS = 1_000

/** The scope of one person's copy on one relay. */
export function snapshotScope(relayUrl: string, pubkey: string): string {
  return `${relayUrl.replace(/\/+$/, '')}|${pubkey}`
}

function sortedValue(value: unknown): unknown {
  return Array.isArray(value) ? [...value].map(String).sort() : value
}

/** A filter's identity as a question, without its clock (`since`, `until`). */
export function snapshotFilterKey(filter: SnapshotFilter): string {
  const keys = Object.keys(filter)
    .filter((k) => k !== 'since' && k !== 'until')
    .sort()
  return JSON.stringify(keys.map((k) => [k, sortedValue(filter[k])]))
}

/** Whether an event matches a filter, `limit` aside — NIP-01's rule. */
export function matchesSnapshotFilter(filter: SnapshotFilter, event: SignedEvent): boolean {
  for (const [key, value] of Object.entries(filter)) {
    if (key === 'limit') continue
    if (key === 'ids') {
      if (!(value as string[]).includes(event.id)) return false
    } else if (key === 'kinds') {
      if (!(value as number[]).includes(event.kind)) return false
    } else if (key === 'authors') {
      if (!(value as string[]).includes(event.pubkey)) return false
    } else if (key === 'since') {
      if (event.created_at < (value as number)) return false
    } else if (key === 'until') {
      if (event.created_at > (value as number)) return false
    } else if (key.startsWith('#') && key.length === 2) {
      const name = key.slice(1)
      const wanted = value as string[]
      if (!event.tags.some((tag) => tag[0] === name && tag[1] !== undefined && wanted.includes(tag[1]))) return false
    } else {
      // `search`, or anything this rule does not know: not something a copy can judge.
      return false
    }
  }
  return true
}

/**
 * {@link matchesSnapshotFilter} for one filter and many events, the same rule:
 * its lists are made sets once, since a pooled `'#a'` or `'#e'` holds hundreds
 * of values and every candidate is judged against it.
 */
function snapshotMatcher(filter: SnapshotFilter): (event: SignedEvent) => boolean {
  const checks: ((event: SignedEvent) => boolean)[] = []
  for (const [key, value] of Object.entries(filter)) {
    if (key === 'limit') continue
    if (key === 'ids' || key === 'kinds' || key === 'authors') {
      const wanted = new Set(value as unknown[])
      const field = key === 'ids' ? 'id' : key === 'kinds' ? 'kind' : 'pubkey'
      checks.push((event) => wanted.has(event[field]))
    } else if (key === 'since') {
      checks.push((event) => event.created_at >= (value as number))
    } else if (key === 'until') {
      checks.push((event) => event.created_at <= (value as number))
    } else if (key.startsWith('#') && key.length === 2) {
      const name = key.slice(1)
      const wanted = new Set(value as string[])
      checks.push((event) => event.tags.some((tag) => tag[0] === name && tag[1] !== undefined && wanted.has(tag[1])))
    } else {
      // `search`, or anything this rule does not know: not something a copy can judge.
      return () => false
    }
  }
  return (event) => checks.every((check) => check(event))
}

function answerable(filter: SnapshotFilter): boolean {
  return Object.keys(filter).every(
    (key) => ['ids', 'kinds', 'authors', 'since', 'until', 'limit'].includes(key) || (key.startsWith('#') && key.length === 2),
  )
}

const isReplaceableKind = (kind: number) => kind === 0 || kind === 3 || (kind >= 10_000 && kind < 20_000)
const isAddressableKind = (kind: number) => kind >= 30_000 && kind < 40_000

/**
 * The most events a filter can match on a relay that keeps one version of each
 * replaceable event, or `Infinity`: a `limit` at least this big cannot cut.
 * Interop asks a set's roots and profiles with `limit` = the list's length.
 */
function mostMatches(filter: SnapshotFilter): number {
  const length = (key: string) => (Array.isArray(filter[key]) ? (filter[key] as unknown[]).length : undefined)
  const kinds = filter.kinds as number[] | undefined
  const authors = length('authors')
  const d = length('#d')
  let most = length('ids') ?? Infinity
  if (kinds && authors !== undefined) {
    if (kinds.every(isReplaceableKind)) most = Math.min(most, kinds.length * authors)
    if (d !== undefined && kinds.every(isAddressableKind)) most = Math.min(most, kinds.length * authors * d)
  }
  return most
}

/** Where a filter's `field` list sits among answered lists: the filter without that field or its `limit`. */
function coverShape(filter: SnapshotFilter, field: string): string {
  const rest: SnapshotFilter = {}
  for (const [key, value] of Object.entries(filter)) if (key !== field && key !== 'limit') rest[key] = value
  return `${field}|${snapshotFilterKey(rest)}`
}

/** Newest first, then by id: the order a relay answers in. */
function byRelayOrder(a: SignedEvent, b: SignedEvent): number {
  return b.created_at - a.created_at || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0)
}

/** The coordinate a replaceable event replaces, or null for a regular one. */
function replaceableKey(event: SignedEvent): string | null {
  const { kind } = event
  if (kind === 0 || kind === 3 || (kind >= 10_000 && kind < 20_000)) return `${kind}:${event.pubkey}`
  if (kind >= 30_000 && kind < 40_000) {
    const d = event.tags.find((tag) => tag[0] === 'd')?.[1] ?? ''
    return `${kind}:${event.pubkey}:${d}`
  }
  return null
}

export function createEventSnapshot(options: EventSnapshotOptions): EventSnapshot {
  const { storage, scope, version } = options
  const owner = options.owner ?? scope.slice(scope.lastIndexOf('|') + 1)
  /** The storage's sign-out count when this copy was read; no read, no write. */
  let epoch: number | undefined
  const maxEvents = options.maxEvents ?? SNAPSHOT_MAX_EVENTS
  const saveAfterMs = options.saveAfterMs ?? SNAPSHOT_SAVE_AFTER_MS
  const now = options.now ?? (() => Date.now())
  const timers = () => options.timers ?? host

  const events = new Map<string, StoredSnapshotEvent>()
  /** The ids held of each kind: a filter is matched against its own kinds, not the whole copy. */
  const byKind = new Map<number, Set<string>>()
  /** The ids held carrying each single-letter tag value, by `<letter>:<value>`: what a `#x` filter can match. */
  const byTag = new Map<string, Set<string>>()
  const tagKeys = (event: SignedEvent) =>
    event.tags.filter((tag) => tag[0]?.length === 1 && tag[1] !== undefined).map((tag) => `${tag[0]}:${tag[1]}`)
  const byCoordinate = new Map<string, string>()
  const byContent = new Map<string, string>()
  /** Plaintexts for a ciphertext no held event carries: this page load only. */
  const looseText = new Map<string, string>()
  const filters = new Set<string>()
  /** The keys of filters whose last answer was whole — the ones a pooled list may be covered by. */
  const whole = new Set<string>()
  /** Every value answered whole, by {@link coverShape}; built when first asked, dropped when `whole` changes. */
  let covers: Map<string, Set<string>> | undefined
  const dirty = new Set<string>()
  const removed = new Set<string>()
  let filtersDirty = false
  let timer: unknown
  let closed = false

  function drop(id: string) {
    const held = events.get(id)
    if (!held) return
    events.delete(id)
    byKind.get(held.event.kind)?.delete(id)
    for (const key of tagKeys(held.event)) byTag.get(key)?.delete(id)
    const coordinate = replaceableKey(held.event)
    if (coordinate) {
      if (byCoordinate.get(coordinate) === id) byCoordinate.delete(coordinate)
      if (byContent.get(held.event.content) === id) byContent.delete(held.event.content)
    }
    dirty.delete(id)
    removed.add(id)
  }

  function hold(stored: StoredSnapshotEvent, mark: boolean): void {
    const { event } = stored
    const coordinate = replaceableKey(event)
    if (coordinate) {
      const current = byCoordinate.get(coordinate)
      const currentEvent = current ? events.get(current)?.event : undefined
      if (currentEvent && currentEvent.id !== event.id) {
        if (byRelayOrder(currentEvent, event) <= 0) return
        drop(currentEvent.id)
      }
      byCoordinate.set(coordinate, event.id)
    }
    const previous = events.get(event.id)
    // The same id again is the same event; if what arrived differs, the indexes follow what is held now.
    if (previous) {
      byKind.get(previous.event.kind)?.delete(event.id)
      for (const key of tagKeys(previous.event)) byTag.get(key)?.delete(event.id)
    }
    // A plaintext belongs to the person's own blob — a replaceable event they signed — and
    // never to somebody else's event that happens to carry the same ciphertext.
    const own = coordinate !== null && event.pubkey === owner
    const plaintext = own ? (stored.plaintext ?? previous?.plaintext ?? looseText.get(event.content)) : undefined
    events.set(event.id, { event, seenAt: stored.seenAt, ...(plaintext !== undefined ? { plaintext } : {}) })
    let ofKind = byKind.get(event.kind)
    if (!ofKind) byKind.set(event.kind, (ofKind = new Set()))
    ofKind.add(event.id)
    for (const key of tagKeys(event)) {
      let carrying = byTag.get(key)
      if (!carrying) byTag.set(key, (carrying = new Set()))
      carrying.add(event.id)
    }
    if (own && event.content) byContent.set(event.content, event.id)
    if (mark) {
      dirty.add(event.id)
      removed.delete(event.id)
    }
  }

  function schedule() {
    if (closed || timer !== undefined) return
    timer = timers().setTimeout(() => {
      timer = undefined
      void flush()
    }, saveAfterMs)
  }

  async function flush(): Promise<void> {
    if (timer !== undefined) {
      timers().clearTimeout(timer)
      timer = undefined
    }
    if (closed || epoch === undefined || (!dirty.size && !removed.size && !filtersDirty)) return
    const change: SnapshotChange = {
      version,
      epoch,
      put: [...dirty].flatMap((id) => {
        const held = events.get(id)
        return held ? [held] : []
      }),
      remove: [...removed],
      filters: [...filters],
      whole: [...whole],
    }
    dirty.clear()
    removed.clear()
    filtersDirty = false
    try {
      await storage.save(scope, change)
    } catch {
      // A copy that could not be written is a slower next load, not a failure —
      // but what it carried is asked again next time, removals above all: a
      // deletion that never reached storage would be drawn on every reload.
      for (const stored of change.put) if (events.has(stored.event.id) && !removed.has(stored.event.id)) dirty.add(stored.event.id)
      for (const id of change.remove) if (!events.has(id)) removed.add(id)
      filtersDirty = true
      schedule()
    }
  }

  /** Answers taken in before the stored copy was read: applied over it, never under it. */
  const early: [SnapshotFilter[], SignedEvent[]][] = []
  let loaded = false

  const ready = (async () => {
    try {
      const read = await storage.load(scope)
      epoch = read.epoch
      const record = read.record
      if (record && record.version === version) {
        for (const stored of record.events) hold(stored, false)
        for (const key of record.filters) filters.add(key)
        for (const key of record.whole ?? []) if (filters.has(key)) whole.add(key)
        // An answer asked before the stored copy was read built what is covered without it.
        covers = undefined
      }
    } catch {
      // Unreadable (a private window, storage refused, a corrupt record): no copy.
    }
    loaded = true
    for (const [asked, answer] of early.splice(0)) take(asked, answer)
  })()

  function take(asked: SnapshotFilter[], answer: SignedEvent[]) {
    if (closed) return
    const seenAt = now()
    for (const event of answer) hold({ event, seenAt }, true)
    const returned = new Set(answer.map((event) => event.id))
    for (const filter of asked) {
      if (!answerable(filter)) continue
      const key = snapshotFilterKey(filter)
      if (!filters.has(key)) {
        filters.add(key)
        filtersDirty = true
      }
      const matches = snapshotMatcher(filter)
      const sent = answer.filter(matches)
      // Cut by its limit — counted on the whole answer too when it is the only filter, so an
      // event the relay matched and this rule does not cannot make a cut answer look whole.
      // Not when the limit is past the most the filter can match, unless the relay sent two
      // versions of one replaceable event, which that bound assumes it never keeps.
      const limit = typeof filter.limit === 'number' ? filter.limit : Infinity
      // An event with two `d` tags matches two coordinates' worth of `#d`, so the bound holds only for one each.
      const bounded =
        limit >= mostMatches(filter) &&
        new Set(sent.map((event) => replaceableKey(event) ?? event.id)).size === sent.length &&
        sent.every((event) => event.tags.filter((tag) => tag[0] === 'd').length <= 1)
      const cut = !bounded && (sent.length >= limit || (asked.length === 1 && answer.length >= limit))
      // Whole only for all time: an answer from `since` on says nothing about what came before it.
      const isWhole = !cut && filter.since === undefined && filter.until === undefined
      const wasWhole = whole.has(key)
      if (isWhole) whole.add(key)
      else whole.delete(key)
      if (wasWhole !== isWhole) {
        // Newly whole: its values join what is covered; no longer whole: what is covered is worked out again.
        if (!isWhole) covers = undefined
        else if (covers) addCovers(covers, key)
        filtersDirty = true
      }
      const floor = cut && sent.length ? Math.min(...sent.map((event) => event.created_at)) : cut ? Infinity : -Infinity
      for (const event of candidates(filter)) {
        // At the cut's own second the relay may have held back events it still has: not judged.
        if (returned.has(event.id) || (cut && event.created_at <= floor)) continue
        if (matches(event)) drop(event.id)
      }
    }
    for (const event of answer) {
      if (event.kind !== 5) continue
      for (const tag of event.tags) {
        if (!tag[1]) continue
        if (tag[0] === 'e' && events.get(tag[1])?.event.pubkey === event.pubkey) drop(tag[1])
        // An addressable file deleted by its coordinate: what its author wrote up to the deletion.
        if (tag[0] === 'a' && tag[1].split(':')[1] === event.pubkey) {
          const id = byCoordinate.get(tag[1])
          const target = id ? events.get(id)?.event : undefined
          if (target && target.created_at <= event.created_at) drop(target.id)
        }
      }
    }
    trim()
    schedule()
  }

  function trim() {
    if (events.size <= maxEvents) return
    const oldest = [...events.values()].sort((a, b) => a.seenAt - b.seenAt)
    for (const stored of oldest.slice(0, events.size - maxEvents)) drop(stored.event.id)
  }

  /**
   * The held events a filter could match — by its `ids`, else by the
   * smallest of its `#x` lists and its `kinds`, else all of them — for its
   * matcher to judge. A copy of the list, so a caller may drop events while it
   * walks it.
   */
  function candidates(filter: SnapshotFilter): SignedEvent[] {
    if (Array.isArray(filter.ids)) {
      const out: SignedEvent[] = []
      for (const id of filter.ids as string[]) {
        const held = events.get(id)
        if (held) out.push(held.event)
      }
      return out
    }
    let smallest: Set<string> | undefined
    const consider = (ids: Set<string>) => {
      if (!smallest || ids.size < smallest.size) smallest = ids
    }
    for (const [key, value] of Object.entries(filter)) {
      if (!Array.isArray(value)) continue
      const ids = new Set<string>()
      if (key === 'kinds') for (const kind of value as number[]) for (const id of byKind.get(kind) ?? []) ids.add(id)
      else if (key.startsWith('#') && key.length === 2) for (const v of value) for (const id of byTag.get(`${key[1]}:${String(v)}`) ?? []) ids.add(id)
      else continue
      consider(ids)
    }
    if (!smallest) return [...events.values()].map((stored) => stored.event)
    return [...smallest].map((id) => events.get(id)!.event)
  }

  /** Add one whole answer's list values to what is covered. */
  function addCovers(into: Map<string, Set<string>>, key: string): void {
    const answered = Object.fromEntries(JSON.parse(key) as [string, unknown][]) as SnapshotFilter
    for (const [field, value] of Object.entries(answered)) {
      if (!Array.isArray(value)) continue
      const shape = coverShape(answered, field)
      const values = into.get(shape) ?? new Set<string>()
      for (const v of value) values.add(String(v))
      into.set(shape, values)
    }
  }

  function covered(filter: SnapshotFilter): boolean {
    if (!covers) {
      covers = new Map()
      for (const key of whole) addCovers(covers, key)
    }
    return Object.entries(filter).some(([field, value]) => {
      if (!Array.isArray(value) || field === 'since' || field === 'until') return false
      const values = covers!.get(coverShape(filter, field))
      return !!values && value.every((v) => values.has(String(v)))
    })
  }

  return {
    ready,
    answer(asked) {
      if (!asked.length) return null
      if (!asked.every((f) => answerable(f) && (filters.has(snapshotFilterKey(f)) || covered(f)))) return null
      const out = new Map<string, SignedEvent>()
      for (const filter of asked) {
        const matched = candidates(filter)
          .filter(snapshotMatcher(filter))
          .sort(byRelayOrder)
        const limit = typeof filter.limit === 'number' ? filter.limit : matched.length
        for (const event of matched.slice(0, limit)) out.set(event.id, event)
      }
      return [...out.values()].sort(byRelayOrder)
    },
    absorb(asked, answer) {
      if (closed) return
      if (!loaded) early.push([asked, answer])
      else take(asked, answer)
    },
    plaintextOf(content) {
      const id = byContent.get(content)
      return (id ? events.get(id)?.plaintext : undefined) ?? looseText.get(content)
    },
    keepPlaintext(content, plaintext) {
      if (closed) return
      const id = byContent.get(content)
      const held = id ? events.get(id) : undefined
      if (!held) {
        looseText.set(content, plaintext)
        return
      }
      if (held.plaintext === plaintext) return
      events.set(held.event.id, { ...held, plaintext })
      dirty.add(held.event.id)
      schedule()
    },
    size: () => events.size,
    flush,
    close() {
      // What changed is written first: a deletion taken in a moment ago must not come back next load.
      void flush()
      closed = true
    },
    discard() {
      if (timer !== undefined) timers().clearTimeout(timer)
      timer = undefined
      closed = true
    },
  }
}

/**
 * Keeps nothing between page loads: for a test, and for a browser without
 * IndexedDB, where the copy still answers within one load.
 */
export function memorySnapshotStorage(): SnapshotStorage & { records: Map<string, SnapshotRecord> } {
  const records = new Map<string, SnapshotRecord>()
  let epoch = 0
  return {
    records,
    async load(scope) {
      const record = records.get(scope)
      return {
        epoch,
        record: record
          ? { ...record, events: [...record.events], filters: [...record.filters], whole: [...(record.whole ?? [])] }
          : null,
      }
    },
    async save(scope, change) {
      if (change.epoch !== epoch) return
      const record = records.get(scope)
      const held = new Map(record && record.version === change.version ? record.events.map((s) => [s.event.id, s]) : [])
      for (const id of change.remove) held.delete(id)
      for (const stored of change.put) held.set(stored.event.id, stored)
      records.set(scope, {
        version: change.version,
        events: [...held.values()],
        filters: [...change.filters],
        whole: [...change.whole],
      })
    },
    async clear() {
      records.clear()
      epoch += 1
    },
  }
}

/*
  IndexedDB, typed by what this file touches. The package compiles without
  `lib: dom` (tsconfig.base.json), so the factory is a parameter shaped like the
  part of `window.indexedDB` used here, never the global.
*/
interface IdbRequest<T = unknown> {
  result: T
  error: unknown
  onsuccess: ((this: unknown, ev: unknown) => unknown) | null
  onerror: ((this: unknown, ev: unknown) => unknown) | null
}
interface IdbOpenRequest extends IdbRequest<IdbDatabase> {
  onupgradeneeded: ((this: unknown, ev: unknown) => unknown) | null
}
interface IdbIndex {
  getAll(query: unknown): IdbRequest<unknown[]>
  getAllKeys(query: unknown): IdbRequest<unknown[]>
}
interface IdbObjectStore {
  put(value: unknown): IdbRequest
  get(key: unknown): IdbRequest<unknown>
  delete(key: unknown): IdbRequest
  clear(): IdbRequest
  index(name: string): IdbIndex
  createIndex(name: string, keyPath: string): unknown
}
interface IdbTransaction {
  objectStore(name: string): IdbObjectStore
  oncomplete: ((this: unknown, ev: unknown) => unknown) | null
  onerror: ((this: unknown, ev: unknown) => unknown) | null
  onabort: ((this: unknown, ev: unknown) => unknown) | null
  error: unknown
}
interface IdbDatabase {
  objectStoreNames: { contains(name: string): boolean }
  createObjectStore(name: string, options: { keyPath: string | string[] }): IdbObjectStore
  transaction(stores: string[], mode: 'readonly' | 'readwrite'): IdbTransaction
  close(): void
}
/** The part of `window.indexedDB` a snapshot uses. */
export interface IdbFactoryLike {
  open(name: string, version: number): IdbOpenRequest
}

const EVENTS = 'events'
const META = 'meta'
/** The `meta` row counting sign-outs: no scope can be named this (`snapshotScope` has a `|`). */
const SIGN_OUTS = '\u0000sign-outs'

function request<T>(req: IdbRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    req.onsuccess = () => resolve(req.result)
    req.onerror = () => reject(req.error)
  })
}

function done(tx: IdbTransaction): Promise<void> {
  return new Promise((resolve, reject) => {
    tx.oncomplete = () => resolve()
    tx.onerror = () => reject(tx.error)
    tx.onabort = () => reject(tx.error)
  })
}

/**
 * The browser's storage for a copy: one database, `events` keyed by scope and
 * id, and a `meta` row per scope with its version and answered filters.
 */
export function indexedDbSnapshotStorage(indexedDB: IdbFactoryLike, name = 'estiva-snapshot'): SnapshotStorage {
  let opened: Promise<IdbDatabase> | undefined
  const db = () => {
    opened ??= new Promise<IdbDatabase>((resolve, reject) => {
      const req = indexedDB.open(name, 1)
      req.onupgradeneeded = () => {
        const database = req.result
        if (!database.objectStoreNames.contains(EVENTS)) {
          database.createObjectStore(EVENTS, { keyPath: ['scope', 'id'] }).createIndex('scope', 'scope')
        }
        if (!database.objectStoreNames.contains(META)) database.createObjectStore(META, { keyPath: 'scope' })
      }
      req.onsuccess = () => resolve(req.result)
      req.onerror = () => reject(req.error)
    })
    // A failed open is asked again next time rather than held for the page.
    opened.catch(() => (opened = undefined))
    return opened
  }

  const epochOf = async (meta: IdbObjectStore) =>
    ((await request(meta.get(SIGN_OUTS))) as { epoch: number } | undefined)?.epoch ?? 0

  return {
    async load(scope) {
      const database = await db()
      const tx = database.transaction([EVENTS, META], 'readonly')
      const [epoch, meta, rows] = await Promise.all([
        epochOf(tx.objectStore(META)),
        request(tx.objectStore(META).get(scope)) as Promise<{ version: number; filters: string[]; whole?: string[] } | undefined>,
        request(tx.objectStore(EVENTS).index('scope').getAll(scope)) as Promise<(StoredSnapshotEvent & { scope: string; id: string })[]>,
      ])
      if (!meta) return { epoch, record: null }
      return {
        epoch,
        record: {
          version: meta.version,
          filters: meta.filters,
          whole: meta.whole ?? [],
          events: rows.map(({ event, plaintext, seenAt }) => ({ event, seenAt, ...(plaintext !== undefined ? { plaintext } : {}) })),
        },
      }
    },
    async save(scope, change) {
      const database = await db()
      // One transaction from the check to the last write: a sign-out in this tab or another
      // is either wholly before it (and refuses it) or wholly after it (and clears it).
      const tx = database.transaction([EVENTS, META], 'readwrite')
      const metaStore = tx.objectStore(META)
      const events = tx.objectStore(EVENTS)
      const [epoch, meta] = await Promise.all([
        epochOf(metaStore),
        request(metaStore.get(scope)) as Promise<{ version: number } | undefined>,
      ])
      if (epoch === change.epoch) {
        if (meta && meta.version !== change.version) {
          const keys = await request(events.index('scope').getAllKeys(scope))
          for (const key of keys) events.delete(key)
        }
        for (const id of change.remove) events.delete([scope, id])
        for (const stored of change.put) events.put({ scope, id: stored.event.id, ...stored })
        metaStore.put({ scope, version: change.version, filters: change.filters, whole: change.whole })
      }
      await done(tx)
    },
    async clear() {
      const database = await db()
      const tx = database.transaction([EVENTS, META], 'readwrite')
      const epoch = await epochOf(tx.objectStore(META))
      tx.objectStore(EVENTS).clear()
      tx.objectStore(META).clear()
      // Counted, so every copy opened before now — in any tab — writes nothing again.
      tx.objectStore(META).put({ scope: SIGN_OUTS, epoch: epoch + 1 })
      await done(tx)
    },
  }
}

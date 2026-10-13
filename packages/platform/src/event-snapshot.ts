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
}

/** What changed since the last save. */
export interface SnapshotChange {
  version: number
  put: StoredSnapshotEvent[]
  remove: string[]
  filters: string[]
}

/** Where a copy lives between page loads. {@link indexedDbSnapshotStorage} is the browser's. */
export interface SnapshotStorage {
  load(scope: string): Promise<SnapshotRecord | null>
  save(scope: string, change: SnapshotChange): Promise<void>
  /** Remove every scope: the person signed out. */
  clear(): Promise<void>
}

export interface SnapshotTimers {
  setTimeout(run: () => void, ms: number): unknown
  clearTimeout(handle: unknown): void
}

const host = globalThis as unknown as SnapshotTimers

export interface EventSnapshotOptions {
  storage: SnapshotStorage
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

function answerable(filter: SnapshotFilter): boolean {
  return Object.keys(filter).every(
    (key) => ['ids', 'kinds', 'authors', 'since', 'until', 'limit'].includes(key) || (key.startsWith('#') && key.length === 2),
  )
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
  const maxEvents = options.maxEvents ?? SNAPSHOT_MAX_EVENTS
  const saveAfterMs = options.saveAfterMs ?? SNAPSHOT_SAVE_AFTER_MS
  const now = options.now ?? (() => Date.now())
  const timers = () => options.timers ?? host

  const events = new Map<string, StoredSnapshotEvent>()
  const byCoordinate = new Map<string, string>()
  const byContent = new Map<string, string>()
  /** Plaintexts for a ciphertext no held event carries: this page load only. */
  const looseText = new Map<string, string>()
  const filters = new Set<string>()
  const dirty = new Set<string>()
  const removed = new Set<string>()
  let filtersDirty = false
  let timer: unknown
  let closed = false

  function drop(id: string) {
    const held = events.get(id)
    if (!held) return
    events.delete(id)
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
    const plaintext = stored.plaintext ?? previous?.plaintext ?? looseText.get(event.content)
    events.set(event.id, { event, seenAt: stored.seenAt, ...(plaintext !== undefined ? { plaintext } : {}) })
    // A person's own blob is a replaceable event: only those carry a plaintext worth keeping.
    if (coordinate && event.content) byContent.set(event.content, event.id)
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
    if (closed || (!dirty.size && !removed.size && !filtersDirty)) return
    const change: SnapshotChange = {
      version,
      put: [...dirty].flatMap((id) => {
        const held = events.get(id)
        return held ? [held] : []
      }),
      remove: [...removed],
      filters: [...filters],
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
      const record = await storage.load(scope)
      if (record && record.version === version) {
        for (const stored of record.events) hold(stored, false)
        for (const key of record.filters) filters.add(key)
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
      const sent = answer.filter((event) => matchesSnapshotFilter(filter, event))
      // Cut by its limit — counted on the whole answer too when it is the only filter, so an
      // event the relay matched and this rule does not cannot make a cut answer look whole.
      const limit = typeof filter.limit === 'number' ? filter.limit : Infinity
      const cut = sent.length >= limit || (asked.length === 1 && answer.length >= limit)
      const floor = cut && sent.length ? Math.min(...sent.map((event) => event.created_at)) : cut ? Infinity : -Infinity
      for (const stored of [...events.values()]) {
        const { event } = stored
        if (returned.has(event.id) || event.created_at < floor) continue
        if (matchesSnapshotFilter(filter, event)) drop(event.id)
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

  return {
    ready,
    answer(asked) {
      if (!asked.length) return null
      if (!asked.every((f) => answerable(f) && filters.has(snapshotFilterKey(f)))) return null
      const out = new Map<string, SignedEvent>()
      for (const filter of asked) {
        const matched = [...events.values()]
          .map((stored) => stored.event)
          .filter((event) => matchesSnapshotFilter(filter, event))
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
  return {
    records,
    async load(scope) {
      const record = records.get(scope)
      return record ? { ...record, events: [...record.events], filters: [...record.filters] } : null
    },
    async save(scope, change) {
      const record = records.get(scope)
      const held = new Map(record && record.version === change.version ? record.events.map((s) => [s.event.id, s]) : [])
      for (const id of change.remove) held.delete(id)
      for (const stored of change.put) held.set(stored.event.id, stored)
      records.set(scope, { version: change.version, events: [...held.values()], filters: [...change.filters] })
    },
    async clear() {
      records.clear()
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

  /** Saves in flight: a sign-out's `clear` waits for them, or one could write the copy back after it. */
  const saving = new Set<Promise<void>>()

  async function write(scope: string, change: SnapshotChange): Promise<void> {
    const database = await db()
    const read = database.transaction([META], 'readonly')
    const meta = (await request(read.objectStore(META).get(scope))) as { version: number } | undefined
    const tx = database.transaction([EVENTS, META], 'readwrite')
    const events = tx.objectStore(EVENTS)
    if (meta && meta.version !== change.version) {
      const keys = await request(events.index('scope').getAllKeys(scope))
      for (const key of keys) events.delete(key)
    }
    for (const id of change.remove) events.delete([scope, id])
    for (const stored of change.put) events.put({ scope, id: stored.event.id, ...stored })
    tx.objectStore(META).put({ scope, version: change.version, filters: change.filters })
    await done(tx)
  }

  return {
    async load(scope) {
      const database = await db()
      const tx = database.transaction([EVENTS, META], 'readonly')
      const [meta, rows] = await Promise.all([
        request(tx.objectStore(META).get(scope)) as Promise<{ version: number; filters: string[] } | undefined>,
        request(tx.objectStore(EVENTS).index('scope').getAll(scope)) as Promise<(StoredSnapshotEvent & { scope: string; id: string })[]>,
      ])
      if (!meta) return null
      return {
        version: meta.version,
        filters: meta.filters,
        events: rows.map(({ event, plaintext, seenAt }) => ({ event, seenAt, ...(plaintext !== undefined ? { plaintext } : {}) })),
      }
    },
    save(scope, change) {
      const run = write(scope, change)
      saving.add(run)
      void run.catch(() => {}).finally(() => saving.delete(run))
      return run
    },
    async clear() {
      await Promise.allSettled([...saving])
      const database = await db()
      const tx = database.transaction([EVENTS, META], 'readwrite')
      tx.objectStore(EVENTS).clear()
      tx.objectStore(META).clear()
      await done(tx)
    },
  }
}

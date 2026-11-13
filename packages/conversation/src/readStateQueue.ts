/*
  SPEC §11: marking things read and getting it onto the relay — the one queue
  Ship and Leaf both use (TOPIC-3), so an app writes read state by
  construction rather than by copying another app's queue.

  One queue per tab, because a slot is one replaceable blob per installation:
  two queues would each hold a partial context map and take turns overwriting
  one another's markers.

  Whole blob, always. The coordinate is replaced, not patched, so every
  publish carries the complete map, and the slot is read back from the relay
  before every write: every tab of this browser shares the slot, and a blob
  read before another tab's publish would write over what that tab added. A
  partial blob does not fail; it silently drops every context it left out, and
  because the cross-slot merge is grow-only the loss stays invisible until
  this is the last slot standing.

  Debounced on marks, never on a poll: a refresh is not somebody reading
  anything, and each publish costs an encrypt, a sign and a publish.

  why: https://github.com/estiva-app/estiva-docs/blob/main/decisions/a-reply-is-read-only-when-its-thread-is-opened.md
*/
import type { SignedEvent, UnsignedEvent } from '@estiva-app/protocol'
import type { QueryFn } from './decorations.js'
import { KIND_APP_DATA } from './kinds.js'
import {
  REPLY_FLOOR_CONTEXT,
  advanceContexts as advance,
  loadSlotIdentity,
  parseReadStateBlob,
  publishReadState,
  readStateDTag,
  rotateSlotId,
  toContextSeconds,
  type Nip44,
  type RandomBytes,
  type SlotIdentity,
  type SlotStorage,
} from './readState.js'

type Timer = unknown
const timers = globalThis as unknown as { setTimeout(run: () => void, ms: number): Timer; clearTimeout(id: Timer): void }
const consoleWarn = (...args: unknown[]): void => (globalThis as unknown as { console?: { warn(...a: unknown[]): void } }).console?.warn(...args)

/** Long enough to batch a few marks, short enough to survive a tab close. */
export const READ_STATE_PUBLISH_DEBOUNCE_MS = 3000

/** How long something must be on screen before it counts as read (Peek's, Ship's and Leaf's). */
export const READ_DWELL_MS = 1500

/** The longest wait between attempts while publishing keeps failing. */
export const READ_STATE_MAX_RETRY_MS = 60_000

/** The part of a browser's `document` the queue and the dwell listen to. */
export interface VisibilitySource {
  readonly hidden: boolean
  addEventListener(type: 'visibilitychange', listener: () => void): void
  removeEventListener(type: 'visibilitychange', listener: () => void): void
}

/** What a flush did, for an app's diagnostic. */
export type ReadStateAttempt =
  | 'nothing-pending'
  | 'no-session'
  | 'not-hydrated'
  | 'unchanged'
  | 'published'
  | 'rejected'
  | 'failed'

export interface ReadStateQueueOptions {
  /** Where the slot id lives (`localStorage`); read when the slot is first needed. It may throw, or be absent. */
  storage: () => SlotStorage | undefined
  /** The app's own key (`ship.readstate.slot`, `leaf.readstate.slot`), so it keeps the slot it has. */
  storageKey: string
  /** Names the app in a new `client_id`: `ship` → `ship-1a2b3c4d`. */
  clientPrefix: string
  random: RandomBytes
  /** Who is signed in now, or undefined. A mark made by nobody is dropped; a change of person drops the last one's queue. */
  pubkey: () => string | undefined
  /**
   * Whether a write can go out now — false while an access token is being renewed. The markers wait and the
   * queue comes back, backing off. Absent: always.
   */
  canWrite?: () => boolean
  query: QueryFn
  nip44: Nip44
  sign: (event: UnsignedEvent) => Promise<SignedEvent>
  publish: (event: SignedEvent) => Promise<{ ok: boolean; reason?: string }>
  /** Each mark that moved a context, at once — before the publish — so a page can draw it read now. */
  onMarked?: (contexts: Readonly<Record<string, number>>) => void
  /** Each flush's outcome, for a diagnostic. */
  onAttempt?: (outcome: ReadStateAttempt, detail?: string, contexts?: number) => void
  debounceMs?: number
}

export interface ReadStateQueue {
  /** Mark these contexts read at `atMs`; the publish follows, debounced. Contexts come from this package's builders. */
  markRead(contexts: readonly (string | undefined)[], atMs?: number): void
  /** Publish what is pending now. */
  flush(): Promise<void>
  /** This installation's slot, minted on first use. */
  identity(): SlotIdentity
  /** Publish before the tab goes away: `visibilitychange` is the one a phone fires. Returns the uninstall. */
  installFlushOnHide(doc: VisibilitySource): () => void
  /** What the queue holds now, copied, for a diagnostic: what can no probe outside the tab can see. */
  state(): ReadStateQueueState
  /** Drop the tab's state, timers included, so a test starts clean. */
  reset(): void
}

export interface ReadStateQueueState {
  /** Everything this slot believes it has read. */
  known: Record<string, number>
  /** Marked but not yet in an accepted publish. Non-empty for long is the smell. */
  pending: Record<string, number>
  /** What the relay is believed to hold for this slot. */
  published: Record<string, number> | undefined
  hydrated: boolean
  /** The wait before the next retry, 0 when none is backing off. */
  retryMs: number
}

export function createReadStateQueue(options: ReadStateQueueOptions): ReadStateQueue {
  const { storageKey, clientPrefix, random, query, nip44 } = options
  const debounceMs = options.debounceMs ?? READ_STATE_PUBLISH_DEBOUNCE_MS
  const canWrite = options.canWrite ?? (() => true)
  const attempt = (outcome: ReadStateAttempt, detail?: string, contexts?: number) => options.onAttempt?.(outcome, detail, contexts)

  let identity: SlotIdentity | undefined
  /** Whose read state this queue holds. */
  let owner: string | undefined
  /** Everything this slot holds: its own blob from the relay, plus what was marked here. */
  let known: Record<string, number> = {}
  /** Marked but not yet in an accepted publish. */
  let pending: Record<string, number> = {}
  /** What the relay is believed to hold, so an unchanged blob is not published again. */
  let published: Record<string, number> | undefined
  /** The last content seen at our coordinate and what it held, so an unchanged slot is not decrypted again. */
  let ownCopy: { content: string; contexts: Record<string, number> } | undefined
  let hydrated = false
  let timer: Timer | undefined
  let retryMs = 0
  let inFlight: Promise<void> = Promise.resolve()

  function currentIdentity(): SlotIdentity {
    identity ??= loadSlotIdentity({ storage: safe(options.storage), storageKey, clientPrefix, random })
    return identity
  }

  function advanceContexts(current: Record<string, number>, updates: Record<string, number>): Record<string, number> {
    const { contexts, evicted } = advance(current, updates)
    if (evicted.length > 0) consoleWarn(`[read-state] over the byte cap; ${evicted.length} oldest markers dropped`)
    return contexts
  }

  /** Another person in this tab: nothing of the last one's — what they read, what waits to be published — carries over. */
  function forPerson(pubkey: string): void {
    if (owner === pubkey) return
    owner = pubkey
    known = {}
    pending = {}
    published = undefined
    ownCopy = undefined
    hydrated = false
  }

  /**
   * Read this installation's own blob back. Only our own coordinate: the write needs nothing of the other slots,
   * and each would cost a `/nip44/decrypt` from the quota the rest of the app shares. Unreachable is not empty, and
   * a slot that would not decrypt this time (a 429 above all) is not ours to write over: both throw, leaving the
   * queue unhydrated so it comes back.
   */
  async function hydrate(pubkey: string): Promise<void> {
    hydrated = false
    const slot = currentIdentity()
    const events = await query([{ kinds: [KIND_APP_DATA], authors: [pubkey], '#d': [readStateDTag(slot.slotId)] }])
    const newest = events.filter((e) => e.pubkey === pubkey).sort((a, b) => b.created_at - a.created_at)[0]
    let own: Record<string, number> = {}
    if (newest && ownCopy?.content === newest.content) own = ownCopy.contexts
    else if (newest) {
      const blob = parseReadStateBlob(await nip44.decrypt(newest.content))
      if (blob?.client_id === slot.clientId) {
        own = blob.contexts
        ownCopy = { content: newest.content, contexts: own }
      } else {
        // Another installation's blob at our coordinate (a copied profile), or one that will never decrypt (a rotated
        // key): take a new slot id and start it empty, never writing over it.
        identity = rotateSlotId(slot, { storage: safe(options.storage), storageKey, random })
        ownCopy = undefined
      }
    }
    if (owner !== pubkey) return
    // Seeded from our own slot, never the merge: a slot is this installation's account of what it read, and seeding
    // from the merge grows every slot to everything the person has read. The floor goes in as `current`, since
    // `advanceContexts` refuses one among the updates.
    const { [REPLY_FLOOR_CONTEXT]: floor, ...marked } = known
    const held = floor === undefined ? own : { ...own, [REPLY_FLOOR_CONTEXT]: Math.max(floor, own[REPLY_FLOOR_CONTEXT] ?? 0) }
    known = advanceContexts(held, marked)
    published = own
    hydrated = true
  }

  function schedule(ms: number): void {
    timer = timers.setTimeout(() => {
      timer = undefined
      void flush()
    }, ms)
  }

  /** Markers are still pending after a failed attempt: come back, backing off so an outage is not a busy loop. */
  function retryLater(): void {
    if (timer !== undefined) return
    retryMs = retryMs === 0 ? debounceMs : Math.min(retryMs * 2, READ_STATE_MAX_RETRY_MS)
    schedule(retryMs)
  }

  function flush(): Promise<void> {
    if (timer !== undefined) {
      timers.clearTimeout(timer)
      timer = undefined
    }
    inFlight = inFlight.then(async () => {
      if (Object.keys(pending).length === 0) return attempt('nothing-pending')
      const pubkey = options.pubkey()
      if (!pubkey || !canWrite()) {
        attempt('no-session', 'retrying')
        return retryLater()
      }
      // Marked by someone else who has since left this tab: theirs, never this person's.
      forPerson(pubkey)
      if (Object.keys(pending).length === 0) return attempt('nothing-pending')
      try {
        await hydrate(pubkey)
      } catch (error) {
        consoleWarn('[read-state] could not read the slot back:', error)
      }
      if (!hydrated) {
        attempt('not-hydrated', 'relay unreachable, or our slot would not decrypt; retrying')
        return retryLater()
      }
      const sending = pending
      const contexts = { ...known }
      pending = {}
      if (published && sameContexts(published, contexts)) return attempt('unchanged')
      try {
        // Signed only as the person whose markers these are: a sign-in in another tab since the flush began would
        // put them in that person's slot. What goes out is remembered, so reading it back costs no decrypt.
        const result = await publishReadState(
          {
            sign: (event) => (options.pubkey() === pubkey ? options.sign(event) : Promise.reject(new Error('the person signed in changed'))),
            publish: async (event) => {
              const answer = await options.publish(event)
              if (answer.ok) ownCopy = { content: event.content, contexts }
              return answer
            },
            nip44,
          },
          pubkey,
          currentIdentity(),
          contexts,
          Date.now(),
        )
        if (result.ok) {
          published = contexts
          retryMs = 0
          return attempt('published', undefined, Object.keys(contexts).length)
        }
        consoleWarn('[read-state] publish refused:', result.reason)
        attempt('rejected', result.reason)
      } catch (error) {
        consoleWarn('[read-state] publish failed:', error)
        attempt('failed', error instanceof Error ? error.message : String(error))
      }
      pending = advanceContexts(pending, sending)
      retryLater()
    })
    return inFlight
  }

  function markRead(contexts: readonly (string | undefined)[], atMs: number = Date.now()): void {
    const pubkey = options.pubkey()
    if (!pubkey) return
    forPerson(pubkey)
    const seconds = toContextSeconds(atMs)
    const moved: Record<string, number> = {}
    for (const context of contexts) {
      if (!context) continue
      const advanced = advanceContexts(known, { [context]: seconds })
      // Not newer, or not a context the blob takes: nothing to publish.
      if (advanced[context] === known[context]) continue
      known = advanced
      pending = advanceContexts(pending, { [context]: seconds })
      moved[context] = seconds
    }
    if (Object.keys(moved).length === 0) return
    options.onMarked?.(moved)
    if (timer !== undefined) timers.clearTimeout(timer)
    schedule(debounceMs)
  }

  function installFlushOnHide(doc: VisibilitySource): () => void {
    const onHidden = () => {
      if (doc.hidden) void flush()
    }
    doc.addEventListener('visibilitychange', onHidden)
    return () => doc.removeEventListener('visibilitychange', onHidden)
  }

  function reset(): void {
    if (timer !== undefined) timers.clearTimeout(timer)
    timer = undefined
    identity = undefined
    owner = undefined
    known = {}
    pending = {}
    published = undefined
    ownCopy = undefined
    hydrated = false
    retryMs = 0
    inFlight = Promise.resolve()
  }

  const state = (): ReadStateQueueState => ({
    known: { ...known },
    pending: { ...pending },
    published: published ? { ...published } : undefined,
    hydrated,
    retryMs,
  })

  return { markRead, flush, identity: currentIdentity, installFlushOnHide, state, reset }
}

/**
 * Mark `contexts` read once they have stayed on screen for {@link READ_DWELL_MS}: a conversation glanced past is not
 * read. Only while the page is shown, and again when it comes back. `newestAtMs` is the newest message drawn for
 * them: the mark never runs past it or past the clock, and a message dated ahead of the clock is read once the clock
 * gets there, asked again at most a minute apart (a date far ahead would overflow the timer). With none drawn, the
 * clock. Returns the cleanup — what a React effect returns.
 */
export function watchDwell(
  contexts: readonly string[],
  newestAtMs: number | undefined,
  mark: (contexts: readonly string[], atMs: number) => void,
  doc: VisibilitySource,
  dwellMs: number = READ_DWELL_MS,
): () => void {
  if (contexts.length === 0) return () => {}
  let t: Timer | undefined
  const fire = () => {
    const now = Date.now()
    mark(contexts, newestAtMs === undefined ? now : Math.min(newestAtMs, now))
    if (newestAtMs !== undefined && newestAtMs > now) t = timers.setTimeout(fire, Math.min(newestAtMs - now, 60_000))
  }
  const arm = () => {
    timers.clearTimeout(t)
    if (!doc.hidden) t = timers.setTimeout(fire, dwellMs)
  }
  arm()
  doc.addEventListener('visibilitychange', arm)
  return () => {
    timers.clearTimeout(t)
    doc.removeEventListener('visibilitychange', arm)
  }
}

/**
 * The key a dwell restarts on: the set of contexts, not the array a render made. JSON, so it is never split back on a
 * character an address may hold; {@link dwellContexts} turns it back.
 */
export function dwellKey(contexts: readonly (string | undefined)[]): string {
  return JSON.stringify(contexts.filter((c): c is string => Boolean(c)).sort())
}

export function dwellContexts(key: string): string[] {
  return JSON.parse(key) as string[]
}

function safe(storage: () => SlotStorage | undefined): SlotStorage | undefined {
  try {
    return storage()
  } catch {
    return undefined
  }
}

function sameContexts(a: Record<string, number>, b: Record<string, number>): boolean {
  const keys = Object.keys(a)
  return keys.length === Object.keys(b).length && keys.every((k) => a[k] === b[k])
}

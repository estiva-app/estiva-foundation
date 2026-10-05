/**
 * Read state — SPEC §11, NIP-RS: per person, not per app.
 *
 * `kind:30078` blobs, NIP-44 encrypted to self, **one per installation**,
 * merged by taking the maximum timestamp per context. Reading a file in Ship
 * marks it read in Peek because both name it the same way (§11.1) and both
 * merge every slot.
 *
 * Ported from Peek's `readState.ts` and `readStateMerge.ts` and Ship's
 * `readState.ts`, which had diverged. Where they differed the SPEC decided:
 *
 * - **The cap is in bytes, not a count** (§11.6). `/nip44/encrypt` refuses a
 *   plaintext over 65,535 bytes, and on production a slot is refused at
 *   ~771 contexts, so Ship's 10,000-context cap could never fire. Eviction is
 *   deterministic to the tie, so a merge does not hand an evicted context back.
 * - **A slot whose coordinate carries another `client_id` is reported**, so
 *   the app can rotate rather than overwrite another installation on every
 *   write (Peek had it; Ship did not).
 * - **An unreachable relay is not "no slots"**, and our own slot existing but
 *   not decrypting is not "first run" (Ship had both apart; kept).
 *
 * Nothing here opens a socket or touches the browser: the relay read, the
 * signer, NIP-44 and storage are parameters.
 */
import type { SignedEvent, UnsignedEvent } from '@estiva-app/protocol'
import { FILE_ADDRESS as ADDRESS_RE, FOLDER_ID as UUID_RE, KIND_APP_DATA } from './kinds.js'
import type { QueryFn } from './decorations.js'

/** NIP-RS's own `t` tag. */
export const READ_STATE_TAG = 'read-state'

/** The `d`-tag prefix the relay's NIP-RS predicate keys on (§11.6). */
export const READ_STATE_D_PREFIX = 'read-state:'

/**
 * Limits from NIP-RS and the reference implementation (§11.6).
 * `MAX_CONTEXTS` binds only the merged view across slots: one blob meets
 * {@link MAX_CONTEXTS_BYTES} far sooner.
 */
export const MAX_CONTEXTS = 10_000
export const MAX_CONTEXT_ID_BYTES = 256
export const MAX_TIMESTAMP = 4_294_967_295
export const MAX_CLIENT_ID_BYTES = 64

/** The plaintext ceiling `/nip44/encrypt` enforces (SPEC §12.5), in bytes of UTF-8. */
export const MAX_BLOB_BYTES = 65_535

/**
 * The bytes the `contexts` map may occupy: the ceiling less the envelope, sized
 * at the **longest legal `client_id`**, so every installation holding the same
 * contexts evicts the same ones.
 */
export const MAX_CONTEXTS_BYTES =
  MAX_BLOB_BYTES - (JSON.stringify({ v: 1, client_id: 'x'.repeat(MAX_CLIENT_ID_BYTES), contexts: {} }).length - 2)

/** A horizon of 90 days: what both apps used. NIP-RS fixes none (§11.6). */
export const READ_STATE_HORIZON_DAYS = 90

/**
 * The thread rule's cut-over, unix seconds (§11.3, CON-34): a reply created
 * after it is read only by its thread's own marker, never by reading the
 * stream it sits in. A suite constant, stated in SPEC — every app must agree
 * on which replies predate it.
 *
 * `MAX_TIMESTAMP` is today's rule exactly (`min(stream, MAX)` is the stream).
 * It is set to a real date only once every app judges by this package, since
 * an app still on the old rule would clear what the others hold.
 */
export const THREAD_RULE_FROM = MAX_TIMESTAMP

/**
 * The reserved context of the reply floor (§11.1, §11.6): every reply at or
 * before it counts as read. Raised, never lowered, when the byte cap drops a
 * `thread:` marker — to that marker's value — so a reply somebody read never
 * lights again; what it costs instead is the oldest replies nobody opened.
 */
export const REPLY_FLOOR_CONTEXT = 'reply-floor'

const EVENT_ID_RE = /^[0-9a-f]{64}$/
const SLOT_ID_RE = /^[0-9a-f]{32}$/

/** Bytes of UTF-8 — counted here, since a package may not reach for `TextEncoder` (ADR 0002). */
function utf8(value: string): number {
  let bytes = 0
  for (const char of value) {
    const code = char.codePointAt(0) ?? 0
    bytes += code < 0x80 ? 1 : code < 0x800 ? 2 : code < 0x10000 ? 3 : 4
  }
  return bytes
}

// ── Context identifiers — §11.1 ─────────────────────────────────────────────

/** A channel's context: the **bare** channel uuid. Undefined for anything else, never coerced. */
export function channelContext(channelUuid: string | null | undefined): string | undefined {
  if (!channelUuid) return undefined
  const value = channelUuid.toLowerCase()
  return UUID_RE.test(value) ? value : undefined
}

/** A file's context: its **bare** address, `d` verbatim (FOL-16). */
export function fileContext(address: string | null | undefined): string | undefined {
  if (!address || utf8(address) > MAX_CONTEXT_ID_BYTES) return undefined
  return ADDRESS_RE.test(address) ? address : undefined
}

/** `thread:<root-event-id>`, NIP-RS's own scheme. */
export function threadContext(rootEventId: string | null | undefined): string | undefined {
  if (!rootEventId) return undefined
  const value = rootEventId.toLowerCase()
  return EVENT_ID_RE.test(value) ? `thread:${value}` : undefined
}

/** `msg:<event-id>`, NIP-RS's own scheme. */
export function messageContext(eventId: string | null | undefined): string | undefined {
  if (!eventId) return undefined
  const value = eventId.toLowerCase()
  return EVENT_ID_RE.test(value) ? `msg:${value}` : undefined
}

/** Epoch ms → the unix **seconds** NIP-RS stores, clamped to its range. */
export function toContextSeconds(atMs: number): number {
  const seconds = Math.floor(atMs / 1000)
  if (!Number.isFinite(seconds) || seconds < 0) return 0
  return Math.min(seconds, MAX_TIMESTAMP)
}

/**
 * Is this a context id worth putting in a grow-only blob: a channel uuid, a
 * file address, `thread:`/`msg:` with 64 lowercase hex, or the reply floor.
 * The reserved `folder:` is refused until §11.5 specifies it.
 */
export function isPublishableContextId(id: string): boolean {
  if (id === REPLY_FLOOR_CONTEXT) return true
  if (id.length === 0 || utf8(id) > MAX_CONTEXT_ID_BYTES) return false
  if (id.startsWith('thread:')) return EVENT_ID_RE.test(id.slice('thread:'.length))
  if (id.startsWith('msg:')) return EVENT_ID_RE.test(id.slice('msg:'.length))
  return UUID_RE.test(id) || ADDRESS_RE.test(id)
}

const isTimestamp = (value: unknown): value is number =>
  typeof value === 'number' && Number.isInteger(value) && value >= 0 && value <= MAX_TIMESTAMP

// ── Slot identity ───────────────────────────────────────────────────────────

/** This installation's slot. */
export interface SlotIdentity {
  /** 32 lowercase hex; the `d` tag is `read-state:<slotId>`. */
  slotId: string
  /** A stable name for this installation, 1–64 characters. */
  clientId: string
}

/** The storage a slot lives in — `localStorage` in a browser. It may throw. */
export interface SlotStorage {
  getItem(key: string): string | null
  setItem(key: string, value: string): void
}

/** `n` cryptographically random bytes — `(n) => crypto.getRandomValues(new Uint8Array(n))`. */
export type RandomBytes = (n: number) => Uint8Array

const hexOf = (bytes: Uint8Array) => Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('')

/** Where a slot lives and how a new one is minted. */
export interface SlotSource {
  storage: SlotStorage | undefined
  /** The app's own key (`estiva-peek:read-state-slot`, `ship.readstate.slot`), so it keeps the slot it has. */
  storageKey: string
  /** Names the app in a new `client_id`: `peek` → `peek-1a2b3c4d`. */
  clientPrefix: string
  random: RandomBytes
}

/**
 * This installation's slot, minted once and reused.
 *
 * Storage must survive a restart — a slot minted per session piles up past the
 * reference client's eight. A storage that throws degrades to an ephemeral
 * slot rather than failing the app.
 */
export function loadSlotIdentity(source: SlotSource): SlotIdentity {
  const { storage, storageKey, clientPrefix, random } = source
  // ASCII and short, so the `client_id` is under the byte limit the reload checks — a longer one would mint a new slot every load.
  if (!/^[a-z0-9-]{1,55}$/.test(clientPrefix)) throw new Error(`client prefix must be 1–55 of [a-z0-9-], got ${JSON.stringify(clientPrefix)}`)
  const fresh = (): SlotIdentity => ({ slotId: hexOf(random(16)), clientId: `${clientPrefix}-${hexOf(random(4))}` })
  if (!storage) return fresh()
  try {
    const raw = storage.getItem(storageKey)
    if (raw) {
      const parsed = JSON.parse(raw) as Partial<SlotIdentity>
      if (
        typeof parsed.slotId === 'string' &&
        SLOT_ID_RE.test(parsed.slotId) &&
        typeof parsed.clientId === 'string' &&
        parsed.clientId.length >= 1 &&
        utf8(parsed.clientId) <= MAX_CLIENT_ID_BYTES
      ) {
        return { slotId: parsed.slotId, clientId: parsed.clientId }
      }
    }
  } catch {
    // Unreadable: mint below.
  }
  const identity = fresh()
  try {
    storage.setItem(storageKey, JSON.stringify(identity))
  } catch {
    // Ephemeral slot.
  }
  return identity
}

/**
 * A new slot id with the same `client_id`, persisted. For one case: our
 * coordinate carries another installation's `client_id`, and writing to it
 * would overwrite theirs on every write.
 */
export function rotateSlotId(identity: SlotIdentity, source: Omit<SlotSource, 'clientPrefix'>): SlotIdentity {
  const { storage, storageKey, random } = source
  const rotated: SlotIdentity = { slotId: hexOf(random(16)), clientId: identity.clientId }
  try {
    storage?.setItem(storageKey, JSON.stringify(rotated))
  } catch {
    // Ephemeral.
  }
  return rotated
}

/** `read-state:<slot-id>`. */
export function readStateDTag(slotId: string): string {
  if (!SLOT_ID_RE.test(slotId)) throw new Error(`slot id must be 32 lowercase hex, got ${JSON.stringify(slotId)}`)
  return `${READ_STATE_D_PREFIX}${slotId}`
}

// ── The blob ────────────────────────────────────────────────────────────────

/** A decrypted NIP-RS blob. */
export interface ReadStateBlob {
  v: 1
  client_id: string
  /** Context id → unix seconds. */
  contexts: Record<string, number>
}

/**
 * Parse a decrypted blob, dropping entries it cannot trust and keeping the
 * rest. Undefined only when it is not a v1 blob at all — which the caller must
 * keep apart from an empty one, so as not to republish over it.
 */
export function parseReadStateBlob(plaintext: string | undefined): ReadStateBlob | undefined {
  if (!plaintext) return undefined
  let raw: unknown
  try {
    raw = JSON.parse(plaintext)
  } catch {
    return undefined
  }
  if (typeof raw !== 'object' || raw === null) return undefined
  const blob = raw as Partial<ReadStateBlob>
  if (blob.v !== 1) return undefined
  const clientId =
    typeof blob.client_id === 'string' && blob.client_id.length >= 1 && utf8(blob.client_id) <= MAX_CLIENT_ID_BYTES ? blob.client_id : ''
  const contexts: Record<string, number> = {}
  const source = typeof blob.contexts === 'object' && blob.contexts !== null ? blob.contexts : {}
  for (const [key, value] of Object.entries(source as Record<string, unknown>)) {
    if (isPublishableContextId(key) && isTimestamp(value)) contexts[key] = value
  }
  return { v: 1, client_id: clientId, contexts }
}

/** Serialize for encryption, keys sorted, so an unchanged set is an unchanged string. */
export function serializeReadStateBlob(blob: ReadStateBlob): string {
  const contexts: Record<string, number> = {}
  for (const key of Object.keys(blob.contexts).sort()) contexts[key] = blob.contexts[key]
  return JSON.stringify({ v: blob.v, client_id: blob.client_id, contexts })
}

/** A context map trimmed to the byte ceiling, and what that cost. */
export interface CappedContexts {
  contexts: Record<string, number>
  /** `JSON.stringify(contexts)` in bytes of UTF-8, braces included. */
  bytes: number
  /** What was dropped, newest first. Empty is the normal case. */
  evicted: string[]
}

const byNewestThenKey = (contexts: Readonly<Record<string, number>>) => (a: string, b: string) =>
  contexts[b] - contexts[a] || (a < b ? -1 : a > b ? 1 : 0)

/**
 * Trim a context map to the byte budget, newest marker first, ties by key.
 * Dropping the oldest marker costs one conversation looking unread; a blob
 * over the ceiling is refused whole and costs all of them. Deterministic and
 * idempotent, so a merge does not undo an eviction.
 */
export function capContextsToBytes(contexts: Readonly<Record<string, number>>, budget: number = MAX_CONTEXTS_BYTES): CappedContexts {
  const cost = (key: string, value: number) => utf8(JSON.stringify(key)) + 1 + String(value).length
  const keys = Object.keys(contexts).sort(byNewestThenKey(contexts))
  const kept: Record<string, number> = {}
  let bytes = 2
  for (let i = 0; i < keys.length; i++) {
    const key = keys[i]
    const next = bytes + cost(key, contexts[key]) + (i === 0 ? 0 : 1)
    if (next > budget) return { contexts: kept, bytes, evicted: keys.slice(i) }
    kept[key] = contexts[key]
    bytes = next
  }
  return { contexts: kept, bytes, evicted: [] }
}

const isThreadKey = (key: string) => key.startsWith('thread:')

/**
 * {@link capContextsToBytes} for a read-state blob (§11.6): the reply floor
 * is never evicted, and dropping a `thread:` marker first raises the floor to
 * its value. Under the thread rule a `thread:` marker is never made redundant
 * by its stream, so without the floor every eviction would light replies the
 * person already read. Deterministic and idempotent, like the cap it wraps.
 */
export function capReadStateContexts(contexts: Readonly<Record<string, number>>, budget: number = MAX_CONTEXTS_BYTES): CappedContexts {
  const { [REPLY_FLOOR_CONTEXT]: floor, ...rest } = contexts
  if (floor === undefined) {
    const capped = capContextsToBytes(rest, budget)
    if (!capped.evicted.some(isThreadKey)) return capped
  }
  // The floor's slot is set aside first, at the widest value it can hold, so raising it never overflows.
  const reserve = utf8(JSON.stringify(REPLY_FLOOR_CONTEXT)) + 1 + String(MAX_TIMESTAMP).length + 1
  const capped = capContextsToBytes(rest, budget - reserve)
  const raised = Math.max(floor ?? 0, ...capped.evicted.filter(isThreadKey).map((key) => rest[key]))
  const kept = { ...capped.contexts, [REPLY_FLOOR_CONTEXT]: raised }
  return { contexts: kept, bytes: utf8(JSON.stringify(kept)), evicted: capped.evicted }
}

/**
 * Apply markers, taking the later of each (§11.4: never lower one), then cap.
 * Unpublishable ids and out-of-range timestamps are dropped.
 */
export function advanceContexts(current: Readonly<Record<string, number>>, updates: Readonly<Record<string, number>>): CappedContexts {
  const next: Record<string, number> = { ...current }
  for (const [id, seconds] of Object.entries(updates)) {
    if (!isPublishableContextId(id) || !isTimestamp(seconds)) continue
    if (next[id] === undefined || seconds > next[id]) next[id] = seconds
  }
  return capReadStateContexts(next)
}

// ── The event ───────────────────────────────────────────────────────────────

/**
 * The unsigned `kind:30078` for one slot: exactly one `d`, exactly one
 * `["t","read-state"]` (§11.6 — an event that misses the shape is stored as an
 * ordinary one and merged by nobody), and no `h`.
 */
export function buildReadStateEvent(pubkey: string, nowMs: number, slotId: string, ciphertext: string): UnsignedEvent {
  return {
    pubkey,
    created_at: Math.floor(nowMs / 1000),
    kind: KIND_APP_DATA,
    tags: [
      ['d', readStateDTag(slotId)],
      ['t', READ_STATE_TAG],
    ],
    content: ciphertext,
  }
}

/**
 * Every slot **this person** owns within the horizon. One pubkey and no list
 * variant: NIP-RS is not a read-receipt protocol.
 */
export function allSlotsFilter(pubkey: string, nowMs: number, horizonDays: number = READ_STATE_HORIZON_DAYS): Record<string, unknown> {
  const since = toContextSeconds(nowMs) - Math.round(horizonDays * 86_400)
  return { kinds: [KIND_APP_DATA], authors: [pubkey], '#t': [READ_STATE_TAG], since: Math.max(0, since) }
}

// ── Merge — §11.3, §11.4 ────────────────────────────────────────────────────

/** One slot as read from the relay. */
export interface SlotBlob {
  dTag: string
  eventId: string
  createdAt: number
  blob: ReadStateBlob
}

/** Every slot merged by the max rule, capped at {@link MAX_CONTEXTS} newest first, ties by key. */
export function mergeSlots(slots: readonly Pick<SlotBlob, 'blob'>[]): Record<string, number> {
  const merged: Record<string, number> = {}
  for (const { blob } of slots) {
    for (const [id, seconds] of Object.entries(blob.contexts)) {
      if (!isPublishableContextId(id) || !isTimestamp(seconds)) continue
      if (merged[id] === undefined || seconds > merged[id]) merged[id] = seconds
    }
  }
  const keys = Object.keys(merged)
  if (keys.length <= MAX_CONTEXTS) return merged
  const kept: Record<string, number> = {}
  for (const id of keys.sort(byNewestThenKey(merged)).slice(0, MAX_CONTEXTS)) kept[id] = merged[id]
  return kept
}

/** Which slots are this installation's. */
export interface OwnSlotVerdict {
  /** Our newest slot by `client_id`. */
  mine: SlotBlob | undefined
  /** Older slots under our `client_id` — left by a rotation. */
  staleDuplicates: SlotBlob[]
  /** Our coordinate holds another installation's `client_id`: rotate before writing. */
  coordinateConflicted: boolean
}

export function classifyOwnSlots(slots: readonly SlotBlob[], identity: SlotIdentity): OwnSlotVerdict {
  const ownDTag = readStateDTag(identity.slotId)
  const [mine, ...staleDuplicates] = slots.filter((s) => s.blob.client_id === identity.clientId).sort((a, b) => b.createdAt - a.createdAt)
  const atOwn = slots.find((s) => s.dTag === ownDTag)
  return { mine, staleDuplicates, coordinateConflicted: atOwn !== undefined && atOwn.blob.client_id !== identity.clientId }
}

/**
 * The effective marker (§11.3). For a reply, `context` is `thread:<root>` and
 * `stream` the file address or channel uuid; the channel never reaches into a
 * file's stream — pass the file's address, not the channel, for a file's
 * thread.
 *
 * A thread is read by its own marker, by the reply floor, and by its stream
 * only up to {@link THREAD_RULE_FROM}: reading a stream reads its top-level
 * messages, and a reply after the cut-over waits for its thread to be opened
 * (CON-34). This is where Estiva parts from NIP-RS's frontier rule, which
 * lets the stream reach every reply. Any other context is the later of its
 * own marker and its stream's, as NIP-RS has it.
 *
 * `from` is the cut-over; anything but the default is for a test.
 */
export function effectiveReadAt(
  merged: Readonly<Record<string, number>>,
  context: string,
  stream?: string,
  from: number = THREAD_RULE_FROM,
): number | undefined {
  const own = merged[context]
  let parent = stream === undefined ? undefined : merged[stream]
  let floor: number | undefined
  if (isThreadKey(context)) {
    if (parent !== undefined) parent = Math.min(parent, from)
    floor = merged[REPLY_FLOOR_CONTEXT]
  }
  return later(later(own, parent), floor)
}

function later(a: number | undefined, b: number | undefined): number | undefined {
  if (a === undefined) return b
  if (b === undefined) return a
  return Math.max(a, b)
}

// ── The relay — injected ────────────────────────────────────────────────────

/** NIP-44 to self. Estiva apps hold no key, so this is a round trip to the identity service. */
export interface Nip44 {
  encrypt(plaintext: string): Promise<string>
  /** Undefined, or a throw, when it will not decrypt. */
  decrypt(ciphertext: string): Promise<string | undefined>
}

/** Read state as far as the relay can tell. */
export interface FetchedReadState {
  /** False when the relay could not be asked — not the same as "no slots". */
  reachable: boolean
  merged: Record<string, number>
  slots: SlotBlob[]
  /** This installation's own blob, when the relay holds one at our coordinate and it decrypted. */
  own?: ReadStateBlob
  /**
   * Our coordinate exists and would not decrypt — typically a `429` from
   * `/nip44/decrypt`. Publishing now would replace it with only this session's
   * markers, so an app must not.
   */
  ownUndecryptable: boolean
  /** Our coordinate holds another installation's blob: {@link rotateSlotId} before writing. */
  coordinateConflicted: boolean
}

/** Fetch every slot within the horizon, decrypt what decrypts, merge. */
export async function fetchReadState(
  query: QueryFn,
  pubkey: string,
  nip44: Pick<Nip44, 'decrypt'>,
  identity: SlotIdentity,
  nowMs: number,
  horizonDays: number = READ_STATE_HORIZON_DAYS,
): Promise<FetchedReadState> {
  let events: SignedEvent[]
  try {
    events = await query([allSlotsFilter(pubkey, nowMs, horizonDays)])
  } catch {
    return { reachable: false, merged: {}, slots: [], ownUndecryptable: false, coordinateConflicted: false }
  }
  const ownDTag = readStateDTag(identity.slotId)
  const slots: SlotBlob[] = []
  let ownUndecryptable = false
  for (const event of events) {
    if (event.pubkey !== pubkey || event.kind !== KIND_APP_DATA) continue
    const dTag = event.tags.find((t) => t[0] === 'd')?.[1]
    if (!dTag?.startsWith(READ_STATE_D_PREFIX)) continue
    let plaintext: string | undefined
    // One at a time on purpose: `/nip44/decrypt` answers 429 to a burst, and
    // a 429 on our own slot reads as undecryptable and blocks publishing.
    try {
      plaintext = await nip44.decrypt(event.content)
    } catch {
      plaintext = undefined
    }
    const blob = parseReadStateBlob(plaintext)
    if (!blob) {
      // Another slot that will not decrypt belongs to a rotated key: skipped.
      if (dTag === ownDTag) ownUndecryptable = true
      continue
    }
    slots.push({ dTag, eventId: event.id, createdAt: event.created_at, blob })
  }
  const atOwn = slots.find((s) => s.dTag === ownDTag)
  const coordinateConflicted = atOwn !== undefined && atOwn.blob.client_id !== identity.clientId
  return {
    reachable: true,
    merged: mergeSlots(slots),
    slots,
    own: atOwn && !coordinateConflicted ? atOwn.blob : undefined,
    ownUndecryptable,
    coordinateConflicted,
  }
}

/** Encrypt, sign and publish this slot's whole blob. The caller has already capped `contexts`. */
export async function publishReadState(
  deps: {
    sign: (event: UnsignedEvent) => Promise<SignedEvent>
    publish: (event: SignedEvent) => Promise<{ ok: boolean; reason?: string }>
    nip44: Pick<Nip44, 'encrypt'>
  },
  pubkey: string,
  identity: SlotIdentity,
  contexts: Readonly<Record<string, number>>,
  nowMs: number,
): Promise<{ ok: boolean; reason?: string }> {
  // Filtered here as well: the blob is grow-only, and a map built outside `advanceContexts` must not put an id into it.
  const plaintext = serializeReadStateBlob({ v: 1, client_id: identity.clientId, contexts: advanceContexts({}, contexts).contexts })
  if (utf8(plaintext) > MAX_BLOB_BYTES) return { ok: false, reason: `read state is ${utf8(plaintext)} bytes, over ${MAX_BLOB_BYTES}` }
  const ciphertext = await deps.nip44.encrypt(plaintext)
  const signed = await deps.sign(buildReadStateEvent(pubkey, nowMs, identity.slotId, ciphertext))
  const result = await deps.publish(signed)
  return { ok: result.ok, reason: result.reason }
}

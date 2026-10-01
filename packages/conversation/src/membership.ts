/**
 * Membership — SPEC §11.8: whose unread a file's conversation is.
 *
 * A person is told about a file's conversation when they are a **member** of
 * the file, and every app computes that the same way, from public events: the
 * file's root, the messages in its stream (§11.1) and its `kind:1851`
 * changes. A Folder's members are its channel roster, which is the relay's
 * and not folded here.
 *
 * | join | the event |
 * | --- | --- |
 * | created it | the root, at the earliest version the reader holds |
 * | took part | a message in the stream, by `P` |
 * | was mentioned | a message in the stream whose content names `P` (`nostr:npub…`) |
 * | was placed | a `kind:1851` on the file, not a membership field, whose `value` is `P` or that carries `["p", P]` |
 * | was added, or joined | a `kind:1851` setting `member:<P>` to `true`, by anyone |
 *
 * A **leave** is a `member:<P>` = `false` signed by `P`; one signed by anybody
 * else is ignored. Joins and leaves order as §6.3 orders changes, `P` is a
 * member when the last is a join, and a member **since** the first join after
 * the last leave.
 *
 * *Placed* reads the `value` as well as the `p`: on production (2026-09-30)
 * 37 of 52 assignee changes and every lead change carried no `p`, including
 * one written that day, so a `p`-only reading would miss most placements the
 * fold can see. The `p` is what makes a placement discoverable by `#p`, which
 * is why {@link buildMembershipChange} writes it.
 *
 * Muting is private and separate (§11.8 *Muting is private*): see
 * {@link parseMutedBlob}.
 */
import type { SignedEvent, UnsignedEvent } from '@estiva-app/protocol'
import { FILE_ADDRESS as ADDRESS, FOLDER_ID, KIND_APP_DATA, KIND_CHANGE, KIND_COMMENT, KIND_MESSAGE } from './kinds.js'
import { byOrder } from './order.js'
import { anchorsOf, isCommentOn, peopleNamedInBody } from './strength.js'
import { groupThreads } from './threads.js'

export { KIND_CHANGE }

/** The field prefix of a membership change: `member:<pubkey>`. */
export const MEMBER_FIELD_PREFIX = 'member:'

const PUBKEY = /^[0-9a-f]{64}$/

type Event = Pick<SignedEvent, 'id' | 'pubkey' | 'kind' | 'created_at' | 'tags' | 'content'>

/** A relay filter, as `QueryFn` takes one. */
type Filter = Record<string, unknown>

const tag = (event: Pick<SignedEvent, 'tags'>, name: string): string | undefined => event.tags.find((t) => t[0] === name)?.[1]

/** The membership field for a person: `member:<pubkey>`. */
export function memberField(pubkey: string): string {
  if (!PUBKEY.test(pubkey)) throw new Error(`not a lowercase hex pubkey: ${JSON.stringify(pubkey)}`)
  return `${MEMBER_FIELD_PREFIX}${pubkey}`
}

/** The person a `member:<pubkey>` field names, or undefined when it is not one. */
export function memberOfField(field: string | undefined): string | undefined {
  if (!field?.startsWith(MEMBER_FIELD_PREFIX)) return undefined
  const pubkey = field.slice(MEMBER_FIELD_PREFIX.length)
  return PUBKEY.test(pubkey) ? pubkey : undefined
}

/**
 * Does the message's content mention the person — a `nostr:npub…` in its body.
 * A `p` tag alone is not a mention for membership: the comment builders tag
 * the file's author and the parent's on every comment (§6.4), so a `p` would
 * re-join an author who left.
 */
export function mentions(event: Pick<SignedEvent, 'content'>, pubkey: string): boolean {
  return peopleNamedInBody(event.content).has(pubkey)
}

/** The address of an addressable event, `<kind>:<pubkey>:<d>`. */
function addressOf(event: Pick<SignedEvent, 'kind' | 'pubkey' | 'tags'>): string | undefined {
  if (event.kind < 30000 || event.kind > 39999) return undefined
  return `${event.kind}:${event.pubkey}:${tag(event, 'd') ?? ''}`
}

/**
 * The messages in a file's stream (§11.1): every root that is a comment on it,
 * and every reply in those threads. A `kind:1111` reply whose root the read
 * does not hold still counts when its `A` is the file — a reply copies its
 * thread's object. A `kind:9` never roots a file's stream (§6.4, CON-20).
 */
export function streamOf<E extends Event>(file: string, events: readonly E[]): E[] {
  const conversation = events.filter((e) => e.kind === KIND_COMMENT || e.kind === KIND_MESSAGE)
  const { roots, replies, missingRoots } = groupThreads(conversation)
  const missing = new Set(missingRoots)
  const out: E[] = []
  for (const root of roots) {
    if (!isCommentOn(root, file)) continue
    out.push(root, ...(replies[root.id] ?? []))
  }
  for (const id of missing) {
    for (const reply of replies[id] ?? []) if (reply.kind === KIND_COMMENT && anchorsOf(reply).includes(file)) out.push(reply)
  }
  return out.sort(byOrder)
}

/** Whether a person is a member of a file, and since which second. */
export interface Membership {
  member: boolean
  /** Unix seconds: the `created_at` of the first join after the last leave. Undefined when not a member. */
  since?: number
}

const NOT_A_MEMBER: Membership = { member: false }

/** `creation` is the root: it orders before everything else for the file, whichever version the reader holds. */
type Step = { event: Event; join: boolean; creation?: boolean }

/**
 * Every join and leave in a file's events, per person. `events` may hold
 * anything; only the file's root versions, its stream and its `kind:1851`
 * changes are read.
 */
function stepsOf(file: string, events: readonly Event[]): Map<string, Step[]> {
  const steps = new Map<string, Step[]>()
  const add = (person: string, event: Event, join: boolean, creation = false) => {
    if (!PUBKEY.test(person)) return
    const list = steps.get(person) ?? []
    list.push({ event, join, creation })
    steps.set(person, list)
  }

  // A relay keeps only the latest version of an addressable event, so the root
  // the reader holds is usually the last edit. Its join is ordered first, so
  // an edit after a leave does not make the author a member again.
  const versions = events.filter((e) => addressOf(e) === file).sort(byOrder)
  if (versions[0]) add(versions[0].pubkey, versions[0], true, true)

  for (const message of streamOf(file, events)) {
    add(message.pubkey, message, true)
    for (const person of peopleNamedInBody(message.content)) add(person, message, true)
  }

  for (const change of events) {
    if (change.kind !== KIND_CHANGE || !change.tags.some((t) => t[0] === 'a' && t[1] === file)) continue
    const field = tag(change, 'field')
    const value = tag(change, 'value')
    const member = memberOfField(field)
    if (member !== undefined) {
      if (value === 'true') add(member, change, true)
      else if (value === 'false' && change.pubkey === member) add(member, change, false)
      continue
    }
    // A change with an empty value takes someone off (an unassign) and places nobody, whatever `p` it carries.
    if (field?.startsWith(MEMBER_FIELD_PREFIX) || !value) continue
    const placed = new Set(change.tags.filter((t) => t[0] === 'p' && typeof t[1] === 'string').map((t) => t[1]))
    placed.add(value)
    for (const person of placed) add(person, change, true)
  }
  return steps
}

function fold(steps: readonly Step[] | undefined): Membership {
  if (!steps || steps.length === 0) return NOT_A_MEMBER
  const ordered = [...steps].sort(
    (a, b) => Number(b.creation ?? false) - Number(a.creation ?? false) || byOrder(a.event, b.event) || Number(a.join) - Number(b.join),
  )
  if (!ordered[ordered.length - 1].join) return NOT_A_MEMBER
  // Since: the earliest second among the joins after the last leave — the creation's
  // held version can be a later edit than the author's first comment.
  let since: number | undefined
  for (const step of ordered) {
    if (!step.join) since = undefined
    else since = since === undefined ? step.event.created_at : Math.min(since, step.event.created_at)
  }
  return { member: true, since }
}

/**
 * One person's membership of one file (§11.8 *The fold*), from the file's own
 * events: its root, its stream and its changes.
 */
export function membershipOf(file: string, person: string, events: readonly Event[]): Membership {
  return fold(stepsOf(file, events).get(person))
}

/** Every member of a file and since when, from the file's own events. People who left are absent. */
export function membersOf(file: string, events: readonly Event[]): Map<string, Membership> {
  const members = new Map<string, Membership>()
  for (const [person, steps] of stepsOf(file, events)) {
    const membership = fold(steps)
    if (membership.member) members.set(person, membership)
  }
  return members
}

/**
 * The filters that find every file a person may be a member of (§11.8): the
 * changes that name them, what they wrote, and what mentions them. Each
 * candidate file is then read and folded with {@link membershipOf}. The files
 * they created are the app's own query; `since` bounds all three.
 *
 * A placement written without a `p` is not found here — only a read of that
 * file sees it — which is why every writer SHOULD add one.
 */
export function membershipFilters(person: string, since?: number): Filter[] {
  if (!PUBKEY.test(person)) throw new Error(`not a lowercase hex pubkey: ${JSON.stringify(person)}`)
  const bound = since === undefined ? {} : { since }
  return [
    { kinds: [KIND_CHANGE], '#p': [person], ...bound },
    { kinds: [KIND_COMMENT, KIND_MESSAGE], authors: [person], ...bound },
    { kinds: [KIND_COMMENT, KIND_MESSAGE], '#p': [person], ...bound },
  ]
}

/**
 * The files an event can make a person a member of: a change's `a`, a
 * comment's `A` (or every `a` when it has none). A `kind:9` names none — its
 * file, if any, is its root's, which the app resolves by reading the thread.
 */
export function candidateFilesOf(event: Pick<SignedEvent, 'kind' | 'tags'>): string[] {
  if (event.kind === KIND_CHANGE) return event.tags.filter((t) => t[0] === 'a' && ADDRESS.test(t[1] ?? '')).map((t) => t[1])
  return anchorsOf(event).filter((a) => ADDRESS.test(a))
}

/**
 * A membership change (§11.8 *The membership change*): `true` adds a person,
 * by anyone; `false` is a leave and counts only when the person signs it
 * themselves. Tag order: `a`, `field`, `value`, `h`, `ts`, `p`.
 *
 * Sign one only when the person chose it — joining, leaving, or adding
 * somebody. Never to migrate a private follow (§11.8 *Following, retired*).
 *
 * `content` is the note an activity feed shows, as for every change: a change
 * with none renders as a blank line in Ship's feed. "Join", "Leave" or "Add"
 * by default.
 */
export function buildMembershipChange(
  pubkey: string,
  createdAtMs: number,
  args: { file: string; folder: string; person: string; member: boolean; note?: string },
): UnsignedEvent {
  const note = args.note ?? (!args.member ? 'Leave' : args.person === pubkey ? 'Join' : 'Add')
  if (!ADDRESS.test(args.file)) throw new Error(`not a file address: ${JSON.stringify(args.file)}`)
  if (!FOLDER_ID.test(args.folder)) throw new Error(`not a Folder id (lowercase UUID v4): ${JSON.stringify(args.folder)}`)
  if (!Number.isSafeInteger(createdAtMs) || createdAtMs < 0) throw new Error(`not epoch milliseconds: ${createdAtMs}`)
  return {
    pubkey,
    created_at: Math.floor(createdAtMs / 1000),
    kind: KIND_CHANGE,
    tags: [
      ['a', args.file],
      ['field', memberField(args.person)],
      ['value', args.member ? 'true' : 'false'],
      ['h', args.folder],
      ['ts', String(createdAtMs)],
      ['p', args.person],
    ],
    content: note,
  }
}

// ── Muting: private, suite-wide (§11.8 *Muting is private*, §12) ────────────

/** The `d` of the person's mute list. */
export const MUTED_D_TAG = 'estiva:muted:v1'

/** The `t` every §12 app-private blob carries. */
export const APPDATA_TAG = 'estiva-appdata'

/** The decrypted mute list: file addresses and channel uuids. */
export interface MutedList {
  v: 1
  updatedAt: number
  keys: string[]
}

const isMuteKey = (key: unknown): key is string => typeof key === 'string' && (ADDRESS.test(key) || FOLDER_ID.test(key))

/** The mute list from its decrypted content, or undefined when it is not a v1 list. Unknown keys are dropped. */
export function parseMutedBlob(plaintext: string): MutedList | undefined {
  let value: unknown
  try {
    value = JSON.parse(plaintext)
  } catch {
    return undefined
  }
  if (!value || typeof value !== 'object') return undefined
  const { v, updatedAt, keys } = value as Record<string, unknown>
  if (v !== 1 || typeof updatedAt !== 'number' || !Number.isFinite(updatedAt) || !Array.isArray(keys)) return undefined
  return { v: 1, updatedAt, keys: [...new Set(keys.filter(isMuteKey))].sort() }
}

/** The plaintext to encrypt to self: keys de-duplicated and sorted, so equal lists are equal bytes. */
export function serializeMutedBlob(keys: Iterable<string>, updatedAt: number): string {
  return JSON.stringify({ v: 1, updatedAt, keys: [...new Set([...keys].filter(isMuteKey))].sort() })
}

/**
 * The unsigned `kind:30078` holding the encrypted mute list. Whole blob, last
 * write wins (§12.3): a writer reads the current list, changes it, and writes
 * all of it.
 */
export function buildMutedEvent(pubkey: string, createdAtMs: number, ciphertext: string): UnsignedEvent {
  return {
    pubkey,
    created_at: Math.floor(createdAtMs / 1000),
    kind: KIND_APP_DATA,
    tags: [
      ['d', MUTED_D_TAG],
      ['t', APPDATA_TAG],
    ],
    content: ciphertext,
  }
}

/** The filter for the person's mute list. */
export function mutedFilter(pubkey: string): Filter {
  return { kinds: [KIND_APP_DATA], authors: [pubkey], '#d': [MUTED_D_TAG], limit: 1 }
}

/**
 * The one migration from a retired `estiva:followed:v1` blob: its `muted`
 * keys, to merge into the mute list. Peek wrote `muted` as a map of key to
 * epoch ms, and for one day as a plain list; both read. Its followed `keys`
 * are **not** returned — the list was private, so nothing may publish them as
 * memberships — and a followed Folder is dropped, since the roster decides a
 * general stream.
 */
export function mutedFromFollowed(followedPlaintext: string): string[] {
  let value: unknown
  try {
    value = JSON.parse(followedPlaintext)
  } catch {
    return []
  }
  const muted = value && typeof value === 'object' ? (value as Record<string, unknown>).muted : undefined
  const keys = Array.isArray(muted) ? muted : muted && typeof muted === 'object' ? Object.keys(muted) : []
  return [...new Set(keys.filter(isMuteKey))].sort()
}

/**
 * Places and following — SPEC §11.8 *Places and following*.
 *
 * A **place** is one of a team's three kinds (§3): its chat, a space, or a
 * topic it leads. A person `P` is **in** a place at a level, All or
 * Important, or not in it, and that, not file membership, decides what on the
 * place is unread for `P`.
 *
 * | way in | the events |
 * | --- | --- |
 * | 1. chose a level | a `follow:<P>` change on the place, signed by `P`, value `all` or `important` |
 * | 2. joined, or was added | a `member:<P>` = `true` on the place, by anyone |
 * | 3. made it | `P` wrote the topic's or space's first record |
 * | 4. a team's default | a space of a team `P` is a member or follower of, or the chat of a team `P` is a member of, not in `P`'s private `off` list |
 *
 * `P`'s own acts read in one order: `P`'s `member:<P>` = `false` ends ways 1
 * to 3 and every level chosen before it; a level, a join or an Add after it
 * puts `P` back in. Only the `off` list turns a default off. An archived
 * team's places hold nobody. A mute already kept for a place still wins: it
 * lights only what mentions `P`.
 *
 * Everything here is worked out from events the caller read with
 * {@link placeFilters}; nothing is stored and no default is ever written.
 *
 * why: https://github.com/estiva-app/estiva-docs/blob/main/decisions/a-team-has-members-and-followers-and-a-place-is-followed-at-a-level.md
 */
import { fileIdOf, KIND, type SignedEvent, type UnsignedEvent } from '@estiva-app/protocol'
import { FILE_ADDRESS, FOLDER_ID, KIND_APP_DATA, KIND_CHANGE } from './kinds.js'
import { APPDATA_TAG, FOLLOW_FIELD_PREFIX, memberOfField } from './membership.js'
import { byOrder } from './order.js'
import { REPLY_FLOOR_CONTEXT, belowReplyFloor, effectiveReadAt, streamMarkerOf, threadContext } from './readState.js'
import { peopleNamedInBody } from './strength.js'
import { groupThreads } from './threads.js'

/** A team's own address kind: on it, a level or a member change is about the team's chat. */
const KIND_TEAM = 39000
/** The relay's list of a team's members (NIP-29). */
const KIND_ROSTER = 39002
/** Put a person on a team, and take one off (NIP-29). */
const KIND_PUT_USER = KIND.NIP29_PUT_USER
const KIND_REMOVE_USER = 9001
/** A person's own join and leave (NIP-29). */
const KIND_JOIN = 9021
const KIND_LEAVE = 9022
const KIND_CREATE_TEAM = KIND.NIP29_CREATE_GROUP
/** A team's relay-signed list, and the command that changes it (§3.3). */
const KIND_FOLDER_STATE = 30890
const KIND_FOLDER_COMMAND = KIND.FOLDER_COMMAND
/** The role on a team list's entry that marks a topic one of the team's spaces (§3.3). */
const SPACE_ROLE = 'space'

const PUBKEY = /^[0-9a-f]{64}$/

type Event = Pick<SignedEvent, 'id' | 'pubkey' | 'kind' | 'created_at' | 'tags' | 'content'>

/** A relay filter, as `QueryFn` takes one. */
type Filter = Record<string, unknown>

const tag = (event: Pick<SignedEvent, 'tags'>, name: string): string | undefined => event.tags.find((t) => t[0] === name)?.[1]
const dOf = (address: string): string => address.split(':').slice(2).join(':')

/** A level on a place. Every default is Important. */
export type Level = 'all' | 'important'

/** The three kinds of place a team holds (§3). */
export type PlaceKind = 'chat' | 'space' | 'topic'

/** A place, as the caller knows it. */
export interface Place {
  /** A topic's or space's address, or the team's own `39000:…` address for its chat. */
  address: string
  /** The uuid of the team the place is in: the one whose list names the topic, or the team itself for its chat. */
  team: string
}

/** What the caller read for one place, with {@link placeFilters}. */
export interface PlaceFacts {
  /** The place's own events: its first record's versions (a topic or space) and its `kind:1851` changes. */
  events: readonly Event[]
  /** The team's `kind:39002` and its stored `kind:9000`, `9001`, `9021`, `9022` and `9007`. */
  roster?: readonly Event[]
  /** The team's `kind:30890` and the `kind:1852` commands naming the place — what makes it a space, and since when. */
  listing?: readonly Event[]
  /** The person's private teams list ({@link parseTeamsBlob}); undefined when they keep none. */
  teams?: TeamsList
  /** Whether the team is archived (§3.2): its places then hold nobody. */
  archived?: boolean
}

/** How `P` is in a place: way 1 to 4 of §11.8. */
export type WayIn = 'level' | 'added' | 'author' | 'team'

/** Whether a person is in a place, at what level, and since when. */
export interface Following {
  kind: PlaceKind
  in: boolean
  /** The level that lights for them: the one they chose, else Important. Undefined when not in. */
  level?: Level
  /** Unix seconds: the earliest start among the ways that hold. Undefined when not in, or no way's start is known. */
  since?: number
  /**
   * Unix seconds the person chose All: what All lights beyond Important counts
   * from then, so choosing it never brings back older replies (Miky,
   * 2026-11-03). Undefined unless the level is All.
   */
  allSince?: number
  /** Every way in that holds now. */
  ways: WayIn[]
}

type Act = { event: Event; act: 'creation' | 'level' | 'clear' | 'join' | 'leave'; level?: Level }

/** The person's own acts on the place, in §6.3's order: the first record first, a leave before a join in a tie. */
function actsOf(place: Place, person: string, events: readonly Event[]): Act[] {
  const id = fileIdOf(place.address) ?? dOf(place.address)
  const acts: Act[] = []
  const versions = place.address.startsWith(`${KIND_TEAM}:`) ? [] : events.filter((e) => addressOf(e) === place.address).sort(byOrder)
  if (versions[0]?.pubkey === person) acts.push({ event: { ...versions[0], created_at: Math.min(...versions.map((v) => v.created_at)) }, act: 'creation' })
  // A change filed in another Folder is ignored (§6.2): the place's own Folder is the team for its chat, else its root's `h`.
  const folder = versions.length ? (tag(versions[versions.length - 1], 'h') ?? place.team) : place.team
  for (const change of events) {
    if (change.kind !== KIND_CHANGE || tag(change, 'a') !== place.address || tag(change, 'h') !== folder) continue
    const O = tag(change, 'O')
    if (O !== undefined && O !== id) continue
    // A level or a membership change is never in a `set` (§11.8): one there is not read.
    if (change.tags.some((t) => t[0] === 'set')) continue
    const field = tag(change, 'field')
    const value = tag(change, 'value')
    if (field === `${FOLLOW_FIELD_PREFIX}${person}`) {
      // Only `P` sets `P`'s level; one signed by anybody else is ignored.
      if (change.pubkey !== person) continue
      if (value === 'all' || value === 'important') acts.push({ event: change, act: 'level', level: value })
      else if (value === '') acts.push({ event: change, act: 'clear' })
    } else if (memberOfField(field) === person) {
      if (value === 'true') acts.push({ event: change, act: 'join' })
      else if (value === 'false' && change.pubkey === person) acts.push({ event: change, act: 'leave' })
    }
  }
  const rank = (a: Act) => (a.act === 'creation' ? 0 : 1)
  return acts.sort((a, b) => rank(a) - rank(b) || byOrder(a.event, b.event) || Number(a.act !== 'leave') - Number(b.act !== 'leave'))
}

function addressOf(event: Pick<SignedEvent, 'kind' | 'pubkey' | 'tags'>): string | undefined {
  if (event.kind < 30000 || event.kind > 39999) return undefined
  return `${event.kind}:${event.pubkey}:${tag(event, 'd') ?? ''}`
}

const latest = (events: readonly Event[]): Event | undefined => [...events].sort(byOrder).at(-1)

/** Whether the entry names the place: its address, or its id in the `o` form. */
const names = (entry: readonly string[], address: string): boolean =>
  (entry[0] === 'a' && entry[1] === address) || (entry[0] === 'o' && entry[1] === (fileIdOf(address) ?? dOf(address)))

/** Whether a list's or a command's entries mark the place a space: named, the role after an empty third element. */
function markOf(event: Event, address: string): 'space' | 'plain' | undefined {
  let mark: 'space' | 'plain' | undefined
  for (const entry of event.tags) {
    if (!names(entry, address)) continue
    if (entry[3] === SPACE_ROLE && !entry[2]) mark ??= 'space'
    else mark = 'plain'
  }
  return mark
}

/** Whether the team's current list marks the place one of its spaces (§3.3). A list naming it without the role too keeps it plain. */
function isSpace(place: Place, listing: readonly Event[]): boolean {
  const state = latest(listing.filter((e) => e.kind === KIND_FOLDER_STATE && tag(e, 'd') === place.team))
  return !!state && markOf(state, place.address) === 'space'
}

/** Which of a team's three kinds the place is. */
export function placeKindOf(place: Place, listing: readonly Event[] = []): PlaceKind {
  if (place.address.startsWith(`${KIND_TEAM}:`)) return 'chat'
  return isSpace(place, listing) ? 'space' : 'topic'
}

/**
 * When the place became one of the team's spaces: the earliest `kind:1852`
 * `add` or `move` into the team naming it with the `space` role, since the
 * last command that unmarked it, removed it or moved it out. A list marking
 * it with no such command held falls back to the list's own time, which is
 * no earlier than the mark.
 */
function spaceStartOf(place: Place, listing: readonly Event[]): number | undefined {
  let start: number | undefined
  const commands = listing.filter((e) => e.kind === KIND_FOLDER_COMMAND).sort(byOrder)
  for (const command of commands) {
    const op = tag(command, 'op')
    const into = tag(command, 'h') === place.team
    const mark = markOf(command, place.address)
    if (!into) {
      // A move out of the team takes the mark with it.
      if (op === 'move' && tag(command, 'from') === place.team && mark) start = undefined
      continue
    }
    if (op === 'remove' && mark) start = undefined
    else if (op === 'set' && !mark) start = undefined
    else if ((op === 'add' || op === 'move' || op === 'set') && mark) {
      if (mark === 'plain') start = undefined
      else start ??= command.created_at
    }
  }
  if (start !== undefined) return start
  return latest(listing.filter((e) => e.kind === KIND_FOLDER_STATE && tag(e, 'd') === place.team))?.created_at
}

/** Whether the team's current roster lists the person. */
function onRoster(team: string, person: string, roster: readonly Event[]): Event | undefined {
  const list = latest(roster.filter((e) => e.kind === KIND_ROSTER && tag(e, 'd') === team))
  return list?.tags.some((t) => t[0] === 'p' && t[1] === person) ? list : undefined
}

/**
 * When the team reached a person its roster lists: the earliest stored
 * `kind:9000` or `kind:9021` naming them on the team since their last
 * `kind:9001` or `kind:9022` (a later `kind:9000` changing their role is not
 * a join), or the `kind:9007` when they made the team. A roster keeps no time
 * per person, so with none of those held the roster's own time stands in: no
 * earlier than their join, so nothing older lights.
 */
function joinedTeamAt(team: string, person: string, roster: readonly Event[], list: Event): number {
  const onTeam = roster.filter((e) => tag(e, 'h') === team).sort(byOrder)
  const namesPerson = (e: Event) => e.tags.some((t) => t[0] === 'p' && t[1] === person)
  let since: number | undefined
  for (const e of onTeam) {
    const left = (e.kind === KIND_REMOVE_USER && namesPerson(e)) || (e.kind === KIND_LEAVE && e.pubkey === person)
    const joined =
      (e.kind === KIND_PUT_USER && namesPerson(e)) || (e.kind === KIND_JOIN && e.pubkey === person) || (e.kind === KIND_CREATE_TEAM && e.pubkey === person)
    if (left) since = undefined
    else if (joined) since ??= e.created_at
  }
  return since ?? list.created_at
}

/** One of a team's members: who, and since when the team reached them (unix seconds). */
export interface TeamMember {
  pubkey: string
  since: number
}

/**
 * A team's members, from the roster facts {@link placeFilters} reads (`kind:39002`
 * and the stored `9000`, `9001`, `9021`, `9022`, `9007`): everyone its current
 * `kind:39002` lists, each with when they joined, in the order they joined. Who
 * is in a team is visible to anyone who can read it; who follows it is not, so
 * this never lists a follower (§11.8).
 */
export function teamMembersOf(team: string, roster: readonly Event[]): TeamMember[] {
  const list = latest(roster.filter((e) => e.kind === KIND_ROSTER && tag(e, 'd') === team))
  if (!list) return []
  const people = [...new Set(list.tags.filter((t) => t[0] === 'p' && t[1]).map((t) => t[1]))]
  return people
    .map((pubkey) => ({ pubkey, since: joinedTeamAt(team, pubkey, roster, list) }))
    .sort((a, b) => a.since - b.since || a.pubkey.localeCompare(b.pubkey))
}

/** The team's own start: its `kind:9007`, when held. */
function teamStartOf(team: string, roster: readonly Event[]): number | undefined {
  return roster.find((e) => e.kind === KIND_CREATE_TEAM && tag(e, 'h') === team)?.created_at
}

/**
 * Whether a person is in a place, at what level and since when (§11.8
 * *Places and following*). Pure: `facts` are the events {@link placeFilters}
 * returned, and the person's private teams list.
 */
export function followingOf(place: Place, person: string, facts: PlaceFacts): Following {
  if (!PUBKEY.test(person)) throw new Error(`not a lowercase hex pubkey: ${JSON.stringify(person)}`)
  const kind = placeKindOf(place, facts.listing)
  const out: Following = { kind, in: false, ways: [] }
  if (facts.archived) return out

  const starts: number[] = []
  const acts = actsOf(place, person, facts.events)
  const lastLeave = acts.map((a) => a.act).lastIndexOf('leave')
  // An Add after a leave names it with `prev`, so the relay's order holds whatever the two clocks said (§11.8).
  const leaveId = acts[lastLeave]?.event.id
  const named = acts.slice(0, Math.max(lastLeave, 0)).filter((a) => a.act === 'join' && leaveId !== undefined && tag(a.event, 'prev') === leaveId)
  const after = [...named, ...acts.slice(lastLeave + 1)]
  // 1. A level chosen since the last leave, and not cleared since; changing it keeps its start.
  let chosen: { level: Level; since: number; allSince?: number } | undefined
  for (const a of after) {
    if (a.act === 'level') {
      const allSince = a.level === 'all' ? (chosen?.allSince ?? a.event.created_at) : undefined
      chosen = { level: a.level!, since: chosen?.since ?? a.event.created_at, ...(allSince !== undefined ? { allSince } : {}) }
    } else if (a.act === 'clear') chosen = undefined
  }
  if (chosen) {
    out.ways.push('level')
    starts.push(chosen.since)
  }
  // 2. Joined, or added, since the last leave. An Add chooses no level.
  const joined = after.find((a) => a.act === 'join')
  if (joined) {
    out.ways.push('added')
    starts.push(joined.event.created_at)
  }
  // 3. Made it: the first record orders before everything, so any leave ends it.
  const made = after.find((a) => a.act === 'creation')
  if (made) {
    out.ways.push('author')
    starts.push(made.event.created_at)
  }
  // 4. A team's default, unless the person's private list turned it off. A topic a team leads reaches nobody.
  const off = new Set(facts.teams?.off ?? [])
  const id = dOf(place.address)
  if (kind !== 'topic' && !off.has(id)) {
    const roster = facts.roster ?? []
    const list = onRoster(place.team, person, roster)
    const followed = facts.teams?.teams[place.team]
    let reached: number | undefined
    if (list) reached = joinedTeamAt(place.team, person, roster, list)
    else if (kind === 'space' && followed !== undefined) reached = Math.floor(followed / 1000)
    if (reached !== undefined) {
      const cameIn = kind === 'space' ? spaceStartOf(place, facts.listing ?? []) : teamStartOf(place.team, roster)
      out.ways.push('team')
      starts.push(Math.max(reached, cameIn ?? reached))
    }
  }

  if (out.ways.length === 0) return out
  return { ...out, in: true, level: chosen?.level ?? 'important', since: Math.min(...starts), ...(chosen?.allSince !== undefined ? { allSince: chosen.allSince } : {}) }
}

/**
 * The filters that read what {@link followingOf} needs for one place: its
 * root and changes, the team's roster, the team's list and the commands
 * naming the place, and the person's teams list. A topic's or space's
 * conversation is the app's own read (see `streamOf`); a team's chat is its
 * general stream.
 */
export function placeFilters(place: Place, person: string): Filter[] {
  if (!PUBKEY.test(person)) throw new Error(`not a lowercase hex pubkey: ${JSON.stringify(person)}`)
  if (!FILE_ADDRESS.test(place.address)) throw new Error(`not a place address: ${JSON.stringify(place.address)}`)
  if (!FOLDER_ID.test(place.team)) throw new Error(`not a team id (lowercase UUID v4): ${JSON.stringify(place.team)}`)
  const [kind, author, d] = [Number(place.address.split(':')[0]), place.address.split(':')[1], dOf(place.address)]
  const id = fileIdOf(place.address)
  return [
    { kinds: [KIND_CHANGE], '#a': [place.address] },
    ...(kind === KIND_TEAM ? [] : [{ kinds: [kind], authors: [author], '#d': [d] }]),
    { kinds: [KIND_PUT_USER, KIND_REMOVE_USER, KIND_JOIN, KIND_LEAVE, KIND_CREATE_TEAM], '#h': [place.team] },
    { kinds: [KIND_ROSTER], '#d': [place.team] },
    ...(kind === KIND_TEAM
      ? []
      : [
          { kinds: [KIND_FOLDER_STATE], '#d': [place.team] },
          { kinds: [KIND_FOLDER_COMMAND], '#a': [place.address] },
          ...(id !== undefined ? [{ kinds: [KIND_FOLDER_COMMAND], '#o': [id] }] : []),
        ]),
    teamsFilter(person),
  ]
}

// ── What is unread on a place ───────────────────────────────────────────────

type Message = Pick<SignedEvent, 'id' | 'pubkey' | 'kind' | 'created_at' | 'tags' | 'content'>

/** Who is judging a place's stream, and on what terms. */
export interface PlaceJudge {
  /** The stream's context (§11.1): the topic's or space's address, or the team's uuid for its chat. */
  stream: string
  /** The person reading. */
  me: string
  /** {@link followingOf} for `me` on the place. */
  following: Following
  /** Whether `me` muted the place (`estiva:muted:v1`): a mute already kept still lights only mentions. */
  muted?: boolean
  /** For a message with no marker and no start to bound it, the earliest `created_at` that counts (§11.6). */
  floor?: number
}

/**
 * The unread messages on a place, oldest first per conversation (§11.8 *What
 * is unread on a place*). `messages` is the place's stream: `streamOf` for a
 * topic or space, the team's general stream for its chat.
 *
 * At **Important** a new conversation lights, and a reply in a conversation
 * `me` is in — wrote its root or a reply, or was mentioned in it — from the
 * moment they were. At **All** every message lights from the moment they
 * chose All (`allSince`), and Important's rule before it. A mention of `me` lights
 * at any level, and when they are not in. A file the place lists is judged
 * at All the same way, by passing its own stream and context with this
 * following.
 */
export function unreadOnPlace<E extends Message>(messages: readonly E[], merged: Readonly<Record<string, number>>, judge: PlaceJudge): E[] {
  const { roots, replies } = groupThreads(messages)
  const out: E[] = []
  const conversation = (root: E | undefined, list: readonly E[], rootId: string) => {
    const all = root ? [root, ...list] : [...list]
    const inSince = all.find((m) => m.pubkey === judge.me || peopleNamedInBody(m.content).has(judge.me))?.created_at
    if (root && isUnreadOnPlace(root, undefined, merged, judge, inSince)) out.push(root)
    for (const reply of list) if (isUnreadOnPlace(reply, rootId, merged, judge, inSince)) out.push(reply)
  }
  for (const root of roots) conversation(root, replies[root.id] ?? [], root.id)
  const held = new Set(roots.map((r) => r.id))
  for (const [root, list] of Object.entries(replies)) if (!held.has(root)) conversation(undefined, list, root)
  return out
}

/**
 * Whether one message on a place is unread. `root` is its conversation's root
 * id when it is a reply; `inConversationSince`, the second `me` came into
 * that conversation (wrote in it or was mentioned there), or undefined when
 * they never did — then a reply lights at Important only by a mention.
 */
export function isUnreadOnPlace(
  message: Message,
  root: string | undefined,
  merged: Readonly<Record<string, number>>,
  judge: PlaceJudge,
  inConversationSince: number | undefined,
): boolean {
  if (message.pubkey === judge.me) return false
  const { following } = judge
  const mentioned = peopleNamedInBody(message.content).has(judge.me)
  const started = following.in && (following.since === undefined || message.created_at >= following.since)
  const levelLights =
    (following.level === 'all' && message.created_at >= (following.allSince ?? following.since ?? 0)) ||
    root === undefined ||
    (inConversationSince !== undefined && message.created_at >= inConversationSince)
  if (!mentioned && (judge.muted || !started || !levelLights)) return false
  const thread = root === undefined ? undefined : threadContext(root)
  const marker = thread === undefined ? streamMarkerOf(merged, judge.stream) : effectiveReadAt(merged, thread, judge.stream)
  if (marker !== undefined) return message.created_at > marker
  if (thread !== undefined && belowReplyFloor(message.created_at, merged[REPLY_FLOOR_CONTEXT])) return false
  if (started && following.since !== undefined) return true
  return judge.floor === undefined || message.created_at >= judge.floor
}

// ── A level: `follow:<P>`, signed by `P` alone ──────────────────────────────

/** The level field for a person: `follow:<pubkey>`. */
export function followField(pubkey: string): string {
  if (!PUBKEY.test(pubkey)) throw new Error(`not a lowercase hex pubkey: ${JSON.stringify(pubkey)}`)
  return `${FOLLOW_FIELD_PREFIX}${pubkey}`
}

/**
 * The level change (§11.8 *The level change*): `P` chooses All or Important
 * on a place, or `''` to go back to the default. Signed by `P`, for `P`: the
 * relay refuses, and every reader ignores, one signed by anybody else. Never
 * in a `set`, no `prev`. Tag order: `a`, `[O]`, `field`, `value`, `h`, `ts`,
 * `p`.
 *
 * Not following is never public: turning a team's default off goes in the
 * private teams list ({@link serializeTeamsBlob}), and leaving a place one
 * joined is {@link buildMembershipChange}'s leave.
 */
export function buildLevelChange(
  pubkey: string,
  createdAtMs: number,
  args: { place: string; folder: string; level: Level | ''; note?: string },
): UnsignedEvent {
  const field = followField(pubkey)
  if (!FILE_ADDRESS.test(args.place)) throw new Error(`not a place address: ${JSON.stringify(args.place)}`)
  if (!FOLDER_ID.test(args.folder)) throw new Error(`not a team id (lowercase UUID v4): ${JSON.stringify(args.folder)}`)
  if (args.level !== 'all' && args.level !== 'important' && args.level !== '') throw new Error(`not a level: ${JSON.stringify(args.level)}`)
  if (!Number.isSafeInteger(createdAtMs) || createdAtMs < 0) throw new Error(`not epoch milliseconds: ${createdAtMs}`)
  const id = fileIdOf(args.place)
  return {
    pubkey,
    created_at: Math.floor(createdAtMs / 1000),
    kind: KIND_CHANGE,
    tags: [
      ['a', args.place],
      ...(id !== undefined ? [['O', id]] : []),
      ['field', field],
      ['value', args.level],
      ['h', args.folder],
      ['ts', String(createdAtMs)],
      ['p', pubkey],
    ],
    content: args.note ?? (args.level === 'all' ? 'All' : args.level === 'important' ? 'Important' : 'Default'),
  }
}

// ── The teams a person follows, and their opt-outs: private (§11.8, §12) ────

/** The `d` of the person's teams list. */
export const TEAMS_D_TAG = 'estiva:teams:v1'

/** The decrypted teams list: the teams followed, each from when, and the places whose default is off. */
export interface TeamsList {
  v: 1
  updatedAt: number
  /** Team uuid → epoch ms the person follows it from. */
  teams: Record<string, number>
  /** Places whose team default is off: a topic or space by its `d`, a team's chat by the team's uuid. */
  off: string[]
}

const isPlaceId = (id: unknown): id is string => typeof id === 'string' && id.length > 0 && id.length <= 256 && !/\s/.test(id)
const isEpochMs = (ms: unknown): ms is number => typeof ms === 'number' && Number.isSafeInteger(ms) && ms >= 0

/** The teams list from its decrypted content, or undefined when it is not a v1 list. Entries that are not well formed are dropped. */
export function parseTeamsBlob(plaintext: string): TeamsList | undefined {
  let value: unknown
  try {
    value = JSON.parse(plaintext)
  } catch {
    return undefined
  }
  if (!value || typeof value !== 'object') return undefined
  const { v, updatedAt, teams, off } = value as Record<string, unknown>
  if (v !== 1 || !isEpochMs(updatedAt)) return undefined
  if (!teams || typeof teams !== 'object' || Array.isArray(teams) || !Array.isArray(off)) return undefined
  const kept = Object.entries(teams as Record<string, unknown>).filter((e): e is [string, number] => FOLDER_ID.test(e[0]) && isEpochMs(e[1]))
  return { v: 1, updatedAt, teams: Object.fromEntries(kept.sort(([a], [b]) => (a < b ? -1 : 1))), off: [...new Set(off.filter(isPlaceId))].sort() }
}

/** The plaintext to encrypt to self: teams and opt-outs sorted, so equal lists are equal bytes. */
export function serializeTeamsBlob(list: Pick<TeamsList, 'teams' | 'off'>, updatedAt: number): string {
  const teams = Object.entries(list.teams).filter(([team, since]) => FOLDER_ID.test(team) && isEpochMs(since))
  return JSON.stringify({
    v: 1,
    updatedAt,
    teams: Object.fromEntries(teams.sort(([a], [b]) => (a < b ? -1 : 1))),
    off: [...new Set(list.off.filter(isPlaceId))].sort(),
  })
}

/**
 * The unsigned `kind:30078` holding the encrypted teams list. Whole blob, last
 * write wins (§12.3): a writer reads the current list, changes it, and writes
 * all of it.
 */
export function buildTeamsEvent(pubkey: string, createdAtMs: number, ciphertext: string): UnsignedEvent {
  return {
    pubkey,
    created_at: Math.floor(createdAtMs / 1000),
    kind: KIND_APP_DATA,
    tags: [
      ['d', TEAMS_D_TAG],
      ['t', APPDATA_TAG],
    ],
    content: ciphertext,
  }
}

/** The filter for the person's teams list. */
export function teamsFilter(pubkey: string): Filter {
  return { kinds: [KIND_APP_DATA], authors: [pubkey], '#d': [TEAMS_D_TAG], limit: 1 }
}

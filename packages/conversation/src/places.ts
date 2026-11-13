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
import { FILE_ADDRESS, FOLDER_ID, KIND_APP_DATA, KIND_CHANGE, KIND_COMMENT, KIND_MESSAGE } from './kinds.js'
import { APPDATA_TAG, FOLLOW_FIELD_PREFIX, buildMembershipChange, memberOfField } from './membership.js'
import { byOrder } from './order.js'
import { REACTIONS_TO_ME_FROM, type ReactionToMe } from './reactions.js'
import {
  REPLY_FLOOR_CONTEXT,
  belowReplyFloor,
  channelContext,
  effectiveReadAt,
  fileContext,
  fileIdContext,
  reactionsContext,
  reactionsSeenOf,
  streamMarkerOf,
  threadContext,
} from './readState.js'
import { anchorIdsOf, anchorsOf, peopleNamedInBody } from './strength.js'
import { groupThreads } from './threads.js'
import { lightsIn, seenIn, type StreamJudge } from './unread.js'

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
  /** Who put them in, when the way `added` holds and somebody else signed the Add; undefined for their own join. */
  addedBy?: string
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
    if (joined.event.pubkey !== person) out.addedBy = joined.event.pubkey
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

// ── Who a place lists ───────────────────────────────────────────────────────

/** One person a place lists, and how they are in it. */
export interface Listed {
  pubkey: string
  level: Level
  /** Every way in that holds, of the ones anyone can see: `team` only for the team's members. */
  ways: WayIn[]
  since?: number
  /** Who added them, when somebody else did. */
  addedBy?: string
}

/**
 * Who a place lists (§11.8 *Who a place lists*), worked out from public
 * events alone so every reader gets the same list: everyone who chose a level
 * (at that level), everyone added or joined (at their level, or Important),
 * its author, and, on a team's chat and spaces, the team's members at the
 * default. Someone in it only through a team they follow is not named until
 * they choose a level, and a member's private opt-out is not seen: the list
 * undercounts. All first, then Important, each by since.
 *
 * `viewer`, with their own private teams list, is listed as they are in it:
 * gone once they turned the default off, there when a team they follow
 * reaches them. Everyone else sees them by public events alone.
 *
 * why: https://github.com/estiva-app/estiva-docs/blob/main/decisions/a-place-lists-who-chose-a-level-and-its-teams-members.md
 */
export function placeListing(place: Place, facts: Omit<PlaceFacts, 'teams'>, viewer?: { pubkey: string; teams?: TeamsList }): Listed[] {
  const people = new Set<string>()
  const versions = place.address.startsWith(`${KIND_TEAM}:`) ? [] : facts.events.filter((e) => addressOf(e) === place.address)
  for (const v of versions) people.add(v.pubkey)
  for (const change of facts.events) {
    if (change.kind !== KIND_CHANGE || tag(change, 'a') !== place.address) continue
    const field = tag(change, 'field')
    const member = memberOfField(field)
    if (member !== undefined) people.add(member)
    else if (field?.startsWith(FOLLOW_FIELD_PREFIX)) people.add(field.slice(FOLLOW_FIELD_PREFIX.length))
  }
  if (placeKindOf(place, facts.listing) !== 'topic') for (const m of teamMembersOf(place.team, facts.roster ?? [])) people.add(m.pubkey)
  if (viewer) people.add(viewer.pubkey)

  const listed: Listed[] = []
  for (const pubkey of people) {
    if (!PUBKEY.test(pubkey)) continue
    // Nobody else's private teams list is readable: their following through a team they follow never shows.
    const own = pubkey === viewer?.pubkey ? viewer.teams : undefined
    const f = followingOf(place, pubkey, { ...facts, teams: own })
    if (!f.in || !f.level) continue
    listed.push({ pubkey, level: f.level, ways: f.ways, ...(f.since !== undefined ? { since: f.since } : {}), ...(f.addedBy ? { addedBy: f.addedBy } : {}) })
  }
  const rank = (l: Listed) => (l.level === 'all' ? 0 : 1)
  return listed.sort((a, b) => rank(a) - rank(b) || (a.since ?? 0) - (b.since ?? 0) || a.pubkey.localeCompare(b.pubkey))
}

// ── Add, and the switch: Not following, Important, All, back to the default ──

/**
 * The `prev` an Add of `person` to the place names (§11.8): the person's own
 * leave, when it is the field's current change. Undefined when they never
 * left, or were put back in since — an Add needs none then.
 */
function currentLeaveOf(place: Place, person: string, events: readonly Event[]): Event | undefined {
  const last = actsOf(place, person, events)
    .filter((a) => a.act === 'join' || a.act === 'leave')
    .at(-1)
  return last?.act === 'leave' ? last.event : undefined
}

/** The ms a change sorts at (§6.3): its `ts` where it agrees with `created_at`, else `created_at`. */
function sortMsOf(event: Event): number {
  const ts = Number(tag(event, 'ts'))
  return Number.isSafeInteger(ts) && Math.floor(ts / 1000) === event.created_at ? ts : event.created_at * 1000
}

/**
 * Add a person to a topic, a space or a team's chat (§11.8): a `member:<P>` =
 * `true` by anyone, naming the person's leave with `prev` when they left. The
 * relay refuses a change that does not sort after its `prev` (§6.2), so an
 * adder whose clock is behind the leave stamps the Add 1 ms after it. `folder` is the
 * place's own team: its root's `h`, or the team itself for its chat. `events`
 * are the place's events, as {@link placeFilters} read them.
 *
 * why: https://github.com/estiva-app/estiva-docs/blob/main/decisions/anyone-may-add-a-person-to-a-file.md
 */
export function buildPlaceAdd(
  pubkey: string,
  createdAtMs: number,
  args: { place: Place; folder: string; person: string; events: readonly Event[]; note?: string },
): UnsignedEvent {
  const leave = currentLeaveOf(args.place, args.person, args.events)
  const prev = leave?.id
  const at = leave ? Math.max(createdAtMs, sortMsOf(leave) + 1) : createdAtMs
  return buildMembershipChange(pubkey, at, {
    file: args.place.address,
    folder: args.folder,
    person: args.person,
    member: true,
    ...(args.note !== undefined ? { note: args.note } : {}),
    ...(prev !== undefined ? { prev } : {}),
  })
}

/** What the switch on a place can be set to: a level, Not following, or back to the team's default. */
export type SwitchChoice = Level | 'not-following' | 'default'

/** What the switch shows for a person on a place. */
export interface SwitchState {
  /** The level that lights for them, or Not following. A mute already kept shows as Not following (§11.8 *Muting*). */
  shown: Level | 'not-following'
  /** Whether a team's default would reach them here, were it not turned off. */
  defaultReaches: boolean
  /** A default reaches them and they chose a level, or turned it off. "Back to the default" is offered then. */
  againstDefault: boolean
}

/** The id the private `off` list names a place by: a topic's or space's `d`, a team's chat by the team's uuid. */
export function placeOffId(place: Place): string {
  return dOf(place.address)
}

/** What the switch shows for `person` on the place, from what {@link placeFilters} read. */
export function switchStateOf(place: Place, person: string, facts: PlaceFacts, opts: { muted?: boolean } = {}): SwitchState {
  const following = followingOf(place, person, facts)
  const id = placeOffId(place)
  const off = facts.teams?.off.includes(id) ?? false
  const withDefault = off ? followingOf(place, person, { ...facts, teams: { ...facts.teams!, off: facts.teams!.off.filter((o) => o !== id) } }) : following
  const defaultReaches = withDefault.ways.includes('team')
  const shown = opts.muted || !following.in || !following.level ? 'not-following' : following.level
  return { shown, defaultReaches, againstDefault: defaultReaches && (off || following.ways.includes('level')) }
}

/** The writes one choice on the switch takes. */
export interface SwitchWrites {
  /** The public changes to sign as the person, in order: a level, or a leave. */
  changes: UnsignedEvent[]
  /** The private `off` list's change, when the choice turns a team's default off or back on ({@link withPlaceOff}). */
  off?: { id: string; off: boolean }
  /** Whether a mute already kept for the place is taken out (§11.8 *Muting*): choosing a level or the default does. */
  clearsMute: boolean
}

/**
 * The writes for one choice on a place's switch (§11.8). A level is a
 * `follow:<P>`. Not following is never public: a leave only when `P` chose
 * a level, joined, was added or made the place, and an `off` entry when a
 * team's default reaches `P` — a place `P` is in only by a default gets the
 * entry alone. Back to the default is an empty `follow:<P>` when a level was
 * chosen, and takes the place out of `off`. `folder` is the place's own team:
 * its root's `h`, or the team itself for its chat.
 *
 * why: https://github.com/estiva-app/estiva-docs/blob/main/decisions/a-persons-level-on-a-place-is-theirs-alone.md
 */
export function switchWrites(
  pubkey: string,
  createdAtMs: number,
  args: { place: Place; folder: string; choice: SwitchChoice; following: Following; teams?: TeamsList },
): SwitchWrites {
  const { place, folder, choice, following } = args
  const id = placeOffId(place)
  const isOff = args.teams?.off.includes(id) ?? false
  if (choice === 'all' || choice === 'important') {
    return { changes: [buildLevelChange(pubkey, createdAtMs, { place: place.address, folder, level: choice })], clearsMute: true }
  }
  if (choice === 'default') {
    const changes = following.ways.includes('level') ? [buildLevelChange(pubkey, createdAtMs, { place: place.address, folder, level: '' })] : []
    return { changes, ...(isOff ? { off: { id, off: false } } : {}), clearsMute: true }
  }
  const byDefault = following.ways.includes('team')
  const joined = following.ways.some((w) => w === 'added' || w === 'author')
  // Where a default reaches P and only a chosen level holds besides, clearing the level reads as
  // "back to the default" to everyone else: nobody sees that P switched the place off.
  const changes = joined || (following.ways.includes('level') && !byDefault)
    ? [buildMembershipChange(pubkey, createdAtMs, { file: place.address, folder, person: pubkey, member: false })]
    : following.ways.includes('level')
      ? [buildLevelChange(pubkey, createdAtMs, { place: place.address, folder, level: '' })]
      : []
  return { changes, ...(byDefault ? { off: { id, off: true } } : {}), clearsMute: false }
}

/** The teams list with a place's default turned off, or back on: what to serialize, encrypt and write whole. */
export function withPlaceOff(list: Pick<TeamsList, 'teams' | 'off'> | undefined, change: { id: string; off: boolean }): Pick<TeamsList, 'teams' | 'off'> {
  const off = new Set(list?.off ?? [])
  if (change.off) off.add(change.id)
  else off.delete(change.id)
  return { teams: { ...(list?.teams ?? {}) }, off: [...off].sort() }
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
  return eachMessage(messages, judge.me, (message, root, inSince) => isUnreadOnPlace(message, root, merged, judge, inSince))
}

/**
 * Each message of each conversation in `messages`, root first then its replies, kept when `keep` says so. `inSince`
 * is when `me` came into that message's conversation (wrote its root or a reply, or was mentioned there), or, for a
 * reply whose lowercase `p` names `me` as the author it answers (§6.4), at the latest that reply: `me` wrote what it
 * answers even when the reader holds nothing older of it. Undefined when `me` is not in it.
 */
function eachMessage<E extends Message>(messages: readonly E[], me: string, keep: (message: E, root: string | undefined, inSince: number | undefined) => boolean): E[] {
  const { roots, replies } = groupThreads(messages)
  const out: E[] = []
  const conversation = (root: E | undefined, list: readonly E[], rootId: string) => {
    const all = root ? [root, ...list] : [...list]
    const inSince = all.find((m) => m.pubkey === me || peopleNamedInBody(m.content).has(me))?.created_at
    if (root && keep(root, undefined, inSince)) out.push(root)
    for (const reply of list) {
      const answersMe = reply.tags.some((t) => t[0] === 'p' && t[1] === me)
      if (keep(reply, rootId, answersMe ? Math.min(inSince ?? reply.created_at, reply.created_at) : inSince)) out.push(reply)
    }
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
  return lightsOnPlace(message, root, judge, inConversationSince) && newerThanItsMarker(message, root, merged, judge, startedOn(message, judge.following))
}

/** Whether `me` was in the place when the message was said. */
function startedOn(message: Pick<Message, 'created_at'>, following: Following): boolean {
  return following.in && (following.since === undefined || message.created_at >= following.since)
}

/**
 * Whether one message on a place lights it for `me` at all, read or not (§11.8 *What is unread on a place*, without the
 * marker): a mention at any level; otherwise, unmuted and in the place, a new conversation, a reply in one `me` is in,
 * and at All every message since All. Unread is this and newer than its marker.
 */
function lightsOnPlace(message: Message, root: string | undefined, judge: PlaceJudge, inConversationSince: number | undefined): boolean {
  if (message.pubkey === judge.me) return false
  if (peopleNamedInBody(message.content).has(judge.me)) return true
  const { following } = judge
  const levelLights =
    (following.level === 'all' && message.created_at >= (following.allSince ?? following.since ?? 0)) ||
    root === undefined ||
    (inConversationSince !== undefined && message.created_at >= inConversationSince)
  return !judge.muted && startedOn(message, following) && levelLights
}

/** Whether a message that lights by its level is still unread: its stream's marker, or its thread's for a reply (§11.3). */
function newerThanItsMarker(message: Message, root: string | undefined, merged: Readonly<Record<string, number>>, judge: PlaceJudge, started: boolean): boolean {
  const { following } = judge
  const thread = root === undefined ? undefined : threadContext(root)
  const marker = thread === undefined ? streamMarkerOf(merged, judge.stream) : effectiveReadAt(merged, thread, judge.stream)
  if (marker !== undefined) return message.created_at > marker
  if (thread !== undefined && belowReplyFloor(message.created_at, merged[REPLY_FLOOR_CONTEXT])) return false
  if (started && following.since !== undefined) return true
  return judge.floor === undefined || message.created_at >= judge.floor
}

/**
 * The unread messages on a file a place lists, as they light the place (§11.8 *What is unread on a place*):
 * `messages` is that file's conversation, or what of it the reader holds; `judge.stream` is the file's own context
 * (`fileContext`), so each message answers to the file's own marker, or its thread's for a reply.
 *
 * What names `P` lights at either level: a message that mentions `P`, and a reply in a conversation `P` is in (wrote
 * its root or a reply, or was mentioned there) from the moment they were. A mute keeps only the mentions. At **All**,
 * on a file the place lists directly, every message since `P` chose All lights too. `under` is a file one level under
 * a listed one (a listed project's issue, a listed document's page): only what names `P` lights there, at either level.
 * A new conversation that does not name `P` never lights at Important. Nothing lights when `P` is not in the place,
 * and nothing from before `P`'s start on it. A reply to `P`'s agent belongs here and lights nothing until an app can
 * tell whose agent it is (§6.5).
 *
 * why: https://github.com/estiva-app/estiva-docs/blob/main/decisions/at-important-what-names-you-on-a-listed-file-lights-the-topic.md
 */
export function unreadOnListedFile<E extends Message>(
  messages: readonly E[],
  merged: Readonly<Record<string, number>>,
  judge: PlaceJudge & { under?: boolean },
): E[] {
  if (!judge.following.in) return []
  // A root comment's `p` is the file's author, which says nothing of `P`: only a reply's counts (`eachMessage`).
  return eachMessage(messages, judge.me, (message, root, inSince) =>
    lightsOnListedFile(message, root, judge, inSince) && newerThanItsMarker(message, root, merged, judge, true),
  )
}

/** Whether one message on a listed file lights the place for `me` at all, read or not ({@link unreadOnListedFile} without the marker). */
function lightsOnListedFile(message: Message, root: string | undefined, judge: PlaceJudge & { under?: boolean }, inSince: number | undefined): boolean {
  const { following, me } = judge
  if (!following.in || message.pubkey === me) return false
  if (following.since !== undefined && message.created_at < following.since) return false
  const allFrom = following.level === 'all' && !judge.under && !judge.muted ? (following.allSince ?? following.since ?? 0) : undefined
  const mentioned = peopleNamedInBody(message.content).has(me)
  const inYours = !judge.muted && root !== undefined && inSince !== undefined && message.created_at >= inSince
  const atAll = allFrom !== undefined && message.created_at >= allFrom
  return mentioned || inYours || atAll
}

// ── What lit a stream, new and seen ─────────────────────────────────────────

/**
 * One line of a stream's list (§11.8 *What lit a stream, new and seen*): a message, with why it lit
 * ({@link UnreadReason}), or a reaction to `P`'s message (ACT-7), new until its conversation's `reactions:` key is
 * written past it. `seen` is false for what is unread now: the New part of the list.
 */
export type LitLine<E> =
  | { type: 'message'; message: E; reason: UnreadReason; seen: boolean }
  | { type: 'reaction'; reaction: ReactionToMe; seen: boolean }

/** Options for a stream's list. */
export interface LitLineOptions extends UnreadReasonOptions {
  /**
   * At most this many lines, except that every new line is kept: all the new ones, then the newest seen ones up to
   * it. Each part is newest first, and the new part comes before the seen one. Unbounded when left out.
   */
  limit?: number
  /**
   * The reactions to `P`'s messages in this stream ({@link reactionsToMe}, mapped to it by {@link reactionStreamOf}):
   * each is a line, new by {@link newReactionsIn}, else seen. A reaction to `P` is always about `P`, so a seen one
   * stays in the list.
   */
  reactions?: readonly ReactionToMe[]
}

/** What stays in the list once seen: what was about `P` (Miky, 2026-11-11). A plain message read is in its conversation. */
const KEPT_ONCE_SEEN: ReadonlySet<UnreadReason> = new Set(['mention', 'reply-in-yours'])

function linesOf<E extends Message>(
  messages: readonly E[],
  me: string,
  options: LitLineOptions,
  judge: (message: E, root: string | undefined, inSince: number | undefined) => { lights: boolean; unread: boolean },
  reactions: { merged: Readonly<Record<string, number>>; judge: ReactionJudge },
): LitLine<E>[] {
  const out: LitLine<E>[] = []
  eachMessage(messages, me, (message, root, inSince) => {
    const { lights, unread } = judge(message, root, inSince)
    if (!lights) return false
    const reason = unreadReason(message, root, inSince, me, options)
    if (unread || KEPT_ONCE_SEEN.has(reason)) out.push({ type: 'message', message, reason, seen: !unread })
    return false
  })
  return mergeLitLines([out, reactionLines<E>(options.reactions ?? [], reactions.merged, reactions.judge)], options)
}

/** What a line is ordered and told apart by: its message, or its reaction as an event of that id and time. */
const lineEvent = <E extends Message>(line: LitLine<E>): Pick<Message, 'id' | 'created_at' | 'tags'> =>
  line.type === 'message' ? line.message : { id: line.reaction.id, created_at: line.reaction.at, tags: [] }

/**
 * Several streams' lists as one (§11.8 *What lit a stream, new and seen*): a place's list is its own stream's and each
 * listed file's, and a team's list is its places'. One line per message (the first list that has it wins), every new
 * line before every seen one, each part newest first by §6.3's ordering, and `limit` bounds only the seen lines — the
 * same order and limit as each stream's own list, so a file listed in two places is one line and a seen line never
 * sits above a new one.
 */
export function mergeLitLines<E extends Message>(lists: readonly (readonly LitLine<E>[])[], options: { limit?: number } = {}): LitLine<E>[] {
  const byId = new Map<string, LitLine<E>>()
  for (const list of lists) for (const line of list) if (!byId.has(lineEvent(line).id)) byId.set(lineEvent(line).id, line)
  const out = [...byId.values()].sort((a, b) => byOrder(lineEvent(b), lineEvent(a)))
  // New before seen; a limit never cuts a new line, since those are what light the dot: it bounds the seen ones.
  const fresh = out.filter((line) => !line.seen)
  const seen = out.filter((line) => line.seen)
  return [...fresh, ...(options.limit === undefined ? seen : seen.slice(0, Math.max(0, options.limit - fresh.length)))]
}

/**
 * A place's list, new then seen, each newest first (§11.8 *What lit a stream, new and seen*): every message that is unread on the place
 * ({@link unreadOnPlace}), and every one that lit it and is seen now when it was about `me` — a mention of them or a
 * reply in their conversation. The unseen lines are exactly {@link unreadOnPlace}'s; judged by today's following.
 */
export function whatLitPlace<E extends Message>(messages: readonly E[], merged: Readonly<Record<string, number>>, judge: PlaceJudge, options: LitLineOptions = {}): LitLine<E>[] {
  return linesOf(
    messages,
    judge.me,
    options,
    (message, root, inSince) => {
      const lights = lightsOnPlace(message, root, judge, inSince)
      return { lights, unread: lights && newerThanItsMarker(message, root, merged, judge, startedOn(message, judge.following)) }
    },
    { merged, judge: { contexts: [judge.stream], following: judge.following, muted: judge.muted } },
  )
}

/** A listed file's lines on the place that lists it, as {@link whatLitPlace}: the unseen ones are {@link unreadOnListedFile}'s. */
export function whatLitListedFile<E extends Message>(
  messages: readonly E[],
  merged: Readonly<Record<string, number>>,
  judge: PlaceJudge & { under?: boolean },
  options: LitLineOptions = {},
): LitLine<E>[] {
  if (!judge.following.in) return []
  return linesOf(
    messages,
    judge.me,
    options,
    (message, root, inSince) => {
      const lights = lightsOnListedFile(message, root, judge, inSince)
      return { lights, unread: lights && newerThanItsMarker(message, root, merged, judge, true) }
    },
    { merged, judge: { contexts: [judge.stream], following: judge.following, muted: judge.muted } },
  )
}

/**
 * A stream's lines by membership (a DM, with `{ dm: true }`, or a file `P` is a member of), as {@link whatLitPlace}: the
 * unseen ones are {@link unreadIn}'s.
 */
export function whatLitStream<E extends Message>(messages: readonly E[], merged: Readonly<Record<string, number>>, judge: StreamJudge, options: LitLineOptions = {}): LitLine<E>[] {
  return linesOf(
    messages,
    judge.me,
    options,
    (message, root) => {
      const lights = lightsIn(message, judge)
      return { lights, unread: lights && !seenIn(message, root, merged, judge) }
    },
    // Not a member: no reaction lights, as no message but a mention does.
    { merged, judge: { contexts: [judge.stream], following: null, muted: judge.muted || !judge.member, since: judge.since } },
  )
}

// ── A reaction to your message — §11.8, ACT-7 ───────────────────────────────

/**
 * The §11.1 contexts of the stream a reacted message is in, where its reactions are seen: a reaction on a reply counts
 * in its root's stream. A chat message (`kind:9`, root or reply) is in its channel's general stream, the bare uuid of
 * its `h`. A comment (`kind:1111`, root or reply) is in its file's stream: the address its thread is about and
 * `file:<d>`, both where the comment or the address gives them. Empty for anything else, and for a comment §6.4
 * ignores.
 *
 * why: https://github.com/estiva-app/estiva-docs/blob/main/decisions/a-reaction-is-seen-once-in-its-conversation.md
 */
export function reactionStreamOf(target: Pick<SignedEvent, 'kind' | 'tags'>): string[] {
  if (target.kind === KIND_MESSAGE) {
    const channel = channelContext(tag(target, 'h'))
    return channel === undefined ? [] : [channel]
  }
  if (target.kind !== KIND_COMMENT) return []
  const out = new Set<string>()
  for (const address of anchorsOf(target)) {
    const context = fileContext(address)
    if (context === undefined) continue
    out.add(context)
    const byId = fileIdContext(fileIdOf(address))
    if (byId !== undefined) out.add(byId)
  }
  for (const id of anchorIdsOf(target)) {
    const byId = fileIdContext(id)
    if (byId !== undefined) out.add(byId)
  }
  return [...out]
}

/** Who is judging the reactions in one conversation stream, and on what terms. */
export interface ReactionJudge {
  /** The stream's §11.1 contexts ({@link reactionStreamOf}): a file named both ways passes both. */
  contexts: readonly string[]
  /** {@link followingOf} for `P` on the place the stream is on or listed by; `null` for a DM or a stream `P` is a member of. */
  following: Following | null
  /** Whether `P` muted the place (or the stream): a reaction is not a mention, so nothing lights. */
  muted?: boolean
  /** For a DM or a member stream, unix seconds `P` came in; with a `following`, the later of this and its `since` counts. */
  since?: number
}

/** When a reaction in the stream starts to count for `P`: the later of `P`'s start and {@link REACTIONS_TO_ME_FROM}; undefined when nothing does. */
function reactionsStartOf(judge: ReactionJudge): number | undefined {
  if (judge.muted) return undefined
  if (judge.following !== null && !judge.following.in) return undefined
  return Math.max(judge.following?.since ?? 0, judge.since ?? 0, REACTIONS_TO_ME_FROM)
}

function reactionLines<E>(reactions: readonly ReactionToMe[], merged: Readonly<Record<string, number>>, judge: ReactionJudge): LitLine<E>[] {
  const start = reactionsStartOf(judge)
  if (start === undefined) return []
  const seenTo = reactionsSeenOf(merged, judge.contexts)
  return reactions
    .filter((reaction) => reaction.at >= start)
    .map((reaction): LitLine<E> => ({ type: 'reaction', reaction, seen: reaction.at <= seenTo }))
}

/**
 * The reactions to `P`'s messages in one conversation stream that are new (§11.8, ACT-7): `reactions` are already
 * mapped to the stream ({@link reactionStreamOf}); each is new when it is at or after `P`'s start there (following's
 * `since`, or a DM's or a member stream's) and {@link REACTIONS_TO_ME_FROM}, and later than the stream's `reactions:`
 * key and the reactions floor ({@link reactionsSeenOf}). Not in the place, or a muted one: none. Newest first, as given.
 *
 * Nothing but this conversation's `reactions:` key and the reactions floor clears one: opening the conversation reads
 * its messages, and only writing its {@link reactionsSeenWrites} sees its reactions.
 *
 * why: https://github.com/estiva-app/estiva-docs/blob/main/decisions/a-reaction-is-seen-once-in-its-conversation.md
 */
export function newReactionsIn(reactions: readonly ReactionToMe[], merged: Readonly<Record<string, number>>, judge: ReactionJudge): ReactionToMe[] {
  return reactionLines<never>(reactions, merged, judge).flatMap((line) => (line.type === 'reaction' && !line.seen ? [line.reaction] : []))
}

/**
 * What showing reactions to `P` writes (ACT-7): for each conversation, the `reactions:` key at the newest reaction
 * shown — its `created_at`, never the clock, so a reaction that arrives meanwhile stays new — and never later than
 * `nowMs`, so a reaction dated ahead of the clock cannot mark later ones seen. Written under the stream's write
 * context: `file:<d>` for a file named by its id, else its address; the bare uuid for a chat. `contexts` is the
 * reaction's stream ({@link reactionStreamOf}). Each is ready for the read-state queue: `markRead([context], atMs)`.
 * Resting on a row whose card listed them, and opening a conversation that draws them, both write it.
 *
 * why: https://github.com/estiva-app/estiva-docs/blob/main/decisions/a-reaction-is-seen-once-in-its-conversation.md
 * why: https://github.com/estiva-app/estiva-docs/blob/main/decisions/reactions-seen-is-kept-under-reactions-and-opening-it-sees-it.md
 */
export function reactionsSeenWrites(
  lines: readonly { reaction: ReactionToMe; contexts: readonly string[] }[],
  nowMs: number = Date.now(),
): { context: string; atMs: number }[] {
  const newest = new Map<string, number>()
  for (const { reaction, contexts } of lines) {
    const write = writeContextOf(contexts)
    if (write === undefined) continue
    const key = reactionsContext(write)
    const atMs = Math.min(reaction.at * 1000, nowMs)
    if ((newest.get(key) ?? -1) < atMs) newest.set(key, atMs)
  }
  return [...newest].map(([context, atMs]) => ({ context, atMs }))
}

/** Where a stream's reactions are written: its `file:<d>` (named, or from an address whose `d` is an id), else its address or channel. */
function writeContextOf(contexts: readonly string[]): string | undefined {
  const byId = contexts.find((c) => c.startsWith('file:')) ?? contexts.map((c) => fileIdContext(FILE_ADDRESS.test(c) ? fileIdOf(c) : undefined)).find((c) => c !== undefined)
  return byId ?? contexts[0]
}

/**
 * Why a message is unread for `me` (§11.8 *Why a message is unread*): what the message is to them, never which level
 * let it light, so one message reads the same at Important and at All and in every app. First match wins:
 *
 * - `mention` — it names `me` (§13);
 * - `new-conversation` — it starts a conversation (a top-level comment, or a chat message that answers nothing);
 * - `reply-in-yours` — it replies in a conversation `me` is in (wrote its root or a reply, or was mentioned there,
 *   or the reply's lowercase `p` names `me` as the author it answers), said after they came in;
 * - `message` — anything else that lit: a reply at All, a reply on a file `me` is a member of, or, with
 *   `{ dm: true }`, any DM message that does not name `me` (a DM is one conversation; nothing in it starts one).
 *
 * Which messages light is {@link unreadOnPlace}'s, {@link unreadOnListedFile}'s or the stream's own rule; this only
 * names why. The words a reader sees are each app's own. A reaction is not a message and is never one of these.
 */
export type UnreadReason = 'mention' | 'new-conversation' | 'reply-in-yours' | 'message'

/**
 * Where the messages are, for their reason: a place or a file, whose top-level messages start conversations, or a DM,
 * whose messages are the conversation itself, so none of them starts one or is a reply in yours.
 */
export interface UnreadReasonOptions {
  /** A DM: each message is a mention or a message (§11.8). */
  dm?: boolean
}

/** The {@link UnreadReason} of one message: `root` is its conversation's root id when it is a reply, `inConversationSince` as in {@link isUnreadOnPlace}. */
export function unreadReason(
  message: Pick<Message, 'content' | 'created_at'>,
  root: string | undefined,
  inConversationSince: number | undefined,
  me: string,
  options: UnreadReasonOptions = {},
): UnreadReason {
  if (peopleNamedInBody(message.content).has(me)) return 'mention'
  if (options.dm) return 'message'
  if (root === undefined) return 'new-conversation'
  if (inConversationSince !== undefined && message.created_at >= inConversationSince) return 'reply-in-yours'
  return 'message'
}

/**
 * The {@link UnreadReason} of every message in `messages`, by id: a place's stream, a listed file's conversation, a
 * team's chat or a DM, as the reader holds it. Pair it with the rule that says which of them are unread.
 */
export function unreadReasons(messages: readonly Message[], me: string, options: UnreadReasonOptions = {}): ReadonlyMap<string, UnreadReason> {
  const out = new Map<string, UnreadReason>()
  eachMessage(messages, me, (message, root, inSince) => {
    out.set(message.id, unreadReason(message, root, inSince, me, options))
    return false
  })
  return out
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

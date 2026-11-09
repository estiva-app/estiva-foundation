/**
 * A list row's dot — SPEC §11.8 over a stream's messages, for a reader that
 * holds only who said what and when, never the bodies.
 *
 * Moved here from Peek (SHIPS-2) so Peek's Topics and Ship's Topics judge a
 * topic's dot by one rule: which files the viewer is a member of, read from
 * the relay and folded ({@link membershipQueries}, {@link foldMemberships}),
 * the terms that fold gives a stream ({@link streamTermsOf}), and whether any
 * of the stream's messages is unread on them ({@link streamHasUnread}).
 *
 * The read state and the muted list are encrypted (NIP-44), so nothing here
 * reads them: the app hands in the merged markers and the muted set it holds.
 */
import { encodeNpub, type SignedEvent } from '@estiva-app/protocol'
import { candidateFilesOf, membershipFilters, membershipOf, mentions, type Membership } from './membership.js'
import { READ_STATE_HORIZON_DAYS, fileContext } from './readState.js'
import { isUnread } from './unread.js'

/** What a list holds of a message: no body. `root` is the thread root's id, the message's own when it is one. */
export interface StreamMessage {
  id: string
  /** Unix seconds. */
  at: number
  /** Author pubkey. */
  by: string
  root: string
}

/** What a stream is judged against besides its messages. */
export interface StreamFrontier {
  /** The merged read state: context → unix seconds. */
  merged: Readonly<Record<string, number>>
  /** The viewer's pubkey; their own messages do not count. */
  me: string | undefined
  /** The viewer's own agents, whose messages do not count either (`ownAgentsOf`, PEE-79). */
  mine?: ReadonlySet<string>
  /** Now, unix seconds. */
  nowSeconds: number
  horizonSeconds: number
}

/** The terms a stream is told about on: SPEC §11.8's membership, join time and mute. */
export interface StreamTerms {
  member: boolean
  since?: number
  muted: boolean
}

/**
 * Is anything in this stream unread for the viewer — SPEC §11.8's four
 * conditions over §11.3's markers, judged by {@link isUnread}.
 *
 * `context` is the stream's read-state context (§11.1): `fileContext(address)`
 * for a file, `channelContext(uuid)` for a Folder's general stream. A message is
 * judged against its thread's marker as well as the stream's (§11.3).
 *
 * The messages carry no body, so whether one *names the viewer* comes from
 * `isMentioned` (the ids the membership read's `#p` filter returned) and is
 * handed to the judge as the body it would have had. Without a marker, a file
 * member is told from the second they joined; a Folder's own chat has no
 * members here and lights only for a message that names the viewer, so
 * absence there is the horizon (§11.6).
 */
export function streamHasUnread(
  messages: readonly StreamMessage[],
  context: string,
  terms: StreamTerms,
  frontier: StreamFrontier,
  isMentioned: (messageId: string) => boolean,
): boolean {
  const { me } = frontier
  if (!me) return false
  // Only for a message that names the viewer, so a viewer without a hex key judges the rest.
  const named = () => `nostr:${encodeNpub(me)}`
  const judge = {
    stream: context,
    me,
    mine: frontier.mine,
    member: terms.member,
    since: terms.since,
    muted: terms.muted,
    floor: frontier.nowSeconds - frontier.horizonSeconds,
  }
  for (const message of messages) {
    const root = message.root === message.id ? undefined : message.root
    const unread = isUnread(
      { id: message.id, pubkey: message.by, kind: 1111, created_at: message.at, tags: [], content: isMentioned(message.id) ? named() : '' },
      root,
      frontier.merged,
      judge,
    )
    if (unread) return true
  }
  return false
}

/** Per filter. Measured on production as the agent, the most-named identity there: 700 events in 90 days. */
export const MEMBERSHIP_LIMIT = 1000

/** The read horizon, in seconds: nothing before it can light a dot. */
export const HORIZON_SECONDS = READ_STATE_HORIZON_DAYS * 24 * 60 * 60

/** The three filters that find every file the viewer may be a member of (§11.8), bounded by the horizon. */
export function membershipQueries(pubkey: string, nowSeconds: number, limit = MEMBERSHIP_LIMIT): Record<string, unknown>[] {
  return membershipFilters(pubkey, nowSeconds - HORIZON_SECONDS).map((filter) => ({ ...filter, limit }))
}

/** What the relay says the viewer is a member of, within the horizon. */
export interface MembershipRead {
  /** Every candidate file, folded: the ones the viewer is in and the ones they left. */
  files: ReadonlyMap<string, Membership>
  /** Ids of the messages whose content names the viewer. */
  mentioned: ReadonlySet<string>
  /** Unix seconds a created file's membership starts at — the horizon's start. */
  floor: number
}

/** The address's author, or undefined when it is not a file address. */
export function authorOfAddress(address: string): string | undefined {
  if (fileContext(address) === undefined) return undefined
  return address.split(':')[1]
}

/**
 * Fold what {@link membershipQueries} returned. Pure: the clock is `nowSeconds`.
 *
 * A file's address names its author, so a file the viewer created needs no
 * query: a candidate whose address is theirs is folded with its root added,
 * dated to the horizon's start — the earliest the viewer could be told about —
 * and a leave of theirs among the changes still takes them off. Membership the
 * horizon hides lapses for this reader and comes back with the next event
 * naming the viewer (§11.8 *The fold*).
 */
export function foldMemberships(pubkey: string, events: readonly SignedEvent[], nowSeconds: number): MembershipRead {
  const floor = nowSeconds - HORIZON_SECONDS
  const byFile = new Map<string, SignedEvent[]>()
  const mentioned = new Set<string>()
  for (const event of events) {
    if (mentions(event, pubkey)) mentioned.add(event.id)
    for (const file of candidateFilesOf(event)) {
      const list = byFile.get(file)
      if (list) list.push(event)
      else byFile.set(file, [event])
    }
  }
  const files = new Map<string, Membership>()
  for (const [file, held] of byFile) {
    const [kind, , d] = file.split(':')
    const own = authorOfAddress(file) === pubkey
    // The root the viewer created, when they did — ordered before everything else for the file.
    const root = own ? [{ id: '', pubkey, kind: Number(kind), created_at: floor, tags: [['d', d ?? '']], content: '', sig: '' }] : []
    files.set(file, membershipOf(file, pubkey, [...root, ...held]))
  }
  return { files, mentioned, floor }
}

/**
 * The terms a stream is judged on, from the membership read and the muted set.
 *
 * A file is a member by the fold, else by authorship (a file the viewer
 * created is theirs unless a leave of theirs says otherwise, and a leave is
 * among the files read). Anything that is not a file address — a Folder's
 * general stream — has nothing to read (Miky, 2026-10-01): nobody is a member
 * of it, so it lights only for a message that names the viewer.
 */
export function streamTermsOf(
  key: string,
  read: Pick<MembershipRead, 'files' | 'floor'>,
  me: string | undefined,
  muted: ReadonlySet<string>,
): StreamTerms {
  const isMuted = muted.has(key)
  if (fileContext(key) === undefined) return { member: false, muted: isMuted }
  const folded = read.files.get(key)
  if (folded) return { member: folded.member, since: folded.since, muted: isMuted }
  if (me && authorOfAddress(key) === me) return { member: true, since: read.floor, muted: isMuted }
  return { member: false, muted: isMuted }
}

/**
 * Whether the horizon's read has a word on the viewer in this file: an event
 * naming them within it, or the file is theirs. Without one, "not a member"
 * may only mean they joined before the horizon; a list that must say whose a
 * file is reads those over all history.
 */
export function membershipJudges(key: string, read: Pick<MembershipRead, 'files'>, me: string | undefined): boolean {
  return read.files.has(key) || (!!me && authorOfAddress(key) === me)
}

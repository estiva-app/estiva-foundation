/**
 * Who `@` and `!@` offer in a comment box — one list of people in every app
 * (PEEKM-6; Miky, 20 October: "There is one set of people").
 *
 * The workspace's people are two relay facts: the relay's NIP-43 roster
 * (`kind:13534`, one `member` tag per admitted key) and each key's profile
 * (`kind:0`). `@` offers the roster's keys that have a named profile, agents
 * included (mentioning one is how you ask it something), never the viewer,
 * by name. A roster key with no named profile is left out: the roster also
 * lists keys that are not people (an app's manifest key), and a shortened key
 * is nobody a person can pick.
 *
 * Each app still reads the events its own way; this only maps them, so the
 * same events give the same list, in the same order, everywhere.
 *
 * why: https://github.com/estiva-app/estiva-docs/blob/main/decisions/a-conversation-is-one-shared-thing-and-only-its-colours-are-the-apps.md
 */
import { parseProfile } from '@estiva-app/protocol'

/** NIP-43's relay membership list. */
export const KIND_MEMBERSHIP_LIST = 13534

/** A named profile: what `@`'s row draws, and what a mention of the key reads as. */
export interface NamedProfile {
  pubkey: string
  name: string
  picture?: string
  /** NIP-24's `bot: true`, an agent's profile. Present only when true. */
  bot?: true
}

type ProfileEvent = { kind: number; pubkey: string; created_at: number; content: string }
type RosterEvent = { kind: number; created_at: number; tags: string[][] }

/**
 * Every named profile, newest `kind:0` per key, as protocol's `parseProfile`
 * reads one. Not narrowed to the roster: this answers "what is this key
 * called", which a mention of the viewer, or of someone who has left, still
 * needs answered.
 */
export function namedProfilesOf(events: readonly ProfileEvent[]): Map<string, NamedProfile> {
  const newest = new Map<string, ProfileEvent>()
  for (const e of events) {
    if (e.kind !== 0) continue
    const seen = newest.get(e.pubkey)
    if (!seen || e.created_at > seen.created_at) newest.set(e.pubkey, e)
  }
  const out = new Map<string, NamedProfile>()
  for (const [pubkey, event] of newest) {
    const { displayName, picture, bot } = parseProfile(event)
    const name = displayName?.trim() ? displayName : undefined
    if (!name) continue
    out.set(pubkey, { pubkey, name, ...(picture ? { picture } : {}), ...(bot ? { bot } : {}) })
  }
  return out
}

/** The newest roster's members, or `null` when the relay keeps no roster. */
export function rosterOf(events: readonly RosterEvent[]): Set<string> | null {
  const roster = events.filter((e) => e.kind === KIND_MEMBERSHIP_LIST).sort((a, b) => b.created_at - a.created_at)[0]
  if (!roster) return null
  return new Set(roster.tags.filter((t) => (t[0] === 'member' || t[0] === 'p') && /^[0-9a-f]{64}$/.test(t[1] ?? '')).map((t) => t[1]))
}

/** By name, ignoring case and accents: "anna" sits beside "Anna", "Émile" beside "Emile". */
export function byName(a: { name: string }, b: { name: string }): number {
  return a.name.localeCompare(b.name, undefined, { sensitivity: 'base' })
}

/**
 * Whom `@` and `!@` offer: the named profiles on the roster, never the viewer,
 * by name. With no roster (a relay that keeps none), every named profile given.
 */
export function mentionablePeople<P extends { pubkey: string; name: string }>(
  profiles: Iterable<P>,
  roster: ReadonlySet<string> | null,
  me: string | null | undefined,
): P[] {
  return [...profiles].filter((p) => p.pubkey !== me && p.name.trim() !== '' && (!roster || roster.has(p.pubkey))).sort(byName)
}

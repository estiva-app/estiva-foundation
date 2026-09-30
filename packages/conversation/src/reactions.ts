/**
 * Reactions — SPEC §6.6.
 *
 * A reaction is a NIP-25 `kind:7` naming its target by `e`. **It carries no
 * `h`**, so a channel read never returns one: reactions are fetched addressed
 * by target, which forces a horizon every reader must share.
 *
 * Two apps must agree on a **count**, so what counts is specified (decided
 * 2026-09-29, CON-5):
 *
 * - **Target**: the **last** `e` whose value is 64 hex, as NIP-25 says — the
 *   one the relay files the reaction under (`handlers/ingest.rs`).
 * - **Emoji**: the content as stored, **not trimmed**; an empty content is
 *   `+`, NIP-25's "like".
 * - **Count**: one per `(target, pubkey, emoji)`. The relay refuses an active
 *   duplicate; a reader still deduplicates, because a copy need not.
 * - **Retraction** is a `kind:5` on the reaction, and the relay stops
 *   returning it, so a reader re-reads and does not reconcile.
 * - **Order** is presentation. This keeps first-reaction order; an app MAY
 *   sort by count, and two apps that differ there disagree about nothing.
 */
import type { SignedEvent } from '@estiva-app/protocol'
import { isEventId, KIND_REACTION } from './kinds.js'
import { byOrder } from './order.js'

/**
 * How many targets a reaction read asks about — SPEC §6.6, decided by CON-1.
 * The value is the specification's; two apps with different N disagree about
 * a count, legitimately and unfixably.
 */
export const REACTION_HORIZON = 100

/**
 * The emoji a person can pick, and what each one means — the same five in
 * both apps, in the same order, because a reaction you can read is one you
 * should be able to answer. The name is the tooltip and the accessible name.
 */
export const REACTION_EMOJI: readonly { emoji: string; name: string }[] = [
  { emoji: '👍', name: 'Makes sense' },
  { emoji: '💯', name: 'Agree' },
  { emoji: '🙏', name: 'Thank you' },
  { emoji: '🚀', name: "Let's go!" },
  { emoji: '🎉', name: 'Congrats' },
]

/** The event a `kind:7` reacts to: the **last** 64-hex `e`, lowercased. */
export function reactionTargetOf(event: Pick<SignedEvent, 'tags'>): string | undefined {
  for (let i = event.tags.length - 1; i >= 0; i--) {
    const t = event.tags[i]
    if (t[0] === 'e' && isEventId(t[1])) return t[1].toLowerCase()
  }
  return undefined
}

/** The emoji a `kind:7` carries: its content untrimmed, `+` when empty. */
export function reactionEmojiOf(event: Pick<SignedEvent, 'content'>): string {
  return event.content === '' ? '+' : event.content
}

/** Which targets a reaction read asks about, and how many it leaves out. */
export interface ReactionHorizon {
  /** The ids to ask about, newest first. */
  asked: string[]
  /** How many were left out — what §6.6 makes reporting a MUST. */
  omitted: number
}

/**
 * The horizon applied: **the newest {@link REACTION_HORIZON} targets by
 * `created_at`, ties broken on the higher id**, in one budget across every id
 * space the caller mixes (roots and replies alike). `at` is the target's
 * `created_at` in seconds; a repeated id counts once.
 */
export function reactionHorizon(targets: readonly { id: string; at: number }[], limit = REACTION_HORIZON): ReactionHorizon {
  const unique = new Map<string, number>()
  for (const t of targets) if (!unique.has(t.id)) unique.set(t.id, t.at)
  const newestFirst = [...unique].sort((a, b) => b[1] - a[1] || (a[0] > b[0] ? -1 : a[0] < b[0] ? 1 : 0))
  return { asked: newestFirst.slice(0, limit).map(([id]) => id), omitted: Math.max(0, newestFirst.length - limit) }
}

/** One reaction event, read. */
export interface ReactionEvent {
  id: string
  target: string
  emoji: string
  by: string
  at: number
}

/**
 * Every `kind:7` in `events`, read by §6.6 and deduplicated per
 * `(target, pubkey, emoji)` — the earliest wins, so a retraction names it.
 * Oldest first by §6.3. A reaction with no 64-hex `e` is nobody's.
 */
export function reactionEventsOf(events: readonly SignedEvent[]): ReactionEvent[] {
  const out: ReactionEvent[] = []
  const counted = new Set<string>()
  const seen = new Set<string>()
  for (const event of [...events].sort(byOrder)) {
    if (event.kind !== KIND_REACTION || seen.has(event.id)) continue
    seen.add(event.id)
    const target = reactionTargetOf(event)
    if (!target) continue
    const emoji = reactionEmojiOf(event)
    const key = JSON.stringify([target, event.pubkey, emoji])
    if (counted.has(key)) continue
    counted.add(key)
    out.push({ id: event.id, target, emoji, by: event.pubkey, at: event.created_at })
  }
  return out
}

/** One emoji on one target, and who put it there. */
export interface Reaction {
  emoji: string
  /** Distinct reactors — one per pubkey. */
  count: number
  /** Reactor pubkeys, in the order they reacted. */
  by: string[]
  /**
   * The viewer's own reaction event id, when they are among `by` — what a
   * retraction (`kind:5` on the reaction) names.
   */
  mine?: string
}

/**
 * Fold `kind:7` events into per-target counts (C13): target id → one entry per
 * emoji, in first-reaction order. `viewer` fills `mine`.
 */
export function foldReactions(events: readonly SignedEvent[], viewer?: string): Record<string, Reaction[]> {
  return groupReactions(reactionEventsOf(events), viewer)
}

/** {@link foldReactions} over reactions already read by {@link reactionEventsOf}. */
export function groupReactions(reactions: readonly ReactionEvent[], viewer?: string): Record<string, Reaction[]> {
  const out: Record<string, Reaction[]> = {}
  for (const r of reactions) {
    const list = (out[r.target] ??= [])
    let entry = list.find((e) => e.emoji === r.emoji)
    if (!entry) {
      entry = { emoji: r.emoji, count: 0, by: [] }
      list.push(entry)
    }
    if (entry.by.includes(r.by)) continue
    entry.by.push(r.by)
    entry.count += 1
    if (viewer !== undefined && r.by === viewer) entry.mine = r.id
  }
  return out
}

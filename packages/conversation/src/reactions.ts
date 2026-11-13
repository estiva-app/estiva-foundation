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
import { effectiveAuthor, type SignedEvent } from '@estiva-app/protocol'
import { isConversationKind, isEventId, KIND_DELETION, KIND_REACTION } from './kinds.js'
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

// ── The reactions to a person — §6.6 *Finding the reactions to a person* ────

/**
 * When the reactions to `P`'s messages start counting, unix seconds:
 * 2026-11-13T17:00:00Z, just after every reaction began naming whose message
 * it reacts to (ACT-6). One suite constant, set once: an earlier reaction
 * carries no name, so it is never found, and every reader must agree on where
 * orange starts.
 *
 * why: https://github.com/estiva-app/estiva-docs/blob/main/decisions/a-reaction-names-whose-message-it-reacts-to.md
 */
export const REACTIONS_TO_ME_FROM = 1794589200

/**
 * The read that answers "the reactions to `me`'s messages" (§6.6), stored and
 * kept open: `{kinds:[7], "#p":[me], since}`, never earlier than
 * {@link REACTIONS_TO_ME_FROM}.
 */
export function reactionsToMeFilter(me: string, since?: number): { kinds: number[]; '#p': string[]; since: number } {
  return { kinds: [KIND_REACTION], '#p': [me], since: Math.max(since ?? REACTIONS_TO_ME_FROM, REACTIONS_TO_ME_FROM) }
}

/**
 * The deletions that take a reaction to `me` back, or delete the message it
 * reacted to later: `{kinds:[5], "#e":[…]}` over the reactions drawn **and**
 * their targets, kept open. What it returns goes in {@link reactionsToMe}'s
 * `gone`.
 */
export function reactionTakeBackFilter(ids: readonly string[], since?: number): { kinds: number[]; '#e': string[]; since?: number } {
  return { kinds: [KIND_DELETION], '#e': [...new Set(ids)], ...(since !== undefined ? { since } : {}) }
}

/** One reaction to `me`'s message, kept by §6.6. */
export interface ReactionToMe {
  /** The reaction's event id. */
  id: string
  /** Who reacted: the reaction's effective author. */
  by: string
  /** Its `created_at`, unix seconds. */
  at: number
  /** {@link reactionEmojiOf}. */
  emoji: string
  /** The id of the message it reacts to. */
  target: string
}

type Tagged = Pick<SignedEvent, 'pubkey' | 'kind' | 'tags' | 'created_at'>

const lastP = (event: Pick<SignedEvent, 'tags'>): string | undefined => {
  for (let i = event.tags.length - 1; i >= 0; i--) if (event.tags[i][0] === 'p') return event.tags[i][1]
  return undefined
}

/**
 * Whether a reader keeps a reaction as one to `me`'s message (§6.6, exactly):
 *
 * - its **last** `p` is `me`;
 * - its target (the last 64-hex `e`) is held, is a message or a comment
 *   (`kind:9` or `1111`), and `me` is its effective author, worked out with the
 *   relay's key — so a reaction that names `me` falsely, or beside someone
 *   else, keeps nothing, and without the key a message the relay signed on
 *   `me`'s behalf is the relay's;
 * - `me` is not the reaction's effective author;
 * - it is from {@link REACTIONS_TO_ME_FROM} on.
 *
 * `target` is the event the reader fetched by id; undefined when it is deleted
 * or unreadable, which keeps nothing.
 */
export function keepReactionToMe(reaction: Tagged & Pick<SignedEvent, 'id'>, target: (Tagged & Pick<SignedEvent, 'id'>) | undefined, me: string, relayKey?: string | null): boolean {
  if (reaction.kind !== KIND_REACTION || reaction.created_at < REACTIONS_TO_ME_FROM) return false
  if (lastP(reaction) !== me) return false
  if (!target || reactionTargetOf(reaction) !== target.id.toLowerCase()) return false
  if (!isConversationKind(target.kind)) return false
  if (effectiveAuthor(target, relayKey) !== me) return false
  return effectiveAuthor(reaction, relayKey) !== me
}

/**
 * The reactions to `me`'s messages, kept by {@link keepReactionToMe}, newest
 * first, one per `(by, target, emoji)` (the earliest, as §6.6 counts). A
 * reaction or a target whose id is in `gone` — a `kind:5` seen for it — is
 * dropped: a reaction taken back, or a message deleted after it was reacted to,
 * lights nothing. `targetsById` holds the targets the reader has, by lowercase
 * id.
 */
export function reactionsToMe(
  reactions: readonly SignedEvent[],
  targetsById: ReadonlyMap<string, Tagged & Pick<SignedEvent, 'id'>>,
  me: string,
  opts: { relayKey?: string | null; gone?: ReadonlySet<string> } = {},
): ReactionToMe[] {
  const { relayKey, gone } = opts
  const out: ReactionToMe[] = []
  const counted = new Set<string>()
  const seen = new Set<string>()
  for (const reaction of [...reactions].sort(byOrder)) {
    if (seen.has(reaction.id) || gone?.has(reaction.id)) continue
    seen.add(reaction.id)
    const target = reactionTargetOf(reaction)
    if (target === undefined || gone?.has(target)) continue
    if (!keepReactionToMe(reaction, targetsById.get(target), me, relayKey)) continue
    const by = effectiveAuthor(reaction, relayKey)
    const emoji = reactionEmojiOf(reaction)
    const key = JSON.stringify([by, target, emoji])
    if (counted.has(key)) continue
    counted.add(key)
    out.push({ id: reaction.id, by, at: reaction.created_at, emoji, target })
  }
  return out.reverse()
}

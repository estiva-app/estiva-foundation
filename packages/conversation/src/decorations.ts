/**
 * What has been done to a set of messages since they were written — edits,
 * reactions, resolutions — in one request, read by `#e`.
 *
 * Moved here from `@estiva-app/interop` (CON-5), where it was
 * `commentDecorationsOf` since CON-8. It is a second round trip by nature:
 * an edit, a reaction and a resolution name the *message* by `e`, never the
 * file or the channel, so they cannot be asked for until the message ids are
 * known.
 */
import { MAX_FILTERS_PER_QUERY, RELAY_PAGE_CEILING, type SignedEvent } from '@estiva-app/protocol'
import { editTargetOf, foldEdits, type EditFold } from './edits.js'
import { KIND_ASSERTION, KIND_EDIT, KIND_REACTION } from './kinds.js'
import { resolutionsByTarget, resolutionTargetOf, type Resolution, type resolutionOf } from './resolution.js'

export type { Resolution }
import { reactionEventsOf, reactionHorizon, reactionTargetOf, type ReactionEvent } from './reactions.js'

/**
 * How a caller reads the relay: filters in, events out. The environment's
 * one touch, injected — this package opens no socket and holds no credential.
 * Structurally the same as `@estiva-app/interop`'s `QueryFn`.
 */
export type QueryFn = (filters: Record<string, unknown>[]) => Promise<SignedEvent[]>

/** What has been done to one message since it was written. */
export interface Decoration {
  /** Its edits, folded (§6.8). Absent when nobody edited it. */
  edit?: EditFold
  /** Its reactions, one per `(pubkey, emoji)`, oldest first. Empty inside the horizon means none. */
  reactions: ReactionEvent[]
  /**
   * Every resolve and reopen naming it, oldest first by §6.3. Which one counts
   * — `h` checked, a `support` outside the thread dropped — is
   * {@link resolutionOf}'s: the last one here is not the state on its own.
   */
  resolutions: Resolution[]
}

/** The answer of {@link decorationsOf}. */
export interface Decorations {
  /** Keyed by message id. A target nothing happened to is present, with nothing in it. */
  byId: Record<string, Decoration>
  /**
   * How many targets were **not** asked about reactions, because they fell
   * outside the horizon. §6.6 makes reporting this a MUST: a cap nobody can
   * see is indistinguishable from "nobody reacted".
   */
  reactionTargetsOmitted: number
  /**
   * Whether a reaction read came back at the relay's page ceiling, so some
   * reaction *events* may be missing. §6.6: a reader that caps events MUST
   * report the cut as it reports the target cut.
   */
  reactionEventsCut: boolean
  /**
   * Whether an edit and resolution read came back at the page ceiling, so a
   * message may show an older body or state than the relay holds.
   */
  editEventsCut: boolean
}

/** Ids per `#e` filter. A comfortable fraction of the relay's page, so one filter's answer is rarely cut. */
const TARGETS_PER_FILTER = 100

const chunked = (list: readonly string[]) => {
  const out: string[][] = []
  for (let i = 0; i < list.length; i += TARGETS_PER_FILTER) out.push(list.slice(i, i + TARGETS_PER_FILTER))
  return out
}


/**
 * Edits, reactions and resolutions for `targets`, in as few requests as the
 * relay allows.
 *
 * - **Edits** fold by §6.8 ({@link foldEdits}): the target is the first 64-hex
 *   `e` and no other. Pass each target's `body` so "edited" means the body
 *   changed; without it the first edit counts as a change.
 * - **Reactions** have a horizon ({@link reactionHorizon}): the newest 100
 *   targets by `at`, one budget across whatever id spaces the caller mixes,
 *   the number left out reported. Target is the last 64-hex `e`, empty is `+`,
 *   one per `(target, pubkey, emoji)`.
 * - **Resolutions** are `kind:9101` carrying `t=resolution`; the `action` tag
 *   is the state, the content the rationale, and an `e` marked `support` names
 *   the reply that carried it. The target is the first unmarked `e`
 *   ({@link resolutionTargetOf}), and a thread's state is {@link resolutionOf}'s.
 *
 * Edits and resolutions have no horizon: they are one event per change, not
 * one per reader. A refused read is whatever `query` does with one.
 */
export async function decorationsOf(
  /** `at` is the target's `created_at`, seconds. */
  targets: readonly { id: string; at: number; body?: string }[],
  query: QueryFn,
): Promise<Decorations> {
  // Keyed lowercase: every target this reads off a tag is lowercased (`editTargetOf`, `reactionTargetOf`).
  const byId: Record<string, Decoration> = {}
  const unique: { id: string; at: number }[] = []
  for (const t of targets) {
    const id = t.id.toLowerCase()
    if (Object.hasOwn(byId, id)) continue
    byId[id] = { reactions: [], resolutions: [] }
    unique.push({ id, at: t.at })
  }
  if (unique.length === 0) return { byId, reactionTargetsOmitted: 0, reactionEventsCut: false, editEventsCut: false }

  const { asked, omitted } = reactionHorizon(unique)
  const reactionChunks = chunked(asked)
  const editChunks = chunked(unique.map((t) => t.id))
  const filters: Record<string, unknown>[] = []
  for (const chunk of editChunks) {
    filters.push({ kinds: [KIND_EDIT, KIND_ASSERTION], '#e': chunk, limit: RELAY_PAGE_CEILING })
  }
  for (const chunk of reactionChunks) filters.push({ kinds: [KIND_REACTION], '#e': chunk, limit: RELAY_PAGE_CEILING })

  const seen = new Set<string>()
  const events: SignedEvent[] = []
  for (let start = 0; start < filters.length; start += MAX_FILTERS_PER_QUERY) {
    for (const event of await query(filters.slice(start, start + MAX_FILTERS_PER_QUERY))) {
      if (seen.has(event.id)) continue
      seen.add(event.id)
      events.push(event)
    }
  }

  // `hasOwn`, not `in`: an `e` of `constructor` is anybody's to write.
  const ours = (id: string | undefined): id is string => id !== undefined && Object.hasOwn(byId, id)

  const bodies = targets.flatMap((t) => (t.body === undefined ? [] : [{ id: t.id, body: t.body }]))
  for (const [target, fold] of Object.entries(foldEdits(events, bodies))) {
    if (ours(target)) byId[target].edit = fold
  }

  /*
    A filter answered at its limit may have been cut. Counted per filter by
    which chunk each event's target sits in: one pass, each target read once.
  */
  const cut = (chunks: string[][], kinds: readonly number[], targetOf: (e: SignedEvent) => string | undefined) => {
    const chunkOf = new Map<string, number>()
    chunks.forEach((chunk, i) => chunk.forEach((id) => chunkOf.set(id, i)))
    const answered = new Array<number>(chunks.length).fill(0)
    for (const event of events) {
      if (!kinds.includes(event.kind)) continue
      const i = chunkOf.get(targetOf(event) ?? '')
      if (i !== undefined) answered[i] += 1
    }
    return answered.some((n) => n >= RELAY_PAGE_CEILING)
  }
  const reactionEventsCut = cut(reactionChunks, [KIND_REACTION], reactionTargetOf)
  const editEventsCut = cut(editChunks, [KIND_EDIT, KIND_ASSERTION], (e) =>
    e.kind === KIND_EDIT ? editTargetOf(e) : resolutionTargetOf(e),
  )

  const inHorizon = new Set(asked)
  const reactions = events.filter((e) => e.kind === KIND_REACTION)
  for (const reaction of reactionEventsOf(reactions)) {
    if (ours(reaction.target) && inHorizon.has(reaction.target)) byId[reaction.target].reactions.push(reaction)
  }

  for (const [target, list] of Object.entries(resolutionsByTarget(events))) {
    if (ours(target)) byId[target].resolutions = list
  }

  return { byId, reactionTargetsOmitted: omitted, reactionEventsCut, editEventsCut }
}

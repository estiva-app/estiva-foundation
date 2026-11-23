import type { ResolvedAction } from '@estiva-app/interop'
import type { LauncherAction, LauncherApp, VocabOption } from './launcherActions.js'

/**
 * INT-5 — choosing, from what was said, an action some app declared.
 *
 * **Nothing in this file knows what any app is.** Not Ship, not an issue, not a
 * project. It reasons over `ResolvedAction`s that arrived from manifests at
 * runtime, and the test it is written against is RFC 0.4 §15's: an app nobody
 * here wrote publishes a manifest, and this works for it the same day. If a
 * name of an app or an object appears below, it is a bug.
 *
 * The material it matches on already exists. RFC 0.4 §13.4 took two seams
 * early — an action's `description` and its `effect` — and `ResolvedAction`
 * carries both, annotated *"Carried through, never rendered here"*. They were
 * taken for a consumer that reasons. This is that consumer.
 */

/** One declared action, with the app it belongs to. */
export interface CatalogueEntry {
  appId: string
  appLabel: string
  /** The action as the manifest declared it. */
  action: ResolvedAction
  /** The same action, in the shape the launcher's form panel draws. */
  launcher: LauncherAction
  /** Its own vocabularies, so a form opened without an app scope still has them. */
  vocabularies: Record<string, VocabOption[]>
  /**
   * What a new object could hang under, as the parent picker's options.
   *
   * Travels with the entry for the same reason the vocabularies do: a proposal
   * opens the form without scoping into the app, and a form whose parent field
   * has no options is one the runtime will refuse — which closes silently and
   * looks like success (PEE-1).
   */
  parents: VocabOption[]
}

/**
 * Effects a conversation may propose.
 *
 * `destructive` is excluded, and that is a judgement rather than a rule the
 * RFC states: nothing here invokes anything — every proposal opens a form a
 * person submits — so `writes` is already safe by construction. But a model
 * reading a thread and offering to delete something is a footgun that a form in
 * between does not defuse, and no conversation needs it.
 *
 * An action whose manifest said nothing is `undefined`, which the interop
 * layer documents as *unknown*. Unknown is proposable: it cannot self-invoke
 * either, and excluding it would make this feature do nothing for every app
 * that has not adopted the field.
 */
export function isProposable(action: ResolvedAction): boolean {
  return action.effect !== 'destructive'
}

/**
 * What the model is asked to return.
 *
 * An **id and a sentence**. Deliberately not the field values — those are
 * PEE-5's job, they come from the action's own declared schema, and asking for
 * them here would mean inventing a shape that has to match every app's fields.
 * Two small questions beat one large one on a model this size.
 */
export const PROPOSAL_SCHEMA = {
  type: 'object',
  properties: {
    action: { type: 'string' },
    preview: { type: 'string' },
  },
  required: ['action', 'preview'],
} as const

/**
 * The prompt.
 *
 * The catalogue is rendered as `id — app: label — description`, and the
 * description is the matching material. **Its quality is the producing app's
 * responsibility and nothing checks it**: an app declaring `description: "Add"`
 * matches badly and nothing here can tell. That belongs in the interop
 * conformance suite, because it is a claim about every producer rather than
 * about any one app.
 *
 * It is told it may decline. A model given a lunch thread and a list of actions
 * will otherwise pick one, and a confident irrelevant proposal is worse than
 * none — the same reason `answerInstruction` permits an honest refusal.
 */
export function proposalInstruction(conversation: string, entries: readonly CatalogueEntry[]): string {
  const catalogue = entries
    .map((e) => `${e.action.id} — ${e.appLabel}: ${e.launcher.label}${e.action.description ? ` — ${e.action.description}` : ''}`)
    .join('\n')
  return [
    'A team is having this conversation:',
    '',
    conversation,
    '',
    'These are the things that can be made from it, one per line, as `id — app: label — what it is for`:',
    '',
    catalogue,
    '',
    'Pick the one this conversation most calls for.',
    'Reply with the id exactly as written above, and one sentence describing what would be made, drawn from the conversation.',
    `If none of them fits, reply with the id "${NO_PROPOSAL}" instead of choosing one that does not.`,
  ].join('\n')
}

/**
 * The id a model returns when nothing fits.
 *
 * A reserved word rather than an empty string, because a small model asked for
 * a string returns something. It is validated like any other id and simply
 * matches no entry.
 */
export const NO_PROPOSAL = 'none'

export interface Proposal {
  entry: CatalogueEntry
  preview: string
}

/**
 * Turn what the model said into a proposal, or into nothing.
 *
 * **The id is validated against the real set**, which is the whole reason this
 * is safe: structured output is refused on some builds (Chrome with speculative
 * decoding rejects `responseConstraint` outright, measured 2026-09-02), so
 * selection runs through the lenient path and can return anything at all. An
 * unrecognised id is dropped rather than guessed at — the honour-system
 * discipline `buildCreationEvent` already applies to properties, applied here
 * to an action.
 */
export function readProposal(
  answer: Record<string, unknown> | null,
  entries: readonly CatalogueEntry[],
): Proposal | null {
  // Typed as unknown because it is: the lenient path parses whatever JSON-ish
  // text came back, so a number or an object where a string was asked for is a
  // real possibility rather than a defensive hypothetical.
  const id = typeof answer?.action === 'string' ? answer.action.trim() : ''
  if (!id) return null
  const entry = entries.find((e) => e.action.id === id)
  if (!entry) return null
  const preview = typeof answer?.preview === 'string' ? answer.preview.trim() : ''
  return { entry, preview: preview || entry.launcher.label }
}

/** The apps worth asking for a manifest — those that say what to query. */
export function probeable(apps: readonly LauncherApp[]): LauncherApp[] {
  return apps.filter((a) => typeof a.parentKind === 'number')
}

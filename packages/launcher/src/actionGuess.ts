/**
 * The guess: which suggested action a sentence wants, from the browser's
 * on-device Decisions API (`DecisionModel`), used only to put that action first
 * (KIN-7).
 *
 * > **Miky, 2026-11-20** — the experimental local Decisions API, not the cloud
 * > one; it only orders the suggested actions and never decides whether a
 * > sentence is a search or a question; only the Download row starts a download.
 * > **Miky, 2026-11-24** — on only where the model passes a check of known
 * > sentences when the box opens; no browser is named in the code.
 *
 * ## Why the hidden options and the check
 *
 * Probed 24 Nov in Miky's Chrome 160 and Edge Dev 160 with each app's real
 * list (`~/estiva/decisions-probe`, `results-kin7.jsonl`). Asked to choose among
 * the real actions only, both were confidently wrong: with Ship's two, about 20
 * of 40 sentences moved a wrong row at 0.85 or more — "leaf", a plain search,
 * put Add issue first at 0.90. The API cannot say "none", so `HIDDEN` gives it
 * somewhere else to go: options no row draws, and when one wins nothing moves.
 * With them Edge was right on 10 of 11 moves at 0.6. Chrome was not: it put
 * Create issue first at 0.97–1.00 for "assign this issue to me", which no bar
 * removes. So a model is used only once it leaves `CHECKS` alone — today that
 * is Edge and not Chrome, and Chrome turns on by itself the day it passes.
 *
 * ## What it deliberately does not do
 *
 * It never starts a download: a session is made only where `availability()`
 * says `'available'`, and `downloadGuessModel` is called only by the Download
 * row. It never holds the box: every call is fire-and-forget, and an answer for
 * a sentence that has since changed is dropped by the caller.
 */

/** What the box offers the model: a suggested row's id, and words the model reads (never drawn). */
export interface GuessOption {
  id: string
  wording: string
}

/** The answer of one decision: the option the model chose and how sure it is. */
interface Decision {
  label: string
  confidence: number
}

interface DecisionSession {
  decide(text: string): Promise<Record<string, Decision | undefined>>
  destroy?(): void
}

interface DecisionSchema {
  context: string
  questions: { id: string; type: 'choice'; prompt: string; options: { label: string; description: string }[] }[]
}

interface DecisionModelApi {
  availability(schema: DecisionSchema): Promise<string>
  create(schema: DecisionSchema & { monitor?: (m: EventTarget) => void }): Promise<DecisionSession>
}

/** A move needs this confidence (Miky, 24 Nov 2026; the probe's Edge run was right on 10 of 11 at it). */
export const GUESS_BAR = 0.6

/** Where the model can go when the sentence wants none of the rows. Their labels start with `x-`, which no row id does. */
const HIDDEN = [
  { label: 'x-find', description: 'Find something by its name: a file, topic, project or person' },
  { label: 'x-ask', description: 'Ask a question about the work, or ask for a summary' },
  { label: 'x-change', description: 'Change something that already exists: assign it, change its status, rename it' },
  { label: 'x-write', description: 'Write a document, a page, a spec or an update' },
  { label: 'x-other', description: 'Something else: create a topic, message a person' },
]

/**
 * Sentences that must move nothing. A model that puts a row first for any of
 * them is not used: Chrome 160 put Create issue first for both at 0.97–1.00 on
 * 24 Nov; Edge Dev 160 moved neither.
 */
export const CHECKS = ['assign this issue to me', 'which issues are still open in this project']

/** How long `availability()` may take before the browser counts as not answering (Edge has hung on it). */
const AVAILABILITY_TIMEOUT_MS = 5000

const api = (): DecisionModelApi | undefined => (globalThis as { DecisionModel?: DecisionModelApi }).DecisionModel

export function schemaFor(options: readonly GuessOption[]): DecisionSchema {
  return {
    context: 'A person typed this into the search box of a work app that has conversations, projects, issues and documents.',
    questions: [
      {
        id: 'action',
        type: 'choice',
        prompt: 'Which action fits what the person typed?',
        options: [...options.map((o) => ({ label: o.id, description: o.wording })), ...HIDDEN],
      },
    ],
  }
}

/** The row the answer moves first, or null: a hidden option, an answer below the bar, or no answer. */
const moved = (answer: Record<string, Decision | undefined> | undefined, options: readonly GuessOption[]): string | null => {
  const decision = answer?.action
  if (!decision || decision.confidence < GUESS_BAR) return null
  return options.some((o) => o.id === decision.label) ? decision.label : null
}

const withTimeout = <T>(promise: Promise<T>, ms: number): Promise<T | undefined> =>
  Promise.race([promise, new Promise<undefined>((resolve) => setTimeout(() => resolve(undefined), ms))])

/** What the browser says about the guess's model for these options: 'none' where there is no API or no answer. */
export async function guessAvailability(options: readonly GuessOption[]): Promise<string> {
  const model = api()
  if (!model) return 'none'
  try {
    return (await withTimeout(model.availability(schemaFor(options)), AVAILABILITY_TIMEOUT_MS)) ?? 'none'
  } catch {
    return 'none'
  }
}

/** A guesser for one set of options: it answers which row to move first, or null. */
export type Guesser = (sentence: string) => Promise<string | null>

/** One per set of options and tab: the session and its check run once. */
const guessers = new Map<string, Promise<Guesser | null>>()

/**
 * The guesser for these options, or null where the guess is off: no API, a
 * model not yet downloaded, an error, fewer than two rows to order, or a model
 * that fails `CHECKS`. Never starts a download.
 */
export function guesserFor(options: readonly GuessOption[]): Promise<Guesser | null> {
  if (options.length < 2) return Promise.resolve(null)
  const key = JSON.stringify(options)
  let guesser = guessers.get(key)
  if (!guesser) {
    guesser = makeGuesser(options)
    guessers.set(key, guesser)
  }
  return guesser
}

async function makeGuesser(options: readonly GuessOption[]): Promise<Guesser | null> {
  const model = api()
  if (!model) return null
  if ((await guessAvailability(options)) !== 'available') {
    // Not now — and not cached, so the next open asks again (after the Download row, say).
    guessers.delete(JSON.stringify(options))
    return null
  }
  try {
    const session = await model.create(schemaFor(options))
    for (const sentence of CHECKS) {
      if (moved(await session.decide(sentence), options) !== null) {
        session.destroy?.()
        return null
      }
    }
    return async (sentence) => {
      try {
        return moved(await session.decide(sentence), options)
      } catch {
        return null
      }
    }
  } catch {
    return null
  }
}

/**
 * The Download row's half for the guess: fetch its model where the browser
 * says it can be downloaded. Called only from that row's click, which is the
 * gesture `create()` needs.
 */
export async function downloadGuessModel(options: readonly GuessOption[]): Promise<boolean> {
  const model = api()
  if (!model) return false
  try {
    const session = await model.create(schemaFor(options))
    session.destroy?.()
    guessers.delete(JSON.stringify(options))
    return true
  } catch {
    return false
  }
}

/** For tests: forget every session made in this tab. */
export function forgetGuessers(): void {
  guessers.clear()
}

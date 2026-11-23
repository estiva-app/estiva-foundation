/**
 * Prefilling a launcher form from the conversation (PEE-5).
 *
 * **The insight the whole feature rests on:** a manifest action's `input` is
 * already a JSON Schema, and the Prompt API takes a JSON Schema as
 * `responseConstraint`. So the same declaration that draws the form constrains
 * the model — no mapping layer, no per-app prompt engineering, and an HR tool
 * declaring `add-candidate` gets prefill on the day it publishes its manifest.
 *
 * **The second half of that is conditional, and PEE-5 assumed it was not.**
 * Measured in Chrome on 2026-09-02: a build with speculative decoding (MTP)
 * enabled *refuses* `responseConstraint` outright, while simultaneously
 * requiring explicit sampling options for the same reason. So the declaration
 * cannot always be the constraint. What survives is the more important half —
 * the fields asked for are still generated from the declaration, as words
 * rather than as a schema (`promptApi`'s `jsonHint`), so an app nobody here
 * wrote still gets prefill the day it publishes a manifest. The elegance was
 * conditional; the interoperability was not.
 *
 * The schema here is rebuilt from the **fields the form actually drew**
 * (`FormField[]`) rather than from the manifest's raw `input`. The runtime does
 * not carry the raw schema through, and rebuilding turns out to be the better
 * end anyway: it guarantees the model is constrained to exactly what the person
 * can see and edit. A constraint listing a property the consumer chose not to
 * draw would put a value in a form with nowhere to show it.
 */
import type { FormField, VocabOption } from './launcherActions.js'

/** The synthetic parent field is Peek's, not the app's — never a model's to fill. */
const SYNTHETIC = new Set(['__parent'])

/**
 * A JSON Schema for one action's form.
 *
 * Only the fields a model could sensibly write: an `enum` is constrained to its
 * declared vocabulary, a free-text field to a string. Two are excluded on
 * purpose:
 *
 * - **The parent.** Where a new object hangs is a decision with consequences a
 *   model cannot see, and PEE-1's rule is that the destination is never picked
 *   silently. Guessing it would be exactly that, one layer further from the
 *   person.
 * - **A person picker.** A pubkey is an identifier, not prose. A model asked
 *   for one produces a plausible 64-hex string that belongs to nobody, and the
 *   relay would take it.
 */
export function formSchema(
  fields: readonly FormField[],
  /** The vocabularies the form itself draws from, keyed as `ActionFormPanel`
   *  looks them up. An `enum` has no values without them. */
  vocabularies: Record<string, VocabOption[]> = {},
): { schema: object; keys: string[] } | null {
  const properties: Record<string, object> = {}

  for (const field of fields) {
    if (SYNTHETIC.has(field.key) || field.control === 'parent') continue
    if (field.control === 'pubkey' || field.control === 'people') continue
    if (field.control === 'enum') {
      const values = (vocabularies[field.key] ?? vocabularies[field.vocabulary ?? ''] ?? []).map((o) => o.value)
      // A vocabulary the consumer could not resolve is not a constraint.
      if (!values.length) continue
      properties[field.key] = { type: 'string', enum: values }
    } else {
      properties[field.key] = { type: 'string' }
    }
  }

  const keys = Object.keys(properties)
  if (!keys.length) return null
  return {
    schema: {
      type: 'object',
      properties,
      // Every drawn field, so the model answers about all of them rather than
      // picking the one it finds easiest.
      required: keys,
      additionalProperties: false,
    },
    keys,
  }
}

/**
 * How much of the thread to send. **Measured, not guessed (INT-1).**
 *
 * PEE-5 left this open — *"the choice is worth testing rather than deciding on
 * paper"* — and 4000 was a stated default nobody had tested. Chrome, Gemini
 * Nano, 2026-09-02, via `__promptContext.sweep()`, asking for a one-word answer
 * so the number is the cost of the *input* rather than of a generation:
 *
 * | characters | time to answer |
 * | --- | --- |
 * | 4 000 | 1.8 s |
 * | 8 000 | 2.3 s |
 * | 16 000 | 4.1 s |
 * | 32 000 | 9.1 s |
 * | 64 000 | refused — *"The input is too large."* |
 *
 * **The cost is super-linear**, which is what attention does: the marginal cost
 * per character roughly triples between 4k and 32k. So the ceiling is not the
 * interesting bound — 32k answers, and takes nine seconds doing it.
 *
 * **8000 is chosen for where the curve is still cheap**, not for how much fits.
 * It doubles what a capture sees for half a second, covers roughly 34 messages
 * at this workspace's ~234 characters each, and leaves the whole super-linear
 * region unspent. Two reasons not to take more:
 *
 * - The sweep asked for one word. A real feature generates a paragraph, and
 *   that time lands **on top** of every figure above.
 * - Prefill is unsolicited. It races somebody already typing into the form, so
 *   it is the latency-sensitive caller — INT-3, where a person has asked and
 *   knows they are waiting, can afford a larger budget of its own.
 *
 * The measured evidence that 4000 was too small: a real 9-message thread of
 * 5795 characters was cut to 2465 by this bound — 57% of the conversation
 * discarded — and the untruncated version answered *faster* than the truncated
 * one, both being inside the noise floor.
 */
export const THREAD_CONTEXT_CHARS = 8000

/**
 * The thread, trimmed from the *oldest* end so the newest survives.
 *
 * A message that will not fit is **skipped rather than ending the walk**, and
 * the reason is a case a test caught: the newest message being one pasted
 * stack trace dropped the entire thread and prefill got nothing. The useful
 * context in that thread is the discussion around the paste, which is older
 * than it. Skipping keeps that; stopping threw it away.
 *
 * If nothing fits at all — a single message longer than the whole budget — the
 * newest is truncated instead of returning empty. Its opening is context; its
 * absence is none.
 */
export function threadContext(messages: readonly string[], limit = THREAD_CONTEXT_CHARS): string {
  const flat = messages.map((m) => m.replace(/\s+/g, ' ').trim()).filter(Boolean)
  const kept: string[] = []
  let total = 0
  for (let i = flat.length - 1; i >= 0; i--) {
    const message = flat[i]
    if (total + message.length > limit) continue
    kept.unshift(message)
    total += message.length
  }
  if (!kept.length && flat.length) return flat[flat.length - 1].slice(0, limit)
  return kept.join('\n')
}

/**
 * The instruction, with the conversation as its material.
 *
 * The action's own label is the task description — "Add issue" — because it is
 * what the owning app calls the thing, and inventing a better sentence here
 * would be Peek deciding what another app's action means.
 */
export function prefillInstruction(actionLabel: string, conversation: string | null, sentence?: string): string {
  // What the person wrote in the launcher before picking the action: it says what they want made, so it comes first.
  const asked = sentence?.trim()
  if (!asked) {
    return [
      `A team is having this conversation:`,
      '',
      conversation ?? '',
      '',
      `Fill in the fields for "${actionLabel}" from that conversation.`,
      `Use only what the conversation says. Where it does not say, leave the field empty.`,
    ].join('\n')
  }
  return [
    `Someone wrote this request:`,
    '',
    asked,
    '',
    ...(conversation ? [`They wrote it while their team was having this conversation:`, '', conversation, ''] : []),
    `Fill in the fields for "${actionLabel}" from the request${conversation ? ', and from the conversation where the request does not say' : ''}.`,
    `Use only what ${conversation ? 'they say' : 'the request says'}. Where nothing says, leave the field empty.`,
  ].join('\n')
}

/**
 * The values worth putting in the form.
 *
 * Anything the model returned that is not a drawn field is dropped, and so is
 * anything blank — a key present with an empty string is the model saying it
 * had nothing, and writing that into the field would clear a default the
 * action declared.
 */
export function usablePrefill(
  answer: Record<string, unknown> | null,
  keys: readonly string[],
): Record<string, string> {
  if (!answer) return {}
  const out: Record<string, string> = {}
  for (const key of keys) {
    const value = answer[key]
    if (typeof value !== 'string') continue
    const trimmed = value.trim()
    if (trimmed) out[key] = trimmed
  }
  return out
}

/**
 * The instruction for a drafted reply (INT-4).
 *
 * The thread is the material and the person's request is the brief. Both are
 * needed: "make it shorter" means nothing without the conversation, and the
 * conversation alone does not say what they want written.
 *
 * **It asks for the message only.** A small model will otherwise return "Sure!
 * Here is a draft:" and a closing offer to revise, and every word of that would
 * land in somebody's composer for them to delete. The same reason
 * `prefillInstruction` says to leave a field empty rather than invent one.
 */
export function draftInstruction(conversation: string, request: string): string {
  return [
    'A team is having this conversation:',
    '',
    conversation,
    '',
    `Write a reply for me to send. What I want: ${request}`,
    'Reply with the message text only — no preamble, no sign-off, no quotation marks, and nothing about being an assistant.',
  ].join('\n')
}

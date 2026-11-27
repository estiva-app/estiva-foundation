import type { LauncherPerson as Person } from './host.js'
import type { FormField, LauncherAction } from './launcherActions.js'

/**
 * What has been typed into a launcher form, and the rules for reading it —
 * kept apart from `ActionFormFields` so the launcher can hold the draft (it
 * survives going back and coming in again, R1 A) and the component file
 * exports only components.
 */

/**
 * What a `prose` field's value is written in (C12): `blocks` once it was edited
 * in the field, which hands back a block document; `marker` for marker text — a
 * default, or a suggestion from the conversation (PEE-5). Carried beside the
 * value, never read off it (§13.4).
 */
export type ProseFormat = 'marker' | 'blocks'

/** What has been typed into one form, kept while the launcher is open. */
export interface FormDraft {
  values: Record<string, string>
  /** Each `prose` field's format, by field key; absent is `marker`. */
  formats?: Record<string, ProseFormat>
  /** The person pickers' choices, by field key. */
  people: Record<string, Person[]>
  /**
   * Which fields the person has edited. The answer to PEE-6's typing race: a
   * suggestion from the conversation lands in every box nobody has touched,
   * and never in one somebody has.
   */
  touched: string[]
  /** The answer `withAnswer` put in, so a later answer replaces it while the person has not changed it (KIN-9). */
  answered?: string
}

/** A new draft: each field's default, or the value it was opened with. */
export function seedDraft(action: LauncherAction, initialValues?: Record<string, string>): FormDraft {
  const values: Record<string, string> = {}
  for (const field of action.fields) {
    const initial = initialValues?.[field.key] ?? field.defaultValue
    if (initial !== undefined) values[field.key] = initial
  }
  return { values, people: {}, touched: [] }
}

export const valueOf = (field: FormField, draft: FormDraft): string => {
  // Chips in both cases: `pubkey` wants ONE person (capped below, flattened
  // to `person.id`), `people` keeps the whole list (ids comma-joined).
  if (field.control === 'pubkey') return draft.people[field.key]?.[0]?.id ?? ''
  if (field.control === 'people') return (draft.people[field.key] ?? []).map((p) => p.id).join(',')
  return draft.values[field.key] ?? ''
}

/** What a submission sends: every field with something in it. */
export function draftValues(action: LauncherAction, draft: FormDraft): Record<string, string> {
  const out: Record<string, string> = {}
  for (const field of action.fields) {
    const value = valueOf(field, draft)
    if (value.trim() !== '') out[field.key] = value
  }
  return out
}

export const article = (word: string) => (/^[aeiou]/i.test(word) ? `an ${word}` : `a ${word}`)

/** The required fields still empty, each with the sentence that says what it needs. */
export function missingFields(action: LauncherAction, draft: FormDraft): Record<string, string> {
  const out: Record<string, string> = {}
  for (const field of action.fields) {
    if (!field.required || valueOf(field, draft).trim() !== '') continue
    const noun = field.label.toLowerCase()
    out[field.key] =
      field.control === 'string' || field.control === 'text' || field.control === 'prose'
        ? `Give it ${article(noun)}.`
        : field.control === 'parent'
          ? `Choose ${article(field.parentNoun ?? noun)}.`
          : field.control === 'people'
            ? 'Choose at least one person.'
            : `Choose ${article(noun)}.`
  }
  return out
}

/**
 * A suggestion from the conversation, applied to the fields nobody has
 * touched. It is not an edit: applying it does not mark a field touched, or a
 * second suggestion could never correct the first — the person overtyping it
 * is what makes it theirs.
 */
/**
 * An answer, as a new file's first text (KIN-9): the answer without its numbered citations, which point at messages
 * of the conversation it was asked in and mean nothing on a page of their own.
 */
export function answerAsText(answer: string): string {
  return answer
    .replace(/[ \t]*\[\d+\](?:\s*\[\d+\])*/g, '')
    .replace(/[ \t]+$/gm, '')
    .trim()
}

/**
 * The form of an action picked under an answer, with the answer as its text (KIN-9; Miky, at its kickoff, 27
 * November: "the answer you just read becomes the document's first text").
 *
 * Only into a declared `prose` field — a text the action's own app declares as a whole document (`format` in its
 * manifest) — and only one the person has not typed in: a later answer replaces an earlier one they left as it was.
 * It counts as touched, so the conversation's suggestion (PEE-5) never replaces the answer they chose it for. A form
 * with no such field is left as it is. Which actions take an answer is the registry's (`startsWithAnswer`).
 */
export function withAnswer(draft: FormDraft, action: LauncherAction, answer: string): FormDraft {
  const text = answerAsText(answer)
  const field = action.fields.find((f) => f.control === 'prose')
  if (!text || !field) return draft
  const typed = draft.touched.includes(field.key) && draft.values[field.key] !== draft.answered
  if (typed) return draft
  const formats = { ...draft.formats }
  // Marker text, as every suggestion is.
  delete formats[field.key]
  const touched = draft.touched.includes(field.key) ? draft.touched : [...draft.touched, field.key]
  return { ...draft, values: { ...draft.values, [field.key]: text }, formats, touched, answered: text }
}

export function applyPrefill(draft: FormDraft, prefill: Record<string, string>): FormDraft {
  let changed = false
  const values = { ...draft.values }
  // A suggestion is marker text.
  const formats = { ...draft.formats }
  for (const [key, value] of Object.entries(prefill)) {
    if (draft.touched.includes(key) || values[key] === value) continue
    values[key] = value
    delete formats[key]
    changed = true
  }
  return changed ? { ...draft, values, formats } : draft
}


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


import { documentForEditing, publishableFromEditor, toEditorDocument, type ContentFormat, type EditorDocument } from '@estiva-app/protocol'
import { Field, Select, Textarea, TextInput } from '@estiva-app/ui'
import { DocumentField, type DocumentCodec } from '@estiva-app/ui/editor'
import type { LauncherFormHost } from './host.js'
import type { FormField, LauncherAction, LauncherApp, VocabOption } from './launcherActions.js'
import { article, valueOf, type FormDraft, type ProseFormat } from './formDraft.js'

/**
 * The fields of a form drawn from an action declaration — the launcher's form
 * level, inside the package's `CommandPaletteForm`.
 *
 * Nothing in this file knows what a Ship issue is. It receives a
 * manifest-shaped `LauncherAction` (`lib/launcherActions.ts`) and renders one
 * control per declared field: `string` a text input, `text` a textarea,
 * `prose` the kit's `DocumentField` (a block document, MAN-1, C12), `enum` the kit's Select fed from the owning app's declared vocabulary,
 * `pubkey` the person picker, `parent` a Select over the objects the new one
 * would hang under. The owner declares which fields matter; the launcher renders them
 * in its own design language — the same split a card makes for reading,
 * applied to writing.
 *
 * **Fields only, since UIG-29.** The frame — the button, Ctrl+Enter, the lock
 * while creating, where focus goes — is the palette's (Katerina, 16 September,
 * P2). And **what was typed is the launcher's**, not this component's, so it
 * survives going back and coming in again (R1 A): the draft is passed in and
 * every edit is handed back.
 *
 * **A missing field says what it needs** (the key list: "Ctrl+Enter creates; if
 * something is missing, each field says what it needs and focus goes to the
 * first"). It replaces the 31 August rule that kept the button disabled until
 * every required field was filled, which gave no reason (R14).
 */

/** A description's text as the kit's document field reads and writes it: marker text from a suggestion, a block document once edited. */
const PROSE_CODEC: DocumentCodec = {
  read: (value, format) => toEditorDocument(documentForEditing(value, format as ContentFormat), { links: true }),
  write: (doc) => publishableFromEditor(doc as EditorDocument),
}

export interface ActionFormFieldsProps {
  /**
   * What the fields need of the app (KIN-4): `[` and `@` in a description as
   * the app's comment box offers them, how a reference draws, and the person
   * picker over the app's own people.
   */
  form: LauncherFormHost
  /**
   * The scoped app, whose declared vocabularies feed `enum` fields.
   *
   * Optional since PEE-3: a field-setting action is reached from the first
   * level with an object as its target rather than an app as its scope, and
   * its vocabulary comes off the resolved action instead — see `vocabularies`.
   */
  app?: LauncherApp
  /** Live vocabularies, keyed by field key. Overrides the app's declared ones,
   *  the way `parentOptions` does for a `parent` control. */
  vocabularies?: Record<string, VocabOption[]>
  action: LauncherAction
  /** Live options for `parent` fields, keyed by field key. Overrides the
   *  registry's mock list — the launcher passes real topics for Peek. */
  parentOptions?: Record<string, VocabOption[]>
  draft: FormDraft
  onDraft: (next: FormDraft) => void
  /** What each missing field needs, once a submission has been tried. */
  missing?: Record<string, string>
}

export function ActionFormFields({ form, app, vocabularies, action, parentOptions, draft, onDraft, missing = {} }: ActionFormFieldsProps) {
  const set = (key: string, value: string, format?: ProseFormat) =>
    onDraft({
      ...draft,
      values: { ...draft.values, [key]: value },
      ...(format ? { formats: { ...draft.formats, [key]: format } } : {}),
      touched: draft.touched.includes(key) ? draft.touched : [...draft.touched, key],
    })

  const optionsFor = (field: FormField): VocabOption[] => {
    if (field.control === 'enum') return vocabularies?.[field.key] ?? app?.vocabularies[field.vocabulary ?? ''] ?? []
    if (field.control === 'parent') {
      const live = parentOptions?.[field.key]
      return live && live.length > 0 ? live : (field.parentOptions ?? [])
    }
    return []
  }

  const control = (field: FormField) => {
    switch (field.control) {
      case 'string':
        return (
          <TextInput
            value={draft.values[field.key] ?? ''}
            onChange={(e) => set(field.key, e.target.value)}
            placeholder={field.placeholder}
            className="w-full"
          />
        )
      case 'text':
        return (
          <Textarea
            value={draft.values[field.key] ?? ''}
            onChange={(e) => set(field.key, e.target.value)}
            placeholder={field.placeholder}
            rows={3}
            className="w-full"
          />
        )
      case 'prose':
        return (
          <DocumentField
            value={draft.values[field.key] ?? ''}
            format={draft.formats?.[field.key] ?? 'marker'}
            codec={PROSE_CODEC}
            onChange={(value, contentFormat) => set(field.key, value, contentFormat ? 'blocks' : 'marker')}
            label={field.label}
            placeholder={field.placeholder}
            references={form.references}
            mentions={form.mentions}
            referenceView={form.referenceView}
          />
        )
      case 'enum':
      case 'parent':
        return (
          <Select
            value={valueOf(field, draft)}
            onChange={(value) => set(field.key, value)}
            options={optionsFor(field)}
            placeholder={
              field.control !== 'parent'
                ? 'Select…'
                : optionsFor(field).length === 0
                  ? // Say why the list is empty rather than open on nothing (INT-12).
                    `No ${field.parentNoun ?? 'parent'} you can add to yet`
                  : `Choose ${article(field.parentNoun ?? 'parent')}…`
            }
            ariaLabel={field.label}
          />
        )
      case 'pubkey':
      case 'people':
        return form.personField({
          value: draft.people[field.key] ?? [],
          // `pubkey` holds one person — a later pick replaces the current
          // one rather than growing a list the field cannot express (the
          // kit's `single`, C15). `people` (invitees) keeps them all, as
          // the app's dialog does.
          single: field.control === 'pubkey',
          onChange: (next) =>
            onDraft({
              ...draft,
              people: { ...draft.people, [field.key]: next },
              touched: draft.touched.includes(field.key) ? draft.touched : [...draft.touched, field.key],
            }),
          placeholder: field.placeholder,
        })
    }
  }

  return (
    <>
      {action.fields.map((field) => (
        // @estiva-escape(no-field-outside-a-form): these are the launcher's fields; CommandLauncher holds them in the package's CommandPaletteForm (UIG-29 P2)
        <Field key={field.key} label={field.label} required={field.required} error={missing[field.key]}>
          {control(field)}
        </Field>
      ))}
    </>
  )
}

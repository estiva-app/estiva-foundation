import { BLOCK_DOCUMENT_FORMAT, FOLDER_ACTIONS_ADDRESS, KIND_CHANNEL_METADATA, type ResolvedAction } from '@estiva-app/interop'
import { markerTextToBlockDocument, serializeBlockDocument } from '@estiva-app/protocol'
import type { FormField, LauncherAction, VocabOption } from './launcherActions.js'

/**
 * A live manifest's action, in the shape the launcher's form already draws.
 *
 * `launcherActions.ts` set the bar for this file: *"the Intelligence runtime
 * will hand the launcher real manifests, and swapping this constant for a live
 * read must not reshape any UI."* So this converts and does nothing else —
 * `ActionFormPanel` is untouched, and the registry stays exactly where it is
 * for the actions no app declares yet.
 *
 * The conversion is small because the registry was written in the manifest's
 * own vocabulary. The parts that are not one-to-one are the interesting ones:
 *
 * - **The parent is not a property.** It comes from `emits.toAddressOf: 'self'`
 *   — surfaced by the runtime as `createsUnder` — and it is the half of "needs
 *   a form *and a parent*" that made these unrenderable. A form drawing only
 *   the declared properties would publish an orphan, so the field is synthesised
 *   here and marked required.
 * - **A label is the consumer's business.** The manifest names a property
 *   (`title`); what a person reads above the box is Peek's to choose, the same
 *   split a card makes for reading. Title-casing the property is
 *   a default, not a declaration.
 */

/** The synthetic field key holding the parent address. Never a manifest property. */
export const PARENT_FIELD = '__parent'

/** The field Create topic adds for its members (INT-12). Peek writes it itself; never a manifest property. */
export const MEMBERS_FIELD = '__members'

/** One of a Folder's built-in actions — declared by SPEC §3.2, not by any app (INT-12, interop 0.54.0). */
export function isFolderBuiltIn(action: Pick<ResolvedAction, 'declaredBy'>): boolean {
  return action.declaredBy?.address === FOLDER_ACTIONS_ADDRESS
}

/**
 * A Folder's Start a conversation: a `kind:9` root in it (SPEC §3.2). Peek's own
 * manifest declared it until interop 0.58 made it the Folder's built-in.
 *
 * why: https://github.com/estiva-app/estiva-docs/blob/main/decisions/folders-belong-to-the-protocol.md
 */
export function isStartConversation(action: Pick<ResolvedAction, 'id' | 'declaredBy'>): boolean {
  return isFolderBuiltIn(action) && action.id === 'start-a-conversation'
}

/**
 * The Folder's built-in new file, as Peek offers it: **Create topic** (INT-12).
 *
 * The runtime calls it "New file", since it is every app's; Peek says topic
 * (its manifest's `fileNoun`). And it adds who the topic is for — Miky's call
 * at kickoff, 2026-10-12: the people added become members of the file (SPEC
 * §11.8), so they are told when it has something unread. That is a `kind:1851`
 * per person after the file exists, which no declaration says, so the field is
 * Peek's own and `submitAction` keeps it out of what the runtime is given.
 */
export function asCreateTopic(resolved: Pick<ResolvedAction, 'id' | 'declaredBy'>, action: LauncherAction): LauncherAction {
  if (!isFolderBuiltIn(resolved) || resolved.id !== 'create-file') return action
  return {
    ...action,
    label: 'Create topic',
    submitLabel: 'Create topic',
    fields: [
      ...action.fields.map((field) => (field.key === 'title' ? { ...field, placeholder: "What's this topic about?" } : field)),
      { key: MEMBERS_FIELD, label: 'Members', control: 'people', placeholder: 'Add people...', declaredToday: true },
    ],
    membersField: MEMBERS_FIELD,
  }
}

/**
 * A creation as the launcher offers it: the Folder's new file as Create topic,
 * and Start a conversation knowing which of its parents are DMs, where Peek
 * sends the message itself.
 */
export function asLauncherCreation(creation: Pick<AppCreation, 'action' | 'dms'>, action: LauncherAction): LauncherAction {
  const offered = asCreateTopic(creation.action, action)
  return creation.dms?.length ? { ...offered, dmParents: creation.dms } : offered
}

/** `title` → `Title`, `dueDate` → `Due date`. A default, replaceable by anything better. */
function labelFor(name: string): string {
  const spaced = name.replace(/([a-z0-9])([A-Z])/g, '$1 $2').replace(/[_-]+/g, ' ')
  return spaced.charAt(0).toUpperCase() + spaced.slice(1).toLowerCase()
}

/**
 * A form control for a declared property.
 *
 * `enum` when the manifest gave the property a vocabulary — the runtime has
 * already looked it up — `pubkey` for a person, and otherwise a single-line
 * string.
 *
 * **`text` is now declared rather than inferred** (INT-9). This comment used to
 * say prose was "deliberately not inferred: nothing in the manifest
 * distinguishes a long string from a short one, and guessing would give an app
 * a textarea it never asked for." Both halves still hold — nothing is being
 * guessed here. What changed is that something in the manifest *does* now
 * distinguish them: a property may declare `target: 'content'`, meaning its
 * value is the event's body rather than a tag (interop 0.13.0). An app whose
 * property is a whole message body has asked for a textarea in the only
 * vocabulary that can ask.
 *
 * Still a consumer's choice, and interop says so: *"A consumer may use it to
 * draw prose instead of a single line; it does not have to, and one that
 * ignores it still publishes the right event."* Peek uses it, because a
 * one-line box for a conversation opener is the wrong shape for the thing.
 *
 * **`prose` is the same move one step further** (MAN-1, RIC-13). A content
 * field may also declare `format: 'estiva-blocks-1'` — the owner accepts a
 * block document there — and interop surfaces it as `field.format` only when
 * it is a format this version writes. So the editor is drawn because Ship's
 * published manifest asked for it, never because the field is called
 * `description`.
 */
function controlFor(field: NonNullable<ResolvedAction['fields']>[number]): FormField['control'] {
  if (field.options?.length) return 'enum'
  if (field.type === 'pubkey') return 'pubkey'
  if (field.target === 'content' && field.format === BLOCK_DOCUMENT_FORMAT) return 'prose'
  if (field.target === 'content') return 'text'
  return 'string'
}

export interface LiveActionOptions {
  /** What the parent picker calls the thing being picked — "project", "topic". */
  parentNoun?: string
  /** Overrides the title-cased property name. */
  labels?: Record<string, string>
  submitLabel?: string
}

/**
 * Returns null for anything that is not an object-creating action, which is the
 * honest answer rather than a half-drawn form: a change or a comment is one
 * control and the launcher is not where it belongs.
 */
export function launcherActionFrom(
  action: ResolvedAction,
  options: LiveActionOptions = {},
): LauncherAction | null {
  if (action.control !== 'form' || !action.fields) return null

  const fields: FormField[] = action.fields.map((field) => ({
    key: field.name,
    label: options.labels?.[field.name] ?? labelFor(field.name),
    control: controlFor(field),
    required: field.required,
    // A vocabulary the owning app declared, rendered in Peek's Select. The
    // runtime resolved it; nothing here reads the manifest again.
    ...(field.options?.length
      ? {
          vocabulary: field.name,
          defaultValue: field.options[0]?.value,
        }
      : {}),
    declaredToday: true,
  }))

  /*
    Every creation is invoked on an object, so every one needs it picked —
    `createsUnder` says only whether the new object also names it as a parent.
    Ship's `add-project` has none: it is made *in* a Folder (`placement`), and
    the Folder is still what the action is performed on (MAN-8). Without the
    field the form could never be submitted — `submitAction` refuses a
    creation with nowhere to go.
  */
  fields.push({
    key: PARENT_FIELD,
    label: options.parentNoun ? labelFor(options.parentNoun) : 'Parent',
    control: 'parent',
    required: true,
    parentNoun: options.parentNoun ?? 'object',
    declaredToday: true,
  })

  return {
    id: action.id,
    label: action.label,
    fields,
    submitLabel: options.submitLabel ?? action.label,
    declaredToday: true,
    ...(action.declaredBy ? { declaredBy: action.declaredBy.address } : {}),
  }
}

/** One parent kind's read — `creatableUnderAsViewer`'s answer. */
export interface CreatableKindRead {
  actions: ResolvedAction[]
  parents: { address: string; title: string }[]
  /** The address of the manifest that owns the kind — whose actions are the ones without `declaredBy`. */
  manifest?: string
  /** What the owner's projection calls one of these, when it says. */
  noun?: string
  /** An action's own choices, when they are not `parents` — any creation on a Folder. */
  parentsFor?: Record<string, { address: string; title: string }[]>
  /**
   * Start a conversation's parents, which are the person's DMs only (REC-1,
   * 2026-10-17), by address: a conversation there is Peek's own message, not
   * the Folder's action, since a DM is not a Folder (SPEC §3.2). The launcher
   * refuses to send one anywhere else.
   */
  dms?: string[]
}

/** A creation an app offers, with where it can go and what that is called. */
export interface AppCreation {
  action: ResolvedAction
  parents: VocabOption[]
  parentNoun: string
  /** Which of `parents` are DMs — see {@link CreatableKindRead.dms}. */
  dms?: string[]
}

/**
 * Every creation an app offers, across every parent kind the launcher read —
 * MAN-8.
 *
 * An app's section used to be the actions on its own `parentKind`. Since
 * interop 0.40.0 an object also carries the creations *other* apps declare on
 * its kind, so the reads split the other way: Ship's `add-project` arrives on
 * a Folder (Peek's kind), and belongs in Ship's section with Folders to pick
 * from; Peek's section, reading the same Folder, must not show it.
 *
 * So an action belongs to the app whose manifest declared it — `declaredBy`,
 * or the kind's owner when absent — and an app's manifest is the owner of its
 * own `parentKind`, the one read that names it. Null when that read found
 * nothing, which is the section's "none".
 */
export function creationsFor(
  app: { parentKind?: number; parentNoun?: string; offersFolderBuiltIns?: boolean; declaredBy?: string },
  reads: ReadonlyMap<number, CreatableKindRead | null>,
): AppCreation[] | null {
  if (typeof app.parentKind !== 'number') return app.declaredBy ? declaredBy(app.declaredBy, reads) : null
  const own = reads.get(app.parentKind)
  if (!own) return null
  const out: AppCreation[] = []
  const seen = new Set<string>()
  // Its own kind first, so its rows keep their order.
  const kinds = [app.parentKind, ...[...reads.keys()].filter((kind) => kind !== app.parentKind)]
  for (const kind of kinds) {
    const read = reads.get(kind)
    if (!read) continue
    for (const action of read.actions) {
      // A Folder's built-in (INT-12) is no app's, so it is offered by the app the registry says may sign it.
      const builtIn = isFolderBuiltIn(action)
      const mine = builtIn
        ? !!app.offersFolderBuiltIns
        : kind === app.parentKind
          ? !action.declaredBy || action.declaredBy.address === own.manifest
          : own.manifest !== undefined && action.declaredBy?.address === own.manifest
      if (!mine || seen.has(action.id)) continue
      seen.add(action.id)
      const conversation = isStartConversation(action)
      out.push({
        action,
        parents: (read.parentsFor?.[action.id] ?? read.parents).map((p) => ({ value: p.address, label: p.title })),
        // The app's own noun for its own kind (INT-9); for another's, what that
        // kind's projection says, and a Folder is a team whoever draws it (TEA-8).
        // Start a conversation keeps the noun it had while Peek declared it:
        // its picker holds DMs, which are no Folder.
        parentNoun:
          builtIn && !conversation
            ? 'team'
            : kind === app.parentKind
              ? (app.parentNoun ?? 'parent')
              : (read.noun ?? (kind === KIND_CHANNEL_METADATA ? 'team' : 'parent')),
        ...(conversation && read.dms?.length ? { dms: read.dms } : {}),
      })
    }
  }
  return out
}

/**
 * The kind an app's section reads to find its creations: its own `parentKind`, or a team's for an app known by the
 * manifest that declares its actions (KIN-9). Undefined for an app that is never read.
 */
export function readKindOf(app: { parentKind?: number; declaredBy?: string }): number | undefined {
  return typeof app.parentKind === 'number' ? app.parentKind : app.declaredBy ? KIND_CHANNEL_METADATA : undefined
}

/**
 * The creations one manifest declared, on whichever kind they were read (KIN-9): an action is this app's only when
 * that manifest, by its address, is the one that declared it. Never a team's built-in, and never one another key's
 * manifest declares under the same id. Null when it declared none.
 */
function declaredBy(manifest: string, reads: ReadonlyMap<number, CreatableKindRead | null>): AppCreation[] | null {
  const out: AppCreation[] = []
  const seen = new Set<string>()
  for (const [kind, read] of reads) {
    if (!read) continue
    for (const action of read.actions) {
      if (action.declaredBy?.address !== manifest || isFolderBuiltIn(action) || seen.has(action.id)) continue
      seen.add(action.id)
      out.push({
        action,
        parents: (read.parentsFor?.[action.id] ?? read.parents).map((p) => ({ value: p.address, label: p.title })),
        // A team is a team whoever draws it (TEA-8).
        parentNoun: kind === KIND_CHANNEL_METADATA ? 'team' : (read.noun ?? 'parent'),
      })
    }
  }
  return out.length > 0 ? out : null
}

/**
 * The vocabularies an `enum` field needs, keyed the way `ActionFormPanel` looks
 * them up — by the field's own key, since the runtime hands back options per
 * field rather than a named vocabulary the consumer has to resolve.
 */
export function vocabulariesFrom(action: ResolvedAction): Record<string, { value: string; label: string }[]> {
  const out: Record<string, { value: string; label: string }[]> = {}
  for (const field of action.fields ?? []) {
    if (field.options?.length) out[field.name] = field.options.map((o) => ({ value: o.value, label: o.label }))
  }
  return out
}

/**
 * Split a submitted form into the parent address and the properties.
 *
 * The parent travels as a field because a person picks it in the same form, and
 * it must not travel as a *property*: the runtime refuses any key the manifest
 * did not declare, which is exactly the check that keeps junk out of a shared
 * record. Dropping it here is what makes that refusal meaningful rather than
 * something the consumer has to work around.
 */
export function splitSubmission(values: Record<string, string>): {
  parent?: string
  properties: Record<string, string>
} {
  const { [PARENT_FIELD]: parent, ...properties } = values
  return { ...(parent ? { parent } : {}), properties }
}

/**
 * A submission's `prose` field as the block document its owner declared, and
 * the format to tell the runtime (MAN-1, RIC-13).
 *
 * What was written in the field is already that document (`formats` says
 * `blocks`: the kit's `DocumentField` hands one back, C12), and goes as it is.
 * Marker text — a prefilled description nobody edited (PEE-5) — is turned into
 * §13.3's document by `@estiva-app/protocol`'s bridge, the same function Ship
 * reads a legacy body with. Either way what lands on the event is
 * `content-format: estiva-blocks-1` and a document Ship renders as blocks.
 *
 * An empty prose field sends nothing, as an empty text field does — a
 * title-only capture carries no format and no body.
 */
export function proseSubmission(
  action: LauncherAction,
  properties: Record<string, string>,
  formats: Record<string, 'marker' | 'blocks'> = {},
): { properties: Record<string, string>; contentFormat?: typeof BLOCK_DOCUMENT_FORMAT } {
  const prose = action.fields.find((f) => f.control === 'prose' && properties[f.key]?.trim())
  if (!prose) return { properties }
  if (formats[prose.key] === 'blocks') return { properties, contentFormat: BLOCK_DOCUMENT_FORMAT }
  return {
    properties: { ...properties, [prose.key]: serializeBlockDocument(markerTextToBlockDocument(properties[prose.key]!)) },
    contentFormat: BLOCK_DOCUMENT_FORMAT,
  }
}

/**
 * A **field-setting** action bound to an object that already exists (PEE-3).
 *
 * > **Katerina, 2026-08-19** — *"it would also be useful to assign existing
 * > issue, not just create new one"*
 *
 * `launcherActionFrom` above returns null for these, and said why: *"a change
 * or a comment is one control and the launcher is not where it belongs."* That
 * was right while there was no way to choose a target — a change needs one, and
 * an action list with nothing to apply it to is a form that cannot succeed.
 * PEE-3 supplies the target: the objects the open conversation already refers
 * to. So the action and its target are resolved together and offered as one
 * row, and this converts that pair.
 *
 * One field, because a change **is** one control — the earlier comment's point
 * survives, it just no longer rules the launcher out. `ActionFormPanel` draws
 * it with no changes, which is the bar `launcherActions.ts` set.
 *
 * `current` becomes the control's default, so a status select opens on the
 * status the object actually has rather than on the vocabulary's first entry.
 * Returns null for `form` (that is the other function) and for `text`, whose
 * one control is a comment box and belongs in the thread rather than here.
 */
export function changeActionFrom(
  action: ResolvedAction,
  target: { address: string; label: string },
): LauncherAction | null {
  if (action.control !== 'select' && action.control !== 'pubkey') return null
  if (action.control === 'select' && !action.options?.length) return null
  // A Delete written as its `deleted` change (SPEC §6.5) is asked with a confirm on the file's own menu, never picked here.
  if (action.field === 'deleted') return null

  const key = action.field ?? 'value'
  const field: FormField = {
    key,
    label: labelFor(action.field ?? action.label),
    control: action.control === 'pubkey' ? 'pubkey' : 'enum',
    required: true,
    declaredToday: true,
    ...(action.options?.length
      ? {
          vocabulary: key,
          // The value it holds right now, not the vocabulary's first entry.
          defaultValue: action.current ?? action.options[0]?.value,
        }
      : {}),
  }

  return {
    id: action.id,
    label: action.label,
    fields: [field],
    submitLabel: action.label,
    declaredToday: true,
    target: target.address,
    targetLabel: target.label,
  }
}

/**
 * The vocabulary a converted change action needs, keyed the way
 * `ActionFormPanel` looks one up — by the field key, which for a change is the
 * manifest's own field name.
 */
export function changeVocabulariesFrom(action: ResolvedAction): Record<string, { value: string; label: string }[]> {
  if (!action.options?.length) return {}
  return { [action.field ?? 'value']: action.options.map((o) => ({ value: o.value, label: o.label })) }
}

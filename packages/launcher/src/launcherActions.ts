/**
 * The launcher's app and action registry — manifest-shaped, deliberately.
 *
 * Everything the Cmd+K launcher lists is declared here in the same vocabulary
 * an app's NIP-89 manifest uses (`interop/projection.ts` `ManifestAction`,
 * RFC 0.4 §13.4): an action is `{ id, label, appliesTo, emits, input }`, and a
 * form is drawn FROM that declaration rather than hand-built per app. That is
 * the point of the exercise — the Intelligence runtime will hand the launcher
 * real manifests, and swapping this constant for a live read must not reshape
 * any UI.
 *
 * Two kinds of honesty are kept apart:
 *
 * - `declaredToday: true` marks what the owning app's live manifest actually
 *   declares right now (Ship's `add-issue` declares exactly `{ title }`).
 * - Everything else is this design's PROPOSAL for what the manifest should
 *   grow. Peek's own manifest deliberately declares no actions yet
 *   (`src/nostr/manifest.ts` says why), so both Peek actions are proposals.
 *
 * Submitting a form publishes for real where the live manifest declares the
 * action (PEE-1) and leaves its reference in the composer (PEE-2) — see
 * `CommandLauncher`'s `submitAction`. Publishing a guess at another app's
 * object is what the honour system forbids.
 *
 * **The launcher no longer lists the actions below** (INT-9). It reads each
 * app's manifest and offers what that declares; what is here is the app, its
 * parent kind, its labels, and a proposal for each action the manifest should
 * grow. The proposals are kept here as the design's record of the intended field
 * shapes, and nothing draws them: the Launcher stories that did were removed with
 * UIG-29 (Katerina, 16 September — they were not representative of the launcher).
 *
 * The three that stayed inert were `add-project`, `say` and `create-topic`,
 * and Miky found all three the same way: open the form, fill it, submit,
 * nothing happens. They become real when PRO-18 lets an action create a
 * Folder — a Ship project is a Folder plus a record, and a Peek conversation
 * is scoped by one — at which point Ship and Peek declare them and these
 * literals go. `create-topic` went with INT-12: a Folder offers it itself.
 */

export interface VocabOption {
  value: string
  label: string
}

/**
 * How one field is drawn. The names mirror the manifest's `input` vocabulary:
 * `string`/`text` are `type: 'string'` (single line vs prose), `prose` is a
 * `text` whose owner declared `format: 'estiva-blocks-1'` (SPEC §7.3, MAN-1) —
 * drawn as the editor and sent as a block document — `enum` is
 * `enum: '<vocabulary>'`, `pubkey` is `type: 'pubkey'` (`people` is its plural — invitees), and `parent` is the
 * field implied by `emits.toAddressOf: 'self'` — the object this creation
 * hangs under, which is the half of "needs a form and a parent" that made
 * object-creating actions unrenderable before (RFC 0.4 §13.4).
 */
export type FormControl = 'string' | 'text' | 'prose' | 'enum' | 'pubkey' | 'people' | 'parent'

export interface FormField {
  key: string
  label: string
  control: FormControl
  required?: boolean
  placeholder?: string
  /** For `enum`: which of the app's vocabularies feeds the select. */
  vocabulary?: string
  /** For `enum`: the value preselected before anyone chooses. */
  defaultValue?: string
  /** For `parent`: the noun the picker offers ("project", "topic"). */
  parentNoun?: string
  /** For `parent`: the mock object list v1 offers. A live runtime replaces
   *  this with a relay query; `CommandLauncher` already overrides it for
   *  Peek topics, which the app can list without any new machinery. */
  parentOptions?: VocabOption[]
  /** Declared by the owning app's manifest today, vs proposed by this design. */
  declaredToday?: boolean
}

export interface LauncherAction {
  id: string
  label: string
  /** What the on-device guess reads for this action, never drawn (KIN-7). Without it the guess reads the label. */
  guessAs?: string
  /** Verbatim `ManifestAction` halves where the declaration exists today,
   *  so the runtime can key on them unchanged. */
  appliesTo?: string
  emits?: Record<string, unknown>
  fields: FormField[]
  submitLabel: string
  /** The whole action exists in the live manifest (vs proposed). */
  declaredToday?: boolean
  /**
   * The manifest that declared it, when that is not the parent's own — Ship's
   * `add-project` on a Folder (MAN-8). Passed to `applyAction` so the runtime
   * builds with the declaring manifest.
   */
  declaredBy?: string
  /**
   * The object this action changes, as an address (PEE-3).
   *
   * Set only for a **field-setting** action, where the target already exists
   * and was chosen when the row was — an object-creating action has no target,
   * it has a parent, and that travels as a form field the person fills in.
   * Its presence is what tells `submitAction` to send a scalar to an existing
   * object rather than a property bag to a parent.
   */
  target?: string
  /** What the target is called, for the row and the form's chip. */
  targetLabel?: string
  /**
   * A `people` field whose choices become members of the new file (SPEC §11.8)
   * once it exists — Create topic's (INT-12). Peek writes them itself, so the
   * field is never sent to the runtime as a property.
   */
  membersField?: string
  /**
   * The parents, by address, that are the person's DMs — Start a
   * conversation's (REC-1). A DM is not a Folder, so a conversation started in
   * one is sent as Peek's own message, the one the DM's composer sends, not
   * as the Folder's action.
   */
  dmParents?: string[]
}

export interface LauncherApp {
  /**
   * Any app, not one of two.
   *
   * Widened by INT-5, whose done-when is that this works for an app added
   * after it shipped — a union of the apps that existed when it was written is
   * a type-level assertion that no others will. The two rendering helpers that
   * still compare against `'peek'` fall back to the other mark, which is a gap
   * a third app would fill by bringing its own; it is a registry concern, not
   * a reason to keep the union.
   */
  id: string
  label: string
  description: string
  /** Input placeholder while this app is the active scope. */
  placeholder: string
  /** Same shape the manifest publishes: named option lists used by `enum`
   *  fields. Ship's are verbatim from `ship/src/kinds.ts`. */
  vocabularies: Record<string, VocabOption[]>
  actions: LauncherAction[]
  /**
   * The kind whose records a new object hangs under, if this app creates
   * anything — what `creatableUnder` is asked for.
   *
   * **The one app-specific fact discovery cannot avoid**, and it lives here
   * rather than in whatever consumes it: a projection is per kind, so finding
   * an app's manifest means querying one of its records, and something must
   * name the kind. Adding an app is then a registry entry, not a change to any
   * consumer — which is INT-5's whole test (RFC 0.4 §15: an app nobody here
   * wrote publishes a manifest, and this works for it the same day).
   *
   * Absent for an app that creates nothing readable this way, and such an app
   * is simply not probed.
   */
  parentKind?: number
  /**
   * What the parent picker calls the thing being picked — "project", "topic".
   *
   * The launcher passed a literal `'project'` for every app, which was true
   * while Ship was the only one probed and became wrong the moment Peek
   * declared an action (INT-9): a person starting a conversation was asked to
   * choose a *Project*. It belongs on the app rather than on the action because
   * it names the app's `parentKind`, which is also here.
   *
   * `launcherActionFrom` falls back to "Parent", which is honest and reads
   * badly; an app that declares a `parentKind` should name its noun.
   */
  parentNoun?: string
  /**
   * Whether this app offers a Folder's built-in actions (SPEC §3.2, INT-12) —
   * which no manifest declares, so the registry says who may: an app that can
   * sign what they write (`30840` and `1852` for a new file, §3.3; `kind:9`
   * for Start a conversation, a built-in since interop 0.58).
   */
  offersFolderBuiltIns?: boolean
  /**
   * Whether this app is the one the launcher runs in (INT-13). Its actions are
   * on the first level and it is not listed among Apps — Miky, 2026-10-12.
   */
  isHost?: boolean
}

/** Verbatim `ship/src/kinds.ts` `ISSUE_STATUSES` (values and labels). */
const SHIP_ISSUE_STATUSES: VocabOption[] = [
  { value: 'todo', label: 'Todo' },
  { value: 'in_progress', label: 'In Progress' },
  { value: 'done', label: 'Done' },
  { value: 'cancelled', label: 'Cancelled' },
]

/** Verbatim `ship/src/kinds.ts` `PROJECT_STATUSES`. */
const SHIP_PROJECT_STATUSES: VocabOption[] = [
  { value: 'planned', label: 'Planned' },
  { value: 'in_progress', label: 'In Progress' },
  { value: 'completed', label: 'Completed' },
  { value: 'cancelled', label: 'Cancelled' },
]

/**
 * Mock projects for the parent picker, in the demo dataset's register.
 * A live runtime lists kind:30850 records instead.
 */
const MOCK_SHIP_PROJECTS: VocabOption[] = [
  { value: 'dashboard-redesign', label: 'Dashboard redesign' },
  { value: 'mobile-onboarding', label: 'Mobile onboarding' },
  { value: 'files-and-sharing', label: 'Files & sharing' },
]

const SHIP: LauncherApp = {
  id: 'ship',
  label: 'Ship',
  description: 'Projects & issues',
  placeholder: "Try 'create issue' or 'create project'...",
  // Its projects. Nothing outside this literal knows that number.
  parentKind: 30850,
  parentNoun: 'project',
  vocabularies: {
    issueStatuses: SHIP_ISSUE_STATUSES,
    statuses: SHIP_PROJECT_STATUSES,
  },
  actions: [
    {
      // Ship's manifest declares this action today (`ship/src/manifest.ts`),
      // with an input of exactly `{ title }`. The launcher was built because
      // the consumer runtime skips it: an object-creating action needs a form.
      id: 'add-issue',
      label: 'Create issue',
      guessAs: 'Create a new issue, bug or ticket in a Ship project',
      appliesTo: '30850',
      emits: { kind: 30851, setTag: 'a', toAddressOf: 'self' },
      submitLabel: 'Create issue',
      declaredToday: true,
      fields: [
        {
          key: 'title',
          label: 'Title',
          control: 'string',
          required: true,
          placeholder: 'Issue title',
          declaredToday: true,
        },
        {
          key: 'project',
          label: 'Project',
          control: 'parent',
          required: true,
          parentNoun: 'project',
          parentOptions: MOCK_SHIP_PROJECTS,
          // Not a manifest property: the parent comes from
          // `emits.toAddressOf: 'self'`, which is why it is required.
          declaredToday: true,
        },
        {
          key: 'status',
          label: 'Status',
          control: 'enum',
          vocabulary: 'issueStatuses',
          defaultValue: 'todo',
        },
        {
          key: 'assignee',
          label: 'Assignee',
          control: 'pubkey',
          placeholder: 'Search people...',
        },
      ],
    },
    {
      // Proposed whole: Ship declares no `add-project` yet. Same shape as
      // `add-issue` so declaring it is a manifest line, not a UI change.
      id: 'add-project',
      label: 'Create project',
      guessAs: 'Create a new project in Ship',
      emits: { kind: 30850 },
      submitLabel: 'Create project',
      fields: [
        {
          key: 'title',
          label: 'Name',
          control: 'string',
          required: true,
          placeholder: 'New project title',
        },
        {
          key: 'status',
          label: 'Status',
          control: 'enum',
          vocabulary: 'statuses',
          defaultValue: 'planned',
        },
        {
          key: 'lead',
          label: 'Lead',
          control: 'pubkey',
          placeholder: 'Search people...',
        },
      ],
    },
  ],
}

const PEEK: LauncherApp = {
  id: 'peek',
  label: 'Peek',
  description: 'Topics & conversations',
  placeholder: "Try 'start a conversation' or 'create topic'...",
  /**
   * Peek's topics — the relay's `kind:39000`, whose `d` is the channel uuid.
   *
   * **Absent until INT-9, and its absence was the whole reason Peek's section
   * was empty.** An app with no `parentKind` is never probed
   * (`CommandLauncher`'s effect returns early), so Peek offered nothing even
   * after it had something to offer. Declaring the number is what makes Peek
   * an app the launcher reads a manifest for rather than a heading.
   *
   * Peek reading Peek's own manifest over the relay looks like a detour and is
   * the point: the launcher has one path, and an app that got a private one
   * would stop proving that a third app works the day it publishes (RFC 0.4
   * §15).
   */
  parentKind: 39000,
  parentNoun: 'topic',
  vocabularies: {},
  actions: [
    {
      /*
        **Declared for real since INT-9**, and the id here is the manifest's id
        rather than a near-miss.

        This was `say`, on the note that "Peek's manifest declares no actions
        yet — a reply names an event id and the action vocabulary can only name
        a parent address". The reply half of that is still true and is why the
        manifest declares no reply. Starting a conversation was the case that
        fitted the vocabulary, and it now fits it in practice too: interop
        0.16.0 finds the Folder to write into off a channel record.

        An id that differs from the live declaration's is the registry trap
        INT-9's own watch list names — a row keyed `say` can never match an
        action called `start-a-conversation`, so the `declared` check refuses it
        and the refusal reads as the manifest being absent.

        Since interop 0.58 the live one is no longer Peek's: it is a Folder's
        built-in (SPEC §3.2), which `offersFolderBuiltIns` below lets Peek
        offer, with the id unchanged — so this row still matches it.
      */
      id: 'start-a-conversation',
      label: 'Start a conversation',
      guessAs: 'Start a new conversation in a topic',
      declaredToday: true,
      emits: { kind: 9, toAddressOf: 'self' },
      submitLabel: 'Start conversation',
      fields: [
        {
          key: 'topic',
          label: 'Topic',
          control: 'parent',
          required: true,
          parentNoun: 'topic',
          // Overridden with the live topic list by `CommandLauncher` —
          // Peek can list its own topics without any new machinery.
          parentOptions: [],
        },
        {
          key: 'message',
          label: 'Message',
          control: 'text',
          required: true,
          placeholder: 'Start a new conversation...',
        },
      ],
    },
    /*
      Create topic is not here (INT-12). It was a `kind:9007` proposal from
      before FOL-23, when a topic was a channel; a topic is a bare file in a
      Folder now, and putting one there is a Folder's built-in action (SPEC
      §3.2), which `offersFolderBuiltIns` below lets Peek offer as
      `asCreateTopic` draws it.
    */
  ],
  offersFolderBuiltIns: true,
}

/**
 * Leaf, as the box running in it knows itself (KIN-5). No parent kind: Leaf's manifest declares nothing creatable yet
 * (KIN-9), so it is never probed, and its New document is the host's own action (`LauncherHost.ownActions`).
 */
const LEAF: LauncherApp = {
  id: 'leaf',
  label: 'Leaf',
  description: 'Pages',
  placeholder: 'Search, or ask about this page',
  vocabularies: {},
  actions: [],
}

/**
 * Every app the launcher knows, with the one it runs in marked `isHost` (KIN-4).
 *
 * Order matters: Ship first, matching the ask that started this (Cmd+K forms
 * for Ship, "and I don't see why we wouldn't expose Peek's actions as well").
 */

export function launcherApps(hostId: string): LauncherApp[] {
  // Leaf is listed only where it is the host: elsewhere it would be an app with nothing to offer, until KIN-9.
  const apps = hostId === LEAF.id ? [SHIP, PEEK, LEAF] : [SHIP, PEEK]
  return apps.map((app) => (app.id === hostId ? { ...app, isHost: true } : app))
}

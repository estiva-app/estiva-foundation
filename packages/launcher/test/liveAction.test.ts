/**
 * PRO-4 — a live manifest's action, drawn by the form the launcher already has.
 *
 * The bar `launcherActions.ts` set for this: *"swapping this constant for a
 * live read must not reshape any UI."* So these assert the conversion, and the
 * component test beside them asserts the panel renders it unchanged.
 */
import { describe, expect, it } from 'vitest'
import { FOLDER_ACTIONS_ADDRESS, type ResolvedAction } from '@estiva-app/interop'
import { parseBlockDocument } from '@estiva-app/protocol'
import {
  MEMBERS_FIELD,
  PARENT_FIELD,
  asCreateTopic,
  changeActionFrom,
  creationsFor,
  launcherActionFrom,
  proseSubmission,
  splitSubmission,
  vocabulariesFrom,
  type CreatableKindRead,
} from '../src/liveAction.js'
import { launcherApps } from '../src/launcherActions.js'

/** Exactly what the runtime returns for Ship's live `add-issue`. */
const addIssue: ResolvedAction = {
  id: 'add-issue',
  label: 'Add issue',
  description: 'File a new issue under a project.',
  effect: 'writes',
  control: 'form',
  fields: [{ name: 'title', type: 'string', required: true }],
  createsUnder: 'self',
}

describe('launcherActionFrom', () => {
  it('draws one field per declared property', () => {
    const action = launcherActionFrom(addIssue, { parentNoun: 'project' })!
    const title = action.fields.find((f) => f.key === 'title')!
    expect(title.control).toBe('string')
    expect(title.required).toBe(true)
    expect(title.label).toBe('Title')
  })

  it('adds the parent, which is not a property and never appears in one', () => {
    /*
      The half of "needs a form *and a parent*" that made these unrenderable.
      It comes from `emits.toAddressOf: 'self'` — surfaced as `createsUnder` —
      and a form drawing only the declared properties would publish an orphan.
    */
    const action = launcherActionFrom(addIssue, { parentNoun: 'project' })!
    const parent = action.fields.find((f) => f.key === PARENT_FIELD)!
    expect(parent.control).toBe('parent')
    expect(parent.required).toBe(true)
    expect(parent.parentNoun).toBe('project')
  })

  it('asks where even for a creation that names no parent — it is made in the object it is invoked on (MAN-8)', () => {
    /*
      This asserted the opposite until MAN-8: no `createsUnder`, no picker. Ship's
      `add-project` is the case that broke it — it is placed *in* a Folder rather
      than hung under one, and without the field the form could never be sent.
    */
    const inFolder = launcherActionFrom({ ...addIssue, id: 'add-project', createsUnder: undefined }, { parentNoun: 'Folder' })!
    const parent = inFolder.fields.find((f) => f.key === PARENT_FIELD)!
    expect(parent.required).toBe(true)
    expect(parent.label).toBe('Folder')
  })

  it('carries the declaring manifest of another app’s action, and nothing for the owner’s', () => {
    const ship = '31990:88ac:estiva-ship'
    expect(launcherActionFrom({ ...addIssue, declaredBy: { address: ship, appName: 'Estiva Ship' } })!.declaredBy).toBe(ship)
    expect(launcherActionFrom(addIssue)!).not.toHaveProperty('declaredBy')
  })
})

/** A Folder's Start a conversation, as interop 0.58 offers it: no app's. */
const startConversation: ResolvedAction = {
  ...addIssue,
  id: 'start-a-conversation',
  label: 'Start a conversation',
  declaredBy: { address: FOLDER_ACTIONS_ADDRESS, appName: 'Folder' },
}
const DM = '39000:relay:dm'

describe('creationsFor — an action goes to the app that declared it (MAN-8)', () => {
  const SHIP_MANIFEST = '31990:88ac:estiva-ship'
  const addProject: ResolvedAction = {
    ...addIssue,
    id: 'add-project',
    label: 'New project',
    createsUnder: undefined,
    listed: true,
    declaredBy: { address: SHIP_MANIFEST, appName: 'Estiva Ship' },
  }
  const reads = new Map<number, CreatableKindRead | null>([
    [30850, { actions: [addIssue], parents: [{ address: '30850:88ac:p1', title: 'Payments' }], manifest: SHIP_MANIFEST }],
    [
      39000,
      {
        actions: [startConversation, addProject],
        parents: [{ address: DM, title: 'A DM' }],
        manifest: FOLDER_ACTIONS_ADDRESS,
        parentsFor: {
          'add-project': [{ address: '39000:relay:qa', title: 'QA' }],
          'start-a-conversation': [
            { address: '39000:relay:qa', title: 'QA' },
            { address: DM, title: 'A DM' },
          ],
        },
        dms: [DM],
      },
    ],
  ])

  it('gives Ship its own issue and its project on a Folder, each with its own parents, and not the Folder’s conversation', () => {
    const ship = creationsFor({ parentKind: 30850, parentNoun: 'project' }, reads)!
    expect(ship.map((c) => [c.action.id, c.parentNoun, c.parents.map((p) => p.label)])).toEqual([
      ['add-issue', 'project', ['Payments']],
      ['add-project', 'team', ['QA']],
    ])
  })

  it('keeps Ship’s action out of Peek’s section, though it arrived on a Folder', () => {
    const peek = creationsFor({ parentKind: 39000, parentNoun: 'topic', offersFolderBuiltIns: true }, reads)!
    expect(peek.map((c) => c.action.id)).toEqual(['start-a-conversation'])
  })

  it('is nothing when the app’s own kind read nothing, and ignores a kind that failed', () => {
    expect(creationsFor({ parentKind: 30850 }, new Map([[30850, null]]))).toBeNull()
    const own = new Map<number, CreatableKindRead | null>([[30850, reads.get(30850)!], [39000, null]])
    expect(creationsFor({ parentKind: 30850 }, own)!.map((c) => c.action.id)).toEqual(['add-issue'])
  })
})

describe("Leaf's New document, in every other app's ⌘K (KIN-9)", () => {
  /** Leaf's manifest: the address its committed key publishes (leaf `src/manifest-address.ts`). */
  const LEAF_MANIFEST = '31990:9b0ff001e909e0c6eb9165b81118b0c580db2584c87e1c794a2ec9339f7541ec:estiva-leaf'
  const SHIP_MANIFEST = '31990:88ac:estiva-ship'
  const addDocument = (address: string): ResolvedAction => ({
    ...addIssue,
    id: 'add-document',
    label: 'New document',
    createsUnder: undefined,
    listed: true,
    declaredBy: { address, appName: 'Leaf' },
  })
  const addProject: ResolvedAction = { ...addIssue, id: 'add-project', label: 'New project', createsUnder: undefined, declaredBy: { address: SHIP_MANIFEST, appName: 'Estiva Ship' } }
  const team = { address: '39000:relay:ops', title: 'Ops' }
  const reads = new Map<number, CreatableKindRead | null>([
    [30850, { actions: [addIssue], parents: [{ address: '30850:88ac:p1', title: 'Payments' }], manifest: SHIP_MANIFEST }],
    [
      39000,
      {
        actions: [startConversation, addProject, addDocument(LEAF_MANIFEST)],
        parents: [{ address: DM, title: 'A DM' }],
        manifest: FOLDER_ACTIONS_ADDRESS,
        parentsFor: { 'add-project': [team], 'add-document': [team] },
      },
    ],
  ])
  const app = (host: string, id: string) => {
    const found = launcherApps(host).find((a) => a.id === id)
    expect(found, `${id} in ${host}'s ⌘K`).toBeDefined()
    return found!
  }

  it("lists Leaf in Peek's and Ship's ⌘K with New document, into the teams", () => {
    for (const host of ['peek', 'ship']) {
      const leaf = creationsFor(app(host, 'leaf'), reads)!
      expect(leaf.map((c) => [c.action.id, c.parentNoun, c.parents.map((p) => p.label)])).toEqual([['add-document', 'team', ['Ops']]])
    }
  })

  it("leaves Leaf's New document out of Ship's and Peek's own sections", () => {
    expect(creationsFor(app('peek', 'ship'), reads)!.map((c) => c.action.id)).toEqual(['add-issue', 'add-project'])
    expect(creationsFor(app('ship', 'peek'), reads)!.map((c) => c.action.id)).toEqual(['start-a-conversation'])
  })

  it("offers a New document only from Leaf's own key: another key's manifest declaring the same action is offered by nobody", () => {
    const forged = new Map<number, CreatableKindRead | null>([[39000, { ...reads.get(39000)!, actions: [addDocument('31990:ee11:estiva-leaf')] }]])
    expect(creationsFor(app('peek', 'leaf'), forged)).toBeNull()
  })

  it("keeps Leaf's own ⌘K on its built-in New document, never a second row from its manifest", () => {
    expect(creationsFor(app('leaf', 'leaf'), reads)).toBeNull()
  })
})

describe('a Folder’s built-ins: Create topic and Start a conversation (INT-12, REC-1)', () => {
  const PEEK_MANIFEST = '31990:0a59:estiva-peek'
  const createFile: ResolvedAction = {
    ...addIssue,
    id: 'create-file',
    label: 'New file',
    createsUnder: undefined,
    listed: true,
    declaredBy: { address: FOLDER_ACTIONS_ADDRESS, appName: 'Folder' },
  }
  const reads = new Map<number, CreatableKindRead | null>([
    [
      39000,
      {
        actions: [startConversation, createFile],
        parents: [{ address: DM, title: 'A DM' }],
        manifest: FOLDER_ACTIONS_ADDRESS,
        noun: 'team',
        parentsFor: {
          'create-file': [{ address: '39000:relay:qa', title: 'QA' }],
          'start-a-conversation': [{ address: DM, title: 'A DM' }],
        },
        dms: [DM],
      },
    ],
  ])

  it('are offered by the app that may sign them — a conversation in DMs, a topic in Folders — and by no other', () => {
    const peek = creationsFor({ parentKind: 39000, parentNoun: 'topic', offersFolderBuiltIns: true }, reads)!
    expect(peek.map((c) => [c.action.id, c.parentNoun, c.parents.map((p) => p.label), c.dms])).toEqual([
      ['start-a-conversation', 'topic', ['A DM'], [DM]],
      ['create-file', 'team', ['QA'], undefined],
    ])
    expect(creationsFor({ parentKind: 39000, parentNoun: 'topic' }, reads)).toEqual([])
  })

  it('is called Create topic and adds a Members field Peek writes itself', () => {
    const action = asCreateTopic(createFile, launcherActionFrom(createFile, { parentNoun: 'Folder' })!)
    expect(action.label).toBe('Create topic')
    expect(action.fields.map((f) => [f.key, f.control])).toEqual([
      ['title', 'string'],
      [PARENT_FIELD, 'parent'],
      [MEMBERS_FIELD, 'people'],
    ])
    expect(action.membersField).toBe(MEMBERS_FIELD)
    expect(action.declaredBy).toBe(FOLDER_ACTIONS_ADDRESS)
  })

  it('leaves every other action as it was', () => {
    const issue = launcherActionFrom(addIssue)!
    expect(asCreateTopic(addIssue, issue)).toBe(issue)
    // An app's own `create-file` is not the Folder's.
    const own = { ...createFile, declaredBy: { address: PEEK_MANIFEST } }
    expect(asCreateTopic(own, launcherActionFrom(own)!).label).toBe('New file')
  })
})

describe('launcherActionFrom — its fields', () => {
  it('renders a declared vocabulary as a select, already looked up', () => {
    const withEnum: ResolvedAction = {
      ...addIssue,
      fields: [
        { name: 'title', type: 'string', required: true },
        {
          name: 'priority',
          type: 'string',
          required: false,
          options: [
            { value: 'high', label: 'High' },
            { value: 'low', label: 'Low' },
          ],
        },
      ],
    }
    const action = launcherActionFrom(withEnum)!
    const priority = action.fields.find((f) => f.key === 'priority')!
    expect(priority.control).toBe('enum')
    expect(priority.required).toBe(false)
    expect(vocabulariesFrom(withEnum).priority).toEqual([
      { value: 'high', label: 'High' },
      { value: 'low', label: 'Low' },
    ])
  })

  it('never guesses prose — nothing in a manifest distinguishes a long string', () => {
    // Inferring `text` would hand an app a textarea it never asked for.
    const action = launcherActionFrom(addIssue)!
    expect(action.fields.find((f) => f.key === 'title')!.control).not.toBe('text')
  })

  it('refuses anything that is not an object-creating action', () => {
    // A change or a comment is one control, and the launcher is not where it
    // belongs. Returning null is the honest answer, not a half-drawn form.
    expect(launcherActionFrom({ id: 'set-status', label: 'Change status', control: 'select' })).toBeNull()
    expect(launcherActionFrom({ id: 'comment', label: 'Comment', control: 'text' })).toBeNull()
  })

  it('titles a multi-word property readably', () => {
    const action = launcherActionFrom({
      ...addIssue,
      fields: [{ name: 'dueDate', type: 'string', required: false }],
    })!
    expect(action.fields[0].label).toBe('Due date')
  })
})

describe('changeActionFrom — a row per field a file lets you set', () => {
  const topic = { address: `30840:${'a'.repeat(64)}:aaaaaaaa-0000-4000-8000-000000000001`, label: 'Launch' }
  const options = [
    { value: '', label: 'Not deleted' },
    { value: 'true', label: 'Deleted' },
  ]

  it('offers no picker for a Delete written as its deleted change: it is confirmed on the file’s own menu (ALL-8)', () => {
    const del: ResolvedAction = { id: 'delete', label: 'Delete', effect: 'destructive', control: 'select', field: 'deleted', options, current: '' }
    expect(changeActionFrom(del, topic)).toBeNull()
  })

  it('still offers a status as a picker starting on the value it holds', () => {
    const status: ResolvedAction = { id: 'set-status', label: 'Set status', control: 'select', field: 'status', options: [{ value: 'todo', label: 'Todo' }, { value: 'done', label: 'Done' }], current: 'done' }
    expect(changeActionFrom(status, topic)?.fields[0]).toMatchObject({ key: 'status', control: 'enum', defaultValue: 'done' })
  })
})

describe('splitSubmission', () => {
  it('keeps the parent out of the properties', () => {
    /*
      The runtime refuses any key the manifest did not declare — the check that
      keeps junk out of a shared record. Leaving the synthetic parent field in
      would make Peek trip that check on every submission, and "work around it"
      is the wrong repair.
    */
    const { parent, properties } = splitSubmission({ title: 'Billing entry', [PARENT_FIELD]: '30850:abc:p1' })
    expect(parent).toBe('30850:abc:p1')
    expect(properties).toEqual({ title: 'Billing entry' })
  })

  it('reports no parent rather than an empty one', () => {
    expect(splitSubmission({ title: 'x' }).parent).toBeUndefined()
  })
})

/** Ship's `add-issue` once its description declares a block document (MAN-1). */
const addIssueWithProse: ResolvedAction = {
  ...addIssue,
  fields: [
    { name: 'title', type: 'string', required: true },
    { name: 'description', type: 'string', required: false, target: 'content', format: 'estiva-blocks-1' },
  ],
}

describe('a prose field (MAN-1, RIC-13)', () => {
  it('is drawn as the editor only because the manifest declared the format', () => {
    const prose = launcherActionFrom(addIssueWithProse)!.fields.find((f) => f.key === 'description')!
    expect(prose.control).toBe('prose')
    expect(prose.required).toBe(false)

    // The same field without the format stays a plain textarea.
    const plain = launcherActionFrom({
      ...addIssue,
      fields: [{ name: 'description', type: 'string', required: false, target: 'content' }],
    })!
    expect(plain.fields[0].control).toBe('text')
  })

  it('leaves as a block document, with the format to tag it', () => {
    const action = launcherActionFrom(addIssueWithProse)!
    const { properties, contentFormat } = proseSubmission(action, {
      title: 'Billing entry',
      description: '# Why\nThe **total** is wrong\n- once\n- twice',
    })
    expect(contentFormat).toBe('estiva-blocks-1')
    expect(properties.title).toBe('Billing entry')
    const document = parseBlockDocument(properties.description!)
    expect(document.content.map((b) => b.type)).toEqual(['heading', 'paragraph', 'bulletList'])
    expect(JSON.stringify(document)).toContain('"marks":[{"type":"bold"}]')
  })

  it('sends what was written in the field as the document it already is (C12)', () => {
    const action = launcherActionFrom(addIssueWithProse)!
    const written = JSON.stringify({ type: 'doc', content: [{ type: 'paragraph', id: 'a1b2c3d4e5f6', content: [{ type: 'text', text: 'The total is wrong' }] }] })
    const { properties, contentFormat } = proseSubmission(action, { title: 'Billing entry', description: written }, { description: 'blocks' })
    expect(contentFormat).toBe('estiva-blocks-1')
    expect(properties.description).toBe(written)
  })

  it('sends a title-only capture exactly as before — no body, no format', () => {
    const action = launcherActionFrom(addIssueWithProse)!
    expect(proseSubmission(action, { title: 'Billing entry' })).toEqual({ properties: { title: 'Billing entry' } })
    expect(proseSubmission(action, { title: 'x', description: '  \n' }).contentFormat).toBeUndefined()
  })
})

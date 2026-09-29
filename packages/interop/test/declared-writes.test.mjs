/**
 * MAN-1 — SPEC §7 declares three things apps already did by hand.
 *
 * 1. **`movedBy`**: which field moves a child. A Ship issue moves by a
 *    `project` change, and before this only the bare file's `parent` was
 *    known — hard-coded — so a moved issue listed under its old project.
 * 2. **`placement` and `listed`**: a Ship project names its Folder with
 *    `buzz-channel`, and is then named in that Folder by a `kind:1852`; a
 *    deletion unlists it (FOL-48). `buildActionEvent` wrote `h` and one event.
 * 3. **`format`**: a field whose value is prose, written as a block document
 *    with `content-format` (RIC-13). The declaration could only say `string`.
 *
 * Every manifest here is a fixture, as Ship would declare these actions — not
 * Ship's live one, which declares none of them yet (MAN-4).
 */
import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import {
  actionProblems,
  buildActionEvent,
  buildActionEvents,
  nestingOf,
  resolveForeignObject,
} from '../dist/index.js'

const AUTHOR = 'a'.repeat(64)
const ACTOR = 'c'.repeat(64)
const PROJECT = 30850
const ISSUE = 30851
const TEAM = '7b32200c-e4c0-4216-b79a-8490fc05e0bd'
const OTHER_TEAM = '0d3a1c52-7f0e-4d6b-9a55-2b1f1e6b8c11'
const P1 = `${PROJECT}:${AUTHOR}:p1`
const P2 = `${PROJECT}:${AUTHOR}:p2`
const I1 = `${ISSUE}:${AUTHOR}:i1`
const NOW = 1_700_000_000_000
const SHA = 'f'.repeat(64)

let seq = 0
const event = (partial) => ({
  id: String(++seq).padStart(64, '0'),
  sig: '',
  pubkey: AUTHOR,
  created_at: 1_700_000_000 + seq,
  tags: [],
  content: '',
  ...partial,
})

const RECORDS = {
  changeKind: 1851,
  targetTag: 'a',
  fieldTag: 'field',
  valueTag: 'value',
  order: ['ts', 'created_at', 'id'],
  rule: 'last-write-wins-per-field',
}

const actions = {
  moveIssue: {
    id: 'move-issue',
    label: 'Move',
    description: 'Put this issue under another project in the same Folder.',
    effect: 'writes',
    appliesTo: String(ISSUE),
    emits: { kind: 1851, field: 'project' },
    input: { type: 'string' },
  },
  addProject: {
    id: 'add-project',
    label: 'Add project',
    description: 'Start a new project in this Folder, discoverable by anyone.',
    effect: 'writes',
    appliesTo: '39000',
    emits: { kind: PROJECT, placement: 'buzz-channel', listed: true },
    input: { type: 'object', properties: { name: { type: 'string' } }, required: ['name'] },
  },
  deleteProject: {
    id: 'delete-project',
    label: 'Delete',
    description: 'Ask the relay to delete this project, and take it out of every Folder that lists it.',
    effect: 'destructive',
    appliesTo: String(PROJECT),
    emits: { kind: 5, listed: true },
  },
  addIssue: {
    id: 'add-issue',
    label: 'Add issue',
    description: 'File a new issue under a project. Only a title is required.',
    effect: 'writes',
    appliesTo: String(PROJECT),
    emits: { kind: ISSUE, setTag: 'a', toAddressOf: 'self' },
    input: {
      type: 'object',
      properties: {
        title: { type: 'string' },
        description: { type: 'string', target: 'content', format: 'estiva-blocks-1' },
      },
      required: ['title'],
    },
  },
  describeIssue: {
    id: 'describe-issue',
    label: 'Describe',
    description: 'Replace the issue description, as rich text or plain text.',
    effect: 'writes',
    appliesTo: String(ISSUE),
    emits: { kind: 1851, field: 'description' },
    input: { type: 'string', format: 'estiva-blocks-1' },
  },
  comment: {
    id: 'comment',
    label: 'Comment',
    description: 'Say something about a project or an issue.',
    effect: 'writes',
    appliesTo: [String(PROJECT), String(ISSUE)],
    emits: { kind: 1111, scope: 'address' },
    input: { type: 'string' },
  },
}

const content = (overrides = {}) => ({
  name: 'Estiva Ship',
  records: RECORDS,
  projections: {
    [PROJECT]: {
      widget: 'card',
      slots: { title: { tag: 'name' }, list: { children: { kind: ISSUE, via: 'a', movedBy: 'project', limit: 200 } } },
    },
    [ISSUE]: { widget: 'row', slots: { title: { tag: 'title' }, body: { fold: 'description', field: 'content' } } },
  },
  actions: Object.values(actions),
  ...overrides,
})

const manifestEvent = (body) =>
  event({ kind: 31990, tags: [['d', 'estiva-ship'], ['k', String(PROJECT)], ['k', String(ISSUE)]], content: JSON.stringify(body) })

const relay = (events) => async (filters) =>
  events.filter((e) =>
    filters.some((f) => {
      if (f.kinds && !f.kinds.includes(e.kind)) return false
      if (f.authors && !f.authors.includes(e.pubkey)) return false
      for (const [key, want] of Object.entries(f)) {
        if (!key.startsWith('#')) continue
        const held = e.tags.filter((t) => t[0] === key.slice(1)).map((t) => t[1])
        if (!want.some((v) => held.includes(v))) return false
      }
      return true
    }),
  )

const issueRoot = () => event({ kind: ISSUE, tags: [['d', 'i1'], ['title', 'Wire the move'], ['h', TEAM], ['a', P1]] })
const change = (field, value, extra = {}) =>
  event({ kind: 1851, pubkey: ACTOR, tags: [['a', I1], ['field', field], ['value', value], ['h', TEAM]], ...extra })

const args = (actionId, over = {}) => ({
  manifest: content(),
  kind: ISSUE,
  address: I1,
  objectAuthor: AUTHOR,
  folder: TEAM,
  actionId,
  value: '',
  pubkey: ACTOR,
  createdAtMs: NOW,
  ...over,
})

/** A two-paragraph document with one inline file, as Ship's editor writes it. */
const doc = JSON.stringify({
  type: 'doc',
  content: [
    { type: 'paragraph', id: 'b1', content: [{ type: 'text', text: 'First line' }] },
    { type: 'attachment', id: 'b2', attrs: { url: `/media/${SHA}.png`, m: 'image/png', x: SHA, size: 7 } },
  ],
})

describe('movedBy — the field that moves a child (SPEC §7.2)', () => {
  test('a folded move wins over the root tag, and is the object’s declared parent field', async () => {
    const found = await resolveForeignObject(I1, relay([manifestEvent(content()), issueRoot(), change('project', P2)]))
    assert.equal(found?.parentRef, P2)
    assert.equal(found?.parentField, 'project')
    assert.equal(found?.parentKind, PROJECT, 'a move control offers projects, not other issues')
  })

  test('an empty move is to no parent — not a fall back to the project it left', async () => {
    const found = await resolveForeignObject(I1, relay([manifestEvent(content()), issueRoot(), change('project', '')]))
    assert.equal(found?.parentRef, undefined)
  })

  test('with no change the root tag is the parent, as before', async () => {
    const found = await resolveForeignObject(I1, relay([manifestEvent(content()), issueRoot()]))
    assert.equal(found?.parentRef, P1)
  })

  test('a manifest that declares no movedBy reads exactly as before: tag only, no parent field', async () => {
    const before = content()
    delete before.projections[PROJECT].slots.list.children.movedBy
    const found = await resolveForeignObject(I1, relay([manifestEvent(before), issueRoot(), change('project', P2)]))
    assert.equal(found?.parentRef, P1)
    assert.equal(found?.parentField, undefined)
    assert.equal(found?.parentKind, undefined)
  })

  test('ignored on a list that matches identifiers, since a move names an address', async () => {
    const byId = content()
    byId.projections[PROJECT].slots.list.children.match = 'identifier'
    const found = await resolveForeignObject(I1, relay([manifestEvent(byId), issueRoot(), change('project', P2)]))
    assert.equal(found?.parentField, undefined)
  })

  test('the move itself is the declared change, built from the declaration', () => {
    const built = buildActionEvent(args('move-issue', { value: P2 }))
    assert.deepEqual(built.tags, [['a', I1], ['field', 'project'], ['value', P2], ['h', TEAM], ['ts', String(NOW)]])
  })

  test('nesting offers only the declared parent kind as a move target', () => {
    const files = [
      { ref: P1, address: P1, kind: PROJECT },
      { ref: P2, address: P2, kind: PROJECT },
      { ref: I1, address: I1, kind: ISSUE, parentRef: P1, parentKind: PROJECT },
      { ref: 'topic', address: `30840:${AUTHOR}:t`, kind: 30840 },
    ]
    const targets = nestingOf(files).moveTargetsOf(files[2])
    assert.deepEqual(targets.map((t) => t?.ref), [undefined, P2])
  })
})

describe('placement and listed — where a new object lives, and the command that follows (SPEC §7.3)', () => {
  const addProject = (over = {}) =>
    args('add-project', { kind: 39000, address: `39000:${AUTHOR}:${TEAM}`, value: { name: 'Launch' }, newId: 'p3', ...over })
  const P3 = `${PROJECT}:${ACTOR}:p3`

  test('buzz-channel names the Folder, and the root carries no h', () => {
    const [root] = buildActionEvents(addProject({ folderHasState: false }))
    assert.deepEqual(root.tags, [['d', 'p3'], ['name', 'Launch'], ['buzz-channel', TEAM]])
  })

  test('a Folder with state gets an add naming the new project, after the root', () => {
    const events = buildActionEvents(addProject({ folderHasState: true }))
    assert.equal(events.length, 2)
    assert.equal(events[0].kind, PROJECT)
    assert.equal(events[1].kind, 1852)
    assert.deepEqual(events[1].tags, [['h', TEAM], ['op', 'add'], ['a', P3]])
  })

  test('a Folder without state gets no command, which would hide everything filed in it', () => {
    const events = buildActionEvents(addProject({ folderHasState: false }))
    assert.deepEqual(events.map((e) => e.kind), [PROJECT])
  })

  test('refused without the state, rather than guessing', () => {
    assert.match(buildActionEvents(addProject()), /whether the Folder has state/)
  })

  test('buildActionEvent refuses a listed action rather than drop its command', () => {
    assert.match(buildActionEvent(addProject()), /buildActionEvents/)
    assert.match(buildActionEvent(args('delete-project', { kind: PROJECT, address: P1 })), /buildActionEvents/)
  })

  test('a deletion unlists from every Folder with state that names it, after the kind:5', () => {
    const events = buildActionEvents(
      args('delete-project', {
        kind: PROJECT,
        address: P1,
        listedIn: [
          { id: TEAM, hasState: true },
          { id: OTHER_TEAM, hasState: false },
        ],
      }),
    )
    assert.deepEqual(events.map((e) => e.kind), [5, 1852])
    assert.deepEqual(events[0].tags, [['a', P1], ['k', String(PROJECT)]])
    assert.deepEqual(events[1].tags, [['h', TEAM], ['op', 'remove'], ['a', P1]])
  })

  test('a listed deletion refuses to run without knowing who lists it', () => {
    assert.match(buildActionEvents(args('delete-project', { kind: PROJECT, address: P1 })), /Folders that list it/)
  })

  test('an action that is not listed is one event from either builder', () => {
    const one = buildActionEvent(args('move-issue', { value: P2 }))
    assert.deepEqual(buildActionEvents(args('move-issue', { value: P2 })), [one])
  })

  test('the default placement is h, and anything but h or buzz-channel is refused', () => {
    const plain = content()
    plain.actions = [{ ...actions.addProject, emits: { kind: PROJECT } }]
    const [root] = buildActionEvents(addProject({ manifest: plain }))
    assert.deepEqual(root.tags.at(-1), ['h', TEAM])
    plain.actions = [{ ...actions.addProject, emits: { kind: PROJECT, placement: 'folder' } }]
    assert.match(buildActionEvents(addProject({ manifest: plain })), /h or buzz-channel/)
  })

  test('the resolved actions say which ones need the Folder’s state', async () => {
    const project = event({ kind: PROJECT, tags: [['d', 'p1'], ['name', 'P'], ['buzz-channel', TEAM]] })
    const found = await resolveForeignObject(P1, relay([manifestEvent(content()), project]))
    const del = found?.actions.find((a) => a.id === 'delete-project')
    assert.equal(del?.listed, true)
    assert.equal(found?.actions.find((a) => a.id === 'add-issue')?.listed, undefined)
  })
})

describe('format — a field whose value is prose (SPEC §7.3, RIC-13)', () => {
  const addIssue = (value, over = {}) => args('add-issue', { kind: PROJECT, address: P1, value, newId: 'i9', ...over })

  test('a block document is tagged on the root and names its files', () => {
    const built = buildActionEvent(addIssue({ title: 'T', description: doc }, { contentFormat: 'estiva-blocks-1' }))
    assert.equal(built.content, doc)
    assert.deepEqual(built.tags, [
      ['d', 'i9'],
      ['title', 'T'],
      ['a', P1],
      ['h', TEAM],
      ['content-format', 'estiva-blocks-1'],
      ['imeta', `url /media/${SHA}.png`, 'm image/png', `x ${SHA}`, 'size 7'],
    ])
  })

  test('plain text is written untagged, as marker text — a consumer ignoring format is still correct', () => {
    const built = buildActionEvent(addIssue({ title: 'T', description: 'line one\nline two' }))
    assert.equal(built.content, 'line one\nline two')
    assert.equal(built.tags.some((t) => t[0] === 'content-format'), false)
  })

  test('a title-only capture carries no format either', () => {
    const built = buildActionEvent(addIssue({ title: 'T' }, { contentFormat: 'estiva-blocks-1' }))
    assert.equal(built.content, '')
    assert.equal(built.tags.some((t) => t[0] === 'content-format'), false)
  })

  test('a value claimed as a document that is not one is refused, never tagged', () => {
    assert.match(buildActionEvent(addIssue({ title: 'T', description: '# not json' }, { contentFormat: 'estiva-blocks-1' })), /not a block document/)
  })

  test('a format the action does not declare is refused', () => {
    assert.match(buildActionEvent(addIssue({ title: 'T', description: doc }, { contentFormat: 'markdown' })), /takes estiva-blocks-1/)
    assert.match(buildActionEvent(args('move-issue', { value: P2, contentFormat: 'estiva-blocks-1' })), /declares no estiva-blocks-1/)
    assert.match(buildActionEvent(args('comment', { value: 'hi', contentFormat: 'estiva-blocks-1' })), /takes no prose value/)
  })

  test('a described change carries the tag after h, and its files after ts — Ship’s own order', () => {
    const built = buildActionEvent(args('describe-issue', { value: doc, contentFormat: 'estiva-blocks-1' }))
    assert.deepEqual(built.tags, [
      ['a', I1],
      ['field', 'description'],
      ['value', doc],
      ['h', TEAM],
      ['content-format', 'estiva-blocks-1'],
      ['ts', String(NOW)],
      ['imeta', `url /media/${SHA}.png`, 'm image/png', `x ${SHA}`, 'size 7'],
    ])
  })

  test('the resolved form and change expose the format, so a consumer can draw an editor', async () => {
    const project = event({ kind: PROJECT, tags: [['d', 'p1'], ['name', 'P'], ['buzz-channel', TEAM]] })
    const onProject = await resolveForeignObject(P1, relay([manifestEvent(content()), project]))
    const form = onProject?.actions.find((a) => a.id === 'add-issue')
    assert.deepEqual(
      form?.fields?.map((f) => [f.name, f.format]),
      [
        ['title', undefined],
        ['description', 'estiva-blocks-1'],
      ],
    )
    const onIssue = await resolveForeignObject(I1, relay([manifestEvent(content()), issueRoot()]))
    const describe = onIssue?.actions.find((a) => a.id === 'describe-issue')
    assert.equal(describe?.control, 'text')
    assert.equal(describe?.format, 'estiva-blocks-1')
    assert.equal(onIssue?.actions.find((a) => a.id === 'move-issue')?.format, undefined)
  })

  test('an unknown format, or one on a tag, is not surfaced — nothing draws an editor it cannot tag', async () => {
    const odd = content()
    odd.actions = [
      { ...actions.describeIssue, input: { type: 'string', format: 'estiva-blocks-9' } },
      {
        ...actions.addIssue,
        appliesTo: String(ISSUE),
        input: { type: 'object', properties: { title: { type: 'string', format: 'estiva-blocks-1' } } },
      },
    ]
    const found = await resolveForeignObject(I1, relay([manifestEvent(odd), issueRoot()]))
    assert.equal(found?.actions.find((a) => a.id === 'describe-issue')?.format, undefined)
    assert.equal(found?.actions.find((a) => a.id === 'add-issue')?.fields?.[0].format, undefined)
  })
})

describe('actionProblems — the declarations checked before signing', () => {
  test('the fixture declarations are clean', () => {
    for (const action of Object.values(actions)) assert.deepEqual(actionProblems(action), [], action.id)
  })

  test('flags a placement nothing reads, a listed change, and a format with nowhere to go', () => {
    const problems = [
      ...actionProblems({ ...actions.addProject, emits: { kind: PROJECT, placement: 'folder' } }),
      ...actionProblems({ ...actions.moveIssue, emits: { kind: 1851, field: 'project', listed: true } }),
      ...actionProblems({ ...actions.comment, input: { type: 'string', format: 'estiva-blocks-1' } }),
      ...actionProblems({ ...actions.describeIssue, input: { type: 'string', format: 'html' } }),
    ]
    assert.equal(problems.length, 4, problems.join('\n'))
    assert.match(problems[0], /h or buzz-channel/)
    assert.match(problems[1], /neither creates nor deletes/)
    assert.match(problems[2], /neither a creation's content nor a change's value/)
    assert.match(problems[3], /only format is estiva-blocks-1/)
  })
})

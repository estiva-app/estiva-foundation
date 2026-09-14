/**
 * The README, executed.
 *
 * **This exists because the page was wrong and nothing said so.** PRO-9's whole
 * claim is that a stranger can render a foreign object using only the published
 * page, and §2's example called
 *
 *   buildActionEvent({ object, actionId, value })
 *
 * which is not the function's signature and never was — it takes the manifest,
 * the kind, the address, the object's author, the folder, the signer's pubkey
 * and a clock, because this package reaches for none of them. A stranger
 * following that page got a type error at best. At worst they got the other
 * half of it: `buildActionEvent` returns `UnsignedActionEvent | string`, the
 * string is the refusal, and the example treated the result as an event — so
 * the copy-paste path ended in signing and publishing an error message.
 *
 * The README's other examples had been run once, in a scratch project, when the
 * package was first published. That is a snapshot; this is a check. Every
 * assertion below is a claim the page makes in prose, and the file is in
 * `test/` so `npm run typecheck` compiles it against the real declarations —
 * which is the half that catches a signature moving.
 *
 * It deliberately does not test resolution deeply; `behaviour.test.ts` does
 * that. It tests that the page is not lying.
 */
import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import {
  buildActionEvent,
  pickWidget,
  resolveForeignObject,
  resolveFolderContents,
  listFolders,
  CLOSED_WIDGETS,
} from '../dist/index.js'
import type { SignedEvent } from '@estiva-app/protocol'

const AUTHOR = 'a'.repeat(64)
const SIGNER = 'c'.repeat(64)
const FOLDER = '7b32200c-e4c0-4216-b79a-8490fc05e0bd'
const ISSUE_KIND = 30851
const CHANGE_KIND = 1851

let seq = 0
const event = (partial: Partial<SignedEvent> & { kind: number }): SignedEvent => {
  seq += 1
  return {
    id: String(seq).padStart(64, '0'),
    sig: '',
    pubkey: AUTHOR,
    created_at: 1_700_000_000 + seq,
    tags: [],
    content: '',
    ...partial,
  }
}

const manifestContent = {
  name: 'Estiva Ship',
  records: {
    changeKind: CHANGE_KIND,
    targetTag: 'a',
    fieldTag: 'field',
    valueTag: 'value',
    order: ['ts', 'created_at', 'id'],
    rule: 'last-write-wins-per-field',
  },
  projections: {
    [ISSUE_KIND]: {
      widget: ['ticket', 'row'],
      slots: {
        title: { tag: 'title' },
        status: { fold: 'status', map: 'statuses', default: 'todo' },
        body: { fold: 'description', field: 'content' },
        meta: [{ label: 'Assignee', fold: 'assignee', as: 'pubkey' }],
      },
    },
  },
  vocabularies: {
    statuses: [
      { value: 'todo', label: 'Todo', colour: 'neutral', stage: 'open' },
      { value: 'done', label: 'Done', colour: 'green', stage: 'done' },
    ],
  },
  actions: [
    {
      id: 'set-issue-status',
      label: 'Change status',
      appliesTo: String(ISSUE_KIND),
      emits: { kind: CHANGE_KIND, field: 'status' },
      input: { type: 'string', enum: 'statuses' },
      description: 'Move an issue to a different status',
      effect: 'writes',
    },
    {
      id: 'add-issue',
      label: 'Add issue',
      appliesTo: String(ISSUE_KIND),
      emits: { kind: ISSUE_KIND, setTag: 'a', toAddressOf: 'self' },
      input: { type: 'object', properties: { title: { type: 'string' } }, required: ['title'] },
      description: 'File a new issue under this one',
      effect: 'writes',
    },
  ],
}

const events: SignedEvent[] = [
  event({
    kind: 31990,
    tags: [['d', 'app'], ['k', String(ISSUE_KIND)]],
    content: JSON.stringify(manifestContent),
  }),
  event({
    kind: ISSUE_KIND,
    tags: [['d', 'i1'], ['title', 'Billing entry'], ['h', FOLDER]],
    content: '**Stripe Checkout** for billing.',
  }),
]

function relay(all: SignedEvent[]) {
  return async (filters: Record<string, unknown>[]) => {
    const out: SignedEvent[] = []
    for (const filter of filters) {
      for (const e of all) {
        const kinds = filter.kinds as number[] | undefined
        if (kinds && !kinds.includes(e.kind)) continue
        let ok = true
        for (const [key, values] of Object.entries(filter)) {
          if (!key.startsWith('#')) continue
          const held = e.tags.filter((t) => t[0] === key.slice(1)).map((t) => t[1])
          if (!held.some((v) => (values as string[]).includes(v))) ok = false
        }
        if (ok && !out.includes(e)) out.push(e)
      }
    }
    return out
  }
}

const ADDRESS = `${ISSUE_KIND}:${AUTHOR}:i1`
const query = relay(events)

describe('the README §1: render an object from an app you know nothing about', () => {
  it('resolves to the shape the page prints', async () => {
    const object = await resolveForeignObject(ADDRESS, query)
    assert.ok(object)
    assert.equal(object.ref, ADDRESS)
    assert.equal(object.kind, ISSUE_KIND)
    assert.equal(object.appName, 'Estiva Ship')
    assert.equal(object.slots.title?.value, 'Billing entry')
    assert.deepEqual(object.widget, ['ticket', 'row'])
    assert.ok(Array.isArray(object.meta))
    assert.ok(Array.isArray(object.actions))
  })

  it('gives a body a content model, and gives a title none', async () => {
    const object = await resolveForeignObject(ADDRESS, query)
    // The page's table: 'marker' | 'blocks' | 'unknown', and a slot that is not
    // a body carries no `format` at all.
    assert.equal(object?.slots.body?.format, 'marker')
    assert.ok(!('format' in (object?.slots.title ?? {})))
  })

  it('picks a widget from the chain, as §3 shows', async () => {
    const object = await resolveForeignObject(ADDRESS, query)
    assert.equal(pickWidget(object!.widget, ['ticket', ...CLOSED_WIDGETS], 'card'), 'ticket')
    assert.equal(pickWidget(object!.widget, [...CLOSED_WIDGETS], 'card'), 'row')
  })
})

describe('the README §2: act on it, without an API', () => {
  const common = {
    manifest: manifestContent as never,
    kind: ISSUE_KIND,
    address: ADDRESS,
    objectAuthor: AUTHOR,
    folder: FOLDER,
    pubkey: SIGNER,
    createdAtMs: 1_700_000_500_000,
  }

  it('builds the change event the page describes', () => {
    const built = buildActionEvent({ ...common, actionId: 'set-issue-status', value: 'done' })
    assert.notEqual(typeof built, 'string', typeof built === 'string' ? built : '')
    if (typeof built === 'string') return
    assert.equal(built.kind, CHANGE_KIND)
    assert.equal(built.pubkey, SIGNER)
    const tag = (name: string) => built.tags.find((t) => t[0] === name)?.[1]
    assert.equal(tag('a'), ADDRESS)
    assert.equal(tag('field'), 'status')
    assert.equal(tag('value'), 'done')
  })

  it('refuses with a string a person can read, which the page says to check', () => {
    // The half the old example got wrong: treat this as an event and you sign
    // the refusal.
    const outside = buildActionEvent({ ...common, actionId: 'set-issue-status', value: 'percolating' })
    assert.equal(typeof outside, 'string')
    assert.match(outside as string, /todo|done/i)

    const missing = buildActionEvent({ ...common, actionId: 'no-such-action', value: 'done' })
    assert.equal(typeof missing, 'string')
  })

  it('builds a creation from an object value and a newId, as the form section shows', () => {
    const built = buildActionEvent({
      ...common,
      actionId: 'add-issue',
      value: { title: 'Payment fails on retry' },
      newId: 'b9f1c2d3-0000-4000-8000-000000000001',
    })
    assert.notEqual(typeof built, 'string', typeof built === 'string' ? built : '')
    if (typeof built === 'string') return
    assert.equal(built.kind, ISSUE_KIND)
    const tag = (name: string) => built.tags.find((t) => t[0] === name)?.[1]
    // "A property's name is the tag its value is written to."
    assert.equal(tag('title'), 'Payment fails on retry')
    assert.equal(tag('d'), 'b9f1c2d3-0000-4000-8000-000000000001')
  })

  it('refuses a creation with no id, because an object without one has no address', () => {
    const built = buildActionEvent({ ...common, actionId: 'add-issue', value: { title: 'x' } })
    assert.equal(typeof built, 'string')
  })

  it('resolves an object-creating action with its schema, as the page shows', async () => {
    const object = await resolveForeignObject(ADDRESS, query)
    const form = object?.actions.find((a) => a.control === 'form')
    assert.ok(form, 'the page says an object-creating action arrives with control: "form"')
    assert.equal(form.fields?.[0]?.name, 'title')
    assert.equal(form.fields?.[0]?.required, true)
    assert.ok(form.createsUnder)
  })
})

/**
 * §5. The page says a folder view is §1 in a loop, that files arrive as the
 * same `ForeignObject`, and that a file you cannot see is absent rather than
 * greyed out. All three are claims a reader would build on.
 */
describe('the README §5: read a whole folder', () => {
  const CHANNEL_KIND = 39000
  const RELAY_KEY = 'f'.repeat(64)
  const manifest = event({
    kind: 31990,
    tags: [['d', 'app'], ['k', String(ISSUE_KIND)]],
    content: JSON.stringify(manifestContent),
  })
  const issue = event({
    kind: ISSUE_KIND,
    tags: [['d', 'weir'], ['title', 'Payment fails on retry'], ['h', FOLDER]],
  })
  const channel = event({
    kind: CHANNEL_KIND,
    pubkey: RELAY_KEY,
    tags: [['d', FOLDER], ['name', 'Billing']],
  })

  it('files come back as the ForeignObjects §1 draws', async () => {
    const folder = await resolveFolderContents(FOLDER, relay([manifest, channel, issue]), async () => ({}))
    assert.equal(folder.name, 'Billing')
    assert.equal(folder.files.length, 1)
    // "Every file comes back as the same ForeignObject §1 renders."
    assert.equal(folder.files[0]?.slots.title?.value, 'Payment fails on retry')
    assert.ok(folder.files[0]?.widget, 'a file must carry a widget, or §3 cannot draw it')
  })

  it('source says which model this is, and h alone is the approximation', async () => {
    const folder = await resolveFolderContents(FOLDER, relay([manifest, channel, issue]), async () => ({}))
    assert.equal(folder.source, 'channel')
    assert.equal(folder.hasState, false)
  })

  it('a file that cannot be read is absent, and nothing counts it', async () => {
    // The manifest and the channel resolve; the issue itself does not.
    const folder = await resolveFolderContents(FOLDER, relay([manifest, channel]), async () => ({}))
    assert.deepEqual(folder.files, [])
    assert.equal(JSON.stringify(folder).includes('unreachable'), false)
  })

  it('listFolders names a folder for a sidebar', async () => {
    const folders = await listFolders(relay([manifest, channel, issue]))
    assert.deepEqual(folders, [{ id: FOLDER, name: 'Billing', hasState: false }])
  })

  it('listFolders says which folders another folder lists as files (FOL-22)', async () => {
    // A team whose state lists the Billing channel as a file, the way a Peek
    // topic sits inside its team — and lists itself, which counts for nothing.
    const TEAM = '05bebd5b-b699-4bd4-af50-f5377df0fd67'
    const teamState = event({
      kind: 30890,
      pubkey: RELAY_KEY,
      tags: [
        ['d', TEAM],
        ['name', 'Finance'],
        ['a', `${CHANNEL_KIND}:${RELAY_KEY}:${FOLDER}`],
        ['a', `${CHANNEL_KIND}:${RELAY_KEY}:${TEAM}`],
        ['a', `${ISSUE_KIND}:${AUTHOR}:not-a-folder`],
      ],
    })
    const folders = await listFolders(relay([manifest, channel, issue, teamState]))
    assert.deepEqual(folders, [
      { id: FOLDER, name: 'Billing', hasState: false, listedIn: [TEAM] },
      { id: TEAM, name: 'Finance', hasState: true },
    ])
  })
})

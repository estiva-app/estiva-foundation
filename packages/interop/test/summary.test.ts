/*
  A file's summary — SPEC §6.12, §7.2, §3.2.

  One line of plain text under a file's title, on every card that draws a
  `subtitle`. Seeded by a root `summary` tag, changed by a `kind:1851` with
  `field` `summary`, last write wins; blank once trimmed means none, and the
  seed does not show through. It comes from the runtime for every file kind, so
  an app's manifest need not declare it and cannot aim the line elsewhere
  (Miky, 2026-10-15). A Folder's line is its `about`, never a summary.
*/
import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import {
  KIND_BARE_FILE,
  KIND_CHANNEL_METADATA,
  buildActionEvent,
  resolveForeignObject,
  resolveManifest,
} from '../dist/index.js'
import type { SignedEvent } from '@estiva-app/protocol'

const FOLDER = '7b32200c-e4c0-4216-b79a-8490fc05e0bd'
const OTHER_FOLDER = '0e2f4c1a-5b6d-4e7f-8a9b-0c1d2e3f4a5b'
const AUTHOR = 'a'.repeat(64)
const OTHER = 'b'.repeat(64)
const APP = 'c'.repeat(64)
const RELAY = 'f'.repeat(64)
const PROJECT_KIND = 30850
const DOCUMENT_KIND = 30842

const TOPIC = `${KIND_BARE_FILE}:${AUTHOR}:naming`
const PROJECT = `${PROJECT_KIND}:${AUTHOR}:launch`
const PAGE = `${DOCUMENT_KIND}:${AUTHOR}:page`
const FOLDER_ADDRESS = `${KIND_CHANNEL_METADATA}:${RELAY}:${FOLDER}`

let seq = 0
function event(partial: Partial<SignedEvent> & { kind: number }): SignedEvent {
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

const topic = (extra: string[][] = []) =>
  event({ kind: KIND_BARE_FILE, tags: [['d', 'naming'], ['title', 'Launch naming'], ['h', FOLDER], ...extra] })

/** A summary change by somebody other than the author, as §6.12 writes it. */
const summarize = (target: string, value: string, folder = FOLDER) =>
  event({
    kind: 1851,
    pubkey: OTHER,
    tags: [['a', target], ['field', 'summary'], ['value', value], ['h', folder]],
  })

/** An app owning a kind, with whatever slots a test gives it. */
const app = (kind: number, slots: Record<string, unknown>) =>
  event({
    kind: 31990,
    pubkey: APP,
    tags: [['d', `app-${kind}`], ['k', String(kind)]],
    content: JSON.stringify({
      name: 'Some app',
      records: {
        changeKind: 1851,
        targetTag: 'a',
        fieldTag: 'field',
        valueTag: 'value',
        order: ['ts', 'created_at', 'id'],
        rule: 'last-write-wins-per-field',
      },
      projections: { [kind]: { widget: 'card', slots } },
    }),
  })

type Filter = { ids?: string[]; kinds?: number[]; authors?: string[] } & Record<string, unknown>

function relay(events: SignedEvent[]) {
  const matches = (e: SignedEvent, filter: Filter) => {
    if (filter.ids && !filter.ids.includes(e.id)) return false
    if (filter.kinds && !filter.kinds.includes(e.kind)) return false
    if (filter.authors && !filter.authors.includes(e.pubkey)) return false
    for (const [key, values] of Object.entries(filter)) {
      if (!key.startsWith('#')) continue
      const held = e.tags.filter((t) => t[0] === key.slice(1)).map((t) => t[1])
      if (!held.some((v) => (values as string[]).includes(v))) return false
    }
    return true
  }
  return async (filters: Record<string, unknown>[]) =>
    events.filter((e) => filters.some((f) => matches(e, f as Filter)))
}

describe("a file's summary is its subtitle, whatever its kind", () => {
  it('shows on a topic, from a change by anyone in its Folder, with no manifest anywhere', async () => {
    const found = await resolveForeignObject(TOPIC, relay([topic(), summarize(TOPIC, 'What we call the launch.')]))
    assert.equal(found?.slots.subtitle?.value, 'What we call the launch.')
  })

  it('shows the seed a file was created with until a change overrides it', async () => {
    const seeded = topic([['summary', 'Seeded at creation.']])
    assert.equal((await resolveForeignObject(TOPIC, relay([seeded])))?.slots.subtitle?.value, 'Seeded at creation.')
    const changed = await resolveForeignObject(TOPIC, relay([seeded, summarize(TOPIC, 'Changed since.')]))
    assert.equal(changed?.slots.subtitle?.value, 'Changed since.')
  })

  it("shows on an app's own kind whose manifest says nothing about it", async () => {
    const page = event({ kind: DOCUMENT_KIND, tags: [['d', 'page'], ['title', 'Plan'], ['h', FOLDER]] })
    const found = await resolveForeignObject(
      PAGE,
      relay([app(DOCUMENT_KIND, { title: { tag: 'title', fold: 'title' } }), page, summarize(PAGE, 'The plan for Q4.')]),
    )
    assert.equal(found?.slots.subtitle?.value, 'The plan for Q4.')
  })

  it('ignores a manifest aiming the line at another field', async () => {
    const page = event({
      kind: DOCUMENT_KIND,
      tags: [['d', 'page'], ['title', 'Plan'], ['h', FOLDER]],
      content: '# Heading\n\nThe whole text',
    })
    const manifest = app(DOCUMENT_KIND, { title: { tag: 'title' }, subtitle: { field: 'content', truncate: 120 } })
    const without = await resolveForeignObject(PAGE, relay([manifest, page]))
    assert.equal(without?.slots.subtitle, undefined, 'the description is not a summary')
    const withOne = await resolveForeignObject(PAGE, relay([manifest, page, summarize(PAGE, 'The plan.')]))
    assert.equal(withOne?.slots.subtitle?.value, 'The plan.')
  })

  it("reads a project's change in the Folder its buzz-channel names, and not one from elsewhere", async () => {
    const project = event({
      kind: PROJECT_KIND,
      tags: [['d', 'launch'], ['name', 'Launch'], ['buzz-channel', FOLDER]],
    })
    const manifest = app(PROJECT_KIND, { title: { tag: ['name', 'title'], fold: 'title' } })
    const found = await resolveForeignObject(PROJECT, relay([manifest, project, summarize(PROJECT, 'Ship it.')]))
    assert.equal(found?.slots.subtitle?.value, 'Ship it.')
    const outside = await resolveForeignObject(
      PROJECT,
      relay([manifest, project, summarize(PROJECT, 'From another Folder.', OTHER_FOLDER)]),
    )
    assert.equal(outside?.slots.subtitle, undefined)
  })
})

describe('a summary change nobody can check is not read', () => {
  it('on a file whose root names no Folder, from a member of any Folder', async () => {
    const filed = await resolveForeignObject(TOPIC, relay([topic(), summarize(TOPIC, 'From its Folder.')]))
    assert.equal(filed?.slots.subtitle?.value, 'From its Folder.')
    const unfiled = event({ kind: KIND_BARE_FILE, tags: [['d', 'naming'], ['title', 'Launch naming']] })
    const found = await resolveForeignObject(TOPIC, relay([unfiled, summarize(TOPIC, 'From anywhere.', OTHER_FOLDER)]))
    assert.equal(found?.slots.subtitle, undefined)
  })
})

describe('clearing a summary', () => {
  for (const [what, value] of [
    ['an empty value', ''],
    ['a blank value', '  \n\t '],
  ]) {
    it(`${what} removes the line, and the seed does not show through`, async () => {
      const seeded = topic([['summary', 'Seeded at creation.']])
      const before = await resolveForeignObject(TOPIC, relay([seeded, summarize(TOPIC, 'Set once.')]))
      assert.equal(before?.slots.subtitle?.value, 'Set once.')
      const found = await resolveForeignObject(
        TOPIC,
        relay([seeded, summarize(TOPIC, 'Set once.'), summarize(TOPIC, value)]),
      )
      assert.equal(found?.slots.subtitle, undefined)
    })
  }

  it('a blank seed is no summary either, where a written one is', async () => {
    const written = await resolveForeignObject(TOPIC, relay([topic([['summary', ' Seeded. ']])]))
    assert.equal(written?.slots.subtitle?.value, 'Seeded.')
    const blank = await resolveForeignObject(TOPIC, relay([topic([['summary', '   ']])]))
    assert.equal(blank?.slots.subtitle, undefined)
  })
})

describe('a summary is one line of plain text', () => {
  it('folds line breaks to spaces and keeps markers as written', async () => {
    const found = await resolveForeignObject(
      TOPIC,
      relay([topic(), summarize(TOPIC, '  Two **lines**\nof text \n')]),
    )
    assert.equal(found?.slots.subtitle?.value, 'Two **lines** of text')
    assert.equal(found?.slots.subtitle?.format, undefined, 'no content model applies to it')
  })

  it('is cut short when a writer ignores the length, since the relay does not stop it', async () => {
    const found = await resolveForeignObject(TOPIC, relay([topic(), summarize(TOPIC, 'word '.repeat(200))]))
    const value = found?.slots.subtitle?.value ?? ''
    assert.ok(value.length <= 281, `drawn ${value.length} characters`)
    assert.ok(value.endsWith('…'))
  })
})

describe("a Folder's one-liner is its about", () => {
  const owner = event({
    kind: 31990,
    pubkey: APP,
    tags: [['d', 'talk'], ['k', String(KIND_CHANNEL_METADATA)]],
    content: JSON.stringify({
      name: 'Talk',
      projections: { [KIND_CHANNEL_METADATA]: { widget: 'card', slots: { title: { tag: 'name' } } } },
    }),
  })
  const folder = (extra: string[][] = []) =>
    event({ kind: KIND_CHANNEL_METADATA, pubkey: RELAY, tags: [['d', FOLDER], ['name', 'Accounts'], ...extra] })

  it("draws the channel's about, with nothing in its owner's manifest", async () => {
    const found = await resolveForeignObject(FOLDER_ADDRESS, relay([owner, folder([['about', 'Money in and out.']])]))
    assert.equal(found?.slots.subtitle?.value, 'Money in and out.')
  })

  it('ignores a summary change aimed at it', async () => {
    const change = summarize(FOLDER_ADDRESS, 'Not how a Folder is described.')
    const found = await resolveForeignObject(FOLDER_ADDRESS, relay([owner, folder([['about', 'Money in and out.']]), change]))
    assert.equal(found?.slots.subtitle?.value, 'Money in and out.')
    const none = await resolveForeignObject(FOLDER_ADDRESS, relay([owner, folder(), change]))
    assert.equal(none?.slots.subtitle, undefined)
  })
})

describe('the bare file declares how to change it', () => {
  it('summarize writes a plain summary change in the file’s own Folder', async () => {
    const resolved = await resolveManifest({ kind: KIND_BARE_FILE, pubkey: AUTHOR, identifier: 'naming', relays: [] }, relay([]))
    const found = await resolveForeignObject(TOPIC, relay([topic()]))
    const action = found?.actions.find((a) => a.field === 'summary')
    assert.equal(action?.id, 'summarize')
    assert.equal(action?.control, 'text')
    const built = buildActionEvent({
      manifest: resolved!.manifest,
      kind: KIND_BARE_FILE,
      address: TOPIC,
      objectAuthor: AUTHOR,
      folder: FOLDER,
      actionId: 'summarize',
      value: 'What we call the launch.',
      pubkey: OTHER,
      createdAtMs: 1_700_000_000_000,
    })
    assert.notEqual(typeof built, 'string', String(built))
    const change = built as Exclude<typeof built, string>
    assert.equal(change.kind, 1851)
    assert.deepEqual(
      change.tags.filter((t) => t[0] !== 'ts'),
      [['a', TOPIC], ['field', 'summary'], ['value', 'What we call the launch.'], ['h', FOLDER]],
      'no content-format: a summary is not prose (SPEC §7.3)',
    )
  })
})

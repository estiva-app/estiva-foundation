/*
  The bare file — `kind:30840`, SPEC §6.7, RFC 0.5 §10.7.

  A file no app owns. Its projection is built into the runtime rather than
  published, so the property every test here comes back to is the one the
  ticket names: **remove every manifest from the relay and a bare file still
  resolves, lists its comments, and names its parent.** The fixture below
  therefore holds no `kind:31990` unless a test is specifically about one
  trying to claim the kind — and that test asserts it cannot.
*/
import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import {
  BARE_FILE_MANIFEST_ADDRESS,
  KIND_BARE_FILE,
  commentKindsOf,
  resolveFolderContents,
  resolveForeignObject,
  resolveManifest,
} from '../dist/index.js'
import type { SignedEvent } from '@estiva-app/protocol'

const TEAM = '7b32200c-e4c0-4216-b79a-8490fc05e0bd'
const AUTHOR = 'a'.repeat(64)
const OTHER = 'b'.repeat(64)
const PROJECT_KIND = 30850
const COMMENT_KIND = 1111
const CHANGE_KIND = 1851

const PROJECT = `${PROJECT_KIND}:${OTHER}:launch`
const TOPIC = `${KIND_BARE_FILE}:${AUTHOR}:naming`

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

/** A topic under the launch project, in the team's channel. SPEC §6.1's tag order. */
function topic(extra: string[][] = []) {
  return event({
    kind: KIND_BARE_FILE,
    tags: [['d', 'naming'], ['title', 'Launch naming'], ['h', TEAM], ['a', PROJECT], ...extra],
  })
}

function comment(body: string, author = OTHER) {
  return event({
    kind: COMMENT_KIND,
    pubkey: author,
    tags: [['A', TOPIC], ['a', TOPIC], ['K', String(KIND_BARE_FILE)], ['h', TEAM]],
    content: body,
  })
}

type Filter = { kinds?: number[]; authors?: string[] } & Record<string, unknown>

function relay(events: SignedEvent[]) {
  const matches = (e: SignedEvent, filter: Filter) => {
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

describe('a bare file resolves with no manifest anywhere', () => {
  it('has a title, a card, the plain noun for an app name, and its comments', async () => {
    const found = await resolveForeignObject(
      TOPIC,
      relay([topic(), comment('Friday, then'), comment('Agreed', AUTHOR)]),
    )
    assert.ok(found, 'a bare file must resolve without any kind:31990 on the relay')
    assert.equal(found.kind, KIND_BARE_FILE)
    assert.equal(found.slots.title.value, 'Launch naming')
    assert.equal(found.widget, 'card')
    assert.equal(found.appName, 'File')
    assert.equal(found.folder, TEAM)
    assert.deepEqual(
      found.comments.map((c) => c.body),
      ['Friday, then', 'Agreed'],
    )
  })

  it('names the file it sits under, whatever kind that is', async () => {
    /*
      The project's kind has no manifest here either. `parentRef` for every
      other kind is derived from the *parent's* declared `list` slot; a bare
      file names its own parent, so it nests under a kind whose owner never
      declared bare files as children — or under a kind nobody has met.
    */
    const found = await resolveForeignObject(TOPIC, relay([topic()]))
    assert.equal(found?.parentRef, PROJECT)
  })

  it('reads a re-parent from the change stream before the root tag', async () => {
    // The way an issue's `project` field works: the root seeds, a change wins.
    const moved = event({
      kind: CHANGE_KIND,
      pubkey: OTHER,
      tags: [['a', TOPIC], ['field', 'parent'], ['value', `${PROJECT_KIND}:${OTHER}:pricing`], ['h', TEAM]],
    })
    const found = await resolveForeignObject(TOPIC, relay([topic(), moved]))
    assert.equal(found?.parentRef, `${PROJECT_KIND}:${OTHER}:pricing`)
  })

  it('is absent when the file names no parent', async () => {
    const root = event({
      kind: KIND_BARE_FILE,
      tags: [['d', 'naming'], ['title', 'Launch naming'], ['h', TEAM]],
    })
    const found = await resolveForeignObject(TOPIC, relay([root]))
    assert.equal(found?.parentRef, undefined)
  })

  it('costs zero round trips to resolve the manifest', async () => {
    const sent: unknown[] = []
    const spy = async (filters: Record<string, unknown>[]) => {
      sent.push(filters)
      return []
    }
    const resolved = await resolveManifest(
      { kind: KIND_BARE_FILE, pubkey: AUTHOR, identifier: 'naming', relays: [] },
      spy,
    )
    assert.equal(sent.length, 0)
    assert.equal(resolved?.address, BARE_FILE_MANIFEST_ADDRESS)
    assert.equal(resolved?.viaRecommendation, false)
    assert.deepEqual(commentKindsOf(resolved!.manifest), [COMMENT_KIND])
  })
})

describe('no app may claim the bare file', () => {
  it('ignores a published manifest that lists kind:30840', async () => {
    /*
      A specialized app owning the bare file would own every subject nobody has
      built an app for — RFC 0.5 §10.7's whole reason for the kind being
      ownerless. So a `31990` claiming it must change nothing, not merely lose
      a ranking.
    */
    const claimant = event({
      kind: 31990,
      pubkey: OTHER,
      tags: [['d', 'greedy'], ['k', String(KIND_BARE_FILE)]],
      content: JSON.stringify({
        name: 'Greedy',
        projections: {
          [KIND_BARE_FILE]: { widget: 'row', slots: { title: { tag: 'nope' } } },
        },
      }),
    })
    const recommendation = event({
      kind: 31989,
      tags: [['d', String(KIND_BARE_FILE)], ['a', `31990:${OTHER}:greedy`]],
    })
    const found = await resolveForeignObject(TOPIC, relay([claimant, recommendation, topic()]))
    assert.equal(found?.appName, 'File')
    assert.equal(found?.widget, 'card')
    assert.equal(found?.slots.title.value, 'Launch naming')
  })
})

describe('a folder read by containment lists its bare files', () => {
  it('asks for kind:30840 even when no manifest on the relay mentions it', async () => {
    /*
      A stateless folder's kind list used to be derived from published
      manifests alone. With none published for the bare file, a team's topics
      would have been the one thing its own folder view did not show.
    */
    const shipManifest = event({
      kind: 31990,
      pubkey: OTHER,
      tags: [['d', 'ship'], ['k', String(PROJECT_KIND)]],
      content: JSON.stringify({
        name: 'Ship',
        projections: { [PROJECT_KIND]: { widget: 'card', slots: { title: { tag: 'title' } } } },
      }),
    })
    const project = event({
      kind: PROJECT_KIND,
      pubkey: OTHER,
      tags: [['d', 'launch'], ['title', 'Launch'], ['h', TEAM]],
    })
    const contents = await resolveFolderContents(TEAM, relay([shipManifest, project, topic()]))
    assert.equal(contents.source, 'channel')
    const kinds = contents.files.map((f) => f.kind).sort((a, b) => a - b)
    assert.deepEqual(kinds, [KIND_BARE_FILE, PROJECT_KIND])
    const found = contents.files.find((f) => f.kind === KIND_BARE_FILE)
    assert.equal(found?.parentRef, PROJECT)
    assert.equal(found?.slots.title.value, 'Launch naming')
  })

  it('lists them with nothing else published at all', async () => {
    const contents = await resolveFolderContents(TEAM, relay([topic()]))
    assert.equal(contents.files.length, 1)
    assert.equal(contents.files[0].kind, KIND_BARE_FILE)
  })
})

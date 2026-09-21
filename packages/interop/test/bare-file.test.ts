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
  buildActionEvent,
  commentKindsOf,
  createProjectionCache,
  resolveFolderContents,
  resolveForeignEvent,
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

  it('consults NIP-89 for nothing but where to open it', async () => {
    /*
      The projection is a constant and no `#k` or `kind:31989` lookup is made
      for it. The one request is the handler sweep that finds the app rendering
      every file's conversation (FOL-17) — and with nothing on the relay it
      answers nothing, and the file resolves regardless.
    */
    const sent: Record<string, unknown>[][] = []
    const spy = async (filters: Record<string, unknown>[]) => {
      sent.push(filters)
      return []
    }
    const resolved = await resolveManifest(
      { kind: KIND_BARE_FILE, pubkey: AUTHOR, identifier: 'naming', relays: [] },
      spy,
    )
    assert.equal(sent.length, 1)
    assert.deepEqual(
      sent[0].map((f) => f.kinds),
      [[31990]],
      'the only request is the sweep for every manifest — never a #k or a recommendation',
    )
    assert.ok(!sent[0].some((f) => '#k' in f || '#d' in f))
    assert.equal(resolved?.address, BARE_FILE_MANIFEST_ADDRESS)
    assert.equal(resolved?.viaRecommendation, false)
    assert.equal(resolved?.webTemplate, undefined)
    assert.deepEqual(commentKindsOf(resolved!.manifest), [COMMENT_KIND])
  })
})

/** A generic app — RFC 0.5 §10.7 — that says it renders every file's conversation. */
function conversationApp(extra: { pubkey?: string; d?: string; web?: string; content?: object } = {}) {
  const d = extra.d ?? 'estiva-peek'
  return event({
    kind: 31990,
    pubkey: extra.pubkey ?? OTHER,
    tags: [
      ['d', d],
      ['web', extra.web ?? 'https://peek.example/o/<bech32>', 'naddr'],
    ],
    content: JSON.stringify({ name: 'Peek', aspect: 'conversation', projections: {}, ...extra.content }),
  })
}

describe('a bare file opens in the app that renders its conversation', () => {
  it('derives openUrl from that app’s web template, with the file’s own naddr', async () => {
    const found = await resolveForeignObject(TOPIC, relay([conversationApp(), topic()]))
    assert.ok(found)
    assert.ok(found.openUrl?.startsWith('https://peek.example/o/naddr1'), found.openUrl)
    assert.equal(found.openUrl, `https://peek.example/o/${found.naddr}`)
    // The projection is still the built-in one; only the link is Peek's.
    assert.equal(found.appName, 'File')
    assert.equal(found.widget, 'card')
  })

  it('links every bare file in a folder, from one sweep however many people started one', async () => {
    const sent: Record<string, unknown>[][] = []
    const events = [
      conversationApp(),
      topic(),
      event({
        kind: KIND_BARE_FILE,
        pubkey: OTHER,
        tags: [['d', 'retro'], ['title', 'Retro'], ['h', TEAM]],
      }),
    ]
    const relayWithSpy = relay(events)
    const contents = await resolveFolderContents(TEAM, async (filters) => {
      sent.push(filters)
      return relayWithSpy(filters)
    })
    assert.equal(contents.files.length, 2)
    for (const file of contents.files) {
      assert.equal(file.openUrl, `https://peek.example/o/${file.naddr}`)
    }
    const sweeps = sent.flat().filter((f) => Array.isArray(f.kinds) && (f.kinds as number[]).includes(31990))
    // One from the containment read's own kind list, one to find the opener —
    // not one per author.
    assert.equal(sweeps.length, 2)
  })

  it('has nowhere to open when no manifest declares the aspect', async () => {
    /*
      A specialized app's manifest — Ship's — says nothing about aspects, and a
      generic app that declares one but publishes no `web` template cannot be
      linked to. Neither is an error; the card simply is not a link.
    */
    const ship = event({
      kind: 31990,
      pubkey: OTHER,
      tags: [['d', 'ship'], ['k', String(PROJECT_KIND)], ['web', 'https://ship.example/o/<bech32>', 'naddr']],
      content: JSON.stringify({
        name: 'Ship',
        projections: { [PROJECT_KIND]: { widget: 'card', slots: { title: { tag: 'title' } } } },
      }),
    })
    const withoutTemplate = event({
      kind: 31990,
      pubkey: OTHER,
      tags: [['d', 'quiet']],
      content: JSON.stringify({ name: 'Quiet', aspect: 'conversation', projections: {} }),
    })
    const found = await resolveForeignObject(TOPIC, relay([ship, withoutTemplate, topic()]))
    assert.ok(found)
    assert.equal(found.openUrl, undefined)
  })

  it('offers the link even when the file itself cannot be read', async () => {
    // The `unreachable` case: "you may not have access" is exactly when a
    // person wants to open it in the app that can show it.
    const found = await resolveForeignObject(TOPIC, relay([conversationApp()]))
    assert.equal(found?.unreachable, true)
    assert.equal(found?.openUrl, `https://peek.example/o/${found?.naddr}`)
  })

  it('remembers the opener once, not once per author', async () => {
    const cache = createProjectionCache()
    const sent: Record<string, unknown>[][] = []
    const spied = relay([conversationApp()])
    const query = async (filters: Record<string, unknown>[]) => {
      sent.push(filters)
      return spied(filters)
    }
    for (const pubkey of [AUTHOR, OTHER]) {
      const resolved = await resolveManifest(
        { kind: KIND_BARE_FILE, pubkey, identifier: 'x', relays: [] },
        query,
        cache,
      )
      assert.equal(resolved?.webTemplate, 'https://peek.example/o/<bech32>')
    }
    assert.equal(sent.length, 1)
  })
})

describe('a comment resolves through the built-in manifest, because no app owns kind:1111', () => {
  // A pasted thread link names its root comment by event id (FOL-38). Every
  // app writes `kind:1111` and none claims it with a `k` tag, so before this
  // `resolveForeignEvent` on one answered null and the link stayed a link.
  it('draws the comment as a message: the author as its title, the text as its body', async () => {
    const root = comment('we should call it Launch')
    const found = await resolveForeignEvent(root.id, relay([conversationApp(), topic(), root]))
    assert.ok(found)
    assert.equal(found.kind, COMMENT_KIND)
    assert.equal(found.eventId, root.id)
    assert.equal(found.address, undefined)
    assert.deepEqual(found.widget, ['message', 'card'])
    assert.equal(found.slots.title?.value, OTHER)
    assert.equal(found.slots.title?.isPubkey, true)
    assert.equal(found.slots.body?.value, 'we should call it Launch')
    assert.equal(found.appName, 'File')
  })

  it('opens in the conversation app, by the nevent template when it publishes one', async () => {
    const root = comment('hello')
    const opener = event({
      kind: 31990,
      pubkey: OTHER,
      tags: [
        ['d', 'estiva-peek'],
        ['web', 'https://peek.example/o/<bech32>', 'naddr'],
        ['web', 'https://peek.example/e/<bech32>', 'nevent'],
      ],
      content: JSON.stringify({ name: 'Peek', aspect: 'conversation', projections: {} }),
    })
    const found = await resolveForeignEvent(root.id, relay([opener, topic(), root]))
    assert.ok(found?.openUrl?.startsWith('https://peek.example/e/nevent1'), found?.openUrl)
  })

  it('still resolves, with nowhere to open, when no app declares the aspect', async () => {
    const root = comment('hello')
    const found = await resolveForeignEvent(root.id, relay([topic(), root]))
    assert.ok(found)
    assert.equal(found.openUrl, undefined)
  })

  it('caches the opener per template, so a file and a comment in it never share a wrong link', async () => {
    const cache = createProjectionCache()
    const root = comment('hello')
    const opener = event({
      kind: 31990,
      pubkey: OTHER,
      tags: [
        ['d', 'estiva-peek'],
        ['web', 'https://peek.example/o/<bech32>', 'naddr'],
        ['web', 'https://peek.example/e/<bech32>', 'nevent'],
      ],
      content: JSON.stringify({ name: 'Peek', aspect: 'conversation', projections: {} }),
    })
    const events = relay([opener, topic(), root])
    const file = await resolveForeignObject(TOPIC, events, undefined, 0, cache)
    const thread = await resolveForeignEvent(root.id, events, undefined, cache)
    assert.ok(file?.openUrl?.startsWith('https://peek.example/o/'), file?.openUrl)
    assert.ok(thread?.openUrl?.startsWith('https://peek.example/e/'), thread?.openUrl)
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

describe('a bare file can be renamed and deleted, because its manifest says so', () => {
  /*
    FOL-33. A consumer offering Rename and Delete on a bare file and nothing on
    a Ship issue does so because this manifest declares `rename` and `delete`
    and Ship's does not — the same rule FOL-31 set for `comment`. Nothing here
    asks what kind the object is.
  */
  const build = (actionId: string, value = '', manifest = BARE_MANIFEST) =>
    buildActionEvent({
      manifest,
      kind: KIND_BARE_FILE,
      address: TOPIC,
      objectAuthor: AUTHOR,
      folder: TEAM,
      actionId,
      value,
      pubkey: OTHER,
      createdAtMs: 1_700_000_000_000,
    })
  let BARE_MANIFEST: Parameters<typeof buildActionEvent>[0]['manifest']

  it('declares comment, rename and delete, each as the control a consumer draws', async () => {
    const found = await resolveForeignObject(TOPIC, relay([topic()]))
    assert.deepEqual(
      found?.actions.map((a) => [a.id, a.control, a.effect]),
      [
        ['comment', 'text', 'writes'],
        ['rename', 'text', 'writes'],
        ['delete', 'confirm', 'destructive'],
      ],
    )
    // `rename` sets the field the title slot reads — one fact, two views (PEEK-18).
    assert.equal(found?.actions.find((a) => a.id === 'rename')?.field, found?.slots.title.field)
    const resolved = await resolveManifest({ kind: KIND_BARE_FILE, pubkey: AUTHOR, identifier: 'naming', relays: [] }, relay([]))
    BARE_MANIFEST = resolved!.manifest
  })

  it('renames with a title change anyone in the team may publish, and the title folds it', async () => {
    const built = build('rename', 'Launch naming, second pass')
    assert.notEqual(typeof built, 'string', String(built))
    const change = built as Exclude<typeof built, string>
    assert.equal(change.kind, CHANGE_KIND)
    assert.equal(change.pubkey, OTHER, 'a non-author renames: it is a change, not a re-publish')
    assert.deepEqual(
      change.tags.filter((t) => t[0] !== 'ts'),
      [['a', TOPIC], ['field', 'title'], ['value', 'Launch naming, second pass'], ['h', TEAM]],
    )
    const renamed = event({ ...change, id: 'f'.repeat(64), sig: '' } as SignedEvent)
    const found = await resolveForeignObject(TOPIC, relay([topic(), renamed]))
    assert.equal(found?.slots.title.value, 'Launch naming, second pass')
  })

  it('deletes with a NIP-09 request naming the address, for the relay to adjudicate', () => {
    const built = build('delete')
    assert.notEqual(typeof built, 'string', String(built))
    const request = built as Exclude<typeof built, string>
    assert.equal(request.kind, 5)
    assert.deepEqual(request.tags, [['a', TOPIC], ['k', String(KIND_BARE_FILE)]])
    assert.equal(request.content, '')
    assert.ok(!request.tags.some((t) => t[0] === 'e'), 'an `e` tag would route the relay to the wrong branch')
  })

  it('offers no deletion on a kind whose manifest declares none', async () => {
    // Ship's shape: a change action and a comment, and nothing emitting kind:5.
    const ship = event({
      kind: 31990,
      pubkey: OTHER,
      tags: [['d', 'ship'], ['k', String(PROJECT_KIND)]],
      content: JSON.stringify({
        name: 'Ship',
        records: { changeKind: CHANGE_KIND, targetTag: 'a', fieldTag: 'field', valueTag: 'value' },
        projections: { [PROJECT_KIND]: { widget: 'card', slots: { title: { tag: 'title' } } } },
        actions: [
          { id: 'set-status', label: 'Set status', appliesTo: String(PROJECT_KIND), emits: { kind: CHANGE_KIND, field: 'status' }, input: { type: 'string' } },
          { id: 'comment', label: 'Comment', appliesTo: String(PROJECT_KIND), emits: { kind: COMMENT_KIND, scope: 'address' }, input: { type: 'string' } },
        ],
      }),
    })
    const project = event({ kind: PROJECT_KIND, pubkey: OTHER, tags: [['d', 'launch'], ['title', 'Launch'], ['h', TEAM]] })
    const found = await resolveForeignObject(PROJECT, relay([ship, project]))
    assert.deepEqual(found?.actions.map((a) => a.id), ['set-status', 'comment'])
    assert.ok(!found?.actions.some((a) => a.control === 'confirm'))
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

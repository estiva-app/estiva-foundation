/**
 * One link reader and one Mentioned-in reader for every app (PEEKM-7; SPEC
 * §7.7, §13.1, §6.8). What a link names, the tags a send and an edit carry for
 * it, where its card opens, and which files list a comment while its latest
 * words link them — asserted on the tags that would go on the wire and the
 * rows a reader gets back, over a relay held in memory.
 */
import { test, describe, mock } from 'node:test'
import assert from 'node:assert/strict'
import { encodeNaddr, toRenderTree } from '@estiva-app/protocol'
import { buildActionEvent, linkReader, readMentionedIn, writtenOpenerOf } from '../dist/index.js'

const SHIP = 'a'.repeat(64)
const OTHER = 'b'.repeat(64)
const WRITER = 'c'.repeat(64)
const READER = 'd'.repeat(64)
const FOLDER = '7b32200c-e4c0-4216-b79a-8490fc05e0bd'
const D1 = '11111111-1111-4111-8111-111111111111'
const D2 = '22222222-2222-4222-8222-222222222222'
const SHARED = '33333333-3333-4333-8333-333333333333'
const ISSUE1 = `30851:${SHIP}:${D1}`
const ISSUE2 = `30851:${SHIP}:${D2}`
const PAGE = `30842:${OTHER}:page`
const MESSAGE = 'e'.repeat(64)
const URL1 = `https://ship.estiva.app/issue/first-${D1}`
const URL2 = `https://ship.estiva.app/issue/second-${D2}`

const manifest = {
  id: 'm'.repeat(64),
  kind: 31990,
  pubkey: SHIP,
  created_at: 1,
  content: '',
  tags: [
    ['web', 'https://ship.estiva.app/o/<bech32>', 'naddr'],
    ['web', 'https://peek.estiva.app/e/<bech32>', 'nevent'],
    ['urls', 'https://ship.estiva.app/issue/<slug>-<d>', '30851'],
    ['urls', 'https://ship.estiva.app/issue/<slug>-<d>#block-<block>', '30851'],
    ['urls', 'https://ship.estiva.app/note/<slug>-<d>', '1'],
    ['urls', 'https://peek.estiva.app/message/<id>', '9'],
  ],
}

let serial = 0
const event = (kind, pubkey, tags, content = '', created_at = 1000 + serial) => ({
  id: (++serial).toString(16).padStart(64, '0'),
  kind,
  pubkey,
  created_at,
  tags,
  content,
  sig: '',
})

/** A relay in memory: kinds, ids, `#d`, `#a`, `#e`, limit. `reads` counts the queries. */
function relayOf(events) {
  const relay = {
    reads: 0,
    query: async (filters) => {
      relay.reads += 1
      return filters.flatMap((f) => {
        const hits = events.filter(
          (e) =>
            (!f.kinds || f.kinds.includes(e.kind)) &&
            (!f.ids || f.ids.includes(e.id)) &&
            ['d', 'a', 'e'].every((name) => !f[`#${name}`] || e.tags.some((t) => t[0] === name && f[`#${name}`].includes(t[1]))),
        )
        return f.limit ? hits.slice(0, f.limit) : hits
      })
    },
  }
  return relay
}

const issues = [
  manifest,
  event(30851, SHIP, [['d', D1]]),
  event(30851, SHIP, [['d', D2]]),
  event(30851, SHIP, [['d', SHARED]]),
  event(30851, OTHER, [['d', SHARED]]),
  event(1, SHIP, [['d', D1]]),
]
const marker = (body) => toRenderTree(body, 'marker')

describe('the tags a comment earns for its links', () => {
  test('a Ship issue link alone on its line earns its a; one in code, the words of a link on words, and http earn nothing', async () => {
    const links = linkReader({ query: relayOf(issues).query })
    const body = [URL1, `\`${URL2}\``, `[${URL2}](https://example.com/x)`, `http://ship.estiva.app/issue/second-${D2}`].join('\n')
    assert.deepEqual(await links.tagsFor(marker(body), {}), [['a', ISSUE1]])
  })

  test('[A](B) is one link to B', async () => {
    const links = linkReader({ query: relayOf(issues).query })
    assert.deepEqual(await links.tagsFor(marker(`see [${URL1}](${URL2})`), {}), [['a', ISSUE2]])
  })

  test('the comment’s own file earns no a, the message it answers no q, and another message a q', async () => {
    const links = linkReader({ query: relayOf(issues).query })
    const other = 'f'.repeat(64)
    const body = `${URL1} ${URL2} https://peek.estiva.app/message/${MESSAGE} https://peek.estiva.app/message/${other}`
    assert.deepEqual(await links.tagsFor(marker(body), { file: ISSUE1, parent: MESSAGE }), [
      ['a', ISSUE2],
      ['q', other],
    ])
  })

  test('a nostr: reference earns the same a as a link to the same file', async () => {
    const links = linkReader({ query: relayOf(issues).query })
    const naddr = `nostr:${encodeNaddr({ kind: 30851, pubkey: SHIP, identifier: D2, relays: [] })}`
    assert.deepEqual(await links.tagsFor(marker(`${naddr} and ${URL1}`), {}), [
      ['a', ISSUE2],
      ['a', ISSUE1],
    ])
  })

  test('a link to one block earns its file’s a and a part on a send, and the a alone on an edit', async () => {
    const links = linkReader({ query: relayOf(issues).query })
    const body = marker(`${URL1}#block-b1`)
    assert.deepEqual(await links.tagsFor(body, {}), [
      ['a', ISSUE1],
      ['part', ISSUE1, 'b1'],
    ])
    assert.deepEqual(await links.tagsFor(body, {}, { edit: true }), [['a', ISSUE1]])
  })

  test('a d two authors hold, and a d under a kind that is not addressable, name nothing', async () => {
    const links = linkReader({ query: relayOf(issues).query })
    const body = `https://ship.estiva.app/issue/x-${SHARED} https://ship.estiva.app/note/n-${D1}`
    assert.deepEqual(await links.tagsFor(marker(body), {}), [])
  })

  test('a link not answered in time earns nothing, and the send goes on', async () => {
    mock.timers.enable({ apis: ['setTimeout'] })
    try {
      const links = linkReader({ query: () => new Promise(() => {}) })
      const tags = links.tagsFor(marker(URL1), {}, { waitMs: 3000 })
      await Promise.resolve()
      mock.timers.tick(3000)
      assert.deepEqual(await tags, [])
    } finally {
      mock.timers.reset()
    }
  })
})

describe('asking what a link names', () => {
  test('a read that failed is asked again, and an answer is asked once', async () => {
    const relay = relayOf(issues)
    let fail = true
    const links = linkReader({ query: (f) => (fail ? Promise.reject(new Error('429')) : relay.query(f)), retries: 0 })
    await assert.rejects(links.ask([URL1]))
    assert.equal(links.known(URL1), undefined)
    fail = false
    await links.ask([URL1])
    assert.equal(links.known(URL1), ISSUE1)
    const reads = relay.reads
    await links.ask([URL1])
    assert.equal(relay.reads, reads)
  })
})

describe('a manifest read that came back empty', () => {
  test('is asked again, so a link read before the manifests arrived still names its file', async () => {
    const relay = relayOf(issues)
    let empty = true
    const links = linkReader({ query: relay.query, manifests: async () => (empty ? [] : [manifest]) })
    await assert.rejects(links.ask([URL1]))
    assert.equal(links.answered(URL1), false)
    empty = false
    await links.ask([URL1])
    assert.equal(links.known(URL1), ISSUE1)
  })
})

describe('where a card written as a URL opens', () => {
  test('https on a declared host opens; http, and a host no app declares, do not', async () => {
    const links = linkReader({ query: relayOf(issues).query })
    await links.ask([URL1])
    assert.equal(links.opener(URL1, undefined, 'https://leaf.estiva.app'), URL1)
    assert.equal(links.opener(URL1.replace('https', 'http'), undefined, 'https://leaf.estiva.app'), undefined)
    assert.equal(writtenOpenerOf('https://evil.example/issue/x', undefined, 'https://peek.estiva.app', links.declaredOrigins()), undefined)
  })
})

describe('a file lists a comment while its latest words link it', () => {
  const page = (file) => [['A', file], ['K', file.split(':')[0]], ['P', OTHER], ['a', file], ['h', FOLDER]]

  test('an edit that swaps the link moves the comment from the first issue to the second', async () => {
    const comment = event(1111, WRITER, [...page(PAGE), ['a', ISSUE1]], `look: ${URL1}`)
    const edit = event(40003, WRITER, [['e', comment.id], ['h', FOLDER], ['a', ISSUE2]], `look: ${URL2}`)
    const relay = relayOf([...issues, comment, edit])
    const links = linkReader({ query: relay.query })
    assert.deepEqual((await readMentionedIn(relay.query, ISSUE1, { links })).map((m) => m.event.id), [])
    const second = await readMentionedIn(relay.query, ISSUE2, { links })
    assert.deepEqual(second.map((m) => [m.event.id, m.body]), [[comment.id, `look: ${URL2}`]])
  })

  test('the file’s own conversation, an edit by someone else, and an edit of a message nobody can read list nothing', async () => {
    const own = event(1111, WRITER, page(ISSUE1), `here: ${URL1}`)
    const comment = event(1111, WRITER, [...page(PAGE)], 'nothing linked')
    const forged = event(40003, READER, [['e', comment.id], ['a', ISSUE1]], URL1)
    const orphan = event(40003, WRITER, [['e', '9'.repeat(64)], ['a', ISSUE1]], URL1)
    const relay = relayOf([...issues, own, comment, forged, orphan])
    assert.deepEqual(await readMentionedIn(relay.query, ISSUE1, { links: linkReader({ query: relay.query }) }), [])
  })

  test('a comment whose link cannot be read keeps its row while its latest version points at the file', async () => {
    const comment = event(1111, WRITER, [...page(PAGE), ['a', ISSUE1]], URL1)
    const relay = relayOf([...issues, comment])
    const links = linkReader({ query: (f) => (f[0]['#d'] ? Promise.reject(new Error('429')) : relay.query(f)), retries: 0 })
    assert.deepEqual((await readMentionedIn(relay.query, ISSUE1, { links })).map((m) => m.event.id), [comment.id])
  })
})

describe('opening a file’s Mentioned in asks the relay about a capped number of links', () => {
  const page = (file) => [['A', file], ['K', file.split(':')[0]], ['P', OTHER], ['a', file], ['h', FOLDER]]
  const appLink = (i) => `https://ship.estiva.app/issue/spam-00000000-0000-4000-8000-${String(i).padStart(12, '0')}`
  const linksOf = (from, count) => Array.from({ length: count }, (_, i) => appLink(from + i)).join(' ')
  /** A link reader over `relay` that counts the `#d` reads a link costs the viewer. */
  const counted = (relay) => {
    const reads = { d: 0 }
    const links = linkReader({
      query: (filters) => {
        reads.d += filters.filter((f) => f['#d']).length
        return relay.query(filters)
      },
    })
    return { links, reads }
  }

  test('a comment holding 300 app links costs the viewer at most 24 link reads, and lists nothing when none of those names the file', async () => {
    const spam = event(1111, WRITER, [...page(PAGE), ['a', ISSUE1]], linksOf(0, 300))
    const relay = relayOf([...issues, spam])
    const { links, reads } = counted(relay)
    const listed = await readMentionedIn(relay.query, ISSUE1, { links })
    assert.ok(reads.d <= 24, `asked the relay about ${reads.d} links`)
    assert.deepEqual(listed, [])
  })

  test('twenty newer comments of eight links cost at most 64 link reads a read; an older comment linking the file keeps its row until asked', async () => {
    const comment = event(1111, WRITER, [...page(PAGE), ['a', ISSUE1]], `look: ${URL1}`, 1000)
    const crowd = Array.from({ length: 20 }, (_, i) => event(1111, WRITER, [...page(PAGE), ['a', ISSUE1]], linksOf(i * 8, 8), 2000 + i))
    const relay = relayOf([...issues, comment, ...crowd])
    const { links, reads } = counted(relay)
    const first = await readMentionedIn(relay.query, ISSUE1, { links })
    assert.ok(reads.d <= 64, `asked the relay about ${reads.d} links`)
    assert.ok(first.some((m) => m.event.id === comment.id))
    await readMentionedIn(relay.query, ISSUE1, { links })
    const third = await readMentionedIn(relay.query, ISSUE1, { links })
    assert.deepEqual(third.map((m) => m.event.id), [comment.id])
  })

  test('the newest comments’ links are asked first: an older comment’s link waits for a later read', async () => {
    const older = event(1111, WRITER, [...page(PAGE), ['a', ISSUE1]], `look: ${URL1}`, 1000)
    const newer = Array.from({ length: 8 }, (_, i) => event(1111, WRITER, [...page(PAGE), ['a', ISSUE1]], linksOf(500 + i * 8, 8), 2000 + i))
    const relay = relayOf([...issues, older, ...newer])
    const { links } = counted(relay)
    await readMentionedIn(relay.query, ISSUE1, { links })
    assert.equal(links.answered(URL1), false)
    await readMentionedIn(relay.query, ISSUE1, { links })
    assert.equal(links.known(URL1), ISSUE1)
  })

  test('a comment whose link to the file is among its first links still lists, confirmed, beside a comment holding 300 links', async () => {
    const spam = event(1111, WRITER, [...page(PAGE), ['a', ISSUE1]], linksOf(0, 300), 3000)
    const comment = event(1111, WRITER, [...page(PAGE), ['a', ISSUE1]], `${linksOf(1000, 3)} and ${URL1}`, 2000)
    const relay = relayOf([...issues, spam, comment])
    const { links } = counted(relay)
    const listed = await readMentionedIn(relay.query, ISSUE1, { links })
    assert.deepEqual(listed.map((m) => m.event.id), [comment.id])
    assert.equal(links.known(URL1), ISSUE1)
  })

  test('a link past a comment’s first 24 names nothing, even one the reader already knows names the file', async () => {
    const comment = event(1111, WRITER, [...page(PAGE), ['a', ISSUE1]], `${linksOf(2000, 30)} and ${URL1}`)
    const relay = relayOf([...issues, comment])
    const { links } = counted(relay)
    await links.ask([URL1])
    assert.deepEqual(await readMentionedIn(relay.query, ISSUE1, { links }), [])
  })
})

describe('the agent’s comment carries the link tags it is handed', () => {
  test('a, q and part are written after the people; its own file and anything else are left out', () => {
    const shipManifest = {
      records: { changeKind: 1851, targetTag: 'a', fieldTag: 'field', valueTag: 'value', order: ['ts'] },
      actions: [{ id: 'comment', label: 'Comment', appliesTo: '30851', emits: { kind: 1111, scope: 'address' } }],
    }
    const built = buildActionEvent({
      manifest: shipManifest,
      kind: 30851,
      address: ISSUE1,
      objectAuthor: SHIP,
      folder: FOLDER,
      actionId: 'comment',
      value: URL2,
      pubkey: WRITER,
      createdAtMs: 1_700_000_000_000,
      linkTags: [['a', ISSUE2], ['a', ISSUE1], ['q', MESSAGE], ['p', READER], ['part', ISSUE2, 'b1']],
    })
    assert.deepEqual(
      built.tags.filter((t) => ['a', 'q', 'p', 'part'].includes(t[0])),
      [['a', ISSUE1], ['p', SHIP], ['a', ISSUE2], ['q', MESSAGE], ['part', ISSUE2, 'b1']],
    )
  })
})

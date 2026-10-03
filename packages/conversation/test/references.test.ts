/*
  CON-26's `[` ranking (PEE-21): two capped sections, tiers with nothing
  typed, the match first once you type, and the relay search tier that never
  holds up the rows already there.
*/
import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { decodeNaddr } from '@estiva-app/protocol'
import {
  FILE_TIER,
  fileReference,
  MESSAGE_TIER,
  rankReferences,
  REFERENCE_CAPS,
  referenceMatch,
  referenceSearch,
  referenceTagsFor,
  type ReferenceCandidate,
} from '../dist/index.js'

const PK = 'a'.repeat(64)
const file = (d: string, title: string, tier: number, extra: Partial<ReferenceCandidate> = {}): ReferenceCandidate => ({
  id: `30851:${PK}:${d}`,
  uri: fileReference(`30851:${PK}:${d}`),
  type: 'issue',
  kind: 30851,
  title,
  caption: '',
  tier,
  ...extra,
})
const message = (id: string, author: string, text: string, tier: number, at: number): ReferenceCandidate => ({
  id,
  uri: `nostr:nevent-${id}`,
  type: 'message',
  kind: 9,
  title: author,
  caption: text,
  search: text,
  tier,
  at,
})
const titles = (rows: readonly ReferenceCandidate[]) => rows.map((r) => r.title)

describe('referenceMatch', () => {
  it('ranks whole, start, word start, anywhere', () => {
    assert.equal(referenceMatch('Unread dots', 'unread dots'), 4)
    assert.equal(referenceMatch('Unread dots', 'unr'), 3)
    assert.equal(referenceMatch('Typing [ finds the issue', 'finds'), 2)
    assert.equal(referenceMatch('Typing [ finds the issue', 'ssue'), 1)
    assert.equal(referenceMatch('Typing [ finds the issue', 'issue typing'), 1)
    assert.equal(referenceMatch('Typing [ finds the issue', 'ssue yping'), 0)
    assert.equal(referenceMatch('Anything', '   '), 0)
  })
})

describe('rankReferences', () => {
  const files = [
    file('recent-old', 'Relay rate limits', FILE_TIER.recent, { at: 100 }),
    file('folder', 'Unread dots in the sidebar', FILE_TIER.folder),
    file('recent-new', 'Unread dots on Desk', FILE_TIER.recent, { at: 200 }),
    file('search', 'Unread', FILE_TIER.search),
  ]

  it('with nothing typed, the tiers set the order and search offers nothing', () => {
    const { files: shown } = rankReferences({ messages: [], files, query: '' })
    assert.deepEqual(titles(shown), ['Unread dots in the sidebar', 'Unread dots on Desk', 'Relay rate limits'])
  })

  it('once you type, a better title match beats a closer tier', () => {
    const { files: shown } = rankReferences({ messages: [], files, query: 'unread' })
    assert.deepEqual(titles(shown), ['Unread', 'Unread dots in the sidebar', 'Unread dots on Desk'])
  })

  it('drops what does not match what was typed', () => {
    const { files: shown } = rankReferences({ messages: [], files, query: 'rate' })
    assert.deepEqual(titles(shown), ['Relay rate limits'])
  })

  it('offers a closed issue after an open one on an equal match, and keeps it', () => {
    const shown = rankReferences({
      messages: [],
      files: [file('done', 'Unread dots', FILE_TIER.folder, { closed: true }), file('open', 'Unread dots', FILE_TIER.recent)],
      query: 'unread dots',
    }).files
    assert.deepEqual(shown.map((f) => f.id.split(':')[2]), ['open', 'done'])
  })

  it('the app’s own kinds only break the ties left', () => {
    const project = { ...file('p', 'Composer', FILE_TIER.folder), kind: 30850, type: 'project' as const }
    const issue = file('i', 'Composer', FILE_TIER.folder)
    assert.deepEqual(rankReferences({ messages: [], files: [project, issue], query: 'composer', ownKinds: [30851] }).files.map((f) => f.kind), [30851, 30850])
    assert.deepEqual(rankReferences({ messages: [], files: [project, issue], query: 'composer', ownKinds: [30850] }).files.map((f) => f.kind), [30850, 30851])
  })

  it('keeps a file once, at its closest tier', () => {
    const shown = rankReferences({ messages: [], files: [file('x', 'Same', FILE_TIER.search), file('x', 'Same', FILE_TIER.folder)], query: '' }).files
    assert.equal(shown.length, 1)
    assert.equal(shown[0]!.tier, FILE_TIER.folder)
  })

  it('messages: this thread first, newest first, then the parent file’s', () => {
    const messages = [
      message('p1', 'Ana', 'on the file', MESSAGE_TIER.parent, 50),
      message('h1', 'Ben', 'older here', MESSAGE_TIER.here, 10),
      message('h2', 'Cy', 'newer here', MESSAGE_TIER.here, 20),
    ]
    assert.deepEqual(rankReferences({ messages, files: [], query: '' }).messages.map((m) => m.id), ['h2', 'h1', 'p1'])
    assert.deepEqual(rankReferences({ messages, files: [], query: 'file' }).messages.map((m) => m.id), ['p1'])
    assert.deepEqual(rankReferences({ messages, files: [], query: 'ana' }).messages.map((m) => m.id), ['p1'])
  })

  it('an archived file goes after every other row of the same match, typed or not', () => {
    const files = [
      file('old', 'Roadmap', FILE_TIER.folder, { archived: true }),
      file('done', 'Roadmap review', FILE_TIER.search, { closed: true }),
      file('live', 'Roadmap draft', FILE_TIER.recent),
    ]
    assert.deepEqual(titles(rankReferences({ messages: [], files, query: '' }).files), ['Roadmap draft', 'Roadmap'])
    assert.deepEqual(titles(rankReferences({ messages: [], files, query: 'road' }).files), ['Roadmap draft', 'Roadmap review', 'Roadmap'])
    assert.deepEqual(titles(rankReferences({ messages: [], files, query: 'roadmap' }).files)[0], 'Roadmap', 'an exact title still wins')
  })

  it('caps each section so neither crowds out the other', () => {
    const many = Array.from({ length: 20 }, (_, i) => file(`f${i}`, `File ${i}`, FILE_TIER.folder))
    const chat = Array.from({ length: 20 }, (_, i) => message(`m${i}`, 'Ana', `line ${i}`, MESSAGE_TIER.here, i))
    const ranked = rankReferences({ messages: chat, files: many, query: '' })
    assert.equal(ranked.messages.length, REFERENCE_CAPS.messages)
    assert.equal(ranked.files.length, REFERENCE_CAPS.files)
  })
})

describe('fileReference', () => {
  it('is the naddr a paste carries, with no relay hint, and earns the same `a`', () => {
    const address = `30851:${PK}:2c3e45f8-029a-4998-8eb3-b49177986605`
    const uri = fileReference(address)
    assert.match(uri, /^nostr:naddr1/)
    assert.deepEqual(decodeNaddr(uri.slice('nostr:'.length)), { kind: 30851, pubkey: PK, identifier: '2c3e45f8-029a-4998-8eb3-b49177986605', relays: [] })
    assert.deepEqual(referenceTagsFor(`see ${uri}`), [['a', address]])
  })

  it('refuses what is not an address', () => {
    assert.throws(() => fileReference('not-an-address'))
  })
})

describe('referenceSearch', () => {
  const tick = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))

  it('answers now from what it holds and asks the relay behind it', async () => {
    const asked: string[] = []
    const source = referenceSearch({
      delayMs: 5,
      search: async (query) => {
        asked.push(query)
        return [file(query, `Hit for ${query}`, FILE_TIER.recent)]
      },
    })
    let landed = 0
    source.subscribe(() => landed++)
    assert.deepEqual(source.hits('u'), [], 'too short to ask')
    assert.deepEqual(source.hits('un'), [], 'asked, nothing held yet')
    await tick(20)
    assert.equal(landed, 1)
    const held = source.hits('un')
    assert.equal(held.length, 1)
    assert.equal(held[0]!.tier, FILE_TIER.search, 'a search hit is the search tier whatever the source said')
    assert.deepEqual(titles(source.hits('unr')), ['Hit for un'], 'a longer query shows the shorter one’s hits while it is asked')
    await tick(20)
    assert.deepEqual(titles(source.hits('unr')), ['Hit for unr'])
    assert.deepEqual(asked, ['un', 'unr'])
  })

  it('a failing search is no hits, asked once until the retry pause has passed', async () => {
    let calls = 0
    const source = referenceSearch({
      delayMs: 1,
      retryMs: 30,
      search: async () => {
        calls++
        throw new Error('relay down')
      },
    })
    source.hits('unread')
    await tick(10)
    assert.deepEqual(source.hits('unread'), [])
    await tick(10)
    assert.equal(calls, 1)
    await tick(30)
    source.hits('unread')
    await tick(10)
    assert.equal(calls, 2, 'one blip does not hide the query for the session')
  })

  it('an empty answer that succeeded is kept', async () => {
    let calls = 0
    const source = referenceSearch({
      delayMs: 1,
      retryMs: 5,
      search: async () => {
        calls++
        return []
      },
    })
    source.hits('nothing')
    await tick(20)
    source.hits('nothing')
    await tick(10)
    assert.equal(calls, 1)
  })

  it('a keystroke during the pause asks only for the newest query', async () => {
    const asked: string[] = []
    const source = referenceSearch({
      delayMs: 10,
      search: async (query) => {
        asked.push(query)
        return []
      },
    })
    source.hits('un')
    source.hits('unr')
    source.hits('unre')
    await tick(30)
    assert.deepEqual(asked, ['unre'])
  })
})

/*
  CON-26's `[` ranking (PEE-21): two capped sections, tiers with nothing
  typed, the match first once you type, and the relay search tier that never
  holds up the rows already there.
*/
import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { addrToNaddr, decodeNaddr, decodeNevent } from '@estiva-app/protocol'
import {
  FILE_TIER,
  fileReference,
  MESSAGE_TIER,
  messageCandidate,
  rankReferences,
  REFERENCE_CAPS,
  referenceMatch,
  referenceSearch,
  referenceSectionsOf,
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
  it('ranks whole, start, word start, every word somewhere', () => {
    assert.equal(referenceMatch('Unread dots', 'unread dots'), 8)
    assert.equal(referenceMatch('Unread dots', 'unr'), 3)
    assert.equal(referenceMatch('Typing [ finds the issue', 'finds'), 6)
    assert.equal(referenceMatch('Typing [ finds the issue', 'issue typing'), 5)
    assert.equal(referenceMatch('Anything', '   '), 0)
  })

  it('a title holding a typed word whole ranks above one where it only starts a word', () => {
    const { files } = rankReferences({
      messages: [],
      files: [file('a', 'Shortcuts in Peek', FILE_TIER.search), file('b', 'Remove Short summary from few places', FILE_TIER.search)],
      query: 'short',
    })
    assert.deepEqual(titles(files), ['Remove Short summary from few places', 'Shortcuts in Peek'])
  })

  // SPEC §5.2: the reader's check never drops a hit the relay found.
  const title = 'Remove Short summary from few places'

  it('finds by the start of every typed word, in any order', () => {
    assert.ok(referenceMatch(title, 'Remov') > 0)
    assert.ok(referenceMatch(title, 'remov short') > 0)
    assert.ok(referenceMatch(title, 'short remov') > 0)
    assert.ok(referenceMatch('sum7 202455', 'sum7 20') > 0)
    assert.ok(referenceMatch(title, 'pl few fr') > 0)
  })

  it('finds nothing by the middle of a word', () => {
    assert.equal(referenceMatch(title, 'emove'), 0)
    assert.equal(referenceMatch('Typing [ finds the issue', 'ssue'), 0)
    assert.equal(referenceMatch(title, 'remov hort'), 0)
    assert.equal(referenceMatch(title, 'zqxj'), 0)
  })

  it('ignores punctuation at a typed word’s ends, and a word starts after any', () => {
    assert.ok(referenceMatch(title, 'remov, "short') > 0)
    assert.ok(referenceMatch(title, '(summary)') > 0)
    assert.ok(referenceMatch('Leaf (draft): notes', 'draft notes') > 0)
    assert.ok(referenceMatch('SUM-7 summary', 'sum-7') > 0)
  })

  it('a quoted phrase is those whole words, next to each other and in order', () => {
    assert.ok(referenceMatch(title, '"short summary"') > 0)
    assert.ok(referenceMatch(title, 'remov "short summary"') > 0)
    assert.equal(referenceMatch(title, '"summary short"'), 0)
    assert.equal(referenceMatch(title, '"short summ"'), 0)
    assert.equal(referenceMatch(title, '"remove summary"'), 0)
  })

  it('a quote still open finds by word starts while it is typed', () => {
    assert.ok(referenceMatch(title, '"short summ') > 0)
  })

  it('a minus leaves out a text with a word starting that way', () => {
    assert.equal(referenceMatch(title, 'remov -short'), 0)
    assert.equal(referenceMatch(title, 'remov -sh'), 0)
    assert.ok(referenceMatch(title, 'remov -hort') > 0)
    assert.ok(referenceMatch(title, 'remov -draft') > 0)
    assert.ok(referenceMatch(title, 'remov -') > 0)
  })

  it('a minus before a quoted phrase leaves out a text with those whole words next to each other', () => {
    assert.equal(referenceMatch(title, 'remov -"short summary"'), 0)
    assert.ok(referenceMatch(title, 'remov -"summary short"') > 0)
    assert.ok(referenceMatch('Drafted notes', 'drafted -"draft"') > 0)
    const leaf = ['Leaf 1', 'Leaf probe kit'].filter((t) => referenceMatch(t, 'leaf -"leaf probe"') > 0)
    assert.deepEqual(leaf, ['Leaf 1'])
  })

  it('a minus phrase whose quote is still open leaves nothing out, and is not words to find', () => {
    assert.ok(referenceMatch(title, 'remov -"short summ') > 0)
    assert.ok(referenceMatch(title, 'remov -"zqxj') > 0)
  })

  it('a query that only leaves words out matches nothing', () => {
    assert.equal(referenceMatch(title, '-"short summary"'), 0)
    assert.equal(referenceMatch(title, '-draft'), 0)
    assert.equal(referenceMatch(title, '"" ...'), 0)
  })

  it('or and key:value are ordinary words', () => {
    assert.equal(referenceMatch('Leaf ship', 'leaf or ship'), 0)
    assert.ok(referenceMatch('Leaf or ship', 'leaf or ship') > 0)
    assert.ok(referenceMatch('Moved in: hq', 'in:hq') > 0)
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

  it('never offers the file you are writing in, from any tier', () => {
    const here = `30851:${PK}:folder`
    const again = [...files, file('folder', 'Unread dots in the sidebar', FILE_TIER.recent, { at: 300 })]
    assert.deepEqual(titles(rankReferences({ messages: [], files: again, query: '', exclude: [here] }).files), ['Unread dots on Desk', 'Relay rate limits'])
    assert.deepEqual(titles(rankReferences({ messages: [], files: again, query: 'sidebar', exclude: [here] }).files), [])
  })

  it('an issue’s ref finds it as its title would', () => {
    const withRef = [...files, file('ref', 'Relay search', FILE_TIER.search, { search: 'CON-33' })]
    assert.deepEqual(titles(rankReferences({ messages: [], files: withRef, query: 'con-33' }).files), ['Relay search'])
    assert.deepEqual(titles(rankReferences({ messages: [], files: withRef, query: 'con-3' }).files), ['Relay search'])
    // Only from its start, and only once a digit or hyphen is typed (Miky, 2026-10-05).
    assert.deepEqual(titles(rankReferences({ messages: [], files: withRef, query: 'con' }).files), [])
    assert.deepEqual(titles(rankReferences({ messages: [], files: withRef, query: '33' }).files), [])
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

describe('`[` in every app: Files first, a message found by its own words (widget review item 19)', () => {
  const EVENT = 'e'.repeat(64)
  const CHECKLIST = `30851:${PK}:draft-the-onboarding-checklist`
  const CHECKLIST_URL = 'https://ship.estiva.app/issue/draft-the-onboarding-checklist'
  const resolveLink = (url: string) => (url === CHECKLIST_URL ? CHECKLIST : undefined)
  const nameOf = () => undefined
  const checklist = file('draft-the-onboarding-checklist', 'Draft the onboarding checklist', FILE_TIER.folder)
  const linking = (body: string) => messageCandidate({ id: EVENT, kind: 9, author: 'Ana', body, at: 10 }, MESSAGE_TIER.here, nameOf, { resolveLink })

  it('draws Files above Messages, so the first row is the file when both match', () => {
    const ranked = rankReferences({ messages: [linking('the onboarding plan')], files: [checklist], query: 'onboarding' })
    const sections = referenceSectionsOf(ranked)
    assert.deepEqual(
      sections.map((s) => [s.name, titles(s.items)]),
      [
        ['files', ['Draft the onboarding checklist']],
        ['messages', ['Ana']],
      ],
    )
  })

  it('typing a file’s word finds the file, not a message whose only mention of it is its link', () => {
    const bare = linking(`WR test 3: both ${CHECKLIST_URL}`)
    const unresolved = linking('see https://ship.estiva.app/issue/onboarding-elsewhere')
    const reference = linking(`see nostr:${addrToNaddr(CHECKLIST)}`)
    const ranked = rankReferences({ messages: [bare, unresolved, reference], files: [checklist], query: 'onboarding' })
    assert.deepEqual(titles(ranked.files), ['Draft the onboarding checklist'])
    assert.deepEqual(ranked.messages, [])
    assert.deepEqual(rankReferences({ messages: [reference], files: [], query: 'issue' }).messages, [], 'not by the type word its caption shows')
  })

  it('finds a message by its own words, a link’s words among them, and by who wrote it', () => {
    const words = linking(`read [the onboarding notes](${CHECKLIST_URL}) first`)
    assert.deepEqual(rankReferences({ messages: [words], files: [], query: 'onboarding notes' }).messages.map((m) => m.id), [EVENT])
    assert.deepEqual(rankReferences({ messages: [words], files: [], query: 'ana' }).messages.map((m) => m.id), [EVENT])
  })

  it('a message’s row: its reference with its kind, its author, and a link in its caption read as what it names', () => {
    const row = linking(`WR test 3: both ${CHECKLIST_URL}`)
    const pointer = decodeNevent(row.uri.replace(/^nostr:/, ''))
    assert.deepEqual([pointer.id, pointer.kind], [EVENT, 9])
    assert.equal(row.title, 'Ana')
    assert.equal(row.caption, 'WR test 3: both Issue')
    assert.equal(row.at, 10)
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

  it('a sentence after a query that found nothing asks nothing more', async () => {
    const asked: string[] = []
    const source = referenceSearch({
      delayMs: 1,
      search: async (query) => {
        asked.push(query)
        return []
      },
    })
    source.hits('the')
    await tick(10)
    for (const typed of ['the ', 'the f', 'the figures', 'the figures from', 'The  figures from last week']) {
      assert.deepEqual(source.hits(typed), [])
      await tick(10)
    }
    assert.deepEqual(asked, ['the'], 'one query for the first word, none for the sentence')
    source.hits('them')
    await tick(10)
    assert.deepEqual(asked, ['the', 'them'], 'a longer word is not a longer sentence: it is still asked')
  })

  it('an empty answer for no word at all does not stop the words after it', async () => {
    const asked: string[] = []
    const source = referenceSearch({
      delayMs: 1,
      search: async (query) => {
        asked.push(query)
        return []
      },
    })
    source.hits('--')
    await tick(10)
    source.hits('-- budget')
    await tick(10)
    assert.deepEqual(asked, ['--', '-- budget'])
  })

  it('an empty answer for only words left out does not stop the words after it', async (t) => {
    t.mock.timers.enable({ apis: ['setTimeout'] })
    const asked: string[] = []
    const source = referenceSearch({
      delayMs: 1,
      search: async (query) => {
        asked.push(query)
        return []
      },
    })
    // setImmediate is not mocked: it lets the empty answer land.
    const settle = () => new Promise((done) => setImmediate(done))
    source.hits('-draft')
    t.mock.timers.tick(1)
    await settle()
    source.hits('-draft budget')
    t.mock.timers.tick(1)
    await settle()
    assert.deepEqual(asked, ['-draft', '-draft budget'])
  })

  it('an empty answer while a quote is open does not stop the phrase that closes it', async (t) => {
    t.mock.timers.enable({ apis: ['setTimeout'] })
    const asked: string[] = []
    const source = referenceSearch({
      delayMs: 1,
      search: async (query) => {
        asked.push(query)
        return []
      },
    })
    const settle = () => new Promise((done) => setImmediate(done))
    // `"x -y` leaves y out; `"x -y z"` needs y, so it is not narrower.
    source.hits('"x -y')
    t.mock.timers.tick(1)
    await settle()
    source.hits('"x -y z"')
    t.mock.timers.tick(1)
    await settle()
    assert.deepEqual(asked, ['"x -y', '"x -y z"'])
  })

  it('a failure does not stop a longer query', async () => {
    const asked: string[] = []
    const source = referenceSearch({
      delayMs: 1,
      search: async (query) => {
        asked.push(query)
        if (query === 'the') throw new Error('rate limited')
        return []
      },
    })
    source.hits('the')
    await tick(10)
    source.hits('the figures')
    await tick(10)
    assert.deepEqual(asked, ['the', 'the figures'])
  })
})

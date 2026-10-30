/*
  PEEKM-6: `@` offers one list of people in every app — the roster's named
  profiles, agents included, never the viewer, by name ignoring case and
  accents — and a comment's opening words read the same in every app's `[`.
*/
import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { addrToNaddr, encodeNevent, encodeNpub } from '@estiva-app/protocol'
import { mentionablePeople, messageWords, namedProfilesOf, openingWords, rosterOf } from '../dist/index.js'

const key = (c: string) => c.repeat(64)
const [ANNA, BOB, EMILE, ZOE, AGENT, ME, APP] = ['1', '2', '3', '4', '5', '6', '7'].map(key)
const profile = (pubkey: string, content: Record<string, unknown>, created_at = 100) => ({ kind: 0, pubkey, created_at, content: JSON.stringify(content), tags: [] })
const roster = (members: string[], created_at = 100) => ({ kind: 13534, pubkey: key('f'), created_at, content: '', tags: members.map((m) => ['member', m]) })

const offered = (events: Parameters<typeof namedProfilesOf>[0] & Parameters<typeof rosterOf>[0], me: string) =>
  mentionablePeople(namedProfilesOf(events).values(), rosterOf(events), me).map((p) => p.name)

describe('who @ offers', () => {
  const people = [
    profile(ZOE, { display_name: 'Zoe' }),
    profile(EMILE, { name: 'émile' }),
    profile(BOB, { display_name: 'Bob' }),
    profile(ANNA, { display_name: 'anna' }),
    profile(AGENT, { display_name: 'Claude', bot: true }),
    profile(ME, { display_name: 'QA-1' }),
  ]

  it('sorts by name ignoring case and accents, so a lower-case or accented name sits where every app puts it', () => {
    assert.deepEqual(offered([...people, roster([ANNA, BOB, EMILE, ZOE, AGENT, ME])], ME), ['anna', 'Bob', 'Claude', 'émile', 'Zoe'])
  })

  it('offers agents, but never the viewer', () => {
    const names = offered([...people, roster([AGENT, ME, ZOE])], ME)
    assert.deepEqual(names, ['Claude', 'Zoe'])
  })

  it('leaves out a roster key with no named profile, and a profile off the roster', () => {
    const events = [profile(ZOE, { display_name: 'Zoe' }), profile(BOB, { display_name: '  ' }), profile(ANNA, { display_name: 'anna' }), roster([ZOE, BOB, APP])]
    assert.deepEqual(offered(events, ME), ['Zoe'])
  })

  it('reads the newest profile and the newest roster', () => {
    const events = [profile(ZOE, { display_name: 'Zoe' }, 100), profile(ZOE, { display_name: 'Zoë Novak' }, 200), roster([BOB], 100), roster([ZOE], 200), profile(BOB, { display_name: 'Bob' })]
    assert.deepEqual(offered(events, ME), ['Zoë Novak'])
  })

  it('picks the lowest id between two events of the same second, whatever order they came in', () => {
    const older = { ...profile(ZOE, { display_name: 'Zoe' }, 100), id: 'a'.repeat(64) }
    const newer = { ...profile(ZOE, { display_name: 'Zoë' }, 100), id: 'b'.repeat(64) }
    const rosterA = { ...roster([ZOE], 100), id: 'a'.repeat(64) }
    const rosterB = { ...roster([BOB], 100), id: 'b'.repeat(64) }
    assert.deepEqual(offered([older, newer, rosterA, rosterB], ME), ['Zoe'])
    assert.deepEqual(offered([newer, older, rosterB, rosterA], ME), ['Zoe'])
  })

  it('reads a roster\'s p tags as members too, and no tag value that is not a key', () => {
    const events = [profile(ZOE, { display_name: 'Zoe' }), profile(BOB, { display_name: 'Bob' }), { ...roster([]), tags: [['p', ZOE], ['member', 'Bob']] }]
    assert.deepEqual([...(rosterOf(events) ?? [])], [ZOE])
    assert.deepEqual(offered(events, ME), ['Zoe'])
  })

  it('offers every named profile when the relay keeps no roster', () => {
    assert.deepEqual(offered(people, ME), ['anna', 'Bob', 'Claude', 'émile', 'Zoe'])
  })
})

describe('a comment\'s opening words', () => {
  const QA2 = '3bb30d683788016b85c83604dd5660e4e172e95d46d4e3ebab623ff5847b1f71'
  const nameOf = (pubkey: string) => (pubkey === QA2 ? 'QA-2' : undefined)
  const issue = `nostr:${addrToNaddr(`30851:${key('b')}:widgets`)}`

  it('reads a link as its words, a person by name and an issue as "Issue", as the production probe comment does', () => {
    const body = `Zebra probe: **bold words**, read [the widgets guide](https://example.com/guide) with nostr:${encodeNpub(QA2)} about ${issue} then \`code\``
    assert.equal(openingWords(body, nameOf), 'Zebra probe: bold words, read the widgets guide with @QA-2 about Issue then code')
  })

  it('never leaves a reference blank: a message, an unknown kind and an unknown person each read as something', () => {
    const message = `nostr:${encodeNevent({ id: key('c'), relays: [] })}`
    const other = `nostr:${addrToNaddr(`31923:${key('b')}:event`)}`
    const stranger = `nostr:${encodeNpub(key('d'))}`
    assert.equal(openingWords(`see ${message} and ${other} by ${stranger}`, nameOf), `see Message and File by @${stranger.slice(6, 18)}…`)
  })

  it('reads a project, a topic, a document and a Folder by their type words', () => {
    const words = [30850, 30840, 30842, 39000].map((kind) => `nostr:${addrToNaddr(`${kind}:${key('b')}:x`)}`).join(' ')
    assert.equal(openingWords(words, nameOf), 'Project Topic Document Folder')
  })

  it('keeps a link whose URL has an unclosed "(" as written, as a reader draws it', () => {
    assert.equal(openingWords('see [Foo](https://example.com/Foo_(bar)) here', nameOf), 'see [Foo](https://example.com/Foo_(bar)) here')
  })

  it('still reads a comment of a few thousand bold words, the line as its text, rather than throwing', () => {
    const body = `first line\n${'**b** '.repeat(5000)}`
    assert.equal(openingWords(body, nameOf), `first line ${'b '.repeat(5000).trim()}`)
  })

  it('puts lines on one line without their list, quote, heading or fence markers', () => {
    const body = '## Plan\n> quoted\n- [ ] first\n2. second\n```\nnpm test\n```'
    assert.equal(openingWords(body, nameOf), 'Plan quoted first second npm test')
  })
})

describe('a link in a message preview reads as what it names, never as a raw URL (widget review item 20)', () => {
  const nameOf = () => undefined
  const ISSUE_URL = 'https://ship.estiva.app/issue/draft-the-onboarding-checklist'
  const MESSAGE_URL = 'https://peek.estiva.app/m/one'
  const resolved: Record<string, string> = { [ISSUE_URL]: `30851:${key('b')}:draft-the-onboarding-checklist`, [MESSAGE_URL]: key('c') }
  const resolveLink = (url: string) => resolved[url]

  it('reads a bare app link the app has resolved as its type word, as its chip would', () => {
    assert.equal(openingWords(`WR test 3: both ${ISSUE_URL}`, nameOf, { resolveLink }), 'WR test 3: both Issue')
    assert.equal(openingWords(`as said in ${MESSAGE_URL}.`, nameOf, { resolveLink }), 'as said in Message.')
    assert.equal(openingWords(`**${ISSUE_URL}**`, nameOf, { resolveLink }), 'Issue')
  })

  it('keeps a URL as written where it names nothing: unresolved, another site, in code, or in a link’s words', () => {
    const unresolved = 'https://ship.estiva.app/issue/not-answered-yet'
    assert.equal(openingWords(`see ${unresolved} and https://example.com/a`, nameOf, { resolveLink }), `see ${unresolved} and https://example.com/a`)
    assert.equal(openingWords(`run \`${ISSUE_URL}\``, nameOf, { resolveLink }), `run ${ISSUE_URL}`)
    assert.equal(openingWords(`\`\`\`\n${ISSUE_URL}\n\`\`\``, nameOf, { resolveLink }), ISSUE_URL)
    assert.equal(openingWords(`[${ISSUE_URL}](https://example.com/b)`, nameOf, { resolveLink }), ISSUE_URL)
  })

  it('without a resolver, a URL stays as written, as before', () => {
    assert.equal(openingWords(`both ${ISSUE_URL}`, nameOf), `both ${ISSUE_URL}`)
  })
})

describe('the words a message is found by', () => {
  const nameOf = (pubkey: string) => (pubkey === ANNA ? 'Anna' : undefined)
  const issue = `nostr:${addrToNaddr(`30851:${key('b')}:widgets`)}`

  it('keeps what its writer wrote — a link’s words, a person, code — and drops every URL and the type word of a file or message it names', () => {
    const body = `WR test 3: both https://ship.estiva.app/issue/draft and ${issue}, read [the widgets guide](https://example.com/guide) with nostr:${encodeNpub(ANNA)} then \`npm test\``
    assert.equal(messageWords(body, nameOf), 'WR test 3: both and , read the widgets guide with @Anna then npm test')
  })

  it('a message that is only a link has no words of its own', () => {
    assert.equal(messageWords(`nostr:${encodeNevent({ id: key('c'), relays: [] })}`, nameOf), '')
    assert.equal(messageWords('https://ship.estiva.app/issue/draft', nameOf), '')
  })
})

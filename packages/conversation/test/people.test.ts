/*
  PEEKM-6: `@` offers one list of people in every app — the roster's named
  profiles, agents included, never the viewer, by name ignoring case and
  accents — and a comment's opening words read the same in every app's `[`.
*/
import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { addrToNaddr, encodeNevent, encodeNpub } from '@estiva-app/protocol'
import { mentionablePeople, namedProfilesOf, openingWords, rosterOf } from '../dist/index.js'

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

  it('reads a project, a topic and a document by their type words', () => {
    const words = [30850, 30840, 30842].map((kind) => `nostr:${addrToNaddr(`${kind}:${key('b')}:x`)}`).join(' ')
    assert.equal(openingWords(words, nameOf), 'Project Topic Document')
  })

  it('puts lines on one line without their list, quote, heading or fence markers', () => {
    const body = '## Plan\n> quoted\n- [ ] first\n2. second\n```\nnpm test\n```'
    assert.equal(openingWords(body, nameOf), 'Plan quoted first second npm test')
  })
})

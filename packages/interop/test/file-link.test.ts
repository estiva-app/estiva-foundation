/*
  A file's link, written by the shared writer (LIN-2): the path Copy link hands
  out in every app, from the words the kinds' owners publish (SPEC §7.7 rule 1),
  `/o/<naddr>` when a kind has none, and nothing for an id no file can have.
*/
import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { decodeNaddr } from '@estiva-app/protocol'
import { fileLinkWordsOf, filePathOf, fileUrlOf, matchObjectUrl, urlPatternsOf } from '../dist/index.js'

const PEEK = 'a'.repeat(64)
const SHIP = 'b'.repeat(64)
const LEAF = 'c'.repeat(64)
const STRANGER = 'd'.repeat(64)
const AUTHOR = 'e'.repeat(64)
const D = '3f6d2a1e-8c4b-4d7a-9e21-5b0c7f8a6d13'

type Manifest = { pubkey: string; created_at: number; tags: string[][]; content: string; id?: string }

/** The three manifests as production holds them on 24 Nov (`kind:31990`, read off the relay). */
const peek: Manifest = {
  pubkey: PEEK,
  created_at: 1_793_000_000,
  content: JSON.stringify({ aspect: 'conversation' }),
  tags: [
    ['d', 'estiva-peek'],
    ['web', 'https://peek.estiva.app/o/<bech32>', 'naddr'],
    ['urls', 'https://peek.estiva.app/topic/<slug>-<d>', '30840'],
    ['urls', 'https://peek.estiva.app/topic/<slug>-<d>?thread=<id>', '1111'],
    ['urls', 'https://peek.estiva.app/topic-old/<slug>-<d>', '39000'],
    ['urls', 'https://peek.estiva.app/message/<id>', '9'],
  ],
}
const ship: Manifest = {
  pubkey: SHIP,
  created_at: 1_793_500_000,
  content: JSON.stringify({ projections: { 30850: {}, 30851: {} } }),
  tags: [
    ['d', 'estiva-ship'],
    ['k', '30850'],
    ['k', '30851'],
    ['web', 'https://ship.estiva.app/o/<bech32>', 'naddr'],
    ['urls', 'https://ship.estiva.app/project/<slug>-<d>#block-<block>', '30850'],
    ['urls', 'https://ship.estiva.app/issue/<slug>-<d>#block-<block>', '30851'],
    ['urls', 'https://ship.estiva.app/#/project/<d>', '30850'],
    ['urls', 'https://ship.estiva.app/#/issue/<d>', '30851'],
  ],
}
const leaf: Manifest = {
  pubkey: LEAF,
  created_at: 1_795_000_000,
  content: JSON.stringify({ projections: { 30842: {} } }),
  tags: [
    ['d', 'estiva-leaf'],
    ['k', '30842'],
    ['web', 'https://leaf.estiva.app/f/<bech32>', 'naddr'],
    ['urls', 'https://leaf.estiva.app/document/<slug>-<d>#block-<block>', '30842'],
  ],
}
const PRODUCTION = [leaf, ship, peek]

const words = (manifests: Manifest[]) => fileLinkWordsOf(manifests)
const path = (kind: number, manifests: Manifest[] = PRODUCTION, d = D, title?: string) =>
  filePathOf(`${kind}:${AUTHOR}:${d}`, words(manifests), title)

describe("a file's link", () => {
  it("is /<word>/<name>-<id>, with each kind's owner's word", () => {
    assert.equal(path(30840, PRODUCTION, D, 'Launch naming'), `/topic/launch-naming-${D}`)
    assert.equal(path(30850, PRODUCTION, D, 'Q4 roadmap'), `/project/q4-roadmap-${D}`)
    assert.equal(path(30851, PRODUCTION, D, 'Copy link is wrong'), `/issue/copy-link-is-wrong-${D}`)
    assert.equal(path(30842, PRODUCTION, D, 'Brief'), `/document/brief-${D}`)
  })

  it('is /<word>/<id> for a file with no title, which opens the same file', () => {
    assert.equal(path(30851), `/issue/${D}`)
  })

  it('reads back as the same file and kind on every app’s host', () => {
    const patterns = PRODUCTION.flatMap(urlPatternsOf)
    for (const [kind, title] of [[30840, 'A'], [30850, 'B'], [30851, 'C'], [30842, 'D']] as const) {
      for (const host of ['https://peek.estiva.app', 'https://ship.estiva.app', 'https://leaf.estiva.app']) {
        const url = fileUrlOf(`${kind}:${AUTHOR}:${D}`, words(PRODUCTION), host, title)!
        const match = matchObjectUrl(url, patterns)
        assert.deepEqual([match?.identifier, match?.kind], [D, kind], url)
      }
    }
  })

  it('carries the host given, whatever slashes it ends in', () => {
    assert.equal(fileUrlOf(`30851:${AUTHOR}:${D}`, words(PRODUCTION), 'https://leaf.estiva.app//', 'X'), `https://leaf.estiva.app/issue/x-${D}`)
  })

  it('is /o/<naddr> for a file of a named type (30852), which no word can name', () => {
    const named: Manifest = { ...ship, created_at: ship.created_at + 1, tags: [...ship.tags, ['k', '30852'], ['urls', 'https://ship.estiva.app/invoice/<slug>-<d>', '30852']], content: JSON.stringify({ projections: { 30850: {}, 30851: {}, 30852: {} } }) }
    const link = path(30852, [named, leaf, peek])!
    assert.match(link, /^\/o\/naddr1/)
    const back = decodeNaddr(link.slice(3))
    assert.deepEqual([back.kind, back.pubkey, back.identifier], [30852, AUTHOR, D])
  })

  it('is /o/<naddr> for a kind whose owner has published no manifest', () => {
    assert.match(path(30851, [peek, leaf])!, /^\/o\/naddr1/)
  })

  it('is /o/<naddr> when the owner declares only a fragment route for the kind', () => {
    const old: Manifest = { ...ship, tags: ship.tags.filter((t) => !(t[0] === 'urls' && t[1].includes('/issue/<slug>'))) }
    assert.match(path(30851, [old, leaf, peek])!, /^\/o\/naddr1/)
    assert.equal(path(30850, [old, leaf, peek]), `/project/${D}`)
  })

  const odd: Record<string, string> = {
    'a key a person knows': 'PROJ-1',
    'a v4 uuid in capitals': D.toUpperCase(),
    'a version 1 uuid': '6ba7b810-9dad-11d1-80b4-00c04fd430c8',
    'a version 7 uuid': '01936b2e-8a3c-7c4d-9e5f-0a1b2c3d4e5f',
    'the nil uuid': '00000000-0000-0000-0000-000000000000',
  }
  for (const [label, d] of Object.entries(odd)) {
    it(`is none for ${label} as the id, on every file type`, () => {
      for (const kind of [30840, 30842, 30850, 30851, 30852]) assert.equal(path(kind, PRODUCTION, d), null, `${kind}`)
    })
  }

  it('is none for what is not a file: a team, a malformed address', () => {
    assert.equal(filePathOf(`39000:${AUTHOR}:${D}`, words(PRODUCTION)), null)
    assert.equal(filePathOf(`30851:${AUTHOR.toUpperCase()}:${D}`, words(PRODUCTION)), null)
    assert.equal(filePathOf(D, words(PRODUCTION)), null)
  })
})

describe("whose word a file's link takes", () => {
  it("ignores a word another app declares for a kind it does not own", () => {
    const other: Manifest = { pubkey: STRANGER, created_at: 1_799_000_000, content: '{}', tags: [['web', 'https://tickets.example/o/<bech32>', 'naddr'], ['urls', 'https://tickets.example/ticket/<slug>-<d>', '30851']] }
    assert.equal(path(30851, [other, ...PRODUCTION]), `/issue/${D}`)
  })

  it("takes the newest manifest that claims the kind, as the kind's noun and Open in do (SPEC §6.11)", () => {
    const newer: Manifest = { pubkey: STRANGER, created_at: 1_799_000_000, content: JSON.stringify({ projections: { 30851: {} } }), tags: [['k', '30851'], ['web', 'https://tickets.example/o/<bech32>', 'naddr'], ['urls', 'https://tickets.example/ticket/<slug>-<d>', '30851']] }
    assert.equal(path(30851, [ship, newer, leaf, peek]), `/ticket/${D}`)
  })

  it('does not take a claim with no projection for the kind', () => {
    const empty: Manifest = { pubkey: STRANGER, created_at: 1_799_000_000, content: '{}', tags: [['k', '30851'], ['web', 'https://tickets.example/o/<bech32>', 'naddr'], ['urls', 'https://tickets.example/ticket/<slug>-<d>', '30851']] }
    assert.equal(path(30851, [empty, ...PRODUCTION]), `/issue/${D}`)
  })

  it("gives a topic the word of the newest app that opens conversations, Peek's today", () => {
    const chat: Manifest = { pubkey: STRANGER, created_at: 1_799_000_000, content: JSON.stringify({ aspect: 'conversation' }), tags: [['web', 'https://chat.example/o/<bech32>', 'naddr'], ['urls', 'https://chat.example/room/<slug>-<d>', '30840']] }
    assert.equal(path(30840, PRODUCTION), `/topic/${D}`)
    assert.equal(path(30840, [chat, ...PRODUCTION]), `/room/${D}`)
    // An app that declares the aspect and nowhere to open a file is not the opener.
    const nowhere: Manifest = { ...chat, tags: chat.tags.filter((t) => t[0] !== 'web') }
    assert.equal(path(30840, [nowhere, ...PRODUCTION]), `/topic/${D}`)
  })

  it('is /o/<naddr> when another manifest declares the same word for a different kind, which would read the link plain', () => {
    const clash: Manifest = { pubkey: STRANGER, created_at: 1_790_000_000, content: '{}', tags: [['web', 'https://clash.example/o/<bech32>', 'naddr'], ['urls', 'https://clash.example/issue/<slug>-<d>', '30999']] }
    assert.match(path(30851, [clash, ...PRODUCTION])!, /^\/o\/naddr1/)
    assert.equal(path(30850, [clash, ...PRODUCTION]), `/project/${D}`)
  })

  it('never writes a reserved or malformed word', () => {
    for (const word of ['o', 'app', 'Issue', '9lives', 'is_sue']) {
      const owner: Manifest = { ...ship, tags: [['k', '30851'], ['web', 'https://ship.estiva.app/o/<bech32>', 'naddr'], ['urls', `https://ship.estiva.app/${word}/<slug>-<d>`, '30851']], content: JSON.stringify({ projections: { 30851: {} } }) }
      assert.match(path(30851, [owner, leaf, peek])!, /^\/o\/naddr1/, word)
    }
  })
})

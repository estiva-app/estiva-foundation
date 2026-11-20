/**
 * A link reads back as the file it was written for, on any app's host (TES-4).
 *
 * Every app writes a file's link as `/<word>/<slug>-<d>` (SPEC §7) and reads a
 * pasted one through `matchObjectUrl`, against the shapes the apps' manifests
 * declare. The slug is made from the title, so a title in any language, with
 * any punctuation, must never change which file the link names; and the path
 * is the same on every app's host
 * (decisions/a-files-path-is-the-same-on-every-apps-host.md), so Ship's link
 * with Leaf's host is still Ship's issue.
 *
 * The manifests below are the shapes Peek, Ship and Leaf publish
 * (`scripts/publish-manifest.ts` in each).
 *
 * A failure prints the smallest input that breaks the rule and the seed that
 * replays it: `FC_SEED=<seed> npm test -w packages/interop`.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import fc from 'fast-check'
import { hex64Arb, runSettings } from '@estiva-app/protocol/testing'
import { blockUrlOf, eventIdFromRef, identifierFromRef, matchObjectUrl, objectRef, slugify, urlPatternsOf } from '../dist/index.js'

// 2,000 inputs a rule (measured 20 Nov 2026: about 0.3 s a rule).
const settings = runSettings(2000)
console.log(`fast-check seed ${settings.seed}, ${settings.numRuns} runs per rule`)

const MANIFESTS = [
  {
    tags: [
      ['web', 'https://peek.estiva.app/o/<bech32>', 'naddr'],
      ['urls', 'https://peek.estiva.app/topic/<slug>-<d>', '30840'],
      ['urls', 'https://peek.estiva.app/topic/<slug>-<d>?thread=<id>', '1111'],
      ['urls', 'https://peek.estiva.app/message/<id>', '9'],
    ],
  },
  {
    tags: [
      ['web', 'https://ship.estiva.app/o/<bech32>', 'naddr'],
      ['urls', 'https://ship.estiva.app/project/<slug>-<d>#block-<block>', '30850'],
      ['urls', 'https://ship.estiva.app/issue/<slug>-<d>#block-<block>', '30851'],
      ['urls', 'https://ship.estiva.app/#/issue/<d>', '30851'],
    ],
  },
  {
    tags: [
      ['web', 'https://leaf.estiva.app/f/<bech32>', 'naddr'],
      ['urls', 'https://leaf.estiva.app/document/<slug>-<d>#block-<block>', '30842'],
    ],
  },
]
const PATTERNS = MANIFESTS.flatMap(urlPatternsOf)
const HOSTS = ['https://peek.estiva.app', 'https://ship.estiva.app', 'https://leaf.estiva.app']
/** Each kind with the word its owner writes it under. */
const FILE_KINDS = [
  { kind: 30840, word: 'topic' },
  { kind: 30850, word: 'project' },
  { kind: 30851, word: 'issue' },
  { kind: 30842, word: 'document' },
]

/** A `d` as the apps make one: a lowercase uuid. */
const dArb = fc.uuid()
/** A title as a person types one: any script, emoji, punctuation, digits and hex, dashes, a uuid of its own. */
const titleArb = fc.oneof(
  fc.string({ unit: 'grapheme', maxLength: 80 }),
  fc.string({ unit: fc.constantFrom('-', ' ', ':', '/', '#', '?', '%', '.', 'a', 'f', '0', '9', 'É', 'ß', 'ﬁ', '中', '🙂', '́'), maxLength: 80 }),
  fc.tuple(fc.string({ maxLength: 10 }), fc.uuid()).map(([a, u]) => `${a} ${u}`),
)
const blockArb = fc.stringMatching(/^[A-Za-z0-9_-]{1,64}$/)

test('a slug is only lowercase words and dashes, at most 60 characters, whatever the title', () => {
  fc.assert(
    fc.property(titleArb, (title) => {
      const slug = slugify(title)
      assert.match(slug, /^(?:[a-z0-9]+(?:-[a-z0-9]+)*)?$/)
      assert.ok(slug.length <= 60)
    }),
    settings,
  )
})

test('a ref made from any title reads back as the file it was made for', () => {
  fc.assert(
    fc.property(dArb, titleArb, (d, title) => {
      assert.equal(identifierFromRef(objectRef(d, title)), d)
    }),
    settings,
  )
})

test("a message's ref made from any title reads back as that message", () => {
  fc.assert(
    fc.property(hex64Arb(), titleArb, (id, title) => {
      assert.equal(eventIdFromRef(objectRef(id, title)), id)
    }),
    settings,
  )
})

test('a link to a file reads back as that file and its kind, on any app\'s host, with a block or a tracker\'s query', () => {
  fc.assert(
    fc.property(
      dArb,
      titleArb,
      fc.constantFrom(...FILE_KINDS),
      fc.constantFrom(...HOSTS),
      fc.option(blockArb),
      fc.option(fc.constantFrom('utm_source=chat', 'ref=x&utm_medium=email')),
      (d, title, { kind, word }, host, block, query) => {
        const url = `${host}/${word}/${objectRef(d, title)}${query ? `?${query}` : ''}${block ? `#block-${block}` : ''}`
        const match = matchObjectUrl(url, PATTERNS)
        assert.ok(match, url)
        assert.equal(match.identifier, d, url)
        assert.equal(match.by, 'd', url)
        assert.equal(match.kind, kind, url)
        // Peek's topic shape declares no block; the others carry it through.
        if (block && kind !== 30840) assert.equal(match.block, block, url)
      },
    ),
    settings,
  )
})

test('a link to a thread names the comment, inside the file it is on', () => {
  fc.assert(
    fc.property(dArb, titleArb, hex64Arb(), fc.constantFrom(...HOSTS), (d, title, id, host) => {
      const url = `${host}/topic/${objectRef(d, title)}?thread=${id}`
      const match = matchObjectUrl(url, PATTERNS)
      assert.ok(match, url)
      assert.deepEqual([match.identifier, match.by, match.within], [id, 'id', { identifier: d, by: 'd' }], url)
    }),
    settings,
  )
})

test('a link to one block, written by blockUrlOf, reads back as that file and block', () => {
  fc.assert(
    fc.property(dArb, titleArb, blockArb, fc.constantFrom(30850, 30851, 30842), (d, title, block, kind) => {
      const url = blockUrlOf(PATTERNS, { kind, d, title, block })
      assert.ok(url)
      const match = matchObjectUrl(url, PATTERNS)
      assert.deepEqual([match?.identifier, match?.kind, match?.block], [d, kind, block], url)
    }),
    settings,
  )
})

/**
 * Any `d` at all, the way another app or an old event could hold one. The
 * short form carries a uuid only; for anything else the writer must write no
 * link rather than one that names some other file.
 */
const anyDArb = fc.oneof(
  fc.string({ unit: 'grapheme', maxLength: 40 }),
  fc.tuple(fc.string({ unit: fc.constantFrom('a', 'b', '-', ':', '/', '1'), maxLength: 8 }), fc.uuid()).map(([a, u]) => `${a}${u}`),
  fc.uuid().map((u) => u.toUpperCase()),
  fc.uuid(),
)

test('blockUrlOf writes a link for any d only when that link reads back as the same d', () => {
  fc.assert(
    fc.property(anyDArb, titleArb, blockArb, fc.constantFrom(30850, 30851, 30842), (d, title, block, kind) => {
      const url = blockUrlOf(PATTERNS, { kind, d, title, block })
      if (url === undefined) return
      assert.equal(matchObjectUrl(url, PATTERNS)?.identifier, d, url)
    }),
    settings,
  )
})

test('any text pasted as a link is read without throwing, and names a file only by a uuid or an event id it carries', () => {
  const pasted = fc.oneof(
    fc.string({ unit: 'grapheme', maxLength: 120 }),
    fc.webUrl({ withFragments: true, withQueryParameters: true }),
    fc.tuple(fc.constantFrom(...HOSTS), fc.string({ unit: fc.constantFrom('/', '-', '#', '?', '=', '%', 'topic', 'issue', 'a', '0', 'f'), maxLength: 30 }), fc.option(fc.uuid())).map(
      ([host, junk, uuid]) => `${host}/${junk}${uuid ?? ''}`,
    ),
  )
  fc.assert(
    fc.property(pasted, (text) => {
      const match = matchObjectUrl(text, PATTERNS)
      if (!match) return
      assert.ok(text.toLowerCase().includes(match.identifier), text)
      assert.match(match.identifier, match.by === 'd' ? /^[0-9a-f-]{36}$/ : /^[0-9a-f]{64}$/, text)
    }),
    settings,
  )
})

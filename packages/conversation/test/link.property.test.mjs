/**
 * A link in a message still names the file its card shows (TES-4).
 *
 * A message that shows another file's block keeps the card only while its text
 * still names that file (SPEC §13.6.1), by a `nostr:` reference or by a pasted
 * app link: `urlNames`. Every link an app writes for a file must count, on any
 * host, whatever the title, with a block or a query after it, and whatever the
 * file's `d` holds: a colon in it included. A link to another file must not.
 *
 * The links are the ones the apps write: Ship's, Leaf's and Peek's short form
 * `/<word>/<slug>-<d>`, and Peek's long form for a file whose `d` is not a uuid,
 * `/topic/<kind>:<pubkey>:<d escaped>` (peek-app `src/lib/objectUrl.ts`
 * `filePath`).
 *
 * A failure prints the smallest input that breaks the rule and the seed that
 * replays it: `FC_SEED=<seed> npm test -w packages/conversation`.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import fc from 'fast-check'
import { hex64Arb, runSettings } from '@estiva-app/protocol/testing'
import { urlNames } from '../dist/index.js'

// 2,000 inputs a rule (measured 20 Nov 2026: well under a second a rule).
const settings = runSettings(2000)
console.log(`fast-check seed ${settings.seed}, ${settings.numRuns} runs per rule`)

const HOSTS = ['https://peek.estiva.app', 'https://ship.estiva.app', 'https://leaf.estiva.app']
const WORDS = ['topic', 'issue', 'project', 'document']
const kindArb = fc.constantFrom(30840, 30842, 30850, 30851)
/**
 * A title's slug as interop's `slugify` writes one: lowercase words and dashes,
 * at most 60 characters (its own property test holds it to that).
 */
const slugArb = fc.stringMatching(/^(?:[a-z0-9]{1,12}(?:-[a-z0-9]{1,12}){0,3})?$/)
const objectRef = (d, slug) => (slug ? `${slug}-${d}` : d)
const tailArb = fc.constantFrom('', '/', '?utm_source=chat', '#block-p1', '?thread=' + 'a'.repeat(64))

/** Any `d` long enough to count: any text, a colon or a dash in it. */
const anyDArb = fc
  .oneof(
    fc.string({ unit: 'grapheme', minLength: 8, maxLength: 40 }),
    fc.tuple(fc.string({ unit: fc.constantFrom('a', ':', '-', '/', '%', ' ', 'é'), minLength: 1, maxLength: 8 }), fc.uuid()).map(([a, u]) => `${a}${u}`),
    fc.uuid().map((u) => `team:${u}`),
  )
  .filter((d) => d.length >= 8)

/** The long form Peek writes for a file whose `d` a short link cannot carry. */
const peekLongLink = (host, kind, pubkey, d) => `${host}/topic/${kind}:${pubkey}:${encodeURIComponent(d)}`

test('a short link to a file names that file, on any host, after any title', () => {
  fc.assert(
    fc.property(fc.uuid(), hex64Arb(), kindArb, fc.constantFrom(...HOSTS), fc.constantFrom(...WORDS), slugArb, tailArb, (d, pubkey, kind, host, word, slug, tail) => {
      const url = `${host}/${word}/${objectRef(d, slug)}${tail}`
      assert.equal(urlNames(url, `${kind}:${pubkey}:${d}`), true, url)
    }),
    settings,
  )
})

test("Peek's long link to a file names that file, whatever its d holds, a colon included", () => {
  fc.assert(
    fc.property(anyDArb, hex64Arb(), kindArb, fc.constantFrom(...HOSTS), tailArb, (d, pubkey, kind, host, tail) => {
      const url = peekLongLink(host, kind, pubkey, d) + tail
      assert.equal(urlNames(url, `${kind}:${pubkey}:${d}`), true, url)
    }),
    settings,
  )
})

test('a link to one file never names another', () => {
  fc.assert(
    fc.property(fc.uuid(), fc.uuid(), anyDArb, hex64Arb(), kindArb, slugArb, (d, other, odd, pubkey, kind, slug) => {
      fc.pre(d !== other && odd !== other)
      const otherAddress = `${kind}:${pubkey}:${other}`
      assert.equal(urlNames(`https://ship.estiva.app/issue/${objectRef(d, slug)}`, otherAddress), false)
      assert.equal(urlNames(peekLongLink('https://peek.estiva.app', kind, pubkey, odd), otherAddress), false)
      assert.equal(urlNames(peekLongLink('https://peek.estiva.app', kind, pubkey, d), `${kind}:${pubkey}:${odd}`), false)
    }),
    settings,
  )
})

/*
  Somebody else chooses a file's `d`. One written as the tail of another
  file's link, or as that link's whole address, must not make the link name
  their file, or their card would draw under a link that opens the other one.
*/
test("a d made to look like another file's link is not named by that link", () => {
  fc.assert(
    fc.property(anyDArb, fc.uuid(), hex64Arb(), hex64Arb(), kindArb, slugArb, fc.integer({ min: 1, max: 35 }), (theirD, d, theirs, mine, kind, slug, cut) => {
      fc.pre(theirs !== mine)
      const long = peekLongLink('https://peek.estiva.app', kind, theirs, theirD)
      // Their long link's whole address, escaped or not, as my `d`.
      assert.equal(urlNames(long, `${kind}:${mine}:${kind}:${theirs}:${encodeURIComponent(theirD)}`), false, long)
      assert.equal(urlNames(long, `${kind}:${mine}:${kind}:${theirs}:${theirD}`), false, long)
      // The tail of their short link as my `d`.
      const short = `https://ship.estiva.app/issue/${objectRef(d, slug)}`
      const tail = `issue/${objectRef(d, slug)}`.slice(-36 - cut)
      if (tail !== d) assert.equal(urlNames(short, `${kind}:${mine}:${tail}`), false, `${short} vs ${tail}`)
      if (d.slice(cut).length >= 8) assert.equal(urlNames(short, `${kind}:${mine}:${d.slice(cut)}`), false, `${short} vs ${d.slice(cut)}`)
    }),
    settings,
  )
})

/**
 * A link reads back as the file it was written for (TES-4).
 *
 * A file's `naddr` and an event's `nevent` are how a link names it everywhere
 * a URL cannot: a mention, a `nostr:` reference in a message, Leaf's `/f/` page
 * and every app's `/o/` hand-off. Each is written by one app and read by
 * another, so each must give back exactly the address it was written from,
 * whatever the file's `d` holds: any language, punctuation, a colon or a dash.
 *
 * nostr-tools is the outside reader: what we write it must read the same, and
 * what it writes we must. The strings differ (nostr-tools writes the fields in
 * the other order, which NIP-19 allows), so the pointers are compared.
 *
 * A failure prints the smallest input that breaks the rule and the seed that
 * replays it: `FC_SEED=<seed> npm test -w packages/protocol`.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import fc from 'fast-check'
import { nip19 } from 'nostr-tools'
import { hex64Arb, runSettings } from '@estiva-app/protocol/testing'
import {
  addrToNaddr,
  addressToPointer,
  decodeNaddr,
  decodeNevent,
  encodeNaddr,
  encodeNevent,
  findNaddrs,
  findNostrUris,
  naddrToAddr,
  referenceToPointer,
  stripNaddrs,
} from '../dist/index.js'

// 2,000 inputs a rule (measured 20 Nov 2026: well under a second a rule).
const settings = runSettings(2000)
console.log(`fast-check seed ${settings.seed}, ${settings.numRuns} runs per rule`)

const bytes = (text: string) => new TextEncoder().encode(text).length

/** A uuid as Ship, Leaf and Peek make them, sometimes upper-cased by whatever carried it. */
const uuidArb = fc.oneof(fc.uuid(), fc.uuid().map((u) => u.toUpperCase()))

/**
 * A `d` as the relay can hold one: a uuid, or any text — words in any script,
 * emoji, a colon, a dash, a slash, a percent sign, spaces, or nothing at all.
 * Only well-formed text: a lone surrogate is not a string a JSON event can
 * carry through UTF-8 (it is replaced on the way in), so no link could name it.
 */
const dArb = fc
  .oneof(
    uuidArb,
    fc.string({ unit: 'grapheme', maxLength: 40 }),
    fc.string({ unit: fc.constantFrom(':', '-', '/', '%', ' ', '?', '#', 'a', 'Z', '0', 'é', '中', '🙂'), maxLength: 30 }),
    fc.tuple(fc.string({ unit: 'grapheme-ascii', maxLength: 10 }), uuidArb).map(([a, u]) => `${a}:${u}`),
  )
  // A naddr's field holds at most 255 bytes; a longer `d` is refused, tested below.
  .filter((d) => bytes(d) <= 255)

const kindArb = fc.integer({ min: 0, max: 65535 })

/** A relay hint as people paste them; at most three. */
const relaysArb = fc.array(
  fc.webUrl({ withQueryParameters: true }).map((url) => url.replace(/^https?/, 'wss')).filter((url) => bytes(url) <= 255),
  { maxLength: 3 },
)

const pointerArb = fc.record({ identifier: dArb, pubkey: hex64Arb(), kind: kindArb, relays: relaysArb }, { noNullPrototype: true })

test('an naddr written for any file reads back as that file', () => {
  fc.assert(
    fc.property(pointerArb, (pointer) => {
      const naddr = encodeNaddr(pointer)
      assert.deepEqual(decodeNaddr(naddr), pointer)
      assert.deepEqual(decodeNaddr(`nostr:${naddr}`), pointer)
      assert.deepEqual(decodeNaddr(naddr.toUpperCase()), pointer, 'a link a system upper-cased')
    }),
    settings,
  )
})

test('nostr-tools reads our naddr as the same file, and we read its', () => {
  fc.assert(
    fc.property(pointerArb, (pointer) => {
      const outside = nip19.decode(encodeNaddr(pointer))
      assert.equal(outside.type, 'naddr')
      assert.deepEqual(outside.data, pointer)
      assert.deepEqual(decodeNaddr(nip19.naddrEncode(pointer)), pointer)
    }),
    settings,
  )
})

test('an address written as an naddr and back is the same address, colons in its d and all', () => {
  fc.assert(
    fc.property(pointerArb, (pointer) => {
      const address = `${pointer.kind}:${pointer.pubkey}:${pointer.identifier}`
      assert.equal(naddrToAddr(addrToNaddr(address, pointer.relays)), address)
      assert.deepEqual(addressToPointer(address), { ...pointer, relays: [] })
      assert.deepEqual(referenceToPointer(address), { ...pointer, relays: [] })
      assert.deepEqual(referenceToPointer(`nostr:${addrToNaddr(address, pointer.relays)}`), pointer)
    }),
    settings,
  )
})

test('a d too long for an naddr is refused when written, never written as a link nothing reads', () => {
  fc.assert(
    fc.property(
      fc.string({ unit: 'grapheme', minLength: 1, maxLength: 120 }).map((s) => s.repeat(Math.ceil(256 / Math.max(1, bytes(s))))),
      hex64Arb(),
      kindArb,
      (identifier, pubkey, kind) => {
        assert.ok(bytes(identifier) > 255)
        assert.throws(() => encodeNaddr({ identifier, pubkey, kind, relays: [] }))
      },
    ),
    settings,
  )
})

const eventPointerArb = fc.record(
  { id: hex64Arb(), relays: relaysArb, pubkey: hex64Arb(), kind: kindArb },
  { requiredKeys: ['id', 'relays'], noNullPrototype: true },
)

test('an nevent written for any event reads back as that event, here and in nostr-tools', () => {
  fc.assert(
    fc.property(eventPointerArb, (pointer) => {
      const nevent = encodeNevent(pointer)
      assert.deepEqual(decodeNevent(nevent), pointer)
      assert.deepEqual(decodeNevent(`nostr:${nevent}`), pointer)
      const outside = nip19.decode(nevent)
      assert.equal(outside.type, 'nevent')
      const { pubkey, ...rest } = pointer
      // nostr-tools spells a field it did not find as `undefined`.
      const read = Object.fromEntries(Object.entries(outside.data).filter(([, value]) => value !== undefined))
      assert.deepEqual(read, { ...rest, ...(pubkey === undefined ? {} : { author: pubkey }) })
      assert.deepEqual(decodeNevent(nip19.neventEncode({ ...rest, ...(pubkey === undefined ? {} : { author: pubkey }) })), pointer)
    }),
    settings,
  )
})

/**
 * Text around a `nostr:` link in a message: words in any script, and the
 * punctuation that sits next to a link. A letter or digit that is also a
 * bech32 character, written straight after the link, joins it; nothing can
 * tell those apart, so a link is followed here by a space, a line break or
 * punctuation, as people write them.
 */
const aroundArb = fc.string({ unit: 'grapheme', maxLength: 20 })
const afterArb = fc.tuple(fc.constantFrom(' ', '\n', '.', ',', ')', '!', '?', ''), aroundArb).map(([gap, text]) => gap + text)

test('a nostr: link inside a message is found as the file it names', () => {
  fc.assert(
    fc.property(aroundArb, pointerArb, afterArb, (before, pointer, after) => {
      const naddr = encodeNaddr(pointer)
      const lead = /[a-z0-9]$/i.test(before) ? `${before} ` : before
      const tail = /^[a-z0-9]/i.test(after) ? ` ${after}` : after
      const text = `${lead}nostr:${naddr}${tail}`
      const found = findNaddrs(text)
      assert.ok(found.length >= 1, text)
      assert.deepEqual(decodeNaddr(found.find((f) => f.toLowerCase() === naddr) ?? found[0]), pointer, text)
      assert.ok(findNostrUris(text).includes(`nostr:${naddr}`), text)
      assert.ok(!stripNaddrs(text).includes(naddr), text)
    }),
    settings,
  )
})

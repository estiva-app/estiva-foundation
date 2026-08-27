/**
 * A third implementation, checking ours.
 *
 * SHA-3 asked whether `nostr-tools` should replace this layer. The answer is
 * no — the README records why, and the short version is that its NIP-98 emits no
 * nonce, which Buzz's replay set rejects, and it would put a second major of
 * `@noble/*` in every consumer's tree.
 *
 * But the *evaluation* produced something worth keeping. `nostr-tools/pure`
 * agrees with `computeEventId` on every event tested, including all 103 events
 * recorded from production, and `nostr-tools/nip19` round-trips our pointers. So
 * it stays as a **devDependency** and runs here as an independent oracle: we get
 * the cross-check without the dependency, and consumers pay nothing for it.
 *
 * This is what SPEC §9's C1 asks for — "event ids match a reference
 * implementation byte for byte" — done against somebody else's code rather than
 * against a second copy of our own. It replaces `diff -r` between two vendored
 * trees with a check that fails on its own.
 *
 * ## What this cannot tell you
 *
 * Agreement on the *id* is not agreement on the *tags*. `nostr-tools` has no
 * opinion about Buzz's `h` channel tag, the marked-reply form, or the tag order
 * `build_message` uses — a builder that emitted the tags in the wrong order
 * would hash identically in both implementations and be a different event to the
 * relay. `wire.test.mjs` is what holds that, and the production vectors in it are
 * what hold it against the relay.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { getEventHash, verifyEvent } from 'nostr-tools/pure'
import * as ntNip19 from 'nostr-tools/nip19'

const vectors = JSON.parse(readFileSync(new URL('./wire-vectors.json', import.meta.url), 'utf8'))
const P = await import('../dist/index.js')

test('nostr-tools computes the same id for every recorded vector', () => {
  let checked = 0
  for (const vector of vectors.events) {
    // `getEventHash` validates the pubkey against /^[a-f0-9]{64}$/ before
    // serializing, and one vector deliberately leaves it empty: a NIP-42 auth
    // event built for a *remote* signer, which overwrites the field with the
    // token's subject. Our own hash of it is pinned in `wire.test.mjs`; the
    // oracle simply cannot be asked about a half-built event.
    if (!/^[0-9a-f]{64}$/.test(vector.event.pubkey)) continue
    assert.equal(getEventHash(vector.event), vector.id, `${vector.name}: nostr-tools disagrees with the recorded id`)
    checked++
  }
  assert.equal(checked, vectors.events.length - 1, 'exactly one vector (relayAuth) is unhashable by the oracle')
})

test('nostr-tools computes the same id, and verifies the signature, for every production event', () => {
  for (const event of vectors.production.events) {
    assert.equal(getEventHash(event), event.id, `production ${event.id}: id disagrees`)
    assert.ok(verifyEvent(event), `production ${event.id}: nostr-tools will not verify the relay's own signature`)
  }
})

test('an event we sign verifies under nostr-tools', () => {
  const { SECRET, PUB, CH } = { ...vectors.inputs, PUB: vectors.keys.pubkey }
  const unsigned = P.buildMessage(PUB, 1787142018561, { channelUuid: CH, content: 'signed here, verified there' })
  const signed = P.signEvent(unsigned, SECRET)
  assert.ok(verifyEvent(signed), 'nostr-tools rejects a signature this package produced')
  assert.equal(getEventHash(signed), signed.id)
})

/*
  The negative control. Without it, "nostr-tools agrees" is compatible with
  nostr-tools agreeing about everything, including a corrupted event — which is
  how a cross-check quietly stops checking.
*/
test('the oracle disagrees when the bytes are wrong', () => {
  const vector = vectors.events.find((v) => v.name === 'message-with-about')
  const tampered = { ...vector.event, tags: [vector.event.tags[0], vector.event.tags[2], vector.event.tags[1], ...vector.event.tags.slice(3)] }
  assert.notEqual(getEventHash(tampered), vector.id, 'reordering two tags must change the id — if it does not, this oracle proves nothing')
  assert.notEqual(P.computeEventId(tampered), vector.id)
  assert.equal(getEventHash(tampered), P.computeEventId(tampered), 'and the two implementations must still agree about the wrong answer')
})

test('nostr-tools decodes our naddr, and we decode its differently-ordered one', () => {
  const address = vectors.inputs.ADDR
  const ours = P.addrToNaddr(address, ['https://estiva.estiva.app'])
  const decodedByThem = ntNip19.decode(ours)
  assert.equal(decodedByThem.type, 'naddr')
  assert.equal(`${decodedByThem.data.kind}:${decodedByThem.data.pubkey}:${decodedByThem.data.identifier}`, address)

  const { kind, pubkey, identifier } = P.addressToPointer(address)
  const theirs = ntNip19.naddrEncode({ kind, pubkey, identifier, relays: ['https://estiva.estiva.app'] })
  assert.equal(P.naddrToAddr(theirs), address)

  // Measured, and worth pinning: the same pointer encodes to a DIFFERENT string
  // in the two implementations, because NIP-19 does not fix TLV order. Both
  // decoders read TLVs by type, so the strings interoperate — but nothing may
  // ever compare two naddrs as strings. Compare the addresses they decode to.
  assert.notEqual(ours, theirs)
})

/*
  The canonical NIP-19 `npub` from the specification itself, not from this
  encoder. The checksum layer round-trips against itself even with the wrong
  constant — bech32m instead of bech32 — so only a string produced by somebody
  else catches that, and this is the check that would have caught it.
*/
test('bech32, not bech32m — against the vector in the NIP itself', () => {
  const npub = 'npub180cvv07tjdrrgpa0j7j7tmnyl2yr6yr7l8j4s3evf6u64th6gkwsyjh6w6'
  const hex = '3bf0c63fcb93463407af97a5e5ee64fa883d107ef9e558472c4eb9aaaefa459d'
  const { hrp, data } = P.bech32Decode(npub)
  assert.equal(hrp, 'npub')
  const bytes = P.convertBits(data, 5, 8, false)
  assert.equal(bytes.map((b) => b.toString(16).padStart(2, '0')).join(''), hex)
  assert.equal(P.bech32Encode('npub', P.convertBits(bytes, 8, 5, true)), npub)
})

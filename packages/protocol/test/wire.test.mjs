/**
 * The invariant this package exists for: the bytes did not move.
 *
 * `wire-vectors.json` was recorded from `peek-app/convex/nostr/` and
 * `estiva-ship/lib/nostr/` **before** this package existed — the two
 * hand-written copies that were, between them, publishing to the live relay. So
 * these are not the package's own output blessed as correct; they are what the
 * apps were already doing, and every one of the 12 shapes both apps implemented
 * had an identical event id in both, which is what made the merge a
 * deduplication rather than a reconciliation.
 *
 * **A failure here is a MAJOR**, whether or not any TypeScript signature
 * changed (ADR 0002 §4b). Do not regenerate the fixture to make it pass: that
 * erases the finding. Regenerating is correct only when a builder is deliberately
 * given a new shape, and then the release note says so under "Wire behaviour".
 *
 * Runs against `dist/`, because dist is what ships.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'

const vectors = JSON.parse(readFileSync(new URL('./wire-vectors.json', import.meta.url), 'utf8'))
const P = await import('../dist/index.js')

const { PUB, PUB2, CH, EV1, EV2, MS, ADDR, SECRET, AWKWARD, ABOUT_TEXT } = vectors.inputs

/**
 * Every recorded vector, rebuilt from the package.
 *
 * The arguments are spelled out again rather than read from the fixture: a test
 * that replayed stored arguments through the stored code path would pass on a
 * builder that ignores its input. These are the call sites, written out, and the
 * fixture is only the expected answer.
 */
const rebuild = {
  profile: () =>
    P.buildProfile(PUB, MS, { display_name: 'Ada', name: 'ada', picture: 'https://x/y.png', about: ABOUT_TEXT, nip05: 'ada@estiva.app' }),
  'createChannel-minimal': () => P.buildCreateChannel(PUB, MS, { channelUuid: CH, name: '  # Design  ' }),
  'createChannel-full': () =>
    P.buildCreateChannel(PUB, MS, { channelUuid: CH, name: 'Ops', visibility: 'private', channelType: 'forum', about: 'the ops room', ttlSeconds: 86400 }),
  addMember: () => P.buildAddMember(PUB, MS, { channelUuid: CH, targetPubkey: PUB2.toUpperCase(), role: 'admin' }),
  reaction: () => P.buildReaction(PUB, MS, { targetEventId: EV1, emoji: '\u{1F389}' }),
  deletion: () => P.buildDeletion(PUB, MS, { targetEventId: EV1 }),
  'message-awkward-content': () => P.buildMessage(PUB, MS, { channelUuid: CH, content: AWKWARD }),
  'message-direct-reply': () => P.buildMessage(PUB, MS, { channelUuid: CH, content: 'r', threadRef: { rootId: EV1, parentId: EV1 } }),
  'message-nested-reply': () => P.buildMessage(PUB, MS, { channelUuid: CH, content: 'r', threadRef: { rootId: EV1, parentId: EV2 } }),
  'message-mentions-dedup-broadcast-imeta': () =>
    P.buildMessage(PUB, MS, { channelUuid: CH, content: 'hi', mentions: [PUB2.toUpperCase(), PUB2, PUB], broadcast: true, mediaTags: [['imeta', 'url https://x/a.png', 'm image/png']] }),
  'message-with-about': () =>
    P.buildMessage(PUB, MS, { channelUuid: CH, content: 'about an issue', threadRef: { rootId: EV1, parentId: EV1 }, about: [ADDR, ADDR, `30850:${PUB}:p1`], mentions: [PUB2] }),
  deleteChannel: () => P.buildDeleteChannel(PUB, MS, { channelUuid: CH }),
  editChannelMetadata: () => P.buildEditChannelMetadata(PUB, MS, { channelUuid: CH, name: ' #Renamed ', about: 'why' }),
  'resolution-resolved': () =>
    P.buildResolution(PUB, MS, { channelUuid: CH, targetEventId: EV1, action: 'resolved', supportingEventId: EV2, rationale: 'shipped' }),
  'resolution-reopened': () => P.buildResolution(PUB, MS, { channelUuid: CH, targetEventId: EV1, action: 'reopened' }),
  relayAuth: () => P.buildUnsignedRelayAuthEvent({ pubkey: '', relayUrl: 'wss://estiva.estiva.app/some/path', challenge: 'chal-123', nowMs: MS }),
  'bare-file': () =>
    P.buildBareFile(PUB, MS, { fileId: 'f1', title: 'Spec', channelUuid: CH, parent: `30850:${PUB}:p1`, document: { type: 'doc', content: [{ type: 'paragraph', id: 'b1', content: [{ type: 'text', text: 'Ship Friday.' }] }] } }),
  component: () =>
    P.buildComponent(PUB, MS, { componentId: 'c1', fileId: 'f1', type: 'nfb/todo', payload: { done: false }, channelUuid: CH, labels: [{ namespace: 'nfb.x', value: 'v' }] }),
  highlight: () =>
    P.buildHighlight(PUB, MS, { content: 'an excerpt', channelUuid: CH, sourceEventId: EV1, sourceUrl: 'https://x/y', attribution: [PUB2.toUpperCase()], labels: [{ namespace: 'nfb.highlight', value: 'insight' }] }),
  'nip98-auth-no-body': () => P.buildUnsignedAuthEvent({ pubkey: PUB, url: 'https://estiva.estiva.app/query/', method: 'post', nowMs: MS, nonce: 'deadbeef' }),
  'nip98-auth-with-body': () => P.buildUnsignedAuthEvent({ pubkey: PUB, url: 'https://estiva.estiva.app/events', method: 'POST', body: '{"a":1}', nowMs: MS, nonce: 'cafe' }),
}

test('every recorded builder is covered — a vector nobody rebuilds is not a check', () => {
  const recorded = vectors.events.map((v) => v.name).sort()
  assert.deepEqual(Object.keys(rebuild).sort(), recorded)
})

for (const vector of vectors.events) {
  test(`${vector.name} — bytes unchanged (was: ${vector.producedBy.join(' + ')})`, () => {
    const built = rebuild[vector.name]()
    // The whole event, not just the id: two events can hash the same only by
    // collision, but a diff on the tags is what a person can actually read.
    assert.deepEqual(built, vector.event)
    assert.equal(P.computeEventId(built), vector.id)
  })
}

test('the three naddr encodings Peek and Ship already agreed on', () => {
  assert.equal(P.encodeNaddr({ ...P.addressToPointer(ADDR), relays: ['https://estiva.estiva.app'] }), vectors.naddr.withRelay.peek)
  assert.equal(P.addrToNaddr(ADDR, ['https://estiva.estiva.app']), vectors.naddr.withRelay.ship)
  assert.equal(P.addrToNaddr(ADDR), vectors.naddr.withoutRelay.ship)
  // A `d` tag containing colons — only the first two separate the address.
  assert.equal(P.addrToNaddr(`30078:${PUB}:peek:read:v1`), vectors.naddr.colonsInIdentifier.ship)
  assert.equal(P.naddrToAddr(vectors.naddr.colonsInIdentifier.peek), `30078:${PUB}:peek:read:v1`)
})

test('stripNaddrs repairs whitespace exactly as before, and leaves clean text alone', () => {
  const naddr = vectors.naddr.withRelay.ship
  assert.equal(P.stripNaddrs(`See nostr:${naddr} for details.`), vectors.strip.inline)
  assert.equal(P.stripNaddrs(`Header\n\nnostr:${naddr}\n\nFooter`), vectors.strip.ownLine)
  // Byte-identical when there is nothing to strip. A display helper that
  // reflowed somebody's indentation for free would be a bug wearing a tidy-up's
  // clothes.
  assert.equal(P.stripNaddrs('  no pointer   here  '), vectors.strip.untouched)
})

test('publicKeyFromSecret is unchanged', () => {
  assert.equal(P.publicKeyFromSecret(SECRET), vectors.keys.pubkey)
})

/*
  The strongest check available: events the relay itself accepted, stored and
  handed back. Their `id` and `sig` are the relay's answer, not ours, so
  reproducing the id is a check against the authority rather than against
  ourselves — which is the difference between "our tests pass" and "the wire
  format is still right".

  Sampled from the 96 RECORDED events in Ship's fold fixture, deliberately not
  from the 7 adversarial ones alongside them. Those are hand-built — `h` is the
  literal string "fixture-folder", which the relay would refuse as a channel id
  in the first place — and were never published anywhere, so calling them
  "production" would have been a claim about the relay that the relay had never
  agreed to. One is kept below on its own terms.
*/
for (const event of vectors.production.events) {
  test(`production kind:${event.kind} ${event.id.slice(0, 12)} — the relay's own id reproduces`, () => {
    assert.equal(P.computeEventId(event), event.id)
  })
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/

test('every production vector really is relay-shaped, so the label is earned', () => {
  for (const event of vectors.production.events) {
    const h = event.tags.find((t) => t[0] === 'h')?.[1]
    assert.ok(h === undefined || UUID.test(h), `${event.id}: h is "${h}", which no relay would have stored`)
    assert.match(event.pubkey, /^[0-9a-f]{64}$/)
    assert.match(event.sig, /^[0-9a-f]{128}$/)
  }
})

for (const event of vectors.synthetic.events) {
  test(`synthetic kind:${event.kind} ${event.id.slice(0, 12)} — id computes, relay unasked`, () => {
    assert.equal(P.computeEventId(event), event.id)
    assert.ok(!UUID.test(event.tags.find((t) => t[0] === 'h')?.[1] ?? ''), 'if this ever becomes uuid-shaped it belongs in the production set')
  })
}

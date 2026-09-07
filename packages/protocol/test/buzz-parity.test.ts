/**
 * Cross-implementation regression test.
 *
 * The expected event ids below are not hand-computed: they are the ids Buzz's
 * own Rust crates produced and verified in Phase 4
 * (docs/buzz-compat/phase4-run-output.txt) — `buzz_core::verify_event` accepted
 * them, and `buzz_sdk::builders::build_message` / `build_create_channel`
 * regenerated the identical id from the same inputs.
 *
 * So if these assertions fail, this TypeScript has diverged from Buzz's Rust —
 * which is exactly the drift this whole exercise is trying to prevent. Do not
 * "fix" a failure by updating the expected id; find what changed in the tags,
 * the tag order, or the content.
 */
import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import {
  buildAddMember,
  buildUnsignedRelayAuthEvent,
  relayAuthUrl,
  buildCreateChannel,
  buildDeleteChannel,
  buildDeletion,
  buildEdit,
  buildMessage,
  buildProfile,
  buildReaction,
  canonicalChannelName,
  computeEventId,
} from '../dist/index.js'

/** Derived in Phase 4 from sha256("peek:probe:user:jd7a8f2k3m9p0q1r2s3t4u5v6w"). */
const PUBKEY = '714902a6e7b9a991fe77ebd9cc4dad01b6474afdf58048277e1ec6b9cde567e8'
const CHANNEL = '7b32200c-e4c0-4216-b79a-8490fc05e0bd'

describe('parity with Buzz’s Rust builders', () => {
  it('kind:9 message reproduces the id Buzz’s build_message produced', () => {
    const event = buildMessage(PUBKEY, 1_753_300_200_000, {
      channelUuid: CHANNEL,
      content: 'The new sign-up flow drops a step. Worth a look before Friday.',
    })
    assert.deepEqual(event.tags, [['h', CHANNEL]])
    assert.equal(computeEventId(event), '4f0edeb3b732fa1c44c4dbd26563b4acad022ffeb469ccfdb2aeb02088a92546')
  })

  it('kind:9007 create-channel reproduces the id Buzz’s build_create_channel produced', () => {
    const event = buildCreateChannel(PUBKEY, 1_753_300_100_000, {
      channelUuid: CHANNEL,
      name: 'Onboarding redesign',
      visibility: 'open',
      channelType: 'stream',
    })
    assert.deepEqual(event.tags, [
      ['h', CHANNEL],
      ['name', 'Onboarding redesign'],
      ['visibility', 'open'],
      ['channel_type', 'stream'],
    ])
    assert.equal(computeEventId(event), 'e6fb22b28309ae82d34f5f28c38a572bf84dab47fb6bad8f4fe001e9638e87b8')
  })
})

describe('shape rules taken from builders.rs', () => {
  it('canonicalChannelName strips leading # and whitespace, trims the end', () => {
    // Buzz applies this before tagging, so a mismatch changes the event id.
    assert.equal(canonicalChannelName('  #design  '), 'design')
    assert.equal(canonicalChannelName('##a b '), 'a b')
    assert.equal(canonicalChannelName('normal'), 'normal')
  })

  it('kind:9000 orders tags h, p, role and lowercases the target', () => {
    const target = 'C6047F9441ED7D6D3045406E95C07CD85C778E4B8CEF3CA7ABAC09B95C709EE5'
    const event = buildAddMember(PUBKEY, 1_753_300_100_000, {
      channelUuid: CHANNEL,
      targetPubkey: target,
      role: 'member',
    })
    assert.deepEqual(event.tags, [
      ['h', CHANNEL],
      ['p', target.toLowerCase()],
      ['role', 'member'],
    ])
    assert.equal(event.content, '')
  })

  it('kind:0 serializes profile keys alphabetically, as serde_json’s BTreeMap does', () => {
    // Buzz does NOT enable serde_json's preserve_order feature, so its Map is a
    // BTreeMap and keys come out sorted. Insertion order here is deliberately
    // scrambled to prove we sort rather than preserve.
    const event = buildProfile(PUBKEY, 1_753_300_100_000, {
      picture: 'https://example.com/a.png',
      display_name: 'Alice Chen',
      about: 'Design Lead',
    })
    assert.equal(event.content, '{"about":"Design Lead","display_name":"Alice Chen","picture":"https://example.com/a.png"}')
    assert.deepEqual(event.tags, [])
  })

  it('drops empty and undefined profile fields entirely', () => {
    const event = buildProfile(PUBKEY, 0, { display_name: 'X', about: '', nip05: undefined })
    assert.equal(event.content, '{"display_name":"X"}')
  })

  it('dedupes mentions, preserves first-seen order, and caps at 50', () => {
    const a = 'a'.repeat(64)
    const b = 'b'.repeat(64)
    const event = buildMessage(PUBKEY, 0, {
      channelUuid: CHANNEL,
      content: 'hi',
      mentions: [b, a, b],
    })
    assert.deepEqual(event.tags, [
      ['h', CHANNEL],
      ['p', b],
      ['p', a],
    ])

    assert.throws(() =>
      buildMessage(PUBKEY, 0, {
        channelUuid: CHANNEL,
        content: 'hi',
        mentions: Array.from({ length: 51 }, (_, i) => String(i).padStart(64, '0')),
      }), /too many mentions/)
  })

  it('rejects content over the 64 KiB cap build_message enforces', () => {
    assert.throws(() =>
      buildMessage(PUBKEY, 0, { channelUuid: CHANNEL, content: 'x'.repeat(64 * 1024 + 1) }), /max 65536/)
  })

  it('measures the content cap in bytes, not characters', () => {
    // 'é' is 2 bytes in UTF-8 — a char-based check would let this through.
    assert.throws(() =>
      buildMessage(PUBKEY, 0, { channelUuid: CHANNEL, content: 'é'.repeat(32 * 1024 + 1) }), /max 65536/)
  })

  /**
   * This test previously asserted a `["e", root, "", "root"]` tag for a direct
   * reply, which is what I assumed rather than what Buzz does. It passed, because
   * it pinned my assumption. `thread_tags` (builders.rs:173) emits a SINGLE
   * `"reply"`-marked tag when root == parent, and only splits into root+reply
   * when they differ. Both branches are covered below so the mistake cannot
   * come back.
   */
  it('emits ONE reply-marked e-tag for a direct reply, as thread_tags does', () => {
    const parent = '1'.repeat(64)
    const event = buildMessage(PUBKEY, 0, {
      channelUuid: CHANNEL,
      content: 'hi',
      threadRef: { rootId: parent, parentId: parent },
    })
    assert.deepEqual(event.tags, [
      ['h', CHANNEL],
      ['e', parent, '', 'reply'],
    ])
  })

  it('emits root then reply for a nested reply', () => {
    const root = '1'.repeat(64)
    const parent = '2'.repeat(64)
    const event = buildMessage(PUBKEY, 0, {
      channelUuid: CHANNEL,
      content: 'hi',
      threadRef: { rootId: root, parentId: parent },
    })
    assert.deepEqual(event.tags, [
      ['h', CHANNEL],
      ['e', root, '', 'root'],
      ['e', parent, '', 'reply'],
    ])
  })

  it('kind:7 reaction carries only an e-tag — no h tag', () => {
    // Buzz derives the channel from the target's own #e tag and ignores a
    // client-supplied #h, so adding one would change the id for no benefit.
    const target = '3'.repeat(64)
    const event = buildReaction(PUBKEY, 0, { targetEventId: target, emoji: '👍' })
    assert.equal(event.kind, 7)
    assert.deepEqual(event.tags, [['e', target]])
    assert.equal(event.content, '👍')
  })

  it('kind:5 deletion targets one event with empty content', () => {
    const target = '4'.repeat(64)
    const event = buildDeletion(PUBKEY, 0, { targetEventId: target })
    assert.equal(event.kind, 5)
    assert.deepEqual(event.tags, [['e', target]])
    assert.equal(event.content, '')
  })

  /*
    kind:40003 — the one builder here that deliberately does NOT mirror Buzz's
    tags exactly. `build_edit` emits h and e only; this adds `ts`, because two
    edits published in the same second otherwise have no defined order and, unlike
    a change event, there is no per-field last-write-wins to limit the damage
    (RFC 0.4 §7.2.1). The relay validates kind, `h` and ownership and ignores tags
    it has no rule for, so the addition is safe in the direction that matters.
  */
  it('kind:40003 edit carries the channel, the target and a millisecond ts', () => {
    const target = '5'.repeat(64)
    const event = buildEdit(PUBKEY, 1_753_300_200_999, {
      channelUuid: CHANNEL,
      targetEventId: target,
      body: 'Corrected: the deploy is Thursday.',
    })
    assert.equal(event.kind, 40003)
    assert.deepEqual(event.tags, [
      ['h', CHANNEL],
      ['e', target],
      ['ts', '1753300200999'],
    ])
    assert.equal(event.content, 'Corrected: the deploy is Thursday.')
  })

  /*
    The `ts` rule is "honour it only when it agrees with created_at to the
    second". A rounded ts on a .999 instant would land in the NEXT second and be
    discarded by that very rule, so the floor is load-bearing rather than
    stylistic.
  */
  it('  …whose ts agrees with created_at to the second, which is what makes it usable', () => {
    const event = buildEdit(PUBKEY, 1_753_300_200_999, {
      channelUuid: CHANNEL,
      targetEventId: '5'.repeat(64),
      body: 'x',
    })
    const ts = Number(event.tags.find((t) => t[0] === 'ts')![1])
    assert.equal(Math.floor(ts / 1000), event.created_at)
  })

  it('kind:40003 refuses a body past the 64KB cap, as build_edit does', () => {
    assert.throws(
      () =>
        buildEdit(PUBKEY, 0, {
          channelUuid: CHANNEL,
          targetEventId: '5'.repeat(64),
          body: 'x'.repeat(64 * 1024 + 1),
        }),
      /max 65536/,
    )
  })

  it('truncates Peek’s millisecond timestamps to Nostr seconds', () => {
    const event = buildMessage(PUBKEY, 1_753_300_200_999, { channelUuid: CHANNEL, content: 'hi' })
    assert.equal(event.created_at, 1_753_300_200)
  })
})

/**
 * kind:9008 delete-group (PEEK-170).
 *
 * Deleting a topic removed it, its messages, replies, reactions and huddles
 * from Convex and published nothing — so a conversation somebody deleted,
 * believing it gone, stayed readable to every admitted member. Measured on
 * production: 145 messages across 37 channels, zero deletion requests.
 */
describe('telling the relay a topic is gone', () => {
  it('carries the channel in an h tag and nothing else', () => {
    const event = buildDeleteChannel(PUBKEY, 1_753_300_200_000, { channelUuid: CHANNEL })
    assert.equal(event.kind, 9008)
    /*
      Exactly one tag. Buzz reads the channel from `h` and authorises on it —
      "only owner can delete group" in `validate_admin_event` — so anything else
      here is either ignored or changes the event id for no reason.
    */
    assert.deepEqual(event.tags, [['h', CHANNEL]])
    assert.equal(event.content, '')
  })

  it('refuses a pubkey that is not one', () => {
    // The relay would reject the signature anyway; failing here says why.
    assert.throws(() => buildDeleteChannel('not-a-pubkey', Date.now(), { channelUuid: CHANNEL }))
  })

  /*
    Not a kind:5 per message, and the difference is capability rather than
    efficiency: Buzz rejects a multi-target kind:5 outright, and NIP-09 is
    honoured only for the key that signed the original — so per-message deletion
    could never reach anybody else's messages in the topic. Deleting the channel
    hides the whole container regardless of who wrote what.
  */
  it('is a different event from the per-message deletion, on purpose', () => {
    const group = buildDeleteChannel(PUBKEY, 1_753_300_200_000, { channelUuid: CHANNEL })
    const one = buildDeletion(PUBKEY, 1_753_300_200_000, { targetEventId: PUBKEY })
    assert.notEqual(group.kind, one.kind)
    assert.equal(one.tags[0][0], 'e')
    assert.equal(group.tags[0][0], 'h')
  })
})

describe('the NIP-42 auth event (PEE-5)', () => {
  const CHALLENGE = 'c'.repeat(64)

  it('carries the relay and challenge tags Buzz looks up', () => {
    // `verify_nip42_event` finds both by name — `TagKind::Challenge` and
    // `TagKind::Relay` — so what matters is that they are present and exact,
    // not their order. The challenge is compared byte for byte.
    const event = buildUnsignedRelayAuthEvent({
      pubkey: '',
      relayUrl: 'wss://estiva.estiva.app',
      challenge: CHALLENGE,
      nowMs: 1_756_000_000_000,
    })
    assert.equal(event.kind, 22242)
    assert.equal(event.content, '')
    assert.equal(event.created_at, 1_756_000_000)
    assert.deepEqual(event.tags, [
      ['relay', 'wss://estiva.estiva.app'],
      ['challenge', CHALLENGE],
    ])
  })

  it('reduces the relay tag to an origin', () => {
    // `nip42_expected_relay_url` is `format!("{scheme}://{}", tenant.host())` —
    // no path, ever. Buzz's `normalize_relay_url` forgives a trailing slash but
    // not a path segment, so anything beyond the origin fails the comparison.
    assert.equal(relayAuthUrl('wss://estiva.estiva.app'), 'wss://estiva.estiva.app')
    assert.equal(relayAuthUrl('wss://estiva.estiva.app/'), 'wss://estiva.estiva.app')
    assert.equal(relayAuthUrl('wss://estiva.estiva.app/relay/socket'), 'wss://estiva.estiva.app')
    assert.equal(relayAuthUrl('ws://localhost:3100'), 'ws://localhost:3100')
  })

  it('keeps the port, which is part of the tenant host', () => {
    // Buzz's own test uses `host-a.example:3100`, and `tenant.host()` is an
    // authority rather than a hostname — dropping the port would be a mismatch
    // against every non-default-port deployment, i.e. the local suite.
    assert.equal(relayAuthUrl('ws://a.localhost:3100'), 'ws://a.localhost:3100')
  })

  it('leaves pubkey empty for /sign to fill in', () => {
    // Same contract as the NIP-98 builder: `/sign` overwrites it with the
    // token's subject, and `expectedPubkey` at the call site is the check.
    assert.equal(buildUnsignedRelayAuthEvent({
      pubkey: '',
      relayUrl: 'wss://estiva.estiva.app',
      challenge: CHALLENGE,
    }).pubkey, '')
  })
})

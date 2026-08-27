/**
 * The HTTP bridge: the `accepted` rule, and a client that signs its own auth.
 *
 * `HTTP 200 {"accepted":false}` is a rejection that reads as a success, and it
 * is the failure no type and no status code catches. SPEC §5 states it and §9's
 * C3 makes it a conformance requirement; before SHA-3 the handling was written
 * out twice, once in Peek's browser bridge and once in Ship's `Relay`, which is
 * why `parsePublishResponse` is exported on its own — an app with its own
 * transport still shares the *interpretation of the answer*.
 *
 * The socket and the per-channel subscription manager are covered by
 * `live.test.ts` and `subscriptions.test.ts`, ported with the code itself out of
 * `peek-app/src/nostr/`. They go deeper than a second harness here would, so
 * this file stops at the bridge.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { parsePublishResponse, parseQueryResponse, Relay, secretKeySigner, buildMessage } from '../dist/index.js'

const CH = '24f5c271-3ed4-47f7-92e4-e9d6cf7f42d1'

// ── the `accepted` rule ────────────────────────────────────────────────────

test('HTTP 200 with accepted:false is a rejection, not a success', () => {
  const r = parsePublishResponse(200, JSON.stringify({ accepted: false, message: 'restricted: not a member' }))
  assert.equal(r.ok, false)
  assert.equal(r.duplicate, false)
  assert.equal(r.reason, 'restricted: not a member')
})

test('a duplicate is the desired end state, so it reports ok', () => {
  const r = parsePublishResponse(200, JSON.stringify({ accepted: false, message: 'duplicate: channel already exists', event_id: 'abc' }))
  assert.equal(r.ok, true)
  assert.equal(r.duplicate, true)
  assert.equal(r.eventId, 'abc')
})

test('accepted:true is ok, and the event id comes back', () => {
  const r = parsePublishResponse(200, JSON.stringify({ accepted: true, event_id: 'abc' }))
  assert.deepEqual(r, { ok: true, eventId: 'abc', httpStatus: 200 })
})

test('a non-2xx keeps the status, so 403 is distinguishable from 500', () => {
  const r = parsePublishResponse(403, JSON.stringify({ error: 'relay_membership_required' }))
  assert.equal(r.ok, false)
  assert.equal(r.httpStatus, 403)
  assert.equal(r.reason, 'relay_membership_required')
})

test('an unparseable body is a failure that says so, not a crash', () => {
  const r = parsePublishResponse(502, '<html>bad gateway</html>')
  assert.equal(r.ok, false)
  assert.match(r.reason, /bad gateway/)
})

test('a query answers with events, and a refusal is not an empty result', () => {
  assert.deepEqual(parseQueryResponse(200, '[]').events, [])
  const refused = parseQueryResponse(403, JSON.stringify({ error: 'relay_membership_required' }))
  assert.equal(refused.ok, false)
  assert.equal(refused.reason, 'relay_membership_required')
  // "no events" and "you were refused" must not look alike: a caller that
  // cannot tell them apart renders an empty screen either way.
  assert.notEqual(refused.ok, parseQueryResponse(200, '[]').ok)
})

// ── the bridge client signs its own auth ───────────────────────────────────

const SECRET = '0000000000000000000000000000000000000000000000000000000000000001'

test('every request carries a NIP-98 header, and /query sends a bare array', async () => {
  const seen = []
  const relay = new Relay('https://estiva.estiva.app/', secretKeySigner(SECRET), {
    fetch: async (url, init) => {
      seen.push({ url, init })
      return { status: 200, text: async () => '[]' }
    },
  })
  await relay.query([{ '#h': [CH] }])
  assert.equal(seen.length, 1)
  assert.equal(seen[0].url, 'https://estiva.estiva.app/query', 'the trailing slash is trimmed once, at construction')
  assert.match(seen[0].init.headers.authorization, /^Nostr [A-Za-z0-9+/=]+$/)
  assert.equal(seen[0].init.body, JSON.stringify([{ '#h': [CH] }]), 'a bare array — one filter object gets "invalid type: map, expected a sequence"')

  const auth = JSON.parse(Buffer.from(seen[0].init.headers.authorization.slice('Nostr '.length), 'base64').toString('utf8'))
  assert.equal(auth.kind, 27235)
  assert.deepEqual(auth.tags.map((t) => t[0]), ['u', 'method', 'nonce', 'payload'])
  assert.equal(auth.tags[0][1], 'https://estiva.estiva.app/query')
})

test('two identical requests in one second get different auth event ids', async () => {
  const ids = []
  const relay = new Relay('https://estiva.estiva.app', secretKeySigner(SECRET), {
    fetch: async (_url, init) => {
      const auth = JSON.parse(Buffer.from(init.headers.authorization.slice('Nostr '.length), 'base64').toString('utf8'))
      ids.push(auth.id)
      return { status: 200, text: async () => '[]' }
    },
  })
  await relay.query([{ kinds: [9] }])
  await relay.query([{ kinds: [9] }])
  // Buzz records each auth event id in a Redis seen-set. `created_at` has
  // one-second resolution, so without the nonce these two would be
  // byte-identical and the second refused as `NIP-98: replay detected`.
  assert.notEqual(ids[0], ids[1])
})

test("a caller's extra headers cannot displace the authorization", async () => {
  let headers
  const relay = new Relay('https://r', secretKeySigner(SECRET), {
    headers: () => ({ 'x-auth-tag': 'attestation', authorization: 'Bearer nope' }),
    fetch: async (_u, init) => {
      headers = init.headers
      return { status: 200, text: async () => JSON.stringify({ accepted: true }) }
    },
  })
  const signer = secretKeySigner(SECRET)
  await relay.publish(await signer.sign(buildMessage(signer.pubkey, 1787142018561, { channelUuid: CH, content: 'x' })))
  assert.equal(headers['x-auth-tag'], 'attestation', 'an ambient credential still rides along')
  assert.match(headers.authorization, /^Nostr /, 'but it may not override this client’s own contract with the relay')
})

test('a bare headers callback is still accepted as the second option', async () => {
  let headers
  const relay = new Relay('https://r', secretKeySigner(SECRET), () => ({ 'x-auth-tag': 'v' }))
  // No transport override is possible through the old form, so drive it through
  // a global stub — the point is only that the callback shape still binds.
  const saved = globalThis.fetch
  globalThis.fetch = async (_u, init) => {
    headers = init.headers
    return { status: 200, text: async () => '[]' }
  }
  try {
    await relay.query([{ kinds: [9] }])
  } finally {
    globalThis.fetch = saved
  }
  assert.equal(headers['x-auth-tag'], 'v')
})

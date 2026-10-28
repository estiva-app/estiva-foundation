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
import { mock, test } from 'node:test'
import assert from 'node:assert/strict'
import {
  parsePublishResponse,
  parseQueryResponse,
  commandPayload,
  Relay,
  secretKeySigner,
  buildMessage,
} from '../dist/index.js'
// Read off the namespace, so the file still loads on a build without it.
import * as protocol from '../dist/index.js'

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

// ── a command kind's answer ────────────────────────────────────────────────
//
// Both bodies below are the relay's, copied from a production run on
// 2026-09-17: one 41010 opening a DM, then the same signed event replayed.

test('a command kind answers in `message`, and the accepted branch keeps it', () => {
  const r = parsePublishResponse(
    200,
    JSON.stringify({
      accepted: true,
      event_id: '66ae946e6242cf970258b1e9017eba1ba94a106a079fcd700825bbd788029d09',
      message: 'response:{"channel_id":"6a8d299d-f86c-4b42-a2de-8954f4ed1d91","created":false}',
    }),
  )
  assert.equal(r.ok, true)
  assert.deepEqual(commandPayload(r), {
    channel_id: '6a8d299d-f86c-4b42-a2de-8954f4ed1d91',
    created: false,
  })
})

test('a byte-identical replay is accepted, duplicate, and answers nothing', () => {
  const r = parsePublishResponse(
    200,
    JSON.stringify({
      accepted: true,
      event_id: '66ae946e6242cf970258b1e9017eba1ba94a106a079fcd700825bbd788029d09',
      message: 'duplicate: already processed',
    }),
  )
  assert.equal(r.ok, true)
  assert.equal(r.duplicate, true, 'a caller must be able to tell a replay from a command that said nothing')
  assert.equal(r.message, 'duplicate: already processed')
  assert.equal(commandPayload(r), undefined)
})

test('a message that is not a `response:` payload parses to nothing, not a throw', () => {
  assert.equal(commandPayload({ message: undefined }), undefined)
  assert.equal(commandPayload({ message: 'response:{not json' }), undefined)
  assert.equal(commandPayload({ message: 'response:"a string"' }), undefined)
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

// ── a relay too busy to answer ─────────────────────────────────────────────
// why: https://github.com/estiva-app/estiva-docs/blob/main/decisions/a-busy-relay-says-it-is-busy.md

const BUSY = { status: 503, body: JSON.stringify({ error: 'relay busy, retry shortly' }) }

/** A relay that gives `answers` in turn (the last one repeats), counting the asks. */
function scriptedRelay(answers) {
  const asked = []
  const relay = new Relay('https://r', secretKeySigner(SECRET), {
    fetch: async (url) => {
      const answer = answers[Math.min(asked.length, answers.length - 1)]
      asked.push(url)
      const headers = new Map(Object.entries(answer.headers ?? {}))
      return { status: answer.status, text: async () => answer.body, headers: { get: (name) => headers.get(name) ?? null } }
    },
  })
  return { relay, asked }
}

/** Run `promise` to its end under fake timers, moving the clock past each retry wait. */
async function settle(promise) {
  let done = false
  const tracked = promise.finally(() => {
    done = true
  })
  tracked.catch(() => {})
  while (!done) {
    await new Promise((resolve) => setImmediate(resolve))
    mock.timers.tick(10_000)
  }
  return tracked
}

test('a busy relay is asked again quietly, and the read returns what it then sends', async (t) => {
  mock.timers.enable({ apis: ['setTimeout'] })
  t.after(() => mock.timers.reset())
  const event = { id: 'e1', kind: 9 }
  const { relay, asked } = scriptedRelay([BUSY, { status: 200, body: JSON.stringify([event]) }])
  const answer = await settle(relay.query([{ kinds: [9] }])).catch((error) => error.message)
  assert.deepEqual(answer, [event])
  assert.equal(asked.length, 2)
})

test('a relay that stays busy is reported as "the relay is busy, try again in a moment"', async (t) => {
  mock.timers.enable({ apis: ['setTimeout'] })
  t.after(() => mock.timers.reset())
  const { relay, asked } = scriptedRelay([BUSY])
  await assert.rejects(settle(relay.query([{ kinds: [9] }])), (error) => {
    assert.equal(error.name, 'RelayBusyError')
    assert.equal(error.message, 'the relay is busy, try again in a moment')
    return true
  })
  assert.equal(asked.length, 4, 'the first ask and three quiet retries')
})

test('a read the relay cut off for running too long is not asked again', async (t) => {
  mock.timers.enable({ apis: ['setTimeout'] })
  t.after(() => mock.timers.reset())
  const { relay, asked } = scriptedRelay([{ status: 503, body: JSON.stringify({ error: 'query timed out' }) }])
  await assert.rejects(settle(relay.query([{ kinds: [9] }])), (error) => error.name !== 'RelayBusyError')
  assert.equal(asked.length, 1)
})

test('the relay’s rate limit (a 503 marked rate-limited:) is not busy: asked once, and its own words reach the caller', async (t) => {
  mock.timers.enable({ apis: ['setTimeout'] })
  t.after(() => mock.timers.reset())
  const { relay, asked } = scriptedRelay([
    { status: 503, body: JSON.stringify({ error: 'rate-limited: shared admission unavailable' }) },
  ])
  await assert.rejects(settle(relay.query([{ kinds: [9] }])), (error) => {
    assert.notEqual(error.name, 'RelayBusyError')
    assert.match(error.message, /rate-limited: shared admission unavailable/)
    return true
  })
  assert.equal(asked.length, 1)
})

test('a busy relay asking for five seconds is asked again once, after them, not three times inside them', async (t) => {
  mock.timers.enable({ apis: ['setTimeout'] })
  t.after(() => mock.timers.reset())
  const { relay, asked } = scriptedRelay([{ ...BUSY, headers: { 'retry-after': '5' } }])
  const read = relay.query([{ kinds: [9] }])
  read.catch(() => {})
  const turn = () => new Promise((resolve) => setImmediate(resolve))
  for (let i = 0; i < 5; i++) await turn()
  assert.equal(asked.length, 1)
  mock.timers.tick(4_999)
  for (let i = 0; i < 5; i++) await turn()
  assert.equal(asked.length, 1, 'nothing is sent inside the Retry-After')
  mock.timers.tick(1)
  await assert.rejects(settle(read), (error) => error.name === 'RelayBusyError')
  assert.equal(asked.length, 2)
})

test('a 502 page from the proxy while the relay restarts is busy, and a send says so', async (t) => {
  mock.timers.enable({ apis: ['setTimeout'] })
  t.after(() => mock.timers.reset())
  const { relay, asked } = scriptedRelay([{ status: 502, body: '<!DOCTYPE html><title>502 Bad Gateway</title>' }])
  const signer = secretKeySigner(SECRET)
  const event = await signer.sign(buildMessage(signer.pubkey, 1787142018561, { channelUuid: CH, content: 'x' }))
  const result = await settle(relay.publish(event))
  assert.equal(result.ok, false)
  assert.equal(result.reason, 'the relay is busy, try again in a moment')
  assert.equal(asked.length, 4)
})

test('an app with its own transport gets the same quiet retries, each ask sent afresh', async (t) => {
  mock.timers.enable({ apis: ['setTimeout'] })
  t.after(() => mock.timers.reset())
  // Peek posts through Estiva ID's /sign, not a Relay: each ask signs new auth.
  const answers = [{ status: 502, text: 'Bad Gateway' }, { status: BUSY.status, text: BUSY.body }, { status: 200, text: '[]' }]
  let asks = 0
  const answer = await settle(protocol.retryWhileBusy(async () => answers[asks++]))
  assert.deepEqual(answer, { status: 200, text: '[]' })
  assert.equal(asks, 3)
})

test('an app with its own transport hears the last busy answer when the relay stays busy', async (t) => {
  mock.timers.enable({ apis: ['setTimeout'] })
  t.after(() => mock.timers.reset())
  let asks = 0
  const answer = await settle(protocol.retryWhileBusy(async () => (asks++, { status: BUSY.status, text: BUSY.body })))
  assert.equal(protocol.isRelayBusyResponse(answer.status, answer.text), true)
  assert.equal(asks, 4, 'the first ask and three quiet retries')
})

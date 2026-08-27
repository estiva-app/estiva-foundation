/**
 * The relay clients, and the three failures they exist to make visible.
 *
 * None of these is caught by a type or by a status code:
 *
 *  1. `HTTP 200 {"accepted":false}` — a rejection that reads as a success.
 *  2. A refused NIP-42 AUTH leaves the socket **open** and permanently unable to
 *     subscribe. `readyState` says OPEN; nothing arrives, forever.
 *  3. A reconnect that restores the socket but not its subscriptions. The app
 *     looks connected and never hears anything again.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  parsePublishResponse,
  parseQueryResponse,
  Relay,
  secretKeySigner,
  buildMessage,
  toWebSocketUrl,
  parseFrame,
  createLiveRelay,
  createChannelSubscriptions,
  relayAuthUrl,
} from '../dist/index.js'

const CH = '24f5c271-3ed4-47f7-92e4-e9d6cf7f42d1'
const CH2 = '996ab3d4-5565-4335-9e17-2284fda675a0'

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

// ── the socket ─────────────────────────────────────────────────────────────

test('scheme mapping, and a path is dropped from the NIP-42 relay tag', () => {
  assert.equal(toWebSocketUrl('https://estiva.estiva.app/'), 'wss://estiva.estiva.app')
  assert.equal(toWebSocketUrl('http://localhost:4000'), 'ws://localhost:4000')
  assert.equal(toWebSocketUrl('wss://x'), 'wss://x')
  assert.equal(toWebSocketUrl('estiva.estiva.app'), 'wss://estiva.estiva.app')
  // Buzz's nip42_expected_relay_url is scheme + tenant host, nothing else.
  assert.equal(relayAuthUrl('wss://estiva.estiva.app/socket?x=1'), 'wss://estiva.estiva.app')
})

test('an unknown frame is ignored rather than throwing', () => {
  assert.equal(parseFrame('["AUTH","chal"]').type, 'AUTH')
  assert.equal(parseFrame('["OK","id",true,"msg"]').type, 'OK')
  assert.equal(parseFrame('["EOSE","s1"]').type, 'EOSE')
  assert.equal(parseFrame('["CLOSED","s1","auth-required: x"]').type, 'CLOSED')
  assert.equal(parseFrame('["SOMETHING_NEW",1]').type, 'OTHER')
  assert.equal(parseFrame('not json').type, 'OTHER')
  assert.equal(parseFrame(42).type, 'OTHER')
  // A relay that grows a frame must not take the socket down with it.
  assert.equal(parseFrame('["OK","id","not-a-bool"]').type, 'OTHER')
})

/** A socket that records what was sent and lets a test push frames back. */
function fakeSocket() {
  const sent = []
  const socket = {
    sent,
    send: (data) => sent.push(JSON.parse(data)),
    close: () => {},
    onopen: null,
    onmessage: null,
    onclose: null,
    onerror: null,
    receive: (frame) => socket.onmessage?.({ data: JSON.stringify(frame) }),
  }
  return socket
}

function harness(overrides = {}) {
  const sockets = []
  const timers = []
  const states = []
  const relay = createLiveRelay({
    url: 'wss://estiva.estiva.app',
    getCredential: () => ({ accessToken: 't', pubkey: 'b'.repeat(64) }),
    sign: async (unsigned) => ({ ...unsigned, id: 'auth-id', sig: 'sig' }),
    onState: (s) => states.push(s),
    socketFactory: () => {
      const s = fakeSocket()
      sockets.push(s)
      return s
    },
    now: () => 1787142018561,
    setTimer: (fn) => {
      timers.push(fn)
      return timers.length
    },
    clearTimer: () => {},
    backoff: { baseMs: 1, maxMs: 1, jitter: () => 0 },
    ...overrides,
  })
  return { relay, sockets, timers, states, runTimers: () => timers.splice(0).forEach((fn) => fn()) }
}

test('a successful AUTH reaches live, and re-issues every subscription on reconnect', async () => {
  const h = harness({ subscriptionPrefix: 'test' })
  const events = []
  h.relay.subscribe([{ '#h': [CH] }], (e) => events.push(e))
  assert.equal(h.relay.state(), 'connecting')

  h.sockets[0].receive(['AUTH', 'chal'])
  await new Promise(setImmediate)
  h.sockets[0].receive(['OK', 'auth-id', true, ''])
  assert.equal(h.relay.state(), 'live')

  const req = h.sockets[0].sent.find((f) => f[0] === 'REQ')
  assert.deepEqual(req, ['REQ', 'test-0', { '#h': [CH] }])

  h.sockets[0].receive(['EVENT', 'test-0', { id: 'e1' }])
  assert.deepEqual(events, [{ id: 'e1' }])

  // Drop the socket. A reconnect that restores the connection and not the
  // subscriptions is the silent half of this failure.
  h.sockets[0].onclose?.({})
  h.runTimers()
  h.sockets[1].receive(['AUTH', 'chal2'])
  await new Promise(setImmediate)
  h.sockets[1].receive(['OK', 'auth-id', true, ''])
  assert.deepEqual(
    h.sockets[1].sent.find((f) => f[0] === 'REQ'),
    ['REQ', 'test-0', { '#h': [CH] }],
    'the subscription must come back with the socket',
  )
})

test('a refused AUTH is fatal for that socket, and gives up after three', async () => {
  const h = harness()
  for (let attempt = 0; attempt < 3; attempt++) {
    const socket = h.sockets[attempt]
    socket.receive(['AUTH', `chal${attempt}`])
    await new Promise(setImmediate)
    // Relay-side the connection is now AuthState::Failed and will refuse every
    // REQ while staying OPEN. Reconnecting is the only way out, and only a
    // limited number of times: a missing 22242 grant or a clock an hour out is
    // not something retrying fixes.
    socket.receive(['OK', 'auth-id', false, 'auth-required: bad signature'])
    h.runTimers()
  }
  assert.equal(h.relay.state(), 'failed')
  assert.ok(h.states.includes('authenticating'))
  assert.equal(h.sockets.length, 3, 'no fourth attempt')
})

test('CLOSED with auth-required reconnects; a plain CLOSED does not', async () => {
  const h = harness()
  h.relay.subscribe([{ '#h': [CH] }], () => {})
  h.sockets[0].receive(['AUTH', 'c'])
  await new Promise(setImmediate)
  h.sockets[0].receive(['OK', 'auth-id', true, ''])

  h.sockets[0].receive(['CLOSED', 'sub-0', 'restricted: p-gated events require #p matching your pubkey'])
  assert.equal(h.sockets.length, 1, 'a subscription the relay refuses on its merits is not a connection problem')

  h.sockets[0].receive(['CLOSED', 'sub-0', 'auth-required: authenticate before subscribing'])
  h.runTimers()
  assert.equal(h.sockets.length, 2, 'the poisoned-but-open state is only escapable by reconnecting')
})

test('no credential defers rather than counting as an auth failure', async () => {
  const h = harness({ getCredential: () => null })
  h.sockets[0].receive(['AUTH', 'c'])
  await new Promise(setImmediate)
  h.runTimers()
  // There is nothing to sign with and a session may yet appear, so this must not
  // burn one of the three attempts.
  assert.equal(h.relay.state(), 'reconnecting')
  assert.ok(h.sockets.length > 1)
})

// ── refcounted per-channel subscriptions ──────────────────────────────────

test('two consumers of one channel are one REQ, closed by the last to leave', () => {
  const opened = []
  const closed = []
  const subs = createChannelSubscriptions({
    subscribe: (filters, onEvent) => {
      opened.push(filters)
      return { close: () => closed.push(filters), onEvent }
    },
  })

  const a = subs.subscribe(CH, () => {})
  const b = subs.subscribe(CH, () => {})
  assert.deepEqual(opened, [[{ '#h': [CH] }]], 'one REQ, kindless — a kinds:[] filter is indexed nowhere and receives nothing')
  assert.equal(subs.subscriberCount(CH), 2)

  a.release()
  assert.equal(closed.length, 0, 'the first to leave must not close it under the second')
  b.release()
  assert.equal(closed.length, 1)
  assert.deepEqual(subs.activeChannels(), [])

  a.release()
  b.release()
  assert.equal(closed.length, 1, 'release is idempotent')
})

test('a listener that throws does not stop the others', () => {
  let delivered = 0
  const errors = []
  let deliver
  const subs = createChannelSubscriptions(
    { subscribe: (_f, onEvent) => ((deliver = onEvent), { close: () => {} }) },
    { onListenerError: (e) => errors.push(e) },
  )
  subs.subscribe(CH, () => {
    throw new Error('boom')
  })
  subs.subscribe(CH, () => delivered++)
  deliver({ id: 'e1' })
  assert.equal(delivered, 1, "one component's bug must not silently stop the whole channel updating")
  assert.equal(errors.length, 1)
})

test('a non-uuid key throws here rather than dying silently at the relay', () => {
  const subs = createChannelSubscriptions({ subscribe: () => ({ close: () => {} }) })
  // Buzz only counts an `#h` it can parse as a uuid; anything else registers the
  // subscription GLOBALLY, and a global subscription receives no channel-scoped
  // events at all. Peek's topic ids are Convex ids, which are not uuids — so
  // this is the likelier entrance to the trap, not the theoretical one.
  assert.throws(() => subs.subscribe('kg2abc123def456', () => {}), /not a channel uuid/)
  assert.throws(() => subs.subscribe(undefined, () => {}), /not a channel uuid/)
  assert.doesNotThrow(() => subs.subscribe(CH2, () => {}))
})

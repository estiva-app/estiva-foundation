/**
 * PEE-5 — the socket's behaviour, against a fake relay.
 *
 * The done-when is "reaches `live`, survives a forced disconnect with
 * subscriptions restored, and survives a token renewal without dropping". Each
 * of those is a test here; the live half is a browser probe, since signing a
 * 22242 needs a real user token.
 *
 * The fake relay is deliberately faithful to three behaviours read out of
 * `crates/buzz-*` rather than imagined, because all three present as a healthy
 * socket that delivers nothing:
 *
 *   * AUTH arrives unprompted, immediately on connect
 *   * a refused AUTH leaves the socket **open** and every later REQ is answered
 *     `CLOSED … auth-required`
 *   * a second AUTH on an authenticated connection is refused
 */
import { beforeEach, describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { KIND } from '../dist/index.js'
import type { SignedEvent, UnsignedEvent } from '../dist/index.js'
import { createLiveRelay, parseFrame, toWebSocketUrl, type SocketLike } from '../dist/index.js'

/*
  Two helpers vitest provided and `node:test` does not, written out rather than
  pulled in. The package's whole argument for staying thin is that a dependency
  has to earn itself, and a spy plus a poll do not.
*/
function fn<A extends unknown[], R>(impl?: (...args: A) => R) {
  const calls: A[] = []
  const spy = (...args: A): R => {
    calls.push(args)
    return impl?.(...args) as R
  }
  return Object.assign(spy, { calls })
}

/** Poll until `assertion` stops throwing, or give up. Replaces vitest's waitFor. */
async function waitFor(assertion: () => void, { timeout = 2000, interval = 5 } = {}): Promise<void> {
  const deadline = Date.now() + timeout
  for (;;) {
    try {
      assertion()
      return
    } catch (error) {
      if (Date.now() > deadline) throw error
      await new Promise((resolve) => setTimeout(resolve, interval))
    }
  }
}


const PUBKEY = 'a'.repeat(64)
const CHALLENGE = 'c'.repeat(64)

/** A fake socket that records what was sent and can be driven from the test. */
class FakeSocket implements SocketLike {
  static all: FakeSocket[] = []
  sent: unknown[][] = []
  closed = false
  onopen: SocketLike['onopen'] = null
  onmessage: SocketLike['onmessage'] = null
  onclose: SocketLike['onclose'] = null
  onerror: SocketLike['onerror'] = null

  readonly url: string

  // An explicit field rather than a parameter property: this repo builds with
  // `erasableSyntaxOnly`, under which `constructor(readonly url: string)` is a
  // type error. `vitest` does not care and `tsc -b` does — and `tsc -b` runs
  // only on a push to main, so the difference is a broken deploy rather than a
  // red PR.
  constructor(url: string) {
    this.url = url
    FakeSocket.all.push(this)
  }

  send(data: string) {
    if (this.closed) throw new Error('send on a closed socket')
    this.sent.push(JSON.parse(data))
  }

  close() {
    this.closed = true
  }

  /** Drive the client: open, then hand it a challenge exactly as Buzz does. */
  open() {
    this.onopen?.call(null, {})
  }

  deliver(frame: unknown) {
    this.onmessage?.call(null, { data: JSON.stringify(frame) })
  }

  drop() {
    this.closed = true
    this.onclose?.call(null, {})
  }

  /** Frames of one verb, in order. */
  sentOf(verb: string) {
    return this.sent.filter((f) => f[0] === verb)
  }

  get authEvent(): SignedEvent | undefined {
    return this.sentOf('AUTH')[0]?.[1] as SignedEvent | undefined
  }
}

/** A signer that stamps an id and a pubkey, standing in for `/sign`. */
function fakeSigner() {
  let n = 0
  const calls: { unsigned: UnsignedEvent; token: string; expectedPubkey: string }[] = []
  const sign = fn(
    async (unsigned: UnsignedEvent, token: string, expectedPubkey: string): Promise<SignedEvent> => {
      calls.push({ unsigned, token, expectedPubkey })
      return { ...unsigned, pubkey: expectedPubkey, id: `evt-${n++}`, sig: 'f'.repeat(128) }
    },
  )
  return { sign, calls }
}

interface HarnessOptions {
  credential?: () => { accessToken: string; pubkey: string } | null
}

function harness(opts: HarnessOptions = {}) {
  const { sign, calls } = fakeSigner()
  const states: string[] = []
  const timers: (() => void)[] = []
  const relay = createLiveRelay({
    url: 'https://relay.test',
    getCredential: opts.credential ?? (() => ({ accessToken: 'tok-1', pubkey: PUBKEY })),
    sign,
    onState: (s) => states.push(s),
    socketFactory: (url) => new FakeSocket(url),
    // Timers are collected rather than run, so backoff costs no wall time and
    // a test says explicitly when the next attempt happens.
    setTimer: (fn) => {
      timers.push(fn)
      return timers.length - 1
    },
    clearTimer: () => {},
    backoff: { baseMs: 1, maxMs: 2, jitter: () => 0 },
  })
  return {
    relay,
    states,
    signCalls: calls,
    sign,
    /** Run the pending reconnect, if one is scheduled. */
    runReconnect: () => timers.shift()?.(),
    socket: (i = 0) => FakeSocket.all[i] as FakeSocket,
    latest: () => FakeSocket.all[FakeSocket.all.length - 1] as FakeSocket,
  }
}

/** Connect and authenticate, the happy path, returning the live socket. */
async function reachLive(h: ReturnType<typeof harness>) {
  const s = h.latest()
  s.open()
  s.deliver(['AUTH', CHALLENGE])
  await waitFor(() => assert.notEqual(s.authEvent, undefined))
  s.deliver(['OK', s.authEvent?.id, true, ''])
  return s
}

beforeEach(() => {
  FakeSocket.all = []
})

describe('the URL', () => {
  it('converts an https relay origin to wss', () => {
    assert.equal(toWebSocketUrl('https://estiva.estiva.app'), 'wss://estiva.estiva.app')
    assert.equal(toWebSocketUrl('http://localhost:3000'), 'ws://localhost:3000')
  })

  it('leaves a ws-scheme URL alone and strips a trailing slash', () => {
    assert.equal(toWebSocketUrl('wss://estiva.estiva.app/'), 'wss://estiva.estiva.app')
    assert.equal(toWebSocketUrl('ws://localhost:3000'), 'ws://localhost:3000')
  })
})

describe('frame parsing', () => {
  it('reads every verb the relay sends', () => {
    assert.deepEqual(parseFrame(JSON.stringify(['AUTH', CHALLENGE])), {
      type: 'AUTH',
      challenge: CHALLENGE,
    })
    assert.deepEqual(parseFrame(JSON.stringify(['OK', 'id', false, 'nope'])), {
      type: 'OK',
      eventId: 'id',
      accepted: false,
      message: 'nope',
    })
    assert.deepEqual(parseFrame(JSON.stringify(['EOSE', 'sub'])), { type: 'EOSE', subId: 'sub' })
    assert.deepEqual(parseFrame(JSON.stringify(['CLOSED', 'sub', 'why'])), {
      type: 'CLOSED',
      subId: 'sub',
      message: 'why',
    })
    assert.deepEqual(parseFrame(JSON.stringify(['NOTICE', 'hi'])), { type: 'NOTICE', message: 'hi' })
  })

  it('ignores anything malformed rather than throwing', () => {
    // A relay that grows a frame must not be able to take the socket down.
    for (const raw of ['', 'not json', '{}', '[]', '[1,2]', JSON.stringify(['NEWVERB', 1])]) {
      assert.equal(parseFrame(raw).type, 'OTHER')
    }
    assert.equal(parseFrame(undefined).type, 'OTHER')
  })
})

describe('reaching live', () => {
  it('answers the challenge with a kind:22242 and goes live', async () => {
    const h = harness()
    const s = await reachLive(h)

    const auth = s.authEvent as SignedEvent
    assert.equal(auth.kind, KIND.RELAY_AUTH)
    assert.ok(auth.tags.some((t: string[]) => t.length === 2 && t[0] === 'challenge' && t[1] === CHALLENGE))
    // An origin, no path, no trailing slash — `nip42_expected_relay_url` is
    // `{scheme}://{tenant.host()}` and nothing else.
    assert.ok(auth.tags.some((t: string[]) => t.length === 2 && t[0] === 'relay' && t[1] === 'wss://relay.test'))
    assert.equal(h.relay.state(), 'live')
    assert.deepEqual(h.states, ['authenticating', 'live'])
  })

  it('passes expectedPubkey to the signer', async () => {
    // `/sign` signs as the token's subject whatever it is handed, so a mismatch
    // comes back 200 with an event authored by somebody else. The guard is the
    // only thing that catches it.
    const h = harness()
    await reachLive(h)
    assert.equal(h.signCalls[0]?.expectedPubkey, PUBKEY)
    assert.equal(h.signCalls[0]?.unsigned.pubkey, '')
  })

  it('stamps created_at in seconds, inside the relay’s ±60s window', async () => {
    const h = harness()
    const s = await reachLive(h)
    const createdAt = (s.authEvent as SignedEvent).created_at
    assert.ok((Math.abs(createdAt - Math.floor(Date.now() / 1000))) < (5))
  })
})

describe('subscriptions', () => {
  it('opens a subscription registered before the socket is live', async () => {
    const h = harness()
    const events: SignedEvent[] = []
    h.relay.subscribe([{ kinds: [9] }], (e) => events.push(e))

    const s = await reachLive(h)
    assert.equal((s.sentOf('REQ')).length, 1)

    const subId = s.sentOf('REQ')[0]?.[1] as string
    s.deliver(['EVENT', subId, { id: 'e1', kind: 9 }])
    assert.equal((events).length, 1)
  })

  it('restores every subscription after a reconnect', async () => {
    // The silent half of a reconnect: the socket comes back and the app hears
    // nothing again, because the REQs were lost with the old connection.
    const h = harness()
    h.relay.subscribe([{ kinds: [9] }], () => {})
    h.relay.subscribe([{ kinds: [7] }], () => {})
    const first = await reachLive(h)
    assert.equal((first.sentOf('REQ')).length, 2)

    first.drop()
    assert.equal(h.relay.state(), 'reconnecting')
    h.runReconnect()

    const second = h.latest()
    assert.notEqual(second, first)
    const reauthed = await reachLive(h)
    assert.equal((reauthed.sentOf('REQ')).length, 2)
    assert.deepEqual(reauthed.sentOf('REQ').map((f) => f[2]), [{ kinds: [9] }, { kinds: [7] }])
  })

  it('routes each event only to its own subscription', async () => {
    const h = harness()
    const nine: SignedEvent[] = []
    const seven: SignedEvent[] = []
    h.relay.subscribe([{ kinds: [9] }], (e) => nine.push(e))
    h.relay.subscribe([{ kinds: [7] }], (e) => seven.push(e))
    const s = await reachLive(h)

    const [reqA, reqB] = s.sentOf('REQ')
    s.deliver(['EVENT', reqA?.[1], { id: 'e1', kind: 9 }])
    s.deliver(['EVENT', reqB?.[1], { id: 'e2', kind: 7 }])
    assert.deepEqual(nine.map((e) => e.id), ['e1'])
    assert.deepEqual(seven.map((e) => e.id), ['e2'])
  })

  it('closes a subscription and stops delivering to it', async () => {
    const h = harness()
    const seen: SignedEvent[] = []
    const sub = h.relay.subscribe([{ kinds: [9] }], (e) => seen.push(e))
    const s = await reachLive(h)
    const subId = s.sentOf('REQ')[0]?.[1] as string

    sub.close()
    assert.equal(s.sentOf('CLOSE')[0]?.[1], subId)
    s.deliver(['EVENT', subId, { id: 'e1', kind: 9 }])
    assert.equal((seen).length, 0)

    sub.close() // idempotent
    assert.equal((s.sentOf('CLOSE')).length, 1)
  })

  it('does not re-open a closed subscription on reconnect', async () => {
    const h = harness()
    const sub = h.relay.subscribe([{ kinds: [9] }], () => {})
    h.relay.subscribe([{ kinds: [7] }], () => {})
    const first = await reachLive(h)
    sub.close()

    first.drop()
    h.runReconnect()
    const second = await reachLive(h)
    assert.equal((second.sentOf('REQ')).length, 1)
    assert.deepEqual(second.sentOf('REQ')[0]?.[2], { kinds: [7] })
  })

  it('reports EOSE and a relay-side CLOSED to the subscriber', async () => {
    const h = harness()
    const onEose = fn()
    const onClosed = fn()
    h.relay.subscribe([{ kinds: [9] }], () => {}, { onEose, onClosed })
    const s = await reachLive(h)
    const subId = s.sentOf('REQ')[0]?.[1] as string

    s.deliver(['EOSE', subId])
    assert.equal(onEose.calls.length, 1)
    s.deliver(['CLOSED', subId, 'rate-limited: slow down'])
    assert.deepEqual(onClosed.calls.at(-1), ['rate-limited: slow down'])
  })
})

describe('authentication failures', () => {
  it('reconnects when the relay refuses the auth event', async () => {
    // Relay-side this connection is now AuthState::Failed and stays OPEN,
    // refusing every REQ forever. Keeping it would be a socket that looks
    // healthy and delivers nothing.
    const h = harness()
    const s = h.latest()
    s.open()
    s.deliver(['AUTH', CHALLENGE])
    await waitFor(() => assert.notEqual(s.authEvent, undefined))

    s.deliver(['OK', s.authEvent?.id, false, 'auth-required: verification failed'])
    assert.equal(h.relay.state(), 'reconnecting')
  })

  it('gives up after repeated refusals rather than looping forever', async () => {
    // A missing 22242 grant or a clock more than 60s out fails identically
    // every time. `failed` is terminal on purpose; a relay that is merely down
    // never reaches it.
    const h = harness()
    for (let i = 0; i < 3; i++) {
      const s = h.latest()
      s.open()
      s.deliver(['AUTH', CHALLENGE])
      await waitFor(() => assert.notEqual(s.authEvent, undefined))
      s.deliver(['OK', s.authEvent?.id, false, 'auth-required: verification failed'])
      if (h.relay.state() === 'reconnecting') h.runReconnect()
    }
    assert.equal(h.relay.state(), 'failed')
  })

  it('reconnects when a REQ is refused for want of auth', async () => {
    const h = harness()
    h.relay.subscribe([{ kinds: [9] }], () => {})
    const s = await reachLive(h)
    const subId = s.sentOf('REQ')[0]?.[1] as string

    s.deliver(['CLOSED', subId, 'auth-required: authenticate before subscribing'])
    assert.equal(h.relay.state(), 'reconnecting')
  })

  it('does not count a signing failure against the give-up cap', async () => {
    // An expired token or a network blip is not the relay refusing us, and it
    // fixes itself on the next attempt.
    // vitest's `mockRejectedValue`, written out: the signer rejects rather than
    // signing, which is an expired token or a network blip and not the relay
    // refusing us.
    const sign = () => Promise.reject(new Error('POST /sign failed: 401'))
    const states: string[] = []
    const timers: (() => void)[] = []
    const relay = createLiveRelay({
      url: 'wss://relay.test',
      getCredential: () => ({ accessToken: 'stale', pubkey: PUBKEY }),
      sign,
      onState: (s) => states.push(s),
      socketFactory: (url) => new FakeSocket(url),
      setTimer: (fn) => timers.push(fn),
      clearTimer: () => {},
      backoff: { baseMs: 1, maxMs: 2, jitter: () => 0 },
    })

    for (let i = 0; i < 4; i++) {
      const s = FakeSocket.all[FakeSocket.all.length - 1] as FakeSocket
      s.open()
      s.deliver(['AUTH', CHALLENGE])
      await waitFor(() => assert.equal(relay.state(), 'reconnecting'))
      timers.shift()?.()
    }
    assert.notEqual(relay.state(), 'failed')
  })

  it('waits rather than failing when nobody is signed in', async () => {
    const h = harness({ credential: () => null })
    const s = h.latest()
    s.open()
    s.deliver(['AUTH', CHALLENGE])
    assert.equal(s.authEvent, undefined)
    assert.equal(h.relay.state(), 'reconnecting')
  })
})

describe('token rotation', () => {
  it('does not touch a live socket when the access token is renewed', async () => {
    // The relay authenticated a *pubkey*, by checking a signature. It never saw
    // the Estiva ID token. A renewal issues a new token for the same keypair,
    // so nothing the relay verified has changed — and a second AUTH would be
    // refused with "already authenticated" anyway.
    let token = 'tok-1'
    const { sign } = fakeSigner()
    const relay = createLiveRelay({
      url: 'wss://relay.test',
      getCredential: () => ({ accessToken: token, pubkey: PUBKEY }),
      sign,
      socketFactory: (url) => new FakeSocket(url),
      setTimer: () => 0,
      clearTimer: () => {},
    })
    const s = FakeSocket.all[0] as FakeSocket
    s.open()
    s.deliver(['AUTH', CHALLENGE])
    await waitFor(() => assert.notEqual(s.authEvent, undefined))
    s.deliver(['OK', s.authEvent?.id, true, ''])
    assert.equal(relay.state(), 'live')

    token = 'tok-2'
    assert.equal(relay.state(), 'live')
    assert.equal(s.closed, false)
    assert.equal((s.sentOf('AUTH')).length, 1)
  })

  it('signs with the token held at reconnect time, not the one it started with', async () => {
    let token = 'tok-1'
    const h = harness({ credential: () => ({ accessToken: token, pubkey: PUBKEY }) })
    const first = await reachLive(h)

    token = 'tok-2'
    first.drop()
    h.runReconnect()
    await reachLive(h)

    assert.deepEqual(h.signCalls.map((c) => c.token), ['tok-1', 'tok-2'])
  })
})

describe('reconnect(), for a network the socket cannot detect', () => {
  it('drops a socket that still claims to be open and builds a new one', async () => {
    // The case with no `onclose`: the peer became unreachable but the
    // connection is still OPEN, so nothing in the client would ever fire. Only
    // the browser's own `online`/`offline` events know, and they call this.
    const h = harness()
    const first = await reachLive(h)
    assert.equal(h.relay.state(), 'live')

    h.relay.reconnect()
    assert.equal(first.closed, true)
    const second = h.latest()
    assert.notEqual(second, first)
  })

  it('restores subscriptions on the new socket', async () => {
    const h = harness()
    h.relay.subscribe([{ kinds: [9] }], () => {})
    await reachLive(h)

    h.relay.reconnect()
    const restored = await reachLive(h)
    assert.equal((restored.sentOf('REQ')).length, 1)
  })

  it('connects immediately rather than waiting out the backoff', async () => {
    // Coming back online should not sit through a delay that may have grown to
    // half a minute while there was no network to reach.
    const h = harness()
    const first = await reachLive(h)
    first.drop()
    assert.equal(h.relay.state(), 'reconnecting')

    const before = FakeSocket.all.length
    h.relay.reconnect()
    // A new socket exists without any timer having been run.
    assert.equal(FakeSocket.all.length, before + 1)
  })

  it('does nothing once the relay is closed for good', () => {
    const h = harness()
    h.relay.close()
    const before = FakeSocket.all.length
    h.relay.reconnect()
    assert.equal((FakeSocket.all).length, before)
  })
})

describe('shutting down', () => {
  it('stops reconnecting once closed', async () => {
    const h = harness()
    const s = await reachLive(h)
    h.relay.close()
    assert.equal(s.closed, true)

    const before = FakeSocket.all.length
    h.runReconnect()
    assert.equal((FakeSocket.all).length, before)
  })

  it('ignores frames from a socket it has already replaced', async () => {
    // A dropped socket can still deliver a buffered frame. Acting on it would
    // reconnect a second time on top of the attempt already scheduled.
    const h = harness()
    const first = await reachLive(h)
    first.drop()
    h.runReconnect()
    const second = h.latest()

    first.deliver(['AUTH', 'stale-challenge'])
    assert.equal((second.sentOf('AUTH')).length, 0)
  })
})

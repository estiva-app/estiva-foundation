/**
 * PEE-6 — one REQ per channel, refcounted.
 *
 * The done-when is *"two channels subscribed simultaneously both receive live
 * events… unsubscribing the last consumer sends CLOSE; a reconnect restores
 * both."* Two channels is the case a multi-`#h` implementation gets wrong, so
 * it is asserted from both ends: that both receive, and structurally that no
 * filter this module builds ever names two channels.
 *
 * The reconnect half runs against the **real** `createLiveRelay` over a fake
 * socket, not a stub, because "reconnect restores both" is a property of the
 * composition rather than of either piece.
 */
import { beforeEach, describe, it } from 'node:test'
import assert from 'node:assert/strict'
import type { SignedEvent } from '../dist/index.js'
import { createChannelSubscriptions } from '../dist/index.js'
import { createLiveRelay, type SocketLike, type Subscription } from '../dist/index.js'

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


const CHANNEL_A = '11111111-1111-4111-8111-111111111111'
const CHANNEL_B = '22222222-2222-4222-8222-222222222222'
const PUBKEY = 'a'.repeat(64)
const CHALLENGE = 'c'.repeat(64)

const event = (id: string, kind = 9) => ({ id, kind }) as unknown as SignedEvent

/** A relay stub that records the filters it was handed. */
function stubRelay() {
  const opened: { filters: Record<string, unknown>[]; closed: boolean }[] = []
  const emitters: ((e: SignedEvent) => void)[] = []
  return {
    opened,
    emit: (index: number, e: SignedEvent) => emitters[index]?.(e),
    relay: {
      subscribe(filters: Record<string, unknown>[], onEvent: (e: SignedEvent) => void) {
        const record = { filters, closed: false }
        opened.push(record)
        emitters.push(onEvent)
        return { close: () => { record.closed = true } } satisfies Subscription
      },
    },
  }
}

describe('one REQ per channel', () => {
  it('opens a single kindless #h filter for a channel', () => {
    const { relay, opened } = stubRelay()
    createChannelSubscriptions(relay).subscribe(CHANNEL_A, () => {})

    assert.equal((opened).length, 1)
    assert.deepEqual(opened[0]?.filters, [{ '#h': [CHANNEL_A] }])
    // No `kinds`, deliberately: a kindless filter registers in the channel
    // wildcard index and so receives reactions and deletions too, which carry
    // no h-tag of their own and are matched via StoredEvent.channel_id.
    // `kinds: []` would be worse than useless: Buzz indexes such a subscription
    // nowhere and it silently receives nothing. Absent, not empty.
    assert.ok(!('kinds' in (opened[0]?.filters[0] ?? {})))
  })

  it('shares one REQ between consumers of the same channel', () => {
    const { relay, opened, emit } = stubRelay()
    const subs = createChannelSubscriptions(relay)
    const conversation: string[] = []
    const sidebar: string[] = []

    subs.subscribe(CHANNEL_A, (e) => conversation.push(e.id))
    subs.subscribe(CHANNEL_A, (e) => sidebar.push(e.id))

    assert.equal((opened).length, 1)
    assert.equal(subs.subscriberCount(CHANNEL_A), 2)

    emit(0, event('e1'))
    assert.deepEqual(conversation, ['e1'])
    assert.deepEqual(sidebar, ['e1'])
  })

  it('never builds a filter naming two channels', () => {
    // The trap, asserted structurally rather than by outcome: two distinct #h
    // values in one subscription make Buzz register it globally, and a global
    // subscription receives no channel-scoped events at all.
    const { relay, opened } = stubRelay()
    const subs = createChannelSubscriptions(relay)
    subs.subscribe(CHANNEL_A, () => {})
    subs.subscribe(CHANNEL_B, () => {})

    assert.equal(opened.length, 2)
    for (const record of opened) {
      assert.equal(record.filters.length, 1)
      // A filter is `Record<string, unknown>`, so `#h` is genuinely unknown
      // here. vitest's `toHaveLength` took `any` and hid that; asserting the
      // shape first is what the check meant all along, and it is stronger:
      // a `#h` that was a bare string would have satisfied `.length === 1` too.
      const channels = record.filters[0]?.['#h']
      assert.ok(Array.isArray(channels), `#h is ${typeof channels}, not an array`)
      assert.equal(channels.length, 1)
    }
  })

  it('delivers live events to two channels at once', () => {
    // The done-when's central case, and exactly what a multi-#h implementation
    // gets wrong while still returning correct history.
    const { relay, emit } = stubRelay()
    const subs = createChannelSubscriptions(relay)
    const a: string[] = []
    const b: string[] = []
    subs.subscribe(CHANNEL_A, (e) => a.push(e.id))
    subs.subscribe(CHANNEL_B, (e) => b.push(e.id))

    emit(0, event('from-a'))
    emit(1, event('from-b'))
    assert.deepEqual(a, ['from-a'])
    assert.deepEqual(b, ['from-b'])
  })

  it('routes reactions and deletions on the same subscription', () => {
    // No second REQ per kind: the kindless filter already covers them.
    const { relay, opened, emit } = stubRelay()
    const seen: number[] = []
    createChannelSubscriptions(relay).subscribe(CHANNEL_A, (e) => seen.push(e.kind))

    for (const kind of [9, 7, 5, 9101]) emit(0, event(`e-${kind}`, kind))
    assert.deepEqual(seen, [9, 7, 5, 9101])
    assert.equal((opened).length, 1)
  })
})

describe('refcounting', () => {
  it('keeps the REQ open while any consumer remains', () => {
    const { relay, opened, emit } = stubRelay()
    const subs = createChannelSubscriptions(relay)
    const kept: string[] = []
    const first = subs.subscribe(CHANNEL_A, () => {})
    subs.subscribe(CHANNEL_A, (e) => kept.push(e.id))

    first.release()
    assert.equal(opened[0]?.closed, false)
    assert.equal(subs.subscriberCount(CHANNEL_A), 1)

    emit(0, event('still-arriving'))
    assert.deepEqual(kept, ['still-arriving'])
  })

  it('closes the REQ when the last consumer releases', () => {
    const { relay, opened } = stubRelay()
    const subs = createChannelSubscriptions(relay)
    const a = subs.subscribe(CHANNEL_A, () => {})
    const b = subs.subscribe(CHANNEL_A, () => {})

    a.release()
    b.release()
    assert.equal(opened[0]?.closed, true)
    assert.deepEqual(subs.activeChannels(), [])
  })

  it('treats a repeated release as a no-op', () => {
    // A component that unmounts twice must not decrement somebody else's count.
    const { relay, opened } = stubRelay()
    const subs = createChannelSubscriptions(relay)
    const a = subs.subscribe(CHANNEL_A, () => {})
    const b = subs.subscribe(CHANNEL_A, () => {})

    a.release()
    a.release()
    a.release()
    assert.equal(subs.subscriberCount(CHANNEL_A), 1)
    assert.equal(opened[0]?.closed, false)

    b.release()
    assert.equal(opened[0]?.closed, true)
  })

  it('opens a fresh REQ when a channel is watched again after release', () => {
    const { relay, opened } = stubRelay()
    const subs = createChannelSubscriptions(relay)
    subs.subscribe(CHANNEL_A, () => {}).release()
    subs.subscribe(CHANNEL_A, () => {})

    assert.equal((opened).length, 2)
    assert.equal(opened[1]?.closed, false)
    assert.deepEqual(opened[1]?.filters, [{ '#h': [CHANNEL_A] }])
  })

  it('stops delivering to a released consumer', () => {
    const { relay, emit } = stubRelay()
    const subs = createChannelSubscriptions(relay)
    const gone: string[] = []
    const stays: string[] = []
    const handle = subs.subscribe(CHANNEL_A, (e) => gone.push(e.id))
    subs.subscribe(CHANNEL_A, (e) => stays.push(e.id))

    handle.release()
    emit(0, event('after'))
    assert.deepEqual(gone, [])
    assert.deepEqual(stays, ['after'])
  })

  it('releases every channel on close', () => {
    const { relay, opened } = stubRelay()
    const subs = createChannelSubscriptions(relay)
    subs.subscribe(CHANNEL_A, () => {})
    subs.subscribe(CHANNEL_B, () => {})

    subs.close()
    assert.deepEqual(opened.map((o) => o.closed), [true, true])
    assert.deepEqual(subs.activeChannels(), [])
  })
})

describe('the channel key', () => {
  it('refuses anything that is not a uuid', () => {
    // The second entrance to the trap, and the likelier one. Buzz only counts
    // an #h value it can parse as a uuid; anything else registers the
    // subscription globally, where it receives no channel events — the same
    // silent death as multi-#h. Peek's topic ids are Convex ids, and
    // `topics.channelUuid` is optional, so both bad values are reachable.
    const { relay, opened } = stubRelay()
    const subs = createChannelSubscriptions(relay)

    for (const bad of ['jd7abc123xyz', '', 'not-a-uuid', '1111']) {
      assert.throws(() => subs.subscribe(bad, () => {}), /not a channel uuid/, bad)
    }
    assert.equal((opened).length, 0)
  })

  it('refuses a missing channelUuid rather than subscribing to nothing', () => {
    // `topics.channelUuid` is `v.optional` — absent on topics created before
    // Nostr emission was wired up. Loud beats a dead subscription.
    const { relay } = stubRelay()
    const subs = createChannelSubscriptions(relay)
    assert.throws(() => subs.subscribe(undefined as unknown as string, () => {}))
  })

  it('accepts the uuid shape crypto.randomUUID produces', () => {
    const { relay, opened } = stubRelay()
    createChannelSubscriptions(relay).subscribe(crypto.randomUUID(), () => {})
    assert.equal((opened).length, 1)
  })
})

describe('a misbehaving consumer', () => {
  it('still delivers to the others when one listener throws', () => {
    // One component's bug must not silently stop a whole channel updating.
    const { relay, emit } = stubRelay()
    const onListenerError = fn()
    const subs = createChannelSubscriptions(relay, { onListenerError })
    const ok: string[] = []
    subs.subscribe(CHANNEL_A, () => {
      throw new Error('render failed')
    })
    subs.subscribe(CHANNEL_A, (e) => ok.push(e.id))

    emit(0, event('e1'))
    assert.deepEqual(ok, ['e1'])
    assert.equal(onListenerError.calls.length, 1)
  })

  it('tolerates a listener releasing during dispatch', () => {
    const { relay, emit } = stubRelay()
    const subs = createChannelSubscriptions(relay)
    const seen: string[] = []
    const handle = subs.subscribe(CHANNEL_A, () => handle.release())
    subs.subscribe(CHANNEL_A, (e) => seen.push(e.id))

    assert.doesNotThrow(() => emit(0, event('e1')))
    assert.deepEqual(seen, ['e1'])
    assert.equal(subs.subscriberCount(CHANNEL_A), 1)
  })
})

/** A minimal fake socket, so the reconnect test drives the real client. */
class FakeSocket implements SocketLike {
  static all: FakeSocket[] = []
  sent: unknown[][] = []
  onopen: SocketLike['onopen'] = null
  onmessage: SocketLike['onmessage'] = null
  onclose: SocketLike['onclose'] = null
  onerror: SocketLike['onerror'] = null

  constructor() {
    FakeSocket.all.push(this)
  }

  send(data: string) {
    this.sent.push(JSON.parse(data))
  }
  close() {}
  open() {
    this.onopen?.call(null, {})
  }
  deliver(frame: unknown) {
    this.onmessage?.call(null, { data: JSON.stringify(frame) })
  }
  drop() {
    this.onclose?.call(null, {})
  }
  sentOf(verb: string) {
    return this.sent.filter((f) => f[0] === verb)
  }
}

describe('reconnect, against the real client', () => {
  beforeEach(() => {
    FakeSocket.all = []
  })

  it('restores every channel with a live refcount', async () => {
    const timers: (() => void)[] = []
    const relay = createLiveRelay({
      url: 'wss://relay.test',
      getCredential: () => ({ accessToken: 'tok', pubkey: PUBKEY }),
      sign: async (unsigned) => ({ ...unsigned, pubkey: PUBKEY, id: 'auth', sig: 'f' }) as SignedEvent,
      socketFactory: () => new FakeSocket(),
      setTimer: (fn) => timers.push(fn),
      clearTimer: () => {},
      backoff: { baseMs: 1, maxMs: 2, jitter: () => 0 },
    })
    const subs = createChannelSubscriptions(relay)

    const reachLive = async () => {
      const s = FakeSocket.all[FakeSocket.all.length - 1] as FakeSocket
      s.open()
      s.deliver(['AUTH', CHALLENGE])
      await waitFor(() => assert.equal((s.sentOf('AUTH')).length, 1))
      s.deliver(['OK', 'auth', true, ''])
      return s
    }

    subs.subscribe(CHANNEL_A, () => {})
    const releasable = subs.subscribe(CHANNEL_B, () => {})
    const first = await reachLive()
    assert.equal((first.sentOf('REQ')).length, 2)

    // A channel nobody is watching any more must not come back.
    releasable.release()

    first.drop()
    timers.shift()?.()
    const second = await reachLive()

    const restored = second.sentOf('REQ')
    assert.equal((restored).length, 1)
    assert.deepEqual(restored[0]?.[2], { '#h': [CHANNEL_A] })
  })
})

/**
 * `createLiveClient` — the three behaviours, with no browser and no app.
 *
 * `liveTopics.ts` could not be tested like this, and that is what ADR 0002 §10
 * constraint 3 is about: a module-level singleton with an app import and a
 * `window` touch needs the environment it assumes. Everything here is injected,
 * so the suite drives the real client against a fake socket.
 */
import { test, beforeEach } from 'node:test'
import assert from 'node:assert/strict'
import type { SignedEvent, SocketLike, UnsignedEvent } from '@estiva-app/protocol'
import {
  MAX_FOLDERS_PER_SUBSCRIPTION,
  assumeOnline,
  createLiveClient,
  createLiveClientHolder,
  type LiveClientOptions,
  type OnlineSource,
} from '../dist/index.js'

const CHALLENGE = 'a-challenge-from-the-relay'
const PUBKEY = '4a8098e94dce7a4a191aebae039eda3108985b36b245afceee9df94ee6b2592f'
const FOLDER = '9f1c7c1e-0b8a-4f3d-9c2e-5a6b7c8d9e0f'
const OTHER = 'a1b2c3d4-e5f6-4a7b-8c9d-0e1f2a3b4c5d'

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
  // `erasableSyntaxOnly`, under which a parameter property is a type error.
  constructor(url: string) {
    this.url = url
    FakeSocket.all.push(this)
  }

  send(data: string) {
    if (this.closed) throw new Error('send on a closed socket')
    this.sent.push(JSON.parse(data) as unknown[])
  }
  close() {
    this.closed = true
  }
  open() {
    this.onopen?.call(null, {})
  }
  deliver(frame: unknown) {
    this.onmessage?.call(null, { data: JSON.stringify(frame) })
  }
  /** The AUTH the client answered with, if it has. */
  get authEvent(): SignedEvent | undefined {
    const frame = this.sent.find((f) => f[0] === 'AUTH')
    return frame?.[1] as SignedEvent | undefined
  }
  /** Every REQ's filters, in order. */
  reqs(): Record<string, unknown>[][] {
    return this.sent.filter((f) => f[0] === 'REQ').map((f) => f.slice(2) as Record<string, unknown>[])
  }
  subIdOf(index = 0): string {
    return this.sent.filter((f) => f[0] === 'REQ')[index]?.[1] as string
  }
}

const waitFor = async (assertion: () => void) => {
  for (let i = 0; i < 50; i++) {
    try {
      assertion()
      return
    } catch {
      await new Promise((r) => setTimeout(r, 1))
    }
  }
  assertion()
}

interface HarnessOptions {
  online?: OnlineSource
  credential?: () => { accessToken: string; pubkey: string } | null
  observe?: LiveClientOptions['observe']
  signFails?: boolean
}

function harness(over: HarnessOptions = {}) {
  const credentialReads: string[] = []
  const timers: (() => void)[] = []
  let nth = 0
  const client = createLiveClient({
    relayUrl: 'https://relay.test',
    getCredential:
      over.credential ??
      (() => {
        credentialReads.push(`token-${++nth}`)
        return { accessToken: `token-${nth}`, pubkey: PUBKEY }
      }),
    sign: async (unsigned: UnsignedEvent, token: string, expectedPubkey: string) => {
      if (over.signFails) throw new Error('refused')
      return {
        ...unsigned,
        pubkey: expectedPubkey,
        id: `signed-with-${token}`,
        sig: 'x'.repeat(128),
      } as SignedEvent
    },
    online: over.online ?? assumeOnline(),
    observe: over.observe,
    subscriptionPrefix: 'test-',
    socketFactory: (url) => new FakeSocket(url),
    setTimer: (fn) => {
      timers.push(fn as () => void)
      return timers.length - 1
    },
    clearTimer: () => {},
    backoff: { baseMs: 1, maxMs: 2, jitter: () => 0 },
  })
  return {
    client,
    credentialReads,
    runReconnect: () => timers.shift()?.(),
    latest: () => FakeSocket.all[FakeSocket.all.length - 1] as FakeSocket,
  }
}

/** Connect and authenticate, returning the live socket. */
async function reachLive(h: ReturnType<typeof harness>) {
  const socket = h.latest()
  socket.open()
  socket.deliver(['AUTH', CHALLENGE])
  await waitFor(() => assert.notEqual(socket.authEvent, undefined))
  socket.deliver(['OK', socket.authEvent?.id, true, ''])
  await waitFor(() => assert.equal(h.client.state(), 'live'))
  return socket
}

beforeEach(() => {
  FakeSocket.all = []
})

test('reaches live and reports it', async () => {
  const h = harness()
  await reachLive(h)
  assert.equal(h.client.state(), 'live')
})

test('reads the credential on every connect rather than capturing one', async () => {
  const h = harness()
  await reachLive(h)
  assert.deepEqual(h.credentialReads, ['token-1'])

  // A renewal happens between connects. A captured token would sign the second
  // AUTH with the dead one, which is the trap this behaviour exists for.
  h.latest().onclose?.call(null, {})
  h.runReconnect()
  const second = await reachLive(h)
  assert.deepEqual(h.credentialReads, ['token-1', 'token-2'])
  assert.equal(second.authEvent?.id, 'signed-with-token-2')
})

test('reports a missing credential without treating it as a failure', async () => {
  const seen: string[] = []
  const h = harness({
    credential: () => null,
    observe: { onCredentialMissing: () => seen.push('missing') },
  })
  h.latest().open()
  h.latest().deliver(['AUTH', CHALLENGE])
  await waitFor(() => assert.deepEqual(seen, ['missing']))
  assert.notEqual(h.client.state(), 'failed', 'a session may yet appear')
})

test('reports a sign failure to the app', async () => {
  const failures: unknown[] = []
  const h = harness({ signFails: true, observe: { onSignFailure: (e) => failures.push(e) } })
  h.latest().open()
  h.latest().deliver(['AUTH', CHALLENGE])
  await waitFor(() => assert.equal(failures.length, 1))
})

test('an observer that throws does not stop the socket', async () => {
  // The reason `safely` exists. An app callback on the state path used to be
  // able to take the connection with it.
  const h = harness({
    observe: {
      onState: () => {
        throw new Error('the app is broken')
      },
    },
  })
  await reachLive(h)
  assert.equal(h.client.state(), 'live')
})

test('watchFolders sends one REQ for a whole workspace', async () => {
  const h = harness()
  const socket = await reachLive(h)
  const folders = Array.from({ length: 34 }, (_, i) => `${FOLDER.slice(0, -2)}${String(i).padStart(2, '0')}`)
  h.client.watchFolders(folders, () => {}, { kinds: [9] })

  await waitFor(() => assert.equal(socket.reqs().length, 1))
  const [filter] = socket.reqs()[0] as [Record<string, unknown>]
  assert.deepEqual(filter['#h'], folders, 'every Folder in one filter')
  assert.deepEqual(filter.kinds, [9])
})

test('chunks past the relay’s aggregate #h budget', async () => {
  const h = harness()
  const socket = await reachLive(h)
  const folders = Array.from({ length: MAX_FOLDERS_PER_SUBSCRIPTION + 5 }, (_, i) =>
    `${String(i).padStart(8, '0')}-0b8a-4f3d-9c2e-5a6b7c8d9e0f`,
  )
  h.client.watchFolders(folders, () => {}, { kinds: [9] })

  await waitFor(() => assert.equal(socket.reqs().length, 2))
  const sizes = socket.reqs().map((filters) => (filters[0]?.['#h'] as string[]).length)
  assert.deepEqual(sizes, [MAX_FOLDERS_PER_SUBSCRIPTION, 5])
})

test('tells the listener which Folder changed, not what changed', async () => {
  const h = harness()
  const socket = await reachLive(h)
  const changed: string[] = []
  h.client.watchFolders([FOLDER, OTHER], (folder) => changed.push(folder), { kinds: [9] })
  await waitFor(() => assert.equal(socket.reqs().length, 1))

  socket.deliver([
    'EVENT',
    socket.subIdOf(0),
    { id: 'e1', kind: 9, pubkey: PUBKEY, created_at: 1, tags: [['h', OTHER]], content: 'x', sig: '' },
  ])
  await waitFor(() => assert.deepEqual(changed, [OTHER]))
})

test('hands the listener the event, so a reader that keeps events need not re-read', async () => {
  const h = harness()
  const socket = await reachLive(h)
  const got: { folder: string; id?: string }[] = []
  h.client.watchFolders([FOLDER, OTHER], (folder, event) => got.push({ folder, id: event?.id }), { kinds: [9] })
  await waitFor(() => assert.equal(socket.reqs().length, 1))

  socket.deliver([
    'EVENT',
    socket.subIdOf(0),
    { id: 'e3', kind: 9, pubkey: PUBKEY, created_at: 1, tags: [['h', FOLDER]], content: 'x', sig: '' },
  ])
  await waitFor(() => assert.deepEqual(got, [{ folder: FOLDER, id: 'e3' }]))
})

test('bounds the replay with since when asked, and sends none when not', async () => {
  const h = harness()
  const socket = await reachLive(h)
  h.client.watchFolders([FOLDER], () => {}, { kinds: [9], since: 1_700_000_000 })
  h.client.watchFolders([OTHER], () => {}, { kinds: [9] })

  await waitFor(() => assert.equal(socket.reqs().length, 2))
  const [bounded] = socket.reqs()[0] as [Record<string, unknown>]
  const [open] = socket.reqs()[1] as [Record<string, unknown>]
  assert.equal(bounded.since, 1_700_000_000)
  assert.equal('since' in open, false)
})

test('ignores an event carrying no Folder', async () => {
  const h = harness()
  const socket = await reachLive(h)
  const changed: string[] = []
  h.client.watchFolders([FOLDER], (folder) => changed.push(folder), { kinds: [9] })
  await waitFor(() => assert.equal(socket.reqs().length, 1))

  socket.deliver([
    'EVENT',
    socket.subIdOf(0),
    { id: 'e2', kind: 9, pubkey: PUBKEY, created_at: 1, tags: [], content: 'x', sig: '' },
  ])
  await new Promise((r) => setTimeout(r, 5))
  assert.deepEqual(changed, [])
})

test('stopping a folder watch is idempotent', async () => {
  const h = harness()
  await reachLive(h)
  const watch = h.client.watchFolders([FOLDER], () => {}, { kinds: [9] })
  watch.stop()
  assert.doesNotThrow(() => watch.stop())
})

test('the network coming back drives a reconnect', async () => {
  let announce: ((online: boolean) => void) | undefined
  const online: OnlineSource = {
    online: () => true,
    subscribe: (listener) => {
      announce = listener
      return () => {}
    },
  }
  const h = harness({ online })
  await reachLive(h)
  const before = FakeSocket.all.length

  // The case a socket cannot notice: the peer became unreachable and the
  // connection never closed, so `onclose` never fires and nothing retries.
  announce?.(true)
  await waitFor(() => assert.ok(FakeSocket.all.length > before))
})

test('the holder returns one client per relay origin', () => {
  const holder = createLiveClientHolder()
  const options: LiveClientOptions = {
    relayUrl: 'https://relay.test',
    getCredential: () => null,
    sign: async () => {
      throw new Error('unused')
    },
    socketFactory: (url) => new FakeSocket(url),
  }
  assert.equal(holder.peek(), null, 'null before anything connects is a real state')
  const first = holder.get(options)
  assert.equal(holder.get(options), first, 'a second caller shares the tab’s client')
  assert.equal(holder.peek(), first)

  const moved = holder.get({ ...options, relayUrl: 'https://other.test' })
  assert.notEqual(moved, first, 'a different deployment is a different client')

  holder.reset()
  assert.equal(holder.peek(), null)
})

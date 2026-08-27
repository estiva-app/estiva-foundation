/**
 * One live relay socket, with NIP-42 AUTH and reconnect (PEE-5).
 *
 * A WebSocket that stays open, authenticates as the viewer, and keeps
 * subscriptions alive across disconnects. Nothing is *interpreted* here: this
 * delivers frames, and folding them into state is the consuming app's business.
 *
 * The socket belongs in the **client**, not in a backend: a request-scoped
 * server runtime cannot hold one, and more importantly the viewer's own
 * credential is the only thing that can see the viewer's channels. Buzz gates
 * reads per channel (`is_member_cached`), so a service identity would need
 * membership in every conversation — a product decision, not an implementation
 * detail.
 *
 * **This was built inside Peek** (PEE-5, PEE-6) because Gate 2 had not happened
 * when it was due, and it was Peek-only for two days. SHA-3 is the ticket that
 * owed the move; `subscriptions.ts` beside this file is PEE-6's half.
 *
 * No nostr library. Raw `WebSocket` plus `buildUnsignedRelayAuthEvent` is
 * enough, and the tag layout stays in one place.
 *
 * ## Three things the relay does that shape this file
 *
 * All three were read out of `crates/buzz-*` rather than assumed, because each
 * one fails as a healthy-looking socket that delivers nothing.
 *
 * 1. **A second AUTH on an authenticated connection is refused.** `handle_auth`
 *    matches on `AuthState::{Pending, Authenticated, Failed}` and answers
 *    anything but `Pending` with `OK … false "auth-required: already
 *    authenticated"`. So re-authenticating in place is not possible, and
 *    {@link LiveRelay} never tries.
 *
 * 2. **A failed AUTH poisons the connection and leaves it open.** Only a *ban*
 *    closes the socket; a verification failure sets `AuthState::Failed` and
 *    returns. Every later REQ is answered `CLOSED … "auth-required:
 *    authenticate before subscribing"`, forever, on a socket whose readyState
 *    is OPEN. Treating an AUTH refusal as fatal-for-this-socket and reconnecting
 *    is the only way out.
 *
 * 3. **The `relay` tag is bound to the connection's host**, not the deployment
 *    URL — see `relayAuthUrl`.
 *
 * ## Token rotation needs nothing here, and that is worth stating
 *
 * PEE-5 asked for re-authentication when the app renews its access token,
 * preferring it to a reconnect. Neither is needed, and the first is impossible
 * (point 1 above).
 *
 * The relay authenticates a **pubkey**, by verifying a Schnorr signature. It
 * never sees the Estiva ID access token and has no idea one exists. Renewal
 * issues a new token for the *same* keypair, so nothing the relay checked has
 * changed and the connection stays valid. The token is needed only to *sign* a
 * fresh 22242, which happens on the next connect.
 *
 * What genuinely does not propagate is offboarding: a person whose Estiva ID
 * access is revoked keeps an already-authenticated socket until it drops. That
 * is the relay's session model — its own ban gate is the control for it — and
 * re-authenticating on a timer would not have fixed it either, since a banned
 * pubkey is caught at connect.
 *
 * ## Never logged, never persisted
 *
 * The AUTH event and the access token appear in no log line. Buzz refuses to
 * store kind:22242 for this reason, and Convex surfaces function arguments in
 * its dashboard logs — which is the entire reason Peek's credential lives in the
 * browser. {@link LiveRelayOptions.log} receives states and reasons, never
 * events or credentials, and this module must keep it that way.
 */
import {
  buildUnsignedRelayAuthEvent,
  type SignedEvent,
  type UnsignedEvent,
} from './events.js'

/**
 * `WebSocket` and the timer functions are not in `lib.es2022`, and this package
 * compiles with `types: []` and no `lib: dom` (ADR 0002 §4a). Declared inside
 * this module so nothing lands in a consumer's global scope, and read inside
 * function bodies so importing this module touches no global — which matters
 * more here than anywhere else in the package: `WebSocket` does not exist in
 * Convex's default runtime, and an eager `const WS = WebSocket` at module scope
 * would throw on import in Peek's backend, from a barrel it imports for the
 * builders. `test/runtime-agnostic.test.ts` is what holds that.
 */
declare const WebSocket: { new (url: string): unknown }
declare const setTimeout: (fn: () => void, ms: number) => unknown
declare const clearTimeout: (handle: unknown) => void

/**
 * What the connection is doing, for PEE-9 to render.
 *
 * `failed` is terminal and deliberate: it means repeated *authentication*
 * refusals, which retrying cannot fix — a missing 22242 grant, a clock more
 * than 60s out, a revoked identity. A relay that is merely down stays in
 * `reconnecting` forever, because that one does fix itself.
 */
export type RelayState = 'connecting' | 'authenticating' | 'live' | 'reconnecting' | 'failed'

/** Just enough of `WebSocket` to be faked in a test. */
export interface SocketLike {
  send(data: string): void
  close(): void
  onopen: ((this: unknown, ev: unknown) => unknown) | null
  onmessage: ((this: unknown, ev: { data: unknown }) => unknown) | null
  onclose: ((this: unknown, ev: unknown) => unknown) | null
  onerror: ((this: unknown, ev: unknown) => unknown) | null
}

/** The credential a connect attempt needs. `null` means "not signed in". */
export interface RelayCredential {
  accessToken: string
  pubkey: string
}

export interface LiveRelayOptions {
  /**
   * The relay origin, `https://…` or `wss://…`.
   *
   * Peek reads this from a Convex query rather than a `VITE_` build-time
   * variable, so that the bundle and the backend cannot drift. Where it comes
   * from is the app's decision; that it is one value is not.
   */
  url: string
  /** Read fresh on every connect, so a reconnect picks up a renewed token. */
  getCredential: () => RelayCredential | null
  /**
   * Injected so this module does no fetching of its own. Peek passes
   * `signViaEstivaId`; a keyed client passes a `signEvent` wrapper.
   *
   * `expectedPubkey` is not a request — a remote `/sign` signs as the token's
   * subject whatever it is handed, so a mismatch comes back as HTTP 200 with a
   * valid event authored by somebody else. The implementation must check it.
   */
  sign: (unsigned: UnsignedEvent, token: string, expectedPubkey: string) => Promise<SignedEvent>
  onState?: (state: RelayState) => void
  /** Never receives event bodies or credentials. */
  log?: (message: string, detail?: Record<string, unknown>) => void
  /** Test seams. */
  socketFactory?: (url: string) => SocketLike
  now?: () => number
  setTimer?: (fn: () => void, ms: number) => unknown
  clearTimer?: (handle: unknown) => void
  /** Backoff shape. Exposed so a test does not wait real seconds. */
  backoff?: { baseMs: number; maxMs: number; jitter: () => number }
  /**
   * Prefix for REQ subscription ids. Cosmetic — it appears in the relay's logs
   * and nowhere else — but a relay operator reading two apps' traffic wants to
   * know which is which. Was hardcoded `peek-` while this lived in Peek.
   */
  subscriptionPrefix?: string
}

export interface Subscription {
  /** Idempotent. Sends CLOSE when the socket is live, and forgets it either way. */
  close(): void
}

export interface LiveRelay {
  /**
   * Drop the current socket and connect again now, ignoring any backoff.
   *
   * For the case a socket cannot detect on its own: the network went away and
   * came back without the connection ever closing. A WebSocket whose peer has
   * become unreachable stays `OPEN` until TCP gives up, which can be minutes —
   * and browser devtools' offline mode frequently does not close it at all. The
   * socket therefore reports `live`, delivers nothing, and would never
   * reconnect, because reconnection is driven by `onclose`.
   *
   * `liveTopics` calls this from the browser's own `online`/`offline` events,
   * which are the one authority here that a socket cannot second-guess.
   */
  reconnect(): void
  /**
   * Subscribe now if the socket is live, and on every future reconnect.
   *
   * Registering before `live` is normal and supported — that is what makes a
   * subscription survive a reconnect rather than being lost with the socket.
   */
  subscribe(
    filters: Record<string, unknown>[],
    onEvent: (event: SignedEvent) => void,
    options?: { onEose?: () => void; onClosed?: (reason: string) => void },
  ): Subscription
  state(): RelayState
  /** Stop for good. Does not reconnect afterwards. */
  close(): void
}

/** How many consecutive AUTH refusals before giving up rather than looping. */
const MAX_AUTH_FAILURES = 3

interface LiveSubscription {
  id: string
  filters: Record<string, unknown>[]
  onEvent: (event: SignedEvent) => void
  onEose?: (() => void) | undefined
  onClosed?: ((reason: string) => void) | undefined
}

/** `https://` → `wss://`, `http://` → `ws://`; a `ws`-scheme URL is left alone. */
export function toWebSocketUrl(url: string): string {
  const trimmed = url.trim().replace(/\/+$/, '')
  if (trimmed.startsWith('wss://') || trimmed.startsWith('ws://')) return trimmed
  if (trimmed.startsWith('https://')) return `wss://${trimmed.slice('https://'.length)}`
  if (trimmed.startsWith('http://')) return `ws://${trimmed.slice('http://'.length)}`
  return `wss://${trimmed}`
}

/**
 * A relay message, parsed far enough to route.
 *
 * Deliberately tolerant: an unknown verb is ignored rather than throwing, so a
 * relay that grows a frame does not take the socket down with it.
 */
type RelayFrame =
  | { type: 'AUTH'; challenge: string }
  | { type: 'OK'; eventId: string; accepted: boolean; message: string }
  | { type: 'EVENT'; subId: string; event: SignedEvent }
  | { type: 'EOSE'; subId: string }
  | { type: 'CLOSED'; subId: string; message: string }
  | { type: 'NOTICE'; message: string }
  | { type: 'OTHER' }

export function parseFrame(raw: unknown): RelayFrame {
  if (typeof raw !== 'string') return { type: 'OTHER' }
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch {
    return { type: 'OTHER' }
  }
  if (!Array.isArray(parsed) || typeof parsed[0] !== 'string') return { type: 'OTHER' }

  switch (parsed[0]) {
    case 'AUTH':
      return typeof parsed[1] === 'string'
        ? { type: 'AUTH', challenge: parsed[1] }
        : { type: 'OTHER' }
    case 'OK':
      return typeof parsed[1] === 'string' && typeof parsed[2] === 'boolean'
        ? {
            type: 'OK',
            eventId: parsed[1],
            accepted: parsed[2],
            message: typeof parsed[3] === 'string' ? parsed[3] : '',
          }
        : { type: 'OTHER' }
    case 'EVENT':
      return typeof parsed[1] === 'string' && parsed[2] && typeof parsed[2] === 'object'
        ? { type: 'EVENT', subId: parsed[1], event: parsed[2] as SignedEvent }
        : { type: 'OTHER' }
    case 'EOSE':
      return typeof parsed[1] === 'string' ? { type: 'EOSE', subId: parsed[1] } : { type: 'OTHER' }
    case 'CLOSED':
      return typeof parsed[1] === 'string'
        ? {
            type: 'CLOSED',
            subId: parsed[1],
            message: typeof parsed[2] === 'string' ? parsed[2] : '',
          }
        : { type: 'OTHER' }
    case 'NOTICE':
      return typeof parsed[1] === 'string'
        ? { type: 'NOTICE', message: parsed[1] }
        : { type: 'OTHER' }
    default:
      return { type: 'OTHER' }
  }
}

export function createLiveRelay(options: LiveRelayOptions): LiveRelay {
  const wsUrl = toWebSocketUrl(options.url)
  const now = options.now ?? (() => Date.now())
  const setTimer = options.setTimer ?? ((fn, ms) => setTimeout(fn, ms))
  const clearTimer = options.clearTimer ?? ((h) => clearTimeout(h as ReturnType<typeof setTimeout>))
  const makeSocket =
    options.socketFactory ?? ((url: string) => new WebSocket(url) as unknown as SocketLike)
  const backoff = options.backoff ?? { baseMs: 1_000, maxMs: 30_000, jitter: () => Math.random() }
  const log = options.log ?? (() => {})

  const subscriptions = new Map<string, LiveSubscription>()
  let socket: SocketLike | null = null
  let state: RelayState = 'connecting'
  let attempt = 0
  let authFailures = 0
  let stopped = false
  let reconnectTimer: unknown = null
  /** The id of the AUTH event in flight, so its `OK` is distinguishable. */
  let pendingAuthEventId: string | null = null
  let nextSubId = 0

  function setState(next: RelayState) {
    if (state === next) return
    state = next
    options.onState?.(next)
  }

  function send(frame: unknown[]) {
    try {
      socket?.send(JSON.stringify(frame))
    } catch (error) {
      // A send on a socket the browser has already torn down. The close
      // handler is what recovers; swallowing here keeps that the only path.
      log('send failed', { reason: (error as Error).message })
    }
  }

  function openSubscription(sub: LiveSubscription) {
    send(['REQ', sub.id, ...sub.filters])
  }

  /**
   * Tear the socket down and schedule another attempt.
   *
   * `fatal` is for authentication refusals, which reconnecting cannot fix past
   * a point — see {@link MAX_AUTH_FAILURES}.
   */
  function scheduleReconnect(reason: string) {
    if (stopped) return
    if (socket) {
      // Drop the handlers before closing so our own `onclose` does not fire and
      // schedule a second reconnect on top of this one.
      socket.onopen = socket.onmessage = socket.onclose = socket.onerror = null
      try {
        socket.close()
      } catch {
        // Already closing. Nothing to recover.
      }
      socket = null
    }
    pendingAuthEventId = null

    if (authFailures >= MAX_AUTH_FAILURES) {
      setState('failed')
      log('giving up after repeated auth refusals', { authFailures, reason })
      return
    }

    setState('reconnecting')
    const delay = Math.min(backoff.maxMs, backoff.baseMs * 2 ** attempt) * (0.5 + backoff.jitter() / 2)
    attempt += 1
    log('reconnecting', { reason, delayMs: Math.round(delay), attempt })
    reconnectTimer = setTimer(() => {
      reconnectTimer = null
      connect()
    }, delay)
  }

  async function answerChallenge(challenge: string) {
    const credential = options.getCredential()
    if (!credential) {
      // Not signed in. Not an auth *failure* — there is nothing to sign with,
      // and a session may yet appear, so this does not count toward the cap.
      log('no credential; deferring auth')
      scheduleReconnect('no credential')
      return
    }

    setState('authenticating')
    try {
      const unsigned = buildUnsignedRelayAuthEvent({
        // Left empty deliberately: `/sign` overwrites it with the token's
        // subject, and `expectedPubkey` below is the check that it matched.
        pubkey: '',
        relayUrl: wsUrl,
        challenge,
        nowMs: now(),
      })
      // `expectedPubkey` is not a request — `/sign` signs as the token's
      // subject whatever it is handed, so a mismatch returns HTTP 200 with a
      // valid event authored by somebody else. Passing it is the only thing
      // that catches that, and `bridge.ts` says not to drop it.
      const signed = await options.sign(unsigned, credential.accessToken, credential.pubkey)
      if (stopped || !socket) return
      pendingAuthEventId = signed.id
      send(['AUTH', signed])
    } catch (error) {
      // Signing failed: an expired token, /sign refusing the kind, the network.
      // Not counted as an auth refusal — the relay never saw anything, and the
      // common cause (a token that just expired) fixes itself on reconnect.
      log('could not sign the auth challenge', { reason: (error as Error).message })
      scheduleReconnect('sign failed')
    }
  }

  function onAuthResult(frame: { accepted: boolean; message: string }) {
    pendingAuthEventId = null
    if (!frame.accepted) {
      // The connection is now `AuthState::Failed` relay-side and will refuse
      // every REQ while staying open. There is no recovery on this socket.
      authFailures += 1
      log('relay refused the auth event', { reason: frame.message, authFailures })
      scheduleReconnect('auth refused')
      return
    }

    authFailures = 0
    attempt = 0
    setState('live')
    log('authenticated', { subscriptions: subscriptions.size })
    // Re-issue every live subscription. A reconnect that restores the socket
    // and not the subscriptions is the silent half of this failure: the app
    // looks connected and never hears anything again.
    for (const sub of subscriptions.values()) openSubscription(sub)
  }

  function onFrame(raw: unknown) {
    const frame = parseFrame(raw)
    switch (frame.type) {
      case 'AUTH':
        void answerChallenge(frame.challenge)
        return
      case 'OK':
        if (pendingAuthEventId && frame.eventId === pendingAuthEventId) onAuthResult(frame)
        return
      case 'EVENT':
        subscriptions.get(frame.subId)?.onEvent(frame.event)
        return
      case 'EOSE':
        subscriptions.get(frame.subId)?.onEose?.()
        return
      case 'CLOSED': {
        const sub = subscriptions.get(frame.subId)
        log('subscription closed by the relay', { subId: frame.subId, reason: frame.message })
        sub?.onClosed?.(frame.message)
        // `auth-required` here means the connection is unauthenticated — the
        // poisoned-but-open state. Reconnecting is the only fix, and dropping
        // the subscription would hide it.
        if (frame.message.startsWith('auth-required')) scheduleReconnect('req refused')
        return
      }
      case 'NOTICE':
        log('relay notice', { message: frame.message })
        return
      default:
        return
    }
  }

  function connect() {
    if (stopped) return
    setState(attempt === 0 ? 'connecting' : 'reconnecting')
    let created: SocketLike
    try {
      created = makeSocket(wsUrl)
    } catch (error) {
      log('could not open a socket', { reason: (error as Error).message })
      scheduleReconnect('open threw')
      return
    }
    socket = created

    created.onopen = () => {
      // Nothing to do but wait: Buzz sends `["AUTH", challenge]` immediately on
      // connect, so authentication starts from the message handler.
      log('socket open')
    }
    created.onmessage = (ev) => {
      if (socket !== created) return
      onFrame(ev.data)
    }
    created.onerror = () => {
      // `onclose` always follows, and that is where recovery lives. Logging
      // here only helps distinguish a refused connection from a clean drop.
      log('socket error')
    }
    created.onclose = () => {
      if (socket !== created) return
      socket = null
      scheduleReconnect('socket closed')
    }
  }

  connect()

  return {
    subscribe(filters, onEvent, subOptions) {
      const id = `${options.subscriptionPrefix ?? 'sub'}-${nextSubId++}`
      const sub: LiveSubscription = {
        id,
        filters,
        onEvent,
        onEose: subOptions?.onEose,
        onClosed: subOptions?.onClosed,
      }
      subscriptions.set(id, sub)
      if (state === 'live') openSubscription(sub)
      return {
        close() {
          if (!subscriptions.delete(id)) return
          if (state === 'live') send(['CLOSE', id])
        },
      }
    },
    reconnect() {
      if (stopped) return
      if (reconnectTimer !== null) {
        clearTimer(reconnectTimer)
        reconnectTimer = null
      }
      // Reset the backoff: this is not another failed attempt in a series, it
      // is new information that the network changed.
      attempt = 0
      if (socket) {
        socket.onopen = socket.onmessage = socket.onclose = socket.onerror = null
        try {
          socket.close()
        } catch {
          // Already gone.
        }
        socket = null
      }
      pendingAuthEventId = null
      connect()
    },

    state: () => state,
    close() {
      stopped = true
      if (reconnectTimer !== null) {
        clearTimer(reconnectTimer)
        reconnectTimer = null
      }
      subscriptions.clear()
      if (socket) {
        socket.onopen = socket.onmessage = socket.onclose = socket.onerror = null
        try {
          socket.close()
        } catch {
          // Already gone.
        }
        socket = null
      }
    },
  }
}

/**
 * One live relay socket per tab, with its environment injected.
 *
 * `@estiva-app/protocol` owns the wire: {@link createLiveRelay} is the socket
 * and NIP-42 AUTH, {@link createChannelSubscriptions} is per-channel
 * refcounting. Neither of them ever left Peek's building, because the *plumbing*
 * around them did not move — `peek-app/src/nostr/liveTopics.ts` held a
 * module-level singleton, imported the app's credential provider, and reached
 * for `window`. ADR 0002 §10 scores that file ❌ on constraint 1 and ❌ on
 * constraint 2, and calls it "the bill SHA-7 is paying".
 *
 * This is that bill paid. The three behaviours are here; none of them reaches
 * for anything.
 *
 * 1. **One instance per tab.** `max_subscriptions` is per connection and the
 *    relay authenticates a connection once, so a connection per component mount
 *    is wrong rather than merely wasteful — and React StrictMode makes it
 *    concrete, mounting everything twice. The mechanism is
 *    {@link createLiveClientHolder}; the single module binding stays in the app,
 *    because a module-level global *here* is the constraint-2 failure this
 *    package exists to stop repeating.
 * 2. **The credential is read per connect, never captured.** A token captured
 *    at module load survives a silent renewal as a dead credential, and a
 *    reconnect then signs its `22242` with it. `getCredential` is called on
 *    every connect attempt — that is `createLiveRelay`'s contract, and this
 *    passes it straight through rather than wrapping it.
 * 3. **Network return drives a reconnect.** See {@link OnlineSource}.
 *
 * ## What this deliberately does not know
 *
 * Where anything is stored. Peek's `liveTopics.ts` took a `LiveProjectionApi`,
 * and extracting that as-is would have baked a Convex assumption into a package
 * two apps depend on — the "package shaped like one app" failure. So this
 * delivers frames and connection state and nothing else, and the Convex-shaped
 * projection stays in Peek. It also bets on neither outcome of "do we need
 * Convex": if Convex stays nothing here changes, and if it goes this is already
 * right.
 */
import {
  createChannelSubscriptions,
  createLiveRelay,
  type ChannelSubscriptions,
  type LiveRelay,
  type LiveRelayOptions,
  type RelayCredential,
  type RelayState,
  type SignedEvent,
  type UnsignedEvent,
} from '@estiva-app/protocol'
import { createFolderActivity, type FolderActivity, type FolderListener } from './folder-activity.js'
import { assumeOnline, type OnlineSource } from './online.js'

/**
 * The relay's aggregate `#h` budget for one REQ, COUNT, `/query` or `/count`.
 *
 * `MAX_EXPLICIT_CHANNEL_VALUES` in `buzz-relay/src/handlers/req.rs`: "Explicit
 * channels may each require an uncached membership lookup and, for a live WS
 * subscription, a registry entry plus Redis topic retain." Exceeding it is
 * refused, so {@link LiveClient.watchFolders} chunks rather than hoping.
 */
export const MAX_FOLDERS_PER_SUBSCRIPTION = 128

/**
 * Told what happened, never asked what to do.
 *
 * Peek's freshness model — four states and the copy that goes with them — is
 * product voice and stays in Peek. These are the observations it needs, so the
 * app can derive its own states without this package holding any of them.
 */
export interface LiveClientObservers {
  onState?(state: RelayState): void
  onOnline?(online: boolean): void
  /** No credential at all. Not yet "signed out" — a silent renewal passes through here. */
  onCredentialMissing?(): void
  onSignOk?(): void
  onSignFailure?(error: unknown): void
}

export interface LiveClientOptions {
  /** `https://…` or `wss://…`. Where it comes from is the app's decision. */
  relayUrl: string
  /** Read fresh on every connect attempt, so a reconnect picks up a renewal. */
  getCredential(): RelayCredential | null
  /**
   * Injected so nothing here fetches. Peek passes `signViaEstivaId`; a keyed
   * client passes a `signEvent` wrapper, and must set `unsigned.pubkey` itself
   * because `createLiveRelay` leaves it empty for a remote `/sign` to fill.
   */
  sign(unsigned: UnsignedEvent, token: string, expectedPubkey: string): Promise<SignedEvent>
  /** Defaults to {@link assumeOnline} — a package that assumed a browser would be wrong. */
  online?: OnlineSource
  observe?: LiveClientObservers
  /** Appears in the relay operator's logs and nowhere else. Name your app. */
  subscriptionPrefix?: string
  /** Never receives event bodies or credentials. */
  log?(message: string, detail?: Record<string, unknown>): void
  /** Test seams, passed through untouched. */
  socketFactory?: LiveRelayOptions['socketFactory']
  now?: LiveRelayOptions['now']
  setTimer?: LiveRelayOptions['setTimer']
  clearTimer?: LiveRelayOptions['clearTimer']
  backoff?: LiveRelayOptions['backoff']
}

export interface FolderWatch {
  /** Idempotent. Closes the REQs and forgets the listeners. */
  stop(): void
}

export interface LiveClient {
  /** The socket. Exposed because an app with one subscription needs no more than this. */
  readonly relay: LiveRelay
  /**
   * Per-channel and refcounted: one REQ per channel, every consumer sees every
   * event. What a message projection wants, and what Peek uses.
   */
  readonly subscriptions: ChannelSubscriptions
  state(): RelayState
  onState(listener: (state: RelayState) => void): () => void
  /**
   * Watch a whole workspace with **one REQ per 128 Folders**, and be told which
   * Folder changed rather than what changed.
   *
   * This is the capability a second consumer forced, and it is worth saying why
   * {@link subscriptions} is not it: that path is one REQ per channel, so a
   * 34-Folder workspace spends 34 client→server frames on every connect and
   * every reconnect. `REQ` is metered on `LimitType::WsEvents`, and 50 unpaced
   * REQs are accepted before the 51st is refused `rate-limited: quota
   * exceeded` — measured against production, LIV-1. A wide filter spends one.
   *
   * The wide filter is measured, not assumed: one filter carrying 34 `#h`
   * delivered 34 of 34 live against `wss://estiva.estiva.app`. It is also a
   * property of the *deployed relay branch* — `nfb-demo-kinds` carries the
   * plural `extract_channel_ids_from_filters`, and on `origin/main`'s singular
   * version the same filter files as a global subscription and `fan_out_scoped`
   * never consults it for an event carrying an `h`. That build delivers 0 of 34
   * with no error at all: EOSE, `live`, silence. Anything relying on this should
   * be able to answer "did an event I did not publish arrive", because nothing
   * else distinguishes the two.
   *
   * `kinds` is strongly recommended rather than optional-by-taste: a kindless
   * wide filter was refused outright on that other build with `restricted:
   * p-gated events require #p matching your pubkey`.
   */
  watchFolders(
    folders: string[],
    listener: (folder: string) => void,
    options?: { kinds?: number[] },
  ): FolderWatch
  /** Watch one Folder by name. The refcounted half of {@link watchFolders}. */
  onFolderActivity(folder: string, listener: FolderListener): () => void
  /** Release everything and stop reconnecting. */
  close(): void
}

/**
 * Call an app's observer without letting it break the socket.
 *
 * These are the app's callbacks — Peek's `freshness.ts` recorders — and they run
 * on the connect, sign and state paths. One of them throwing used to be able to
 * skip the `relay.reconnect()` on the line after it, which leaves a socket
 * reporting `live` and delivering nothing: the exact failure the online source
 * exists to prevent, reintroduced by the thing observing it.
 */
function safely(run: () => void): void {
  try {
    run()
  } catch {
    /* an observer's own problem; never the socket's */
  }
}

/** The `h` tag is the Folder — RFC 0.4 §5.2, measured across all production channels. */
function folderOf(event: SignedEvent): string | undefined {
  return event.tags.find((tag) => tag[0] === 'h')?.[1]
}

function chunk<T>(items: T[], size: number): T[][] {
  const out: T[][] = []
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size))
  return out
}

export function createLiveClient(options: LiveClientOptions): LiveClient {
  const stateListeners = new Set<(state: RelayState) => void>()
  const activity: FolderActivity = createFolderActivity()
  const online = options.online ?? assumeOnline()
  let state: RelayState = 'connecting'

  const relay = createLiveRelay({
    url: options.relayUrl,
    getCredential: () => {
      const credential = options.getCredential()
      if (!credential) {
        safely(() => options.observe?.onCredentialMissing?.())
        return null
      }
      return credential
    },
    sign: async (unsigned, token, expectedPubkey) => {
      try {
        const signed = await options.sign(unsigned, token, expectedPubkey)
        safely(() => options.observe?.onSignOk?.())
        return signed
      } catch (error) {
        // The status is the honest signal, and "expired" versus "this app
        // cannot verify the token" decides whether sending somebody to sign in
        // again helps or wastes their time.
        safely(() => options.observe?.onSignFailure?.(error))
        throw error
      }
    },
    onState: (next) => {
      state = next
      safely(() => options.observe?.onState?.(next))
      for (const listener of [...stateListeners]) safely(() => listener(next))
    },
    subscriptionPrefix: options.subscriptionPrefix,
    log: options.log,
    socketFactory: options.socketFactory,
    now: options.now,
    setTimer: options.setTimer,
    clearTimer: options.clearTimer,
    backoff: options.backoff,
  })

  const subscriptions = createChannelSubscriptions(relay, {
    onListenerError: (error) => options.log?.('a channel listener threw', { error: String(error) }),
  })

  safely(() => options.observe?.onOnline?.(online.online()))
  const releaseOnline = online.subscribe((isOnline) => {
    safely(() => options.observe?.onOnline?.(isOnline))
    // `offline` drops the socket so the reported state becomes honest at once;
    // `online` retries immediately rather than waiting out a backoff that may
    // have grown to half a minute while there was no network to reach.
    relay.reconnect()
  })

  return {
    relay,
    subscriptions,
    state: () => state,
    onState(listener) {
      stateListeners.add(listener)
      return () => stateListeners.delete(listener)
    },
    onFolderActivity: (folder, listener) => activity.watch(folder, listener),
    watchFolders(folders, listener, watchOptions) {
      const unwatch = folders.map((folder) => activity.watch(folder, () => listener(folder)))
      const subs = chunk([...new Set(folders)], MAX_FOLDERS_PER_SUBSCRIPTION).map((group) =>
        relay.subscribe(
          [{ ...(watchOptions?.kinds ? { kinds: watchOptions.kinds } : {}), '#h': group }],
          (event) => {
            const folder = folderOf(event)
            if (folder) activity.notify(folder)
          },
          {
            onClosed: (reason) => options.log?.('folder subscription closed', { reason }),
          },
        ),
      )
      let stopped = false
      return {
        stop() {
          if (stopped) return
          stopped = true
          for (const sub of subs) sub.close()
          for (const release of unwatch) release()
        },
      }
    },
    close() {
      releaseOnline()
      subscriptions.close()
      relay.close()
      stateListeners.clear()
    },
  }
}

export interface LiveClientHolder {
  /**
   * The tab's client, built on first use.
   *
   * A changed relay origin means a different deployment, so the old client is
   * torn down rather than left pointed at it. Not expected in a page's lifetime.
   */
  get(options: LiveClientOptions): LiveClient
  /**
   * The client if one exists, without building it.
   *
   * A consumer that only wants to listen has no business holding whatever the
   * builder needed — in Peek's case the Convex actions, which would otherwise
   * appear in the dependency list of a component that reads the relay directly.
   * `null` before anything has connected is a real state, not an error: the
   * caller falls back to its timer.
   */
  peek(): LiveClient | null
  /** Drops the instance so the next `get` builds a new one. Test seam. */
  reset(): void
}

/**
 * Somewhere to keep the one client, without this package keeping it.
 *
 * The app holds the single module-scope binding — `const holder =
 * createLiveClientHolder()` — which is the one place a per-tab singleton can
 * live without making the package un-instantiable twice.
 */
export function createLiveClientHolder(): LiveClientHolder {
  let current: { relayUrl: string; client: LiveClient } | null = null
  return {
    get(options) {
      if (current && current.relayUrl === options.relayUrl) return current.client
      current?.client.close()
      current = { relayUrl: options.relayUrl, client: createLiveClient(options) }
      return current.client
    },
    peek: () => current?.client ?? null,
    reset() {
      current?.client.close()
      current = null
    },
  }
}

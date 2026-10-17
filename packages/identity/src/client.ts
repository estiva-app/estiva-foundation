/**
 * Signing in with Estiva ID — authorization code + PKCE.
 *
 * The app does not hold a password or a key. It sends the person to the identity
 * service and gets back a token whose `sub` is their Nostr pubkey.
 *
 * ## Why a redirect rather than a fetch
 *
 * `POST /token` is reachable cross-origin, but the *session* that authorises the
 * redirect is a `SameSite=Lax` cookie on the identity origin. Lax cookies ride
 * top-level navigations and nothing else, so the only way to prove who you are
 * is to actually go there. That is deliberate on their side (PEEK-90): the origin
 * holding every custodied key does not relax its cookie or send
 * `Access-Control-Allow-Credentials`.
 *
 * **A hidden iframe does not work**, and the reason is the same property: `Lax`
 * withholds the cookie from anything that is not a top-level navigation. The
 * refresh-token grant exists because of this. Do not "simplify" it back.
 *
 * ## The bits that must match exactly
 *
 * `redirect_uri` is compared **exact-string** against the app's registered list —
 * a trailing slash is a different URI and gets a 400 before anything else
 * happens. An identity provider that prefix-matched would be an open redirector
 * handing out authorization codes.
 *
 * `/token` is plain OAuth 2.0 (RFC 6749 §4.1.3, §6): a form-encoded body with
 * snake_case fields, and a refusal answered as `{"error": "invalid_grant"}`.
 * Until 0.3.0 this sent Estiva's own camelCase JSON, which no OAuth library
 * speaks; Estiva ID drops it once every app runs this release (AUT-3).
 * why: https://github.com/estiva-app/estiva-docs/blob/main/decisions/sign-in-is-plain-oauth.md
 *
 * ## Everything is injected, and each injection is a real difference
 *
 * This is a factory rather than a module of free functions because the two
 * consumers genuinely differ, and hardcoding either would have made the package
 * come out shaped like whichever app it was extracted from:
 *
 * - **`clientId`** — `estiva-peek` and `estiva-ship` are separate rows in
 *   `app_credentials` with separate `redirectUris` and separate kind ceilings.
 * - **`redirectUri`** — Peek registers a fixed `/auth/callback`; Ship routes on
 *   `location.hash` and registers its current pathname. Neither is more correct.
 * - **`storage`** and **`pendingStore`** — two stores, because the flow needs
 *   two. The *session* lives in `localStorage` so every tab shares it and it
 *   outlives a tab; the *in-flight PKCE credentials* live in `sessionStorage`
 *   because the flow starts and ends in one tab. That is the default since
 *   PEE-3, when Peek gave up its per-tab session (a new tab paid a ~0.5 s
 *   `/authorize` bounce) and all three apps came to choose the same. Both stay
 *   injectable — a test, a script or a future "public computer" mode may differ.
 *   A shared session is why renewal takes a cross-tab {@link EstivaIdConfig.lock}.
 * - **`keyPrefix`** — so two apps on one origin cannot read each other's keys.
 * - **`navigate`** — the one genuinely untestable act. Injected so a test can
 *   observe where the flow *would* go.
 */
import { type KeyValueStore, type ShellReason, clearGuard, markGuard } from './shell.js'

/**
 * `crypto`, `btoa`, `TextEncoder`, `URL`, `URLSearchParams` and `fetch` are not
 * in `lib.es2022`, and this package compiles with `types: []` and no `lib: dom`
 * so one published `.d.ts` works in every consumer (ADR 0002 §4a).
 *
 * Declared inside this module, so nothing lands in a consumer's global scope,
 * and read inside function bodies, so importing this module touches no global.
 * The same pattern `@estiva-app/protocol` uses, and it turned out to stretch
 * further than expected — see the README on the prediction it falsified.
 */
declare const crypto: {
  getRandomValues(array: Uint8Array): Uint8Array
  subtle: { digest(algorithm: string, data: Uint8Array): Promise<ArrayBuffer> }
}
declare const btoa: (binary: string) => string
/** Reading the `exp` claim out of a token the app already holds. */
declare const atob: (base64: string) => string
declare const TextEncoder: { new (): { encode(input: string): Uint8Array } }
declare const URL: {
  new (url: string, base?: string): { searchParams: { set(k: string, v: string): void }; toString(): string }
}
declare const URLSearchParams: {
  new (init: string | Record<string, string>): { get(name: string): string | null; toString(): string }
}

/**
 * The timer pair, for {@link EstivaIdClient.scheduleRenewal}.
 *
 * Declared here for the same reason as everything above, and returning
 * `unknown` for one more: the handle's real type is `number` in a browser and an
 * object in Node, and naming either would put an ambient type in the published
 * `.d.ts` — which `check-identity.yml` fails the build over, correctly. Nothing
 * outside this module ever sees a handle; `scheduleRenewal` hands back a
 * `cancel` function instead.
 */
declare const setTimeout: (run: () => void, ms: number) => unknown
declare const clearTimeout: (handle: unknown) => void

/** Just enough of `fetch` to redeem a code. A parameter as well as a global. */
export type FetchLike = (
  url: string,
  init: { method: string; headers: Record<string, string>; body: string },
) => Promise<{ ok: boolean; status: number; json(): Promise<unknown> }>

declare const fetch: FetchLike

/**
 * The defaults for `storage`, `pendingStore` and `lock`. Read through `typeof`
 * inside functions, so a runtime without them — Node, a worker — gets null or
 * the unguarded path rather than a ReferenceError.
 */
declare const localStorage: KeyValueStore | undefined
declare const sessionStorage: KeyValueStore | undefined
declare const navigator:
  | { locks?: { request<T>(name: string, run: () => Promise<T>): Promise<T> } }
  | undefined

/** A browser store, or null where there is none or reading it throws (a sandboxed frame). */
function webStore(which: 'local' | 'session'): KeyValueStore | null {
  try {
    if (which === 'local') return typeof localStorage === 'undefined' ? null : (localStorage ?? null)
    return typeof sessionStorage === 'undefined' ? null : (sessionStorage ?? null)
  } catch {
    return null
  }
}

function webLock<T>(name: string, run: () => Promise<T>): Promise<T> {
  const locks = typeof navigator === 'undefined' ? undefined : navigator?.locks
  return locks ? locks.request(name, run) : run()
}

/** The default for `onWake`: declared here for the same reason as the stores above. */
interface EventTargetLike {
  addEventListener(type: string, listener: () => void): void
  removeEventListener(type: string, listener: () => void): void
}
declare const document: (EventTargetLike & { visibilityState?: string }) | undefined
declare const window: EventTargetLike | undefined

/** A tab shown again, or the network back: the moments a throttled or failed renewal is owed. */
function pageWake(wake: () => void): () => void {
  const doc = typeof document === 'undefined' ? undefined : document
  const win = typeof window === 'undefined' ? undefined : window
  const shown = () => {
    if (doc?.visibilityState === 'visible') wake()
  }
  doc?.addEventListener('visibilitychange', shown)
  win?.addEventListener('online', wake)
  return () => {
    doc?.removeEventListener('visibilitychange', shown)
    win?.removeEventListener('online', wake)
  }
}

/** A form-encoded `/token` request (RFC 6749 §4.1.3, §6). */
function tokenRequest(fields: Record<string, string>): { method: string; headers: Record<string, string>; body: string } {
  return {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams(fields).toString(),
  }
}

export interface EstivaIdConfig {
  /** Origin of the identity service, e.g. `https://id.estiva.app`. */
  base: string
  /** This app's `client_id` row in `app_credentials`. Never defaulted. */
  clientId: string
  /**
   * Where Estiva ID sends people back to. Must match a registered entry
   * **exactly** — a trailing slash is a refused sign-in.
   */
  redirectUri: () => string
  /**
   * Where the **session** lives — the token and nothing else.
   *
   * Defaults to `localStorage`: every tab shares one session and it survives a
   * tab close (PEE-3). Returns null outside a browser.
   */
  storage?: () => KeyValueStore | null
  /**
   * Where an **in-flight sign-in's** single-use credentials live — the verifier,
   * the state, the returnTo, the shell reason and the silent-attempt guard.
   *
   * Defaults to `sessionStorage` when {@link storage} is defaulted too, and to
   * {@link storage} when it is given — so a caller passing one store keeps
   * exactly the behaviour it had before the defaults existed.
   *
   * **The two are separate because the flow needs it.** The session belongs in
   * `localStorage` so it outlives a tab, while the PKCE credentials are per-tab
   * by nature — the flow starts and ends in one tab, and the guard's whole point
   * is that a genuinely new tab is entitled to a fresh attempt.
   *
   * This parameter was added by wiring the second consumer. The package had
   * assumed one store because it was extracted from Peek, which uses one: the
   * exact "comes out shaped like the app it came from" failure SHA-4 names, found
   * by the mechanism SHA-4 prescribes for finding it.
   */
  pendingStore?: () => KeyValueStore | null
  /** Namespaces this app's keys, e.g. `peek.estivaId`. */
  keyPrefix: string
  /** Defaults to the runtime's `location.assign`-equivalent via `navigate`. */
  navigate?: (url: string) => void
  now?: () => number
  fetch?: FetchLike
  /**
   * The timers `scheduleRenewal` runs on, injected for exactly the reason
   * `fetch` and `navigate` are: a test cannot wait ten minutes to find out
   * whether the renewal was scheduled, and "we scheduled it" and "we did
   * nothing" are otherwise the same observation.
   */
  setTimer?: (run: () => void, ms: number) => unknown
  clearTimer?: (handle: unknown) => void
  /**
   * Runs `run` while holding the lock `name` against every other tab of this
   * origin (PEE-3). Renewal holds it, because a shared session means every
   * tab's timer fires at the same moment, and Estiva ID revokes the whole chain
   * when one refresh token is presented twice — two tabs renewing together
   * would sign the person out of all of them.
   *
   * Defaults to the Web Locks API (`navigator.locks.request`), and to running
   * `run` unguarded where there is none — a single-page runtime has no other
   * tab to race.
   */
  lock?: <T>(name: string, run: () => Promise<T>) => Promise<T>
  /**
   * Calls `wake` whenever a renewal may be owed early, and returns how to stop
   * (AUT-3). A background tab's timers are throttled to once a minute and
   * may be frozen outright, so the scheduled renewal can still be pending when
   * the tab is shown again with a dead token; and a renewal the network
   * swallowed is owed the moment it is back.
   *
   * Defaults to the page's `visibilitychange` (to visible) and `online`
   * events, and to nothing where there is no page.
   */
  onWake?: (wake: () => void) => () => void
}

export interface StoredToken {
  accessToken: string
  /** Epoch ms. Derived from `expires_in` at receipt, not sent by the server. */
  expiresAt: number
  pubkey: string
  /**
   * The credential that renews the one above without a redirect (PEEK-108).
   *
   * Absent when Estiva ID issued none — a deployment predating the grant. The
   * app then behaves exactly as it did before, which is what lets the two sides
   * ship independently.
   *
   * **Single-use.** Estiva ID rotates it on every redemption and treats a replay
   * as evidence of theft, revoking the whole chain. So it is replaced, never
   * kept alongside its successor.
   */
  refreshToken?: string
}

/**
 * `setTimeout`'s ceiling. Above 2^31-1 ms the delay overflows to a negative
 * int32 and the timer fires immediately.
 */
const MAX_TIMER_MS = 2_147_483_647

/** How long renewal keeps the cross-tab lock after writing, for the write to reach the other tabs (PEE-3). */
const RENEWAL_SETTLE_MS = 250

export class SignInError extends Error {}

/** What a scheduled renewal reports back. Both optional; neither is required to be useful. */
export interface RenewalHandlers {
  /** A renewal succeeded. The session continues, on a later expiry. */
  onRenewed?: (token: StoredToken) => void
  /**
   * Estiva ID refused the renewal, and the sign-in is over.
   *
   * The app asks for the passkey on the page the person is on (SPEC §4.4: "Any
   * 4xx from the refresh grant ends renewal"). An unreachable network does not
   * fire this since 0.3.0: the schedule retries, shortly and whenever the
   * network is back, because a laptop waking before its wifi must not look
   * like a sign-out (AUT-3).
   */
  onEnded?: () => void
}

/**
 * What one renewal came to. `refused` is Estiva ID's answer (any 4xx) and has
 * already cleared the stored session; `unreachable` is no answer, or a 5xx, and
 * has cleared nothing; `none` means there was no refresh token to spend.
 */
export type Renewal =
  | { outcome: 'renewed'; token: StoredToken }
  | { outcome: 'refused' }
  | { outcome: 'unreachable' }
  | { outcome: 'none' }

/** How long a renewal the network swallowed waits before trying again, doubling to the ceiling. */
const UNREACHABLE_RETRY_MS = 15_000
const UNREACHABLE_RETRY_MAX_MS = 5 * 60_000

/**
 * How close to its renewal time a token must be for a wake to renew it now.
 * `expiresAt` already sits 30 s before the token's real end (`tokenFrom`);
 * this covers a tab shown just before the timer would have fired anyway.
 */
const WAKE_MARGIN_MS = 60_000

export interface RenewalSchedule {
  /** Stop renewing. Idempotent, and safe to call after the session has ended. */
  cancel: () => void
}

interface TokenResponse {
  access_token?: string
  expires_in?: number
  pubkey?: string
  refresh_token?: string
}

export interface EstivaIdClient {
  redirectUri: () => string
  codeChallenge: (verifier: string) => Promise<string>
  beginSignIn: (returnTo: string, options?: { silent?: boolean }) => Promise<void>
  completeSignIn: (search: string) => Promise<{ token: StoredToken; returnTo: string }>
  refreshAccessToken: () => Promise<StoredToken | null>
  renew: () => Promise<Renewal>
  scheduleRenewal: (handlers?: RenewalHandlers) => RenewalSchedule
  storedToken: () => StoredToken | null
  validToken: (now?: number) => StoredToken | null
  hasSession: () => boolean
  currentAccessToken: () => string | undefined
  beginSignOut: () => void
  clearSession: () => void
  hasPendingSignIn: () => boolean
  clearPendingSignIn: () => void
  takeReturnTo: () => string | null
  stashShellReason: (reason: ShellReason) => void
  takeShellReason: () => ShellReason | null
}

export function createEstivaId(config: EstivaIdConfig): EstivaIdClient {
  const now = config.now ?? (() => Date.now())
  /** In-flight credentials, which may live somewhere shorter than the session. */
  /** The session, shared by every tab unless the app says otherwise (PEE-3). */
  const session = config.storage ?? (() => webStore('local'))
  const pending = config.pendingStore ?? config.storage ?? (() => webStore('session'))
  const lock = config.lock ?? webLock
  const send = () => config.fetch ?? fetch
  const go = (url: string) => {
    if (!config.navigate) throw new Error('createEstivaId: navigate is required to leave for Estiva ID')
    config.navigate(url)
  }

  const VERIFIER_KEY = `${config.keyPrefix}.codeVerifier`
  const STATE_KEY = `${config.keyPrefix}.state`
  const RETURN_KEY = `${config.keyPrefix}.returnTo`
  const TOKEN_KEY = `${config.keyPrefix}.token`
  /** Why the last round trip came back empty, handed from the callback to the shell. */
  const REASON_KEY = `${config.keyPrefix}.shellReason`

  const base64Url = (bytes: Uint8Array): string => {
    let s = ''
    for (const b of bytes) s += String.fromCharCode(b)
    return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
  }

  const randomUrlSafe = (bytes = 32): string => base64Url(crypto.getRandomValues(new Uint8Array(bytes)))

  /** `base64url(sha256(verifier))` — the S256 challenge. `plain` is refused upstream. */
  const codeChallenge = async (verifier: string): Promise<string> => {
    const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(verifier))
    return base64Url(new Uint8Array(digest))
  }

  /**
   * The `exp` claim, in epoch ms, or null if the token does not carry a readable one.
   *
   * Not verification — that is the resource server's job and it holds the key.
   * This reads one number out of a payload the app already holds, for one
   * purpose: so that "is this token still good" is answered by the same fact the
   * service will answer it with.
   *
   * Parse failures return null rather than throwing. A token this cannot read is
   * still a token, and refusing to hold one because its middle segment is not
   * base64url would be a worse failure than the one this prevents.
   */
  const expFromJwt = (accessToken: string): number | null => {
    const payload = accessToken.split('.')[1]
    if (!payload) return null
    try {
      const json = atob(payload.replace(/-/g, '+').replace(/_/g, '/'))
      const exp = (JSON.parse(json) as { exp?: unknown }).exp
      return typeof exp === 'number' && Number.isFinite(exp) ? exp * 1000 : null
    } catch {
      return null
    }
  }

  /**
   * Shape a token response into what is kept.
   *
   * The expiry is deliberately pessimistic by 30s, so a token is never presented
   * in the window where it is technically alive and about to not be.
   *
   * ## Why `exp` and not just `expires_in`
   *
   * `expires_in` describes a *duration*, so acting on it means adding it to the
   * local clock — and the service decides using the token's own `exp` against
   * *its* clock. Those two answers agree only while the clocks do.
   *
   * When they diverge in the unsafe direction the app believes a dead token is
   * live, and the failure is genuinely nasty: `POST /sign` answers
   * `401 Invalid token: "exp" claim timestamp check failed`, while `validToken`
   * keeps returning that same token to every caller that asks — including the
   * one Convex asks — so nothing ever renews and nothing ever recovers. Peek got
   * into exactly this state overnight on a machine that had slept, and the only
   * way out was clearing site data and signing in again.
   *
   * So both bounds are computed and **the earlier wins**. `exp` is what the
   * service will actually check; `expires_in` still covers a token with no
   * readable `exp`, and a clock that is *behind* the service's, where `exp`
   * alone would be the more generous of the two.
   */
  const tokenFrom = (body: TokenResponse, pubkey: string): StoredToken => {
    const accessToken = body.access_token as string
    const fromDuration = now() + Math.max(0, (body.expires_in ?? 600) - 30) * 1000
    const exp = expFromJwt(accessToken)
    const fromClaim = exp === null ? null : exp - 30_000
    return {
      accessToken,
      expiresAt: fromClaim === null ? fromDuration : Math.min(fromDuration, fromClaim),
      pubkey,
      ...(body.refresh_token ? { refreshToken: body.refresh_token } : {}),
    }
  }

  const storedToken = (): StoredToken | null => {
    const raw = session()?.getItem(TOKEN_KEY)
    if (!raw) return null
    try {
      const parsed = JSON.parse(raw) as StoredToken
      return parsed.accessToken && parsed.expiresAt ? parsed : null
    } catch {
      return null
    }
  }

  const validToken = (at = now()): StoredToken | null => {
    const t = storedToken()
    return t && t.expiresAt > at ? t : null
  }

  /**
   * Forget this app's session. **Not** an in-flight sign-in — and that
   * separation is the whole point (PEEK-167).
   *
   * This used to clear the verifier, state and `returnTo` as well, which reads
   * as thoroughness and is a bug. Those three are not session state: they are
   * the credentials of an authorization request that is *currently in the air*,
   * owned by the `beginSignIn` that wrote them and spent by the
   * `completeSignIn` that comes back. Clearing them on somebody else's schedule
   * does not tidy anything up — it destroys a sign-in that is still happening.
   *
   * The path that made it matter: a boot whose token has expired renews, fails,
   * clears the session, drops to the shell, and the shell probes and writes a
   * fresh verifier. A *second* renewal awaiting the same in-flight promise then
   * resolves and clears again — now deleting the verifier the probe just wrote.
   * The code comes back to a tab with nothing to redeem it, `completeSignIn`
   * refuses it before `/token` is ever called, and the identity service has no
   * record of a failure at all because nothing was asked of it.
   *
   * Anything that wants both says so, and only `beginSignOut` does.
   */
  const clearSession = (): void => {
    session()?.removeItem(TOKEN_KEY)
    // The reason lives with the in-flight credentials, which may be a different
    // store — see `pendingStore`. Still cleared here: a reason outliving the
    // session it described is a lie, and that was true before the split.
    pending()?.removeItem(REASON_KEY)
  }

  /**
   * Abandon a sign-in that has not come back.
   *
   * Deliberately not called on any failure path. A verifier outliving its
   * attempt is harmless — `completeSignIn` clears all three before it does
   * anything else, and a stale one cannot redeem a code issued against a
   * different challenge. Destroying a live one is the expensive direction.
   */
  const clearPendingSignIn = (): void => {
    const s = pending()
    if (!s) return
    for (const k of [VERIFIER_KEY, STATE_KEY, RETURN_KEY]) s.removeItem(k)
  }

  const stashShellReason = (reason: ShellReason): void => {
    pending()?.setItem(REASON_KEY, reason)
  }

  /** Read once. Single-use: a stale reason outliving its cause is a lie. */
  const takeShellReason = (): ShellReason | null => {
    const s = pending()
    const raw = s?.getItem(REASON_KEY)
    if (raw) s?.removeItem(REASON_KEY)
    return (raw as ShellReason | null) ?? null
  }

  /**
   * Where to go back to, as stashed by `beginSignIn`. Single-use.
   *
   * The refusal path needs this as much as the success path: a silent probe that
   * comes back `login_required` was still started from somewhere, and dropping it
   * puts people on a default screen instead of the link they opened (PEEK-123).
   */
  const takeReturnTo = (): string | null => {
    const s = pending()
    const raw = s?.getItem(RETURN_KEY)
    if (raw) s?.removeItem(RETURN_KEY)
    return raw ?? null
  }

  /**
   * Renew the access token without leaving the page (PEEK-108).
   *
   * This is the whole reason the grant exists. Before it, an expired token
   * could only be replaced by a top-level navigation through `/authorize`,
   * which costs whatever the person had on screen.
   *
   * Two failures, and since 0.3.0 they are told apart (AUT-3). A refusal is
   * any 4xx: the sign-in is over (Estiva ID answers a uniform `invalid_grant`
   * for every reason, by design), and the stored token is cleared so a spent
   * refresh token is never presented twice — a replay is what Estiva ID treats
   * as theft. No answer, or a 5xx, is not a refusal: the token is kept, and the
   * caller tries again rather than asking for a passkey.
   */
  // Whatever this tab's renewal came to, another tab's sign-out or sign-in
  // since is the session now.
  const theirs = (): Renewal => {
    const token = validToken()
    return token ? { outcome: 'renewed', token } : { outcome: 'refused' }
  }

  const performRefresh = async (): Promise<Renewal> => {
    const s = session()
    const current = storedToken()
    if (!s || !current?.refreshToken) return { outcome: 'none' }

    let response: Awaited<ReturnType<FetchLike>>
    try {
      response = await send()(
        new URL('/token', config.base).toString(),
        tokenRequest({
          grant_type: 'refresh_token',
          refresh_token: current.refreshToken,
          client_id: config.clientId,
        }),
      )
    } catch {
      // Unreachable rather than refused. The token in hand may still be fine,
      // so this deliberately does not clear the session — a flaky network must
      // not sign somebody out.
      return { outcome: 'unreachable' }
    }
    if (response.status >= 500) return { outcome: 'unreachable' }

    /*
      The session is shared by every tab (PEE-3), and signing out takes no lock:
      while `/token` was answering, another tab may have signed out — or in.
      Then this answer belongs to a session that is gone, and writing it would
      put a live token back after the sign-out, for its whole lifetime. Only
      the session this renewal spent is replaced or cleared.
    */
    const stillOurs = () => storedToken()?.refreshToken === current.refreshToken

    if (!response.ok) {
      if (!stillOurs()) return theirs()
      clearSession()
      return { outcome: 'refused' }
    }

    let body: TokenResponse
    try {
      body = (await response.json()) as TokenResponse
    } catch {
      return { outcome: 'unreachable' }
    }
    if (!stillOurs()) return theirs()
    if (!body.access_token) {
      clearSession()
      return { outcome: 'refused' }
    }

    const next = tokenFrom(body, body.pubkey ?? current.pubkey)
    s.setItem(TOKEN_KEY, JSON.stringify(next))
    return { outcome: 'renewed', token: next }
  }

  /**
   * The renewal in flight, if there is one.
   *
   * **A refresh token is single-use and a replay is read as theft**, which
   * revokes the whole chain — so two renewals must never be in the air at once.
   * Two easily can be: Ship signs the NIP-98 auth event and the content event as
   * separate `POST /sign` calls, and a token that expires between them answers
   * `401` to both, each of which renews.
   *
   * Peek has guarded this since PEEK-108 with a `refreshing` ref in its Convex
   * adapter, and SHA-4 lists the guard as one of the behaviours that must
   * survive the extraction — but the guard is the one part that did not travel,
   * because it lived in the hook rather than the client. So Peek kept it and
   * Ship never had it. It belongs here, where every caller of every consumer
   * gets it whether or not they thought about it.
   *
   * Coalescing rather than caching: the promise is dropped the moment it
   * settles, so the *next* expiry renews again.
   *
   * **And never across tabs either (PEE-3).** The promise guards one page; a
   * session in `localStorage` is shared by every tab, and each tab's timer
   * fires at the same moment, for the same expiry. So the renewal runs under
   * {@link EstivaIdConfig.lock}, and a tab that waited for it compares the
   * stored refresh token with the one it set out to spend: if another tab
   * renewed (or signed out, or in) meanwhile, that tab's answer is taken and
   * `/token` is not called — presenting the spent token would be the replay.
   */
  let refreshing: Promise<Renewal> | null = null

  const renew = (): Promise<Renewal> => {
    if (refreshing) return refreshing
    const spending = storedToken()?.refreshToken
    refreshing = new Promise<Renewal>((answer, fail) => {
      lock(`${config.keyPrefix}.renewal`, async () => {
        if (storedToken()?.refreshToken !== spending) return answer(theirs())
        answer(await performRefresh())
        /*
          Held a little longer than the renewal, though the caller already has
          its answer. A browser does not order one tab's `localStorage` write
          with another tab's lock grant — the write reaches the other process's
          copy shortly after — so a tab granted the lock at once could still
          read the spent token and present it again.
        */
        await new Promise<void>((settle) => setTimeout(settle, RENEWAL_SETTLE_MS))
      }).catch(fail)
    }).finally(() => {
      refreshing = null
    })
    return refreshing
  }

  /** {@link renew}, for callers that only need the token: `null` for every failure, as before 0.3.0. */
  const refreshAccessToken = (): Promise<StoredToken | null> =>
    renew().then((r) => (r.outcome === 'renewed' ? r.token : null))


  return {
    redirectUri: config.redirectUri,
    codeChallenge,
    storedToken,
    validToken,
    clearSession,
    clearPendingSignIn,
    stashShellReason,
    takeShellReason,
    takeReturnTo,

    hasSession: () => validToken() !== null,

    /**
     * The access token to hand anything that talks to the relay.
     *
     * Every such call needs it, because Buzz answers a non-member with
     * `403 relay_membership_required` and a backend is a member of nothing. One
     * call site forgetting it is not a visible failure — the read comes back
     * empty and the widget renders nothing — so it is worth one name for "the
     * current token" rather than copies of `validToken()?.accessToken`.
     */
    currentAccessToken: () => validToken()?.accessToken,

    /**
     * Whether this tab has a sign-in of its own in the air.
     *
     * `beginSignIn` writes the verifier and state together and `completeSignIn`
     * spends them together, so either key answers this. Both are read because
     * the interesting question is not which key survived — it is whether the
     * code that just arrived belongs to anything this tab did.
     */
    hasPendingSignIn: () => {
      const s = pending()
      return Boolean(s?.getItem(VERIFIER_KEY) && s.getItem(STATE_KEY))
    },

    /**
     * Leave for the identity service. Never returns — the browser navigates away.
     *
     * `returnTo` is kept locally rather than smuggled through `state`: `state` is
     * a CSRF token, and widening it into a general-purpose payload invites
     * treating whatever comes back as trustworthy. What comes back is only ever
     * compared.
     */
    async beginSignIn(returnTo: string, { silent = false }: { silent?: boolean } = {}): Promise<void> {
      const s = pending()
      if (!s) throw new Error('sign-in requires a browser')

      const verifier = randomUrlSafe()
      const state = randomUrlSafe(16)
      s.setItem(VERIFIER_KEY, verifier)
      s.setItem(STATE_KEY, state)
      s.setItem(RETURN_KEY, returnTo)

      /*
        The guard is marked HERE, synchronously with the writes above, and not
        further down next to the navigation (PEEK-167).

        It used to sit just before the navigation, which reads as the same thing
        and is not: `codeChallenge` awaits a `crypto.subtle` digest in between.
        For that whole window the verifier and state have already been overwritten
        while `readGuard` still answers null, so a second boot decision landing in
        it decides to probe as well.

        Two probes then write two verifier/state pairs into one tab's storage, and
        only one of the two navigations commits. When the one that commits is not
        the one that wrote last, the code comes back matched to a state that is no
        longer there and `completeSignIn` refuses it — an `exchange_failed` for a
        code that was never even presented to `/token`.

        Marking it with the other single-use writes is what makes the guard cover
        the window it exists for: they are the things this attempt has already
        spent, and they become true together or not at all.
      */
      if (silent) markGuard(s, now())

      const url = new URL('/authorize', config.base)
      url.searchParams.set('client_id', config.clientId)
      url.searchParams.set('redirect_uri', config.redirectUri())
      url.searchParams.set('response_type', 'code')
      url.searchParams.set('code_challenge', await codeChallenge(verifier))
      url.searchParams.set('code_challenge_method', 'S256')
      url.searchParams.set('state', state)

      /*
        A silent attempt asks not to be prompted (PEEK-117), so a browser with no
        session comes straight back with `error=login_required` instead of landing
        on the identity origin's sign-in page.
      */
      if (silent) url.searchParams.set('prompt', 'none')

      go(url.toString())
    },

    /**
     * Finish the round trip: verify `state`, redeem the code, keep the token.
     *
     * Throws `SignInError` with something a human can read — every refusal from
     * `/token` is a deliberately uniform `invalid_grant`, so the useful detail is
     * on this side of the exchange.
     */
    async completeSignIn(search: string): Promise<{ token: StoredToken; returnTo: string }> {
      const s = pending()
      const sessionStore = session()
      if (!s || !sessionStore) throw new SignInError('sign-in requires a browser')

      const params = new URLSearchParams(search)
      const error = params.get('error')
      if (error) throw new SignInError(`Estiva ID refused the sign-in (${error}).`)

      const code = params.get('code')
      const state = params.get('state')
      const expectedState = s.getItem(STATE_KEY)
      const verifier = s.getItem(VERIFIER_KEY)
      const returnTo = s.getItem(RETURN_KEY) || '/'

      // Clear first: these are single-use, and a failed attempt must not leave a
      // verifier lying around for a second code to be redeemed against.
      s.removeItem(STATE_KEY)
      s.removeItem(VERIFIER_KEY)
      s.removeItem(RETURN_KEY)

      if (!code) throw new SignInError('Estiva ID sent no authorization code back.')
      if (!verifier || !expectedState) {
        throw new SignInError('This sign-in did not start in this tab. Try signing in again.')
      }
      if (state !== expectedState) {
        // The one check that is not about ergonomics: a code arriving with
        // someone else's state is the shape of a login-CSRF, refused outright.
        throw new SignInError('Sign-in state did not match. Try signing in again.')
      }

      const response = await send()(
        new URL('/token', config.base).toString(),
        tokenRequest({
          grant_type: 'authorization_code',
          code,
          client_id: config.clientId,
          redirect_uri: config.redirectUri(),
          code_verifier: verifier,
        }),
      )

      if (!response.ok) {
        throw new SignInError(
          response.status === 400
            ? 'Estiva ID rejected this sign-in code. It may have expired — codes last 60 seconds.'
            : `Estiva ID returned ${response.status} exchanging the code.`,
        )
      }

      const body = (await response.json()) as TokenResponse
      if (!body.access_token || !body.pubkey) throw new SignInError('Estiva ID returned no token.')

      const token = tokenFrom(body, body.pubkey)
      sessionStore.setItem(TOKEN_KEY, JSON.stringify(token))
      // The attempt worked, so the next boot is entitled to a fresh silent one.
      clearGuard(s)
      return { token, returnTo }
    },

    refreshAccessToken,
    renew,

    /**
     * Renew shortly **before** the token expires, rather than reacting to it
     * having expired.
     *
     * SHA-4 lists this as one of the behaviours that must survive the
     * extraction, and it is the one that reads as an optimisation and is not.
     * Reacting to expiry means somebody's next action is the thing that
     * discovers the session is over — a failed publish, a blank list, or at best
     * a retry they can feel. Renewing 30 seconds early (`tokenFrom` already
     * subtracts them) means they notice nothing at all.
     *
     * It did not travel with the rest of SHA-4: the timer lived in Peek's Convex
     * adapter, so Peek kept it and Ship, whose whole point was to be the second
     * consumer, silently did not get it. Ship renews only when `POST /sign`
     * answers `401`, which is precisely "on failure".
     *
     * ## The timer is a `setTimeout`, and browsers throttle those
     *
     * A background tab gets its timers clamped — to once a minute in Chrome and
     * Safari, and after five minutes of being hidden they may be frozen outright.
     * So a tab left in the background can miss its renewal window entirely.
     *
     * So the schedule also listens for {@link EstivaIdConfig.onWake} — the tab
     * shown again, the network back — and renews there if the token is due
     * (AUT-3). Until 0.3.0 this was left to each app, and none did: a Peek tab
     * shown after an hour carried a dead token until its throttled timer came
     * round. The default reads `document` and `window` the way the stores are
     * read, declared here and checked with `typeof`, so the published types
     * still name no DOM global (ADR 0002 §4a). What it must not do is renew
     * *twice* in the scramble, which is what the guard on `renew` is for.
     *
     * ## Unreachable is not ended
     *
     * A renewal that gets no answer retries after {@link UNREACHABLE_RETRY_MS},
     * doubling, and at once on a wake; only Estiva ID's refusal calls `onEnded`.
     */
    scheduleRenewal(handlers: RenewalHandlers = {}): RenewalSchedule {
      const setTimer = config.setTimer ?? ((run, ms) => setTimeout(run, ms))
      const clearTimer = config.clearTimer ?? ((handle) => clearTimeout(handle))

      let handle: unknown = null
      let cancelled = false
      /** The expiry the timer was last armed for: a later one in storage is another tab's renewal. */
      let armedFor = 0
      /** Set while a renewal is out, so a wake in the meantime does not start a second schedule. */
      let renewing = false
      /** The wait before the next try after an unreachable renewal; null when the last one was answered. */
      let retryMs: number | null = null

      const clear = (): void => {
        if (handle !== null) clearTimer(handle)
        handle = null
      }

      const attempt = (): void => {
        renewing = true
        // A renewal that threw (storage full, a lock aborted) answered nothing,
        // so it is retried like one the network lost, never left holding
        // `renewing` with no timer armed.
        void renew().catch((): Renewal => ({ outcome: 'unreachable' })).then((result) => {
          renewing = false
          if (cancelled) return
          if (result.outcome === 'unreachable') {
            retryMs = retryMs === null ? UNREACHABLE_RETRY_MS : Math.min(retryMs * 2, UNREACHABLE_RETRY_MAX_MS)
            handle = setTimer(fire, retryMs)
            return
          }
          retryMs = null
          // A token already out of date (a clock ahead of Estiva ID's) is no
          // renewal: re-arming on it would fire at once, against `/token`, forever.
          if (result.outcome !== 'renewed' || result.token.expiresAt <= now()) {
            stop()
            handlers.onEnded?.()
            return
          }
          handlers.onRenewed?.(result.token)
          // Re-armed from the *new* expiry rather than a fixed interval, so
          // the schedule follows whatever lifetime Estiva ID actually issued.
          arm()
        })
      }

      const fire = (): void => {
        handle = null
        // Another tab sharing the session renewed first (PEE-3): follow its
        // token rather than spend a grant this tab no longer needs.
        const shared = storedToken()
        if (shared && shared.expiresAt > armedFor) {
          retryMs = null
          handlers.onRenewed?.(shared)
          arm()
          return
        }
        attempt()
      }

      const wake = (): void => {
        if (cancelled || renewing) return
        const token = storedToken()
        if (!token) return
        clear()
        // Due, owed a retry, or already renewed by another tab: settle it now.
        // Otherwise only re-arm, since a throttled timer may have drifted.
        if (retryMs !== null || token.expiresAt > armedFor || token.expiresAt - now() <= WAKE_MARGIN_MS) fire()
        else arm()
      }

      let unwatch = (): void => {}

      const stop = (): void => {
        cancelled = true
        clear()
        unwatch()
      }

      const arm = (): void => {
        const token = storedToken()
        // Nothing to renew. Not an ending — the caller is simply signed out, and
        // an app that signs in later starts a new schedule.
        if (!token) return
        armedFor = token.expiresAt

        /*
          Clamped at both ends. A negative delay is a token that already expired
          — renew now rather than never, since the refresh token almost certainly
          has not. The ceiling is `setTimeout`'s: a delay above 2^31-1 ms
          overflows to a negative int32 and fires immediately, so a nonsensical
          `expires_in` would otherwise become a hot loop against `/token` instead
          of one very distant timer.
        */
        const delay = Math.min(Math.max(0, token.expiresAt - now()), MAX_TIMER_MS)

        handle = setTimer(fire, delay)
      }

      arm()
      // Subscribed last, so an `onWake` that wakes at once finds the schedule whole.
      if (!cancelled) unwatch = (config.onWake ?? pageWake)(wake)

      return { cancel: stop }
    },


    /**
     * Leave for Estiva ID to end the session *there* (PEEK-122).
     *
     * Clearing the local token is not signing out. The `estiva_id_session` cookie
     * on the identity origin is untouched by it, so the shell's silent probe
     * succeeds on the next boot and puts the person straight back in — which is
     * exactly what "sign out doesn't sign me out" was.
     *
     * The cookie can only be reached by going there, for the same reason entry
     * works the way it does. The reason is stashed first so the shell offers a
     * passkey on return rather than silently probing for a session just ended.
     */
    beginSignOut(): void {
      clearSession()
      // Going to /logout makes any half-started sign-in moot, and this is the
      // one caller that genuinely means both.
      clearPendingSignIn()
      stashShellReason('no_session')
      const url = new URL('/logout', config.base)
      url.searchParams.set('client_id', config.clientId)
      url.searchParams.set('post_logout_redirect_uri', config.redirectUri())
      go(url.toString())
    },
  }
}

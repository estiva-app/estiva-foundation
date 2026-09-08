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
 * The request body is **camelCase JSON** (`codeVerifier`, not `code_verifier`)
 * while the response is snake_case (`access_token`). That is genuinely the
 * contract, not a typo — see `docs/API.md` in estiva-id.
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
 * - **`storage`** and **`pendingStore`** — two stores, because Ship needs two.
 *   Peek keeps everything in `sessionStorage`, which dies with the tab and keeps
 *   a bearer token off a shared machine's disk. Ship keeps its *session* in
 *   `localStorage` so it outlives a tab, and its *in-flight PKCE credentials* in
 *   `sessionStorage` because the flow starts and ends in one tab. The package
 *   assumed one store until the second consumer was wired — see `pendingStore`.
 *   **Do not unify them**: NIP-RS slots (CRO-4) must survive a restart and belong
 *   in `localStorage`, while an access token does not.
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
declare const URLSearchParams: { new (init: string): { get(name: string): string | null } }

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
   * Peek uses `sessionStorage`: it dies with the tab, which keeps a bearer token
   * off a shared machine's disk. Ship uses `localStorage` so a session survives
   * a tab close. Returns null outside a browser.
   */
  storage: () => KeyValueStore | null
  /**
   * Where an **in-flight sign-in's** single-use credentials live — the verifier,
   * the state, the returnTo, the shell reason and the silent-attempt guard.
   *
   * Defaults to {@link storage}, which is what Peek wants: one store for both.
   *
   * **Ship needs them separated, and that is why this exists.** Its session
   * belongs in `localStorage` so it outlives a tab, while the PKCE credentials
   * are per-tab by nature — the flow starts and ends in one tab, and the guard's
   * whole point is that a genuinely new tab is entitled to a fresh attempt.
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

export class SignInError extends Error {}

/** What a scheduled renewal reports back. Both optional; neither is required to be useful. */
export interface RenewalHandlers {
  /** A renewal succeeded. The session continues, on a later expiry. */
  onRenewed?: (token: StoredToken) => void
  /**
   * A renewal failed, and the session is over.
   *
   * The only honest thing an app can do here is drop to the shell. Note this
   * fires on refusal *and* on an unreachable network — `refreshAccessToken`
   * distinguishes them for the purpose of clearing the stored token, but from a
   * scheduler's point of view a renewal that did not happen is a renewal that
   * did not happen, and the shell's own probe is what sorts out which it was.
   */
  onEnded?: () => void
}

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
  const pending = config.pendingStore ?? config.storage
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
    const raw = config.storage()?.getItem(TOKEN_KEY)
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
    config.storage()?.removeItem(TOKEN_KEY)
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
   * Returns `null` for every failure, and the failures are not worth
   * distinguishing: Estiva ID answers `invalid_grant` for all of them by
   * design, and the caller's only move either way is to fall back to the
   * shell. The stored token is cleared on refusal so a spent refresh token is
   * never presented twice — a replay is what Estiva ID treats as theft.
   */
  const performRefresh = async (): Promise<StoredToken | null> => {
    const s = config.storage()
    const current = storedToken()
    if (!s || !current?.refreshToken) return null

    let response: Awaited<ReturnType<FetchLike>>
    try {
      response = await send()(new URL('/token', config.base).toString(), {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          grantType: 'refresh_token',
          refreshToken: current.refreshToken,
          clientId: config.clientId,
        }),
      })
    } catch {
      // Unreachable rather than refused. The token in hand may still be fine,
      // so this deliberately does not clear the session — a flaky network must
      // not sign somebody out.
      return null
    }

    if (!response.ok) {
      clearSession()
      return null
    }

    const body = (await response.json()) as TokenResponse
    if (!body.access_token) {
      clearSession()
      return null
    }

    const next = tokenFrom(body, body.pubkey ?? current.pubkey)
    s.setItem(TOKEN_KEY, JSON.stringify(next))
    return next
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
   */
  let refreshing: Promise<StoredToken | null> | null = null

  const refreshAccessToken = (): Promise<StoredToken | null> => {
    if (refreshing) return refreshing
    refreshing = performRefresh().finally(() => {
      refreshing = null
    })
    return refreshing
  }


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
      const sessionStore = config.storage()
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

      const response = await send()(new URL('/token', config.base).toString(), {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        // camelCase — see the file header.
        body: JSON.stringify({
          grantType: 'authorization_code',
          code,
          clientId: config.clientId,
          redirectUri: config.redirectUri(),
          codeVerifier: verifier,
        }),
      })

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
     * This is a known limitation rather than a bug, and it is recorded here so
     * it is not rediscovered once per app. It degrades safely: a late renewal is
     * still a valid renewal, because the refresh token outlives the access token
     * by a long way, and a call that beats the late timer gets the existing
     * `401`-and-retry path. What it must not do is renew *twice* in the scramble,
     * which is what the guard on `refreshAccessToken` is for.
     *
     * A `visibilitychange` listener that re-arms on foreground would tighten
     * this, and is deliberately not here: `document` is a global this package
     * does not touch (ADR 0002 §4a), and an app that wants it can `cancel()` and
     * call this again.
     */
    scheduleRenewal(handlers: RenewalHandlers = {}): RenewalSchedule {
      const setTimer = config.setTimer ?? ((run, ms) => setTimeout(run, ms))
      const clearTimer = config.clearTimer ?? ((handle) => clearTimeout(handle))

      let handle: unknown = null
      let cancelled = false

      const arm = (): void => {
        const token = storedToken()
        // Nothing to renew. Not an ending — the caller is simply signed out, and
        // an app that signs in later starts a new schedule.
        if (!token) return

        /*
          Clamped at both ends. A negative delay is a token that already expired
          — renew now rather than never, since the refresh token almost certainly
          has not. The ceiling is `setTimeout`'s: a delay above 2^31-1 ms
          overflows to a negative int32 and fires immediately, so a nonsensical
          `expires_in` would otherwise become a hot loop against `/token` instead
          of one very distant timer.
        */
        const delay = Math.min(Math.max(0, token.expiresAt - now()), MAX_TIMER_MS)

        handle = setTimer(() => {
          handle = null
          void refreshAccessToken().then((next) => {
            if (cancelled) return
            if (!next) {
              handlers.onEnded?.()
              return
            }
            handlers.onRenewed?.(next)
            // Re-armed from the *new* expiry rather than a fixed interval, so
            // the schedule follows whatever lifetime Estiva ID actually issued.
            arm()
          })
        }, delay)
      }

      arm()

      return {
        cancel(): void {
          cancelled = true
          if (handle !== null) {
            clearTimer(handle)
            handle = null
          }
        },
      }
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

/**
 * The PKCE client, and the five incidents it must keep surviving.
 *
 * Ported from `peek-app/src/auth/estivaId.test.ts` with SHA-4. The harness had to
 * change — the package is a factory taking injected storage, `fetch` and
 * `navigate`, where Peek's module reached for `sessionStorage` and
 * `window.location` directly — but every behaviour below is one Peek learned the
 * hard way, and the ticket lists each as an incident rather than a nicety.
 *
 * The injection is not test scaffolding that leaked into the API. It is there
 * because Peek and Ship genuinely differ on storage, redirect URI and client id;
 * that it also makes navigation observable is the happy consequence.
 */
import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import {
  type EstivaIdConfig,
  type KeyValueStore,
  GUARD_KEY,
  SignInError,
  createEstivaId,
  readGuard,
} from '../dist/index.js'

/** A `KeyValueStore` that is a plain object — which is the point of the interface. */
function memoryStore(): KeyValueStore & { dump: () => Record<string, string> } {
  const map = new Map<string, string>()
  return {
    getItem: (k) => map.get(k) ?? null,
    setItem: (k, v) => void map.set(k, v),
    removeItem: (k) => void map.delete(k),
    dump: () => Object.fromEntries(map),
  }
}

interface Harness {
  client: ReturnType<typeof createEstivaId>
  store: ReturnType<typeof memoryStore>
  navigated: string[]
  requests: Array<{ url: string; body: unknown }>
  reply: (body: unknown, init?: { ok?: boolean; status?: number }) => void
}

function harness(over: Partial<EstivaIdConfig> = {}): Harness {
  const store = memoryStore()
  const navigated: string[] = []
  const requests: Array<{ url: string; body: unknown }> = []
  let next: { body: unknown; ok: boolean; status: number } = { body: {}, ok: true, status: 200 }

  const client = createEstivaId({
    base: 'https://id.estiva.app',
    clientId: 'estiva-peek',
    redirectUri: () => 'https://peek.estiva.app/auth/callback',
    storage: () => store,
    keyPrefix: 'peek.estivaId',
    navigate: (url) => void navigated.push(url),
    now: () => 1_787_142_018_561,
    fetch: async (url, init) => {
      requests.push({ url, body: JSON.parse(init.body) })
      return { ok: next.ok, status: next.status, json: async () => next.body }
    },
    ...over,
  })

  return {
    client,
    store,
    navigated,
    requests,
    reply: (body, init = {}) => {
      next = { body, ok: init.ok ?? true, status: init.status ?? 200 }
    },
  }
}

const KEYS = {
  verifier: 'peek.estivaId.codeVerifier',
  state: 'peek.estivaId.state',
  returnTo: 'peek.estivaId.returnTo',
  token: 'peek.estivaId.token',
  reason: 'peek.estivaId.shellReason',
}

describe('leaving for Estiva ID', () => {
  it('sends exactly the parameters /authorize compares, and never a fragment', async () => {
    const h = harness()
    await h.client.beginSignIn('/topics/abc')
    assert.equal(h.navigated.length, 1)
    const url = new URL(h.navigated[0])
    assert.equal(url.origin + url.pathname, 'https://id.estiva.app/authorize')
    assert.equal(url.searchParams.get('client_id'), 'estiva-peek')
    // Exact-string compared upstream: a trailing slash is a refused sign-in.
    assert.equal(url.searchParams.get('redirect_uri'), 'https://peek.estiva.app/auth/callback')
    assert.equal(url.searchParams.get('response_type'), 'code')
    assert.equal(url.searchParams.get('code_challenge_method'), 'S256')
    assert.match(url.searchParams.get('code_challenge') ?? '', /^[A-Za-z0-9_-]{43}$/)
    assert.match(url.searchParams.get('state') ?? '', /^[A-Za-z0-9_-]+$/)
    assert.equal(url.hash, '')
  })

  it('stashes the verifier, state and returnTo together', async () => {
    const h = harness()
    await h.client.beginSignIn('/topics/abc')
    assert.match(h.store.getItem(KEYS.verifier) ?? '', /^[A-Za-z0-9_-]{43}$/)
    assert.ok(h.store.getItem(KEYS.state))
    assert.equal(h.store.getItem(KEYS.returnTo), '/topics/abc')
  })

  it('asks not to be prompted only when the attempt is silent (PEEK-117)', async () => {
    const loud = harness()
    await loud.client.beginSignIn('/')
    assert.equal(new URL(loud.navigated[0]).searchParams.get('prompt'), null)

    const silent = harness()
    await silent.client.beginSignIn('/', { silent: true })
    assert.equal(new URL(silent.navigated[0]).searchParams.get('prompt'), 'none')
  })

  /*
    PEEK-167, and the reason the guard is where it is. `codeChallenge` awaits a
    subtle-crypto digest between the storage writes and the navigation. If the
    guard were marked next to the navigation, a second boot landing in that window
    would see readGuard() === null, decide to probe too, and overwrite the
    verifier/state pair — after which the code comes back matched to a state that
    is gone, and completeSignIn refuses it before /token is ever called.
  */
  it('marks the silent guard synchronously with the writes, not at the navigation', async () => {
    const h = harness()
    const pending = h.client.beginSignIn('/', { silent: true })
    // Before the digest resolves and anything navigates, the guard is already set
    // — the window a second boot could have raced through is closed.
    assert.notEqual(readGuard(h.store), null, 'guard must be set before the await, not after')
    assert.equal(h.navigated.length, 0, 'and before the navigation, which is the whole point')
    await pending
    assert.equal(h.navigated.length, 1)
  })

  it('does not mark the guard for a loud attempt', async () => {
    const h = harness()
    await h.client.beginSignIn('/')
    assert.equal(readGuard(h.store), null)
  })
})

describe('coming back', () => {
  const started = async (h: Harness) => {
    await h.client.beginSignIn('/topics/abc')
    return { state: h.store.getItem(KEYS.state)! }
  }

  it('redeems the code with camelCase keys, which is genuinely the contract', async () => {
    const h = harness()
    const { state } = await started(h)
    // Captured before the call: `completeSignIn` spends the verifier before it
    // asks /token anything, which is the behaviour asserted two tests below.
    const verifier = h.store.getItem(KEYS.verifier)
    h.reply({ access_token: 'at', pubkey: 'b3'.repeat(32), expires_in: 3600, refresh_token: 'rt' })

    const { token, returnTo } = await h.client.completeSignIn(`?code=abc&state=${state}`)
    assert.equal(h.requests.length, 1)
    assert.equal(h.requests[0].url, 'https://id.estiva.app/token')
    assert.deepEqual(h.requests[0].body, {
      grantType: 'authorization_code',
      code: 'abc',
      clientId: 'estiva-peek',
      redirectUri: 'https://peek.estiva.app/auth/callback',
      codeVerifier: verifier,
    })
    assert.equal(token.accessToken, 'at')
    assert.equal(token.refreshToken, 'rt')
    assert.equal(returnTo, '/topics/abc')
  })

  it('is pessimistic about expiry by 30 seconds', async () => {
    const h = harness()
    const { state } = await started(h)
    h.reply({ access_token: 'at', pubkey: 'b3'.repeat(32), expires_in: 3600 })
    const { token } = await h.client.completeSignIn(`?code=abc&state=${state}`)
    // A token is never presented in the window where it is technically alive and
    // about to not be.
    assert.equal(token.expiresAt, 1_787_142_018_561 + (3600 - 30) * 1000)
  })

  it('refuses a code arriving with somebody else’s state', async () => {
    const h = harness()
    await started(h)
    // The one check that is not about ergonomics: this is the shape of a
    // login-CSRF, and it is refused outright.
    await assert.rejects(() => h.client.completeSignIn('?code=abc&state=not-mine'), SignInError)
    assert.equal(h.requests.length, 0, '/token must never be asked')
  })

  it('spends the verifier, state and returnTo before doing anything else', async () => {
    const h = harness()
    await started(h)
    await assert.rejects(() => h.client.completeSignIn('?code=abc&state=wrong'))
    // A failed attempt must not leave a verifier for a second code to be
    // redeemed against.
    for (const k of [KEYS.verifier, KEYS.state, KEYS.returnTo]) assert.equal(h.store.getItem(k), null)
  })

  it('says which side refused, because /token answers invalid_grant for everything', async () => {
    const h = harness()
    const { state } = await started(h)
    h.reply({}, { ok: false, status: 400 })
    await assert.rejects(
      () => h.client.completeSignIn(`?code=abc&state=${state}`),
      /expired — codes last 60 seconds/,
    )
  })

  it('surfaces an error parameter without pretending to exchange anything', async () => {
    const h = harness()
    await assert.rejects(() => h.client.completeSignIn('?error=login_required'), /login_required/)
    assert.equal(h.requests.length, 0)
  })

  it('clears the silent guard on success, so the next boot may probe again', async () => {
    const h = harness()
    await h.client.beginSignIn('/', { silent: true })
    const state = h.store.getItem(KEYS.state)!
    assert.notEqual(readGuard(h.store), null)
    h.reply({ access_token: 'at', pubkey: 'b3'.repeat(32) })
    await h.client.completeSignIn(`?code=abc&state=${state}`)
    assert.equal(readGuard(h.store), null)
    assert.equal(h.store.getItem(GUARD_KEY), null)
  })
})

describe('renewal (PEEK-108)', () => {
  const signedIn = (h: Harness, over: Record<string, unknown> = {}) => {
    h.store.setItem(
      KEYS.token,
      JSON.stringify({ accessToken: 'old', expiresAt: 1_787_142_999_999, pubkey: 'b3'.repeat(32), refreshToken: 'rt', ...over }),
    )
  }

  it('renews with the refresh grant and keeps the new token', async () => {
    const h = harness()
    signedIn(h)
    h.reply({ access_token: 'new', expires_in: 3600, refresh_token: 'rt2' })
    const next = await h.client.refreshAccessToken()
    assert.equal(next?.accessToken, 'new')
    assert.deepEqual(h.requests[0].body, { grantType: 'refresh_token', refreshToken: 'rt', clientId: 'estiva-peek' })
    // Single-use: Estiva ID rotates on every redemption and reads a replay as
    // theft, so the successor replaces its predecessor rather than sitting beside it.
    assert.equal(next?.refreshToken, 'rt2')
    assert.equal(h.client.storedToken()?.refreshToken, 'rt2')
  })

  it('does nothing at all without a refresh token', async () => {
    const h = harness()
    signedIn(h, { refreshToken: undefined })
    assert.equal(await h.client.refreshAccessToken(), null)
    assert.equal(h.requests.length, 0, 'a deployment that issues none must behave exactly as before')
  })

  it('clears the session when the grant is refused, so a spent token is never replayed', async () => {
    const h = harness()
    signedIn(h)
    h.reply({}, { ok: false, status: 400 })
    assert.equal(await h.client.refreshAccessToken(), null)
    assert.equal(h.store.getItem(KEYS.token), null)
  })

  it('does NOT clear the session when the network is merely unreachable', async () => {
    const h = harness({
      fetch: async () => {
        throw new Error('offline')
      },
    })
    signedIn(h)
    assert.equal(await h.client.refreshAccessToken(), null)
    // A flaky network must not sign somebody out — the token in hand may be fine.
    assert.notEqual(h.store.getItem(KEYS.token), null)
  })
})

describe('clearSession must not touch a sign-in in flight (PEEK-167)', () => {
  it('clears the token and the reason, and nothing else', async () => {
    const h = harness()
    await h.client.beginSignIn('/topics/abc')
    h.store.setItem(KEYS.token, JSON.stringify({ accessToken: 'at', expiresAt: 9e15, pubkey: 'b3'.repeat(32) }))
    h.client.stashShellReason('token_rejected')

    h.client.clearSession()

    assert.equal(h.store.getItem(KEYS.token), null)
    assert.equal(h.store.getItem(KEYS.reason), null)
    /*
      These three are not session state. They are the credentials of an
      authorization request currently in the air, owned by the beginSignIn that
      wrote them. Clearing them here destroyed a sign-in that was still happening:
      a boot renews, fails, clears, drops to the shell, the shell probes and writes
      a fresh verifier — then a second renewal awaiting the same promise resolves
      and clears again, deleting the verifier the probe just wrote. The code comes
      back with nothing to redeem it and /token is never asked, so the identity
      service has no record of a failure at all.
    */
    assert.ok(h.store.getItem(KEYS.verifier), 'the verifier belongs to the in-flight attempt')
    assert.ok(h.store.getItem(KEYS.state))
    assert.equal(h.store.getItem(KEYS.returnTo), '/topics/abc')
  })

  it('and only beginSignOut clears both, because it is the one caller that means it', async () => {
    const h = harness()
    await h.client.beginSignIn('/topics/abc')
    h.client.beginSignOut()
    for (const k of [KEYS.verifier, KEYS.state, KEYS.returnTo, KEYS.token]) {
      assert.equal(h.store.getItem(k), null)
    }
  })
})

describe('signing out actually signs out (PEEK-122)', () => {
  it('leaves for /logout with both parameters, because the cookie is only reachable there', () => {
    const h = harness()
    h.client.beginSignOut()
    const url = new URL(h.navigated[0])
    assert.equal(url.origin + url.pathname, 'https://id.estiva.app/logout')
    assert.equal(url.searchParams.get('client_id'), 'estiva-peek')
    assert.equal(url.searchParams.get('post_logout_redirect_uri'), 'https://peek.estiva.app/auth/callback')
  })

  it('stashes no_session first, so the shell offers a passkey instead of probing', () => {
    const h = harness()
    h.client.beginSignOut()
    // Read after the fact: stashShellReason wrote it, and takeShellReason is
    // single-use, so this both checks the value and proves it survives the call.
    assert.equal(h.client.takeShellReason(), 'no_session')
    assert.equal(h.client.takeShellReason(), null, 'and a reason is read exactly once')
  })
})

describe('reading the session', () => {
  it('offers a token only while it is still valid', () => {
    const h = harness()
    h.store.setItem(KEYS.token, JSON.stringify({ accessToken: 'at', expiresAt: 1_787_142_018_000, pubkey: 'p' }))
    assert.equal(h.client.validToken(), null, 'expired 561ms before now()')
    assert.equal(h.client.hasSession(), false)
    assert.equal(h.client.currentAccessToken(), undefined)

    h.store.setItem(KEYS.token, JSON.stringify({ accessToken: 'at', expiresAt: 1_787_142_999_999, pubkey: 'p' }))
    assert.equal(h.client.validToken()?.accessToken, 'at')
    assert.equal(h.client.hasSession(), true)
    assert.equal(h.client.currentAccessToken(), 'at')
  })

  it('treats a corrupt or half-written token as no token', () => {
    const h = harness()
    for (const bad of ['not json', '{}', '{"accessToken":"at"}', '{"expiresAt":9e15}']) {
      h.store.setItem(KEYS.token, bad)
      assert.equal(h.client.storedToken(), null, `"${bad}" must not read as a session`)
    }
  })

  it('answers hasPendingSignIn from either half of the pair', async () => {
    const h = harness()
    assert.equal(h.client.hasPendingSignIn(), false)
    await h.client.beginSignIn('/')
    assert.equal(h.client.hasPendingSignIn(), true)
    h.store.removeItem(KEYS.state)
    assert.equal(h.client.hasPendingSignIn(), false)
  })

  it('takes returnTo exactly once, including on the refusal path (PEEK-123)', async () => {
    const h = harness()
    await h.client.beginSignIn('/deep/link')
    assert.equal(h.client.takeReturnTo(), '/deep/link')
    assert.equal(h.client.takeReturnTo(), null)
  })
})

describe('the injection seams are real differences, not test scaffolding', () => {
  it('namespaces keys by prefix, so two apps on one origin cannot read each other', async () => {
    const store = memoryStore()
    const ship = createEstivaId({
      base: 'https://id.estiva.app',
      clientId: 'estiva-ship',
      redirectUri: () => 'https://ship.estiva.app/',
      storage: () => store,
      keyPrefix: 'ship.estiva-id',
      navigate: () => {},
      now: () => 1,
    })
    await ship.beginSignIn('#/p/abc')
    assert.ok(store.getItem('ship.estiva-id.codeVerifier'))
    assert.equal(store.getItem('peek.estivaId.codeVerifier'), null)
  })

  it('never hardcodes a client id or a redirect uri', async () => {
    const h = harness({ clientId: 'estiva-ship', redirectUri: () => 'https://ship.estiva.app/' })
    await h.client.beginSignIn('#/')
    const url = new URL(h.navigated[0])
    assert.equal(url.searchParams.get('client_id'), 'estiva-ship')
    assert.equal(url.searchParams.get('redirect_uri'), 'https://ship.estiva.app/')
  })

  it('refuses to navigate rather than reaching for a global', async () => {
    const h = harness({ navigate: undefined })
    await assert.rejects(() => h.client.beginSignIn('/'), /navigate is required/)
  })

  it('survives having no storage at all, which is what a non-browser is', () => {
    const nowhere = createEstivaId({
      base: 'https://id.estiva.app',
      clientId: 'estiva-peek',
      redirectUri: () => 'https://peek.estiva.app/auth/callback',
      storage: () => null,
      keyPrefix: 'peek.estivaId',
      navigate: () => {},
    })
    assert.equal(nowhere.storedToken(), null)
    assert.equal(nowhere.hasSession(), false)
    assert.equal(nowhere.hasPendingSignIn(), false)
    assert.equal(nowhere.takeReturnTo(), null)
    assert.doesNotThrow(() => nowhere.clearSession())
  })
})

describe('two stores, because the second consumer needed two', () => {
  /*
    The package assumed a single store, because it was extracted from Peek, which
    uses one. Ship keeps its session in localStorage so it outlives a tab, and its
    in-flight PKCE credentials in sessionStorage because the flow starts and ends
    in one tab. That is the "comes out shaped like the app it came from" failure
    SHA-4 names, and wiring the second consumer is the mechanism SHA-4 prescribes
    for finding it. These tests are what that finding left behind.
  */
  const split = () => {
    const session = memoryStore()
    const pendingStore = memoryStore()
    const navigated: string[] = []
    const client = createEstivaId({
      base: 'https://id.estiva.app',
      clientId: 'estiva-ship',
      redirectUri: () => 'https://ship.estiva.app/',
      storage: () => session,
      pendingStore: () => pendingStore,
      keyPrefix: 'ship.estiva-id',
      navigate: (url) => void navigated.push(url),
      now: () => 1_787_142_018_561,
      fetch: async () => ({ ok: true, status: 200, json: async () => ({ access_token: 'at', pubkey: 'b3'.repeat(32), expires_in: 3600 }) }),
    })
    return { client, session, pendingStore, navigated }
  }

  it('puts the in-flight credentials in the pending store and nothing else there', async () => {
    const s = split()
    await s.client.beginSignIn('#/p/abc', { silent: true })
    for (const k of ['ship.estiva-id.codeVerifier', 'ship.estiva-id.state', 'ship.estiva-id.returnTo']) {
      assert.ok(s.pendingStore.getItem(k), `${k} belongs to the in-flight attempt`)
      assert.equal(s.session.getItem(k), null, `${k} must NOT be in the session store`)
    }
    // The guard is per-tab for the same reason: a genuinely new tab is entitled
    // to a fresh silent attempt.
    assert.notEqual(readGuard(s.pendingStore), null)
    assert.equal(readGuard(s.session), null)
  })

  it('puts the session in the session store, so it can outlive a tab', async () => {
    const s = split()
    await s.client.beginSignIn('#/p/abc')
    const state = s.pendingStore.getItem('ship.estiva-id.state')!
    await s.client.completeSignIn(`?code=abc&state=${state}`)
    assert.ok(s.session.getItem('ship.estiva-id.token'), 'the token belongs to the durable store')
    assert.equal(s.pendingStore.getItem('ship.estiva-id.token'), null)
    assert.equal(s.client.validToken()?.accessToken, 'at')
  })

  it('clearSession drops the token without touching the in-flight attempt', async () => {
    const s = split()
    await s.client.beginSignIn('#/p/abc')
    s.session.setItem('ship.estiva-id.token', JSON.stringify({ accessToken: 'at', expiresAt: 9e15, pubkey: 'p' }))
    s.client.clearSession()
    assert.equal(s.session.getItem('ship.estiva-id.token'), null)
    // PEEK-167 across two stores: the separation has to survive the split, or the
    // split reintroduces exactly the bug the separation exists to prevent.
    assert.ok(s.pendingStore.getItem('ship.estiva-id.codeVerifier'))
    assert.ok(s.pendingStore.getItem('ship.estiva-id.state'))
  })

  /*
    The control. Without it, every test above would pass on a package that quietly
    ignored `pendingStore` and wrote everything to `storage` — the two stores would
    simply be the same store as far as the assertions could tell.
  */
  it('CONTROL: defaults pendingStore to storage, so Peek still gets one store', async () => {
    const only = memoryStore()
    const client = createEstivaId({
      base: 'https://id.estiva.app',
      clientId: 'estiva-peek',
      redirectUri: () => 'https://peek.estiva.app/auth/callback',
      storage: () => only,
      keyPrefix: 'peek.estivaId',
      navigate: () => {},
      now: () => 1,
    })
    await client.beginSignIn('/topics/abc')
    // One store holds both, which is what Peek asked for and what the package did
    // before `pendingStore` existed.
    assert.ok(only.getItem('peek.estivaId.codeVerifier'))
    only.setItem('peek.estivaId.token', JSON.stringify({ accessToken: 'at', expiresAt: 9e15, pubkey: 'p' }))
    assert.equal(client.validToken()?.accessToken, 'at')
  })
})

/*
  The renewal guard, and the schedule that leans on it.

  Both are SHA-4 "hard-won behaviour that must survive" items that did NOT
  survive the first pass, for the same reason: they lived in
  `peek-app/src/auth/useEstivaIdAuth.ts` — the Convex adapter, which is
  deliberately the one file that stays out of this package — rather than in the
  client. So Peek kept them and Ship, the second consumer whose whole purpose was
  to catch exactly this, silently did not get them.
*/
const NOW = 1_787_142_018_561
/** `signedIn` above uses this expiry; the delay it implies is 981,438 ms. */
const EXPIRES_AT = 1_787_142_999_999

function seedSession(h: Harness, over: Record<string, unknown> = {}): void {
  h.store.setItem(
    KEYS.token,
    JSON.stringify({ accessToken: 'old', expiresAt: EXPIRES_AT, pubkey: 'b3'.repeat(32), refreshToken: 'rt', ...over }),
  )
}

/** Timers as data, so a test can read what was scheduled instead of waiting for it. */
function fakeTimers() {
  const armed: Array<{ id: number; run: () => void; ms: number }> = []
  const cleared: unknown[] = []
  let nextId = 1
  return {
    armed,
    cleared,
    setTimer: (run: () => void, ms: number): unknown => {
      const id = nextId++
      armed.push({ id, run, ms })
      return id
    },
    clearTimer: (handle: unknown): void => void cleared.push(handle),
    /** Run the timer armed most recently. */
    fire: (): void => armed[armed.length - 1].run(),
  }
}

describe('two renewals are never in the air at once', () => {
  it('coalesces concurrent callers into ONE call to /token', async () => {
    const h = harness()
    seedSession(h)
    h.reply({ access_token: 'new', expires_in: 3600, refresh_token: 'rt2' })

    const [a, b] = await Promise.all([h.client.refreshAccessToken(), h.client.refreshAccessToken()])

    /*
      The whole point. A refresh token is single-use and Estiva ID reads a replay
      as theft, revoking the chain — so a second POST here does not merely waste a
      round trip, it signs the person out of everything. Two callers is not
      hypothetical: Ship signs the NIP-98 auth event and the content event as
      separate `POST /sign` calls, and a token that expires between them answers
      401 to both.
    */
    assert.equal(h.requests.length, 1, 'a replayed refresh token is read as theft')
    assert.equal(a?.accessToken, 'new')
    assert.equal(b?.accessToken, 'new', 'the second caller gets the same answer, not null')
  })

  it('does not cache — the NEXT expiry renews again', async () => {
    /*
      The control. A guard that held the promise forever would pass the test
      above and be a worse bug than the one it fixed: the session would never
      renew a second time and would die at the first expiry it was supposed to
      survive.
    */
    const h = harness()
    seedSession(h)
    h.reply({ access_token: 'new', expires_in: 3600, refresh_token: 'rt2' })
    await h.client.refreshAccessToken()
    await h.client.refreshAccessToken()
    assert.equal(h.requests.length, 2)
  })
})

describe('renewing before expiry rather than reacting to it', () => {
  it('arms a timer for the moment the token expires', () => {
    const t = fakeTimers()
    const h = harness({ setTimer: t.setTimer, clearTimer: t.clearTimer })
    seedSession(h)

    h.client.scheduleRenewal()

    assert.equal(t.armed.length, 1)
    // `tokenFrom` already subtracted 30s when it stored this, so the timer fires
    // while the token is still good — which is what makes the renewal invisible.
    assert.equal(t.armed[0].ms, EXPIRES_AT - NOW)
  })

  it('renews when it fires, and re-arms from the NEW expiry', async () => {
    const t = fakeTimers()
    const h = harness({ setTimer: t.setTimer, clearTimer: t.clearTimer })
    seedSession(h)
    h.reply({ access_token: 'new', expires_in: 3600, refresh_token: 'rt2' })

    let renewed: (token: unknown) => void = () => {}
    const done = new Promise<unknown>((resolve) => (renewed = resolve))
    h.client.scheduleRenewal({ onRenewed: renewed })

    t.fire()
    await done

    assert.equal(h.requests.length, 1)
    assert.equal(h.client.storedToken()?.accessToken, 'new')
    assert.equal(t.armed.length, 2, 'a renewal that does not re-arm renews exactly once')
    // 3600s less the 30s `tokenFrom` holds back. Read off the new token rather
    // than a fixed interval, so the schedule follows whatever Estiva ID issued.
    assert.equal(t.armed[1].ms, (3600 - 30) * 1000)
  })

  it('ends the session on a failed renewal, and stops', async () => {
    const t = fakeTimers()
    const h = harness({ setTimer: t.setTimer, clearTimer: t.clearTimer })
    seedSession(h)
    h.reply({}, { ok: false, status: 400 })

    let ended: () => void = () => {}
    const done = new Promise<void>((resolve) => (ended = resolve))
    h.client.scheduleRenewal({ onEnded: ended })

    t.fire()
    await done

    assert.equal(t.armed.length, 1, 'a dead session must not keep asking')
    assert.equal(h.store.getItem(KEYS.token), null)
  })

  it('renews immediately when the token has already expired', () => {
    const t = fakeTimers()
    const h = harness({ setTimer: t.setTimer, clearTimer: t.clearTimer })
    seedSession(h, { expiresAt: NOW - 60_000 })

    h.client.scheduleRenewal()

    // Late is not never. The refresh token outlives the access token by a long
    // way, so a tab whose timers were throttled in the background renews on the
    // way back rather than dropping somebody to the shell.
    assert.equal(t.armed[0].ms, 0)
  })

  it('clamps a nonsensical expiry instead of hot-looping', () => {
    const t = fakeTimers()
    const h = harness({ setTimer: t.setTimer, clearTimer: t.clearTimer })
    seedSession(h, { expiresAt: NOW + 10 * 365 * 24 * 3600 * 1000 })

    h.client.scheduleRenewal()

    // Above 2^31-1 ms a setTimeout delay overflows to a negative int32 and fires
    // immediately — which would turn one very distant timer into a hot loop
    // against /token.
    assert.equal(t.armed[0].ms, 2_147_483_647)
  })

  it('does nothing at all when there is no session to renew', () => {
    const t = fakeTimers()
    const h = harness({ setTimer: t.setTimer, clearTimer: t.clearTimer })

    h.client.scheduleRenewal()

    assert.equal(t.armed.length, 0, 'signed out is not an ending, it is a starting condition')
  })

  it('cancel stops the timer, and a renewal that lands after it reports nothing', async () => {
    const t = fakeTimers()
    const h = harness({ setTimer: t.setTimer, clearTimer: t.clearTimer })
    seedSession(h)
    h.reply({ access_token: 'new', expires_in: 3600, refresh_token: 'rt2' })

    let renewals = 0
    const schedule = h.client.scheduleRenewal({ onRenewed: () => void renewals++ })
    t.fire()
    schedule.cancel()
    await new Promise((resolve) => setTimeout(resolve, 0))

    assert.deepEqual(t.cleared, [], 'the timer had already fired; there is no handle left to clear')
    assert.equal(renewals, 0, 'a cancelled schedule does not report a renewal it no longer owns')
    assert.equal(t.armed.length, 1, 'and does not re-arm')
  })

  it('cancel before the timer fires clears the handle', () => {
    const t = fakeTimers()
    const h = harness({ setTimer: t.setTimer, clearTimer: t.clearTimer })
    seedSession(h)

    h.client.scheduleRenewal().cancel()

    assert.deepEqual(t.cleared, [1])
  })
})

/*
  Where the expiry comes from, and the stuck state it caused.

  `expires_in` is a duration, so acting on it means trusting the local clock;
  the service decides with the token's own `exp` against its own clock. When
  those disagree in the unsafe direction the app holds a token it believes is
  live and every server refuses, and — this is the part that made it a dead end
  rather than a hiccup — `validToken` kept handing that same token to every
  caller, so nothing renewed and nothing recovered.

  Peek reached this overnight on a machine that had slept. `POST /sign` answered
  `401 Invalid token: "exp" claim timestamp check failed` while the app showed
  the `token_rejected` shell, which says signing in again will not help. Clearing
  site data was the only way out.
*/
const b64url = (o: unknown) => Buffer.from(JSON.stringify(o)).toString('base64url')
/** A token shaped like a real one: three dot-separated segments, unpadded base64url. */
const jwt = (claims: Record<string, unknown>) => `${b64url({ alg: 'EdDSA' })}.${b64url(claims)}.signature`

describe('the expiry is the token’s own, not the clock’s', () => {
  const refreshInto = async (h: Harness, body: Record<string, unknown>) => {
    h.store.setItem(
      KEYS.token,
      JSON.stringify({ accessToken: 'old', expiresAt: EXPIRES_AT, pubkey: 'b3'.repeat(32), refreshToken: 'rt' }),
    )
    h.reply(body)
    return h.client.refreshAccessToken()
  }

  it('takes exp when exp is the earlier bound — the clock-ahead case', async () => {
    const h = harness()
    // exp 60s out, but expires_in claims 600. A browser clock running ahead of
    // the service produces exactly this, and it is the direction that hurts.
    const next = await refreshInto(h, { access_token: jwt({ exp: NOW / 1000 + 60 }), expires_in: 600 })
    assert.equal(next?.expiresAt, NOW + 30_000, 'exp minus the 30s hold-back')
  })

  it('takes expires_in when THAT is the earlier bound', async () => {
    const h = harness()
    const next = await refreshInto(h, { access_token: jwt({ exp: NOW / 1000 + 3600 }), expires_in: 60 })
    assert.equal(next?.expiresAt, NOW + 30_000, 'expires_in minus the 30s hold-back')
  })

  it('falls back to expires_in for a token carrying no readable exp', async () => {
    // The control: an opaque token, or one from a service that does not set the
    // claim, must behave exactly as it did before this existed.
    const h = harness()
    assert.equal((await refreshInto(h, { access_token: 'opaque', expires_in: 600 }))?.expiresAt, NOW + 570_000)
    const noClaim = harness()
    assert.equal((await refreshInto(noClaim, { access_token: jwt({ sub: 'x' }), expires_in: 600 }))?.expiresAt, NOW + 570_000)
  })

  it('holds a token whose payload will not parse, rather than refusing it', async () => {
    // A token this cannot read is still a token. Refusing to hold one because
    // its middle segment is not base64url would be worse than what it prevents.
    const h = harness()
    const next = await refreshInto(h, { access_token: 'a.!!!not-base64!!!.c', expires_in: 600 })
    assert.equal(next?.accessToken, 'a.!!!not-base64!!!.c')
    assert.equal(next?.expiresAt, NOW + 570_000)
  })

  it('never hands out a token the service has already expired', async () => {
    /*
      The regression, stated as the thing that actually went wrong. Before this,
      an `exp` in the past with a generous `expires_in` produced a stored token
      that `validToken` returned happily — so Convex refused it, the shell
      declared a configuration fault, and `fetchAccessToken` answered every
      retry with the same dead token.
    */
    const h = harness()
    const next = await refreshInto(h, { access_token: jwt({ exp: NOW / 1000 - 3600 }), expires_in: 600 })
    assert.ok(next, 'the token is still stored — this is not a refusal')
    assert.equal(h.client.validToken(), null, 'but it is never offered to a caller')
    assert.ok(h.client.storedToken(), 'and it is still there for a renewal to replace')
  })
})

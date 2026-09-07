# @estiva-app/identity

## 0.1.2 — 2026-09-07

**No wire behaviour, no break.** `scheduleRenewal` is new and the guard on
`refreshAccessToken` only prevents a call that should never have been made, so a
consumer on `^0.1.0` needs no change — ADR 0002 §4b puts the break on MINOR
within `0.x`.

Two of SHA-4's five "hard-won behaviour that must survive" items did not, in
fact, survive — and both for the same reason. They lived in
`peek-app/src/auth/useEstivaIdAuth.ts`, the `ConvexProviderWithAuth` adapter,
which is deliberately the one file kept *out* of this package. So Peek kept them
and Ship, the second consumer whose entire purpose was to catch exactly this,
silently did not get them. Wiring a second consumer proves a package is not
shaped like the first app; it does not prove the first app handed everything
over.

- **`refreshAccessToken` now coalesces concurrent callers.** A refresh token is
  single-use and Estiva ID reads a replay as theft, revoking the whole chain — so
  two renewals in the air at once do not waste a round trip, they sign somebody
  out of everything. Two callers is not hypothetical: Ship signs the NIP-98 auth
  event and the content event as separate `POST /sign` calls, and a token that
  expires between them answers `401` to both, each of which renews.

  Peek has had this since PEEK-108 as a `refreshing` ref in its hook. Ship has
  never had it. It belongs here, where every caller of every consumer gets it
  without having thought about it. Coalescing, not caching: the promise is
  dropped the moment it settles, and a test asserts the *next* expiry renews
  again — a guard that held the promise forever would pass the first test and be
  a worse bug than the one it fixed.

- **`scheduleRenewal(handlers)` renews before expiry rather than reacting to
  it.** `tokenFrom` has always stored an expiry 30 seconds early; nothing in the
  package acted on it. Reacting to expiry means somebody's next action is what
  discovers the session ended. Renewing early means they notice nothing, which
  is the whole point of PEEK-108.

  The timer is injected (`setTimer`/`clearTimer`) for the same reason `fetch` and
  `navigate` are: "we scheduled it" and "we did nothing" are otherwise the same
  observation. The handle type never reaches the published `.d.ts` — it is
  `number` in a browser and an object in Node, and naming either fails
  `check-identity.yml`, correctly.

  **Known limitation, documented here rather than rediscovered per app:** a
  `setTimeout` is throttled in a background tab — to once a minute in Chrome and
  Safari, and frozen outright after five minutes hidden — so a backgrounded tab
  can miss its window. It degrades safely, because the refresh token long
  outlives the access token: a late renewal is still a renewal, and anything that
  beats the timer takes the existing `401`-and-retry path. The guard above is
  what stops the two racing.

## 0.1.1 — 2026-08-28

**No wire behaviour**, and no break: `pendingStore` is optional and defaults to
`storage`, so a consumer on `^0.1.0` needs no change. Additive, so a PATCH —
ADR 0002 §4b puts the break on MINOR within `0.x`.

- **`pendingStore`**, a second storage seam. Wiring Ship — the second consumer —
  found that the package assumed **one** store because it was extracted from
  Peek, which uses one. Ship uses two, with different lifetimes on purpose: its
  *session* lives in `localStorage` so it outlives a tab, and its *in-flight PKCE
  credentials* live in `sessionStorage` because the flow starts and ends in one
  tab, which is also why the silent-attempt guard belongs there.

  This is the exact "a library pulled from one app comes out shaped like that
  app" failure SHA-4 names, found by the mechanism SHA-4 prescribes for finding
  it. The ticket said wiring Ship was the point rather than a formality; it was
  right, and this is what it caught.

  `clearSession` now spans both stores — the token from `storage`, the shell
  reason from `pendingStore` — while still leaving the verifier, state and
  returnTo alone. PEEK-167's separation had to survive the split, or the split
  would have reintroduced the bug the separation exists to prevent. A test
  asserts exactly that, and a control asserts the single-store default still
  behaves as Peek expects, so none of it can pass on a package that quietly
  ignores the new parameter.

## 0.1.0 — 2026-08-27

First release. SHA-4, extracted during REW-2.

**No wire behaviour.** This package publishes no events. It obtains and holds a
token; `@estiva-app/protocol` is what turns intent into bytes.

The PKCE flow, token storage and validity, silent renewal, sign-out, the returnTo
and shell-reason vocabulary, and the auth-shell state machine. Extracted from
Peek, which was ahead of Ship: Ship had no shell-reason vocabulary at all, so
this is an upgrade for Ship rather than a port of it.

### What is deliberately not here

- **Any app's data layer.** Peek's `useEstivaIdAuth.ts` — the
  `ConvexProviderWithAuth` adapter — stays in Peek. If it were here, Ship and
  every future app would inherit a Convex dependency to work around. Ship needing
  no adapter at all is the test that the line held, and CI enforces it.
- **The shell's rendering.** A full-page surface each app will want its own of.
  Shared is the state machine and the reason vocabulary, which is where the
  expensive mistakes live — and keeping components out also keeps this package
  clear of `@estiva-app/ui`, whose entry would trigger ADR 0002 §2's rule about
  folding `ui` back into the foundation repo.

### Five behaviours that are each an incident, not a nicety

Every one is covered by a test that travelled with the code:

- **`clearSession` must not touch a sign-in in flight (PEEK-167).** The verifier,
  state and returnTo belong to an authorization request currently in the air.
  Clearing them on somebody else's schedule destroys a sign-in that is still
  happening, and the failure surfaces as an `exchange_failed` for a code that was
  never presented to `/token` — so the identity service has no record of it.
- **The silent guard is marked synchronously with those writes**, not next to the
  navigation. `codeChallenge` awaits a digest in between, and that window is long
  enough for a second boot to decide to probe as well.
- **`token_rejected` never reads as "session expired".** Telling somebody their
  session expired when their token was refused for a configuration fault sends
  them to re-authenticate against a wall.
- **Refresh tokens are single-use and a replay is treated as theft.** The stored
  token is cleared when the grant is *refused*, and deliberately not when the
  network is merely unreachable — a flaky connection must not sign somebody out.
- **Clearing the local token is not signing out (PEEK-122).** The
  `estiva_id_session` cookie on the identity origin survives it, so the next
  silent probe puts the person straight back in. Real sign-out navigates to
  `/logout`.

### A prediction this package falsified

The expectation on record, from having just done `@estiva-app/protocol`, was that
identity could not follow ADR 0002 §4a as cleanly — that being browser-shaped
throughout, it would need `lib: dom` and a looser rule.

It did not need either. Details in the README; the short version is that a browser
API an app must inject is also a browser API a test can observe.

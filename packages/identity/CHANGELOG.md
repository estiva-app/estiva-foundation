# @estiva-app/identity

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

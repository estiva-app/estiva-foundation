# @estiva-app/identity

Signing in with Estiva ID: authorization code + PKCE, token storage, silent
renewal, sign-out, and the auth-shell state machine.

```bash
npm install @estiva-app/identity
```

No runtime dependencies. CI enforces that.

## The seam this package exists for

**In:** everything that decides *whether somebody is signed in* and *what to say
when they are not*.

**Not in: any app's data layer.** `peek-app/src/auth/useEstivaIdAuth.ts` is the
adapter `ConvexProviderWithAuth` reads, and it stays in Peek. If it were here,
Ship and every future app would inherit a Convex dependency to work around —
which is precisely the failure SHA-4's sequencing exists to avoid.

**Ship needing no adapter at all is the test that the line held.** It hands the
token straight to its relay client.

**Not in: the shell's rendering.** A full-page surface each app wants its own of.
Shared is the state machine and the reason vocabulary. That also keeps this
package clear of `@estiva-app/ui` — ADR 0002 §2 names identity depending on `ui`
as the trigger that folds `ui` back into the foundation repo, and that should be
a decision somebody makes rather than one a sign-in screen makes by accident.

## Every difference between the consumers is a parameter

The package is a factory, not a module of free functions, because Peek and Ship
genuinely differ on every one of these — and hardcoding any would have made the
package come out Peek-shaped, which is the whole risk SHA-4 names.

| injected | Peek | Ship |
| --- | --- | --- |
| `clientId` | `estiva-peek` | `estiva-ship` |
| `redirectUri` | a fixed `/auth/callback` | its current pathname — Ship routes on `location.hash` |
| `storage` — the session | `sessionStorage`, dies with the tab | `localStorage`, outlives a tab |
| `pendingStore` — in-flight PKCE credentials | defaults to `storage` | `sessionStorage`, because the flow starts and ends in one tab |
| `keyPrefix` | `peek.estivaId` | `ship.estiva-id` |
| `navigate` | the one genuinely untestable act, so it is observable |  |

**Do not unify the two stores.** NIP-RS read-state slots (CRO-4) must survive a
restart and belong in `localStorage`; an access token does not. Different
lifetimes, different homes.

`pendingStore` exists because wiring the second consumer found the package
assuming one store — it was extracted from Peek, which uses one. That is the "a
library pulled from one app comes out shaped like that app" failure SHA-4 names,
caught by the mechanism SHA-4 prescribes. Worth knowing as evidence that the
second-consumer rule earns its keep rather than being ceremony.

An app instantiates once and re-exports its own names, so call sites do not churn:

```ts
const client = createEstivaId({
  base: ESTIVA_ID_ORIGIN,
  clientId: 'estiva-peek',
  redirectUri: () => `${window.location.origin}/auth/callback`,
  storage: () => (typeof window === 'undefined' ? null : window.sessionStorage),
  keyPrefix: 'peek.estivaId',
  navigate: (url) => window.location.assign(url),
})
export const { validToken, beginSignIn, completeSignIn, beginSignOut } = client
```

## The prediction this package falsified

Before starting, the expectation on the ticket was that identity **could not**
follow ADR 0002 §4a as cleanly as `@estiva-app/protocol` did — that being
browser-shaped throughout, it would need `lib: dom`, and that the ADR would need
amending to say so.

That was wrong, and it is worth saying why rather than quietly not mentioning it:

- `crypto`, `btoa`, `TextEncoder`, `URL`, `URLSearchParams`, `fetch` and `console`
  are declared inside the modules that use them and read inside function bodies.
- The DOM's `Storage` became a local `KeyValueStore` interface. `sessionStorage`,
  `localStorage` and a plain object all satisfy it structurally, and the published
  declarations name no ambient type.
- Navigation is a **required** `navigate` callback rather than a `location` reach.

So the package builds with `types: []` and no `lib: dom`, exactly as `protocol`
does, and a test can import it with every browser global deleted. CI asserts both.

The thing that made it possible was not cleverness. It was that **a browser API an
app must inject is also a browser API a test can observe** — the seams §4a forces
and the seams a test wants are the same seams. Worth remembering before assuming
the next browser-shaped package needs an exemption.

`@estiva-app/ui` is still the counter-example: it ships `.d.ts` files naming
`HTMLButtonElement`, and gets away with it only because both its consumers are
browser apps.

## Releasing

```bash
git tag identity@0.1.1 && git push origin identity@0.1.1
```

The **first** publish is manual and once-ever, because a trusted publisher is
configured on a package that already exists — ADR 0002 §4c, §7. Every release
after it is a tag.

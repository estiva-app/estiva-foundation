/**
 * `@estiva-app/identity` — signing in with Estiva ID, once.
 *
 * ## What is in here, and what is deliberately not
 *
 * **In:** the PKCE flow, token storage and validity, silent renewal, sign-out,
 * the returnTo and shell-reason vocabulary, and the auth-shell state machine.
 * Everything that decides *whether somebody is signed in* and *what to say when
 * they are not*.
 *
 * **Not in: any app's data layer.** `peek-app/src/auth/useEstivaIdAuth.ts` is the
 * adapter Convex's `ConvexProviderWithAuth` reads, and it stays in Peek. If it
 * were here, Ship and every future app would inherit a Convex dependency to work
 * around — which is precisely the failure this package's sequencing exists to
 * avoid. Ship needs no adapter at all: it hands the token straight to its relay
 * client, and that is the test that the line held.
 *
 * **Not in: the shell's rendering.** It is a full-page surface and each app will
 * want its own. What is shared is the state machine and the reason vocabulary,
 * which is where the expensive mistakes live. This also keeps the package clear
 * of `@estiva-app/ui` — ADR 0002 §2 names identity depending on ui as the trigger
 * that folds ui back into the foundation repo, and that should be a decision
 * rather than a discovery.
 *
 * ## Every difference between the two consumers is a parameter
 *
 * `clientId`, `redirectUri`, `storage`, `keyPrefix` and `navigate` are all
 * injected, because Peek and Ship genuinely differ on every one of them and
 * hardcoding any would have made the package come out Peek-shaped. See
 * `client.ts` for what each difference actually is.
 *
 * ## The globals prediction this package falsified
 *
 * Before starting, the expectation on record was that identity could not follow
 * ADR 0002 §4a as cleanly as `@estiva-app/protocol` did — that being
 * browser-shaped throughout, it would need `lib: dom` and a looser rule.
 *
 * It did not. `crypto`, `btoa`, `TextEncoder`, `URL`, `URLSearchParams`, `fetch`
 * and `console` are declared inside the modules that use them and read inside
 * function bodies; the DOM's `Storage` became a local `KeyValueStore` interface
 * that `sessionStorage` and `localStorage` both satisfy structurally; and
 * navigation is a required `navigate` callback rather than a `location` reach.
 * The published declarations name no ambient global, and the package builds with
 * `types: []` and no `lib: dom` exactly as `protocol` does.
 *
 * The thing that made it possible was not cleverness — it was that a browser API
 * an app must inject is also a browser API a test can observe.
 */
export const IDENTITY_VERSION = '0.1.1'

export {
  type KeyValueStore,
  type ShellPhase,
  type ShellReason,
  type ShellState,
  type BootObservation,
  type BootAction,
  type ShellEvent,
  isRecoverable,
  SHELL_COPY,
  CONTINUE_LABEL,
  RETRY_LABEL,
  PROBE_TIMEOUT_MS,
  GUARD_TTL_MS,
  GUARD_KEY,
  decideBoot,
  reasonForCallbackError,
  readGuard,
  markGuard,
  clearGuard,
  logShellEvent,
} from './shell.js'

export {
  type EstivaIdConfig,
  type EstivaIdClient,
  type StoredToken,
  type FetchLike,
  SignInError,
  createEstivaId,
} from './client.js'

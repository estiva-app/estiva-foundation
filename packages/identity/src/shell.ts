/**
 * The auth shell's contract: what a boot may conclude, and what to say about it.
 *
 * Pure decision logic and vocabulary. No I/O, no globals, no rendering — the
 * shell's *appearance* stays in each app, because it is a full-page surface and
 * each app will want its own. What is shared is the state machine and the
 * reason vocabulary, which is where the expensive mistakes live.
 *
 * ## This file was duplicated verbatim, and said so
 *
 * Until SHA-4 it existed twice — `peek-app/src/auth/shell/contract.ts` and
 * `estiva-ship/lib/auth/shell/contract.ts` — and each copy's header pointed at
 * the other. They were byte-identical apart from that sentence, which is a file
 * asking to be a package. Now it is one, and the claim is true by construction
 * rather than by discipline.
 *
 * ## Why `token_rejected` is not "session expired"
 *
 * The distinction below is load-bearing and asserted by a test that travelled
 * here with the code. Telling somebody their session expired when their token
 * was refused for a *configuration* fault sends them to re-authenticate against
 * a wall: they will succeed at signing in and fail in exactly the same way, and
 * nothing in the message points at the real cause.
 *
 * ## `Storage` is not named here
 *
 * The guard helpers take a local {@link KeyValueStore} rather than the DOM's
 * `Storage`. Both `sessionStorage` and `localStorage` satisfy it structurally,
 * and it keeps the published declarations free of an ambient DOM type — a `.d.ts`
 * that names one compiles in a browser app and fails in a Node consumer
 * (ADR 0002 §4a).
 */

/**
 * The subset of a web Storage this package uses.
 *
 * Structural, so `sessionStorage`, `localStorage` and a plain object all satisfy
 * it. Which one an app passes is an app decision with real consequences — see
 * the note on storage in `client.ts`.
 */
export interface KeyValueStore {
  getItem(key: string): string | null
  setItem(key: string, value: string): void
  removeItem(key: string): void
}

/**
 * Five states, and no more.
 *
 * `checking` and `entering` deliberately render the same thing: the difference
 * is not information a person entering their own app needs, and distinguishing
 * them visually produces two loading screens for one boot.
 */
export type ShellPhase = 'checking' | 'entering' | 'authenticating' | 'ready' | 'failed'

/**
 * Why the shell is not simply entering.
 *
 * These are not interchangeable. The whole reason the list is this long is that
 * "your session expired" told to somebody whose token was refused for a
 * configuration fault sends them to re-authenticate against a wall.
 */
export type ShellReason =
  | 'no_session'
  | 'session_expired'
  | 'identity_inactive'
  | 'token_rejected'
  | 'exchange_failed'
  | 'network'
  | 'timeout'
  | 'loop_guard'

export type ShellState =
  | { phase: 'checking' }
  | { phase: 'entering' }
  | { phase: 'authenticating'; reason: ShellReason }
  | { phase: 'ready' }
  | { phase: 'failed'; reason: ShellReason }

/** Whether a reason can be cleared by authenticating, or needs somebody else. */
export function isRecoverable(reason: ShellReason): boolean {
  return reason !== 'identity_inactive' && reason !== 'token_rejected'
}

/**
 * What the shell says, per reason.
 *
 * Deliberately plain and deliberately short. This is a bootstrap surface, not a
 * login page, and a paragraph of reassurance here reads as a product asking to
 * be trusted rather than an app starting up.
 *
 * `token_rejected` is the one that must never read as "signed out" — it is a
 * configuration fault that signing in again cannot fix, and saying otherwise
 * cost a real debugging detour the first time it appeared.
 */
export const SHELL_COPY: Record<ShellReason, string> = {
  no_session: 'Continue with your passkey to enter.',
  session_expired: 'Your Estiva ID session ended. Continue with your passkey.',
  identity_inactive: 'This identity is not active. An administrator needs to restore it.',
  token_rejected:
    'Signed in to Estiva ID, but this app could not verify the token. That is a configuration problem rather than an expired session — signing in again will not fix it.',
  exchange_failed: 'That sign-in did not complete. Try again.',
  network: 'Could not reach Estiva ID. Check your connection and try again.',
  timeout: 'Estiva ID did not answer in time. Try again.',
  loop_guard: 'Continue with your passkey to enter.',
}

/** The label on the one affordance the shell ever shows. */
export const CONTINUE_LABEL = 'Continue with passkey'
export const RETRY_LABEL = 'Try again'

// --- The boot decision -------------------------------------------------------

/** What the app observed before deciding anything. */
export interface BootObservation {
  /** Parsed from the address bar, if this load is a return trip. */
  callback: { code?: string | undefined; error?: string | undefined } | null
  /** A stored token that is present *and* still usable. */
  hasValidToken: boolean
  /** The silent-attempt marker, if one is set. */
  guardAttemptedAt: number | null
  /**
   * Whether this page load has already been inside the app.
   *
   * A cold boot and a token dying under somebody's hands are the same
   * observation — no valid token — and they must not get the same treatment.
   * Silent entry is right on boot, where there is nothing on screen to lose.
   * Mid-session it navigates away and takes whatever they were doing with it,
   * which is how "enter automatically" turned into "the page left on its own".
   */
  enteredThisPageLoad: boolean
  now: number
}

export type BootAction =
  /** Redeem the code in the address bar. */
  | { do: 'complete_callback' }
  /** Enter with what is already held. */
  | { do: 'enter' }
  /** Navigate to `/authorize?prompt=none`. Sets the marker first. */
  | { do: 'probe_silently' }
  /** Show the one affordance and wait for the tap. */
  | { do: 'prompt_passkey'; reason: ShellReason }
  /** Stop, with something honest on screen. */
  | { do: 'fail'; reason: ShellReason }

/**
 * How long a silent attempt may take before the return trip counts as a timeout.
 *
 * A navigation cannot be timed out from the page being unloaded, so this is
 * measured across the round trip instead: the marker carries when we left, and
 * a return that took this long means a slow or half-failing identity service.
 * Generous, because it is competing with a cold DNS lookup and a redirect, and
 * a false timeout is worse than a slow entry.
 */
export const PROBE_TIMEOUT_MS = 15_000

/**
 * How long the guard remembers a silent attempt.
 *
 * Long enough that an immediate bounce is caught, short enough that a person
 * who left the tab open and came back gets a real attempt rather than an
 * affordance explaining a failure from an hour ago.
 */
export const GUARD_TTL_MS = 60_000

/**
 * The whole entry decision, as a pure function.
 *
 * Ordering is the contract. A callback is handled before a stored token because
 * the code in the address bar is fresher and must be spent or discarded either
 * way; the guard is consulted before a new probe because that is what stops the
 * bounce.
 */
export function decideBoot(o: BootObservation): BootAction {
  if (o.callback) {
    const { code, error } = o.callback
    if (error) return { do: 'prompt_passkey', reason: reasonForCallbackError(error) }
    if (code) return { do: 'complete_callback' }
  }

  if (o.hasValidToken) return { do: 'enter' }

  /**
   * The token died while they were working. Offer the passkey and let them
   * choose when to lose the page, rather than deciding it for them.
   *
   * The old signed-out screen was a button partly for this reason. Re-entry is
   * usually silent, so the cost here is not a prompt — it is a full navigation
   * out of whatever they had open, and that is not the shell's call to make.
   * PEEK-108 is what removes the interruption rather than relocating it.
   */
  if (o.enteredThisPageLoad) return { do: 'prompt_passkey', reason: 'session_expired' }

  // A silent attempt already ran and we are back here without a token. Never
  // navigate again — this is the infinite bounce the guard exists to prevent.
  if (o.guardAttemptedAt !== null && o.now - o.guardAttemptedAt < GUARD_TTL_MS) {
    const elapsed = o.now - o.guardAttemptedAt
    return { do: 'prompt_passkey', reason: elapsed >= PROBE_TIMEOUT_MS ? 'timeout' : 'loop_guard' }
  }

  return { do: 'probe_silently' }
}

/**
 * Map what `/authorize` sent back onto a reason.
 *
 * `login_required` is the expected negative answer from `prompt=none`, not a
 * fault. `access_denied` is a suspended or offboarded identity, which is the
 * one refusal a person genuinely cannot clear themselves.
 */
export function reasonForCallbackError(error: string): ShellReason {
  switch (error) {
    case 'login_required':
      return 'no_session'
    case 'access_denied':
      return 'identity_inactive'
    default:
      return 'exchange_failed'
  }
}

// --- The loop guard ----------------------------------------------------------

export const GUARD_KEY = 'estiva.authShell.silentAttempt'

/**
 * Per-tab, on purpose. `sessionStorage` dies with the tab, so a genuinely new
 * session gets a genuinely fresh silent attempt rather than inheriting a
 * failure somebody hit yesterday.
 */
export function readGuard(store: Pick<KeyValueStore, 'getItem'>): number | null {
  const raw = store.getItem(GUARD_KEY)
  if (!raw) return null
  const at = Number(raw)
  return Number.isFinite(at) ? at : null
}

export function markGuard(store: Pick<KeyValueStore, 'setItem'>, now: number): void {
  store.setItem(GUARD_KEY, String(now))
}

export function clearGuard(store: Pick<KeyValueStore, 'removeItem'>): void {
  store.removeItem(GUARD_KEY)
}

// --- Instrumentation ---------------------------------------------------------

/**
 * One event vocabulary across both apps (PEEK-120).
 *
 * Shared so Peek and Ship can be compared rather than read as two unrelated
 * auth systems. `app` is the client id, which is already the name Estiva ID
 * knows each of them by.
 */
/**
 * `console` is not in `lib.es2022`. Declared module-locally and read inside
 * `logShellEvent`, so importing this module touches no global (ADR 0002 §4a).
 */
declare const console: { info(...data: unknown[]): void; error(...data: unknown[]): void }

export interface ShellEvent {
  app: string
  phase: ShellPhase
  reason?: ShellReason
  /** Milliseconds since the shell started, for the drop-off view. */
  elapsedMs: number
}

/**
 * Failures are logged at `error`, not `warn`.
 *
 * The point of PEEK-120 is that a broken entry is loud. A `warn` in a browser
 * console is indistinguishable from the noise every app emits at boot.
 */
export function logShellEvent(e: ShellEvent): void {
  const line = `[auth-shell] ${e.app} ${e.phase}${e.reason ? ` (${e.reason})` : ''} +${e.elapsedMs}ms`
  if (e.phase === 'failed') console.error(line)
  else console.info(line)
}

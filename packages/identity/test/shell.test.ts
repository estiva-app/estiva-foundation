/**
 * Pins the auth shell contract (PEEK-115/116).
 *
 * This file exists for the same reason `src/nostr/event.test.ts` does: the
 * implementation is duplicated in another repo on purpose, and a test that
 * fails when the copies drift is what keeps independence from becoming
 * divergence. Ship carries the same assertions against its own copy.
 *
 * The awkward paths are the interesting ones. A shell that enters when it
 * should is easy; a shell that refuses to bounce forever is the feature.
 */
import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import {
  CONTINUE_LABEL,
  GUARD_TTL_MS,
  PROBE_TIMEOUT_MS,
  SHELL_COPY,
  type ShellReason,
  decideBoot,
  isRecoverable,
  reasonForCallbackError,
} from '../dist/index.js'

const NOW = 1_700_000_000_000

const observation = (o: Partial<Parameters<typeof decideBoot>[0]> = {}) =>
  decideBoot({
    callback: null,
    hasValidToken: false,
    guardAttemptedAt: null,
    enteredThisPageLoad: false,
    now: NOW,
    ...o,
  })

describe('the boot decision', () => {
  it('enters on a live token without touching the network', () => {
    assert.deepEqual(observation({ hasValidToken: true }), { do: 'enter' })
  })

  it('probes silently on a cold load with nothing held', () => {
    assert.deepEqual(observation(), { do: 'probe_silently' })
  })

  it('redeems a code that came back', () => {
    assert.deepEqual(observation({ callback: { code: 'abc' } }), { do: 'complete_callback' })
  })

  /**
   * The point of `prompt=none`: a miss is an answer, and it lands the person in
   * the app's own shell rather than on the identity origin's sign-in page.
   */
  it('turns login_required into the passkey affordance, in place', () => {
    assert.deepEqual(observation({ callback: { error: 'login_required' } }), {
      do: 'prompt_passkey',
      reason: 'no_session',
    })
  })

  it('does not offer a passkey to a suspended identity', () => {
    const action = observation({ callback: { error: 'access_denied' } })
    assert.deepEqual(action, { do: 'prompt_passkey', reason: 'identity_inactive' })
    assert.equal(isRecoverable('identity_inactive'), false)
  })

  /**
   * The loop guard. Without this, an app that redirects whenever it has no
   * session, against a service that redirects straight back, is an infinite
   * bounce — which is exactly why Peek's old screen was a button.
   */
  it('never probes twice in one page-load chain', () => {
    const action = observation({ guardAttemptedAt: NOW - 500 })
    assert.deepEqual(action, { do: 'prompt_passkey', reason: 'loop_guard' })
  })

  it('calls a slow round trip a timeout rather than a loop', () => {
    const action = observation({ guardAttemptedAt: NOW - PROBE_TIMEOUT_MS - 1 })
    assert.deepEqual(action, { do: 'prompt_passkey', reason: 'timeout' })
  })

  it('lets a stale guard go, so a returning tab gets a real attempt', () => {
    assert.deepEqual(observation({ guardAttemptedAt: NOW - GUARD_TTL_MS - 1 }), {
      do: 'probe_silently',
    })
  })

  /**
   * A code and a tripped guard arrive together on every successful silent
   * entry — the guard was set on the way out. The code has to win, or a
   * successful probe would be discarded at the last step.
   */
  it('prefers a returned code over a guard set on the way out', () => {
    assert.deepEqual(observation({ callback: { code: 'abc' }, guardAttemptedAt: NOW - 500 }), {
      do: 'complete_callback',
    })
  })
})

/**
 * A cold boot and a token dying under somebody's hands look identical — no
 * valid token — and treating them the same is what made the page navigate away
 * mid-work (PEEK-123).
 */
describe('mid-session expiry', () => {
  it('asks before navigating once the app has been entered', () => {
    assert.deepEqual(observation({ enteredThisPageLoad: true }), {
      do: 'prompt_passkey',
      reason: 'session_expired',
    })
  })

  it('still enters silently on a cold boot', () => {
    assert.deepEqual(observation({ enteredThisPageLoad: false }), { do: 'probe_silently' })
  })

  it('does not interfere with a live token', () => {
    assert.deepEqual(observation({ enteredThisPageLoad: true, hasValidToken: true }), { do: 'enter' })
  })

  /**
   * The callback still wins. A token can expire while the round trip is in
   * flight, and discarding the code we just fetched would strand the person.
   */
  it('still redeems a code that arrived', () => {
    assert.deepEqual(observation({ enteredThisPageLoad: true, callback: { code: 'abc' } }), {
      do: 'complete_callback',
    })
  })
})

describe('the copy', () => {
  const reasons: ShellReason[] = [
    'no_session',
    'session_expired',
    'identity_inactive',
    'token_rejected',
    'exchange_failed',
    'network',
    'timeout',
    'loop_guard',
  ]

  it('covers every reason', () => {
    for (const reason of reasons) assert.ok(SHELL_COPY[reason])
    assert.deepEqual(Object.keys(SHELL_COPY).sort(), [...reasons].sort())
  })

  /**
   * The distinction that cost a debugging detour: a live token the backend
   * refuses is a configuration fault, and telling somebody their session
   * expired sends them to re-authenticate against a wall.
   */
  it('never tells a token_rejected user their session expired', () => {
    assert.match(SHELL_COPY.token_rejected, /configuration/i)
    // It may *contrast* with expiry — "rather than an expired session" is the
    // point. What it must never do is assert it, or offer signing in as the fix.
    assert.doesNotMatch(SHELL_COPY.token_rejected, /your session (has )?(expired|ended)/i)
    assert.match(SHELL_COPY.token_rejected, /will not fix/i)
  })

  it('offers a passkey rather than naming the identity provider', () => {
    // "Sign in with Estiva ID" is the surface this milestone exists to delete.
    assert.doesNotMatch(CONTINUE_LABEL, /sign in/i)
    assert.match(CONTINUE_LABEL, /passkey/i)
  })
})

describe('callback errors', () => {
  it('maps anything unrecognised to a retryable failure', () => {
    assert.equal(reasonForCallbackError('server_error'), 'exchange_failed')
    assert.equal(isRecoverable('exchange_failed'), true)
  })
})

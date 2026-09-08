/**
 * Signing by asking Estiva ID, holding no key at all.
 *
 * The point of the whole seam: an app publishes as a person without ever seeing
 * their secret. `POST /sign` takes a bearer token and an unsigned event and
 * returns a signed one.
 *
 * ## Why this is identity's and not protocol's
 *
 * `@estiva-app/protocol` owns how an event gets its signature — the id
 * computation, the serialization, the bytes. It owns the {@link Signer} seam and
 * the raw-secret-key implementation of it. What it deliberately does not own is
 * *who is allowed to ask*: the token, its renewal, and the round trip to an
 * identity service. That is this package, and `ship/lib/nostr/signer.ts` has
 * said so in a header comment since SHA-3 — "it is `@estiva-app/identity`'s
 * remit — SHA-4. Until then this file is the app's copy."
 *
 * There were three copies until this file existed:
 *
 * | where | what |
 * | --- | --- |
 * | `ship/lib/nostr/signer.ts` | `estivaIdSigner` |
 * | `estiva-agent/lib/nostr/signer.ts` | byte-identical to it |
 * | `peek/src/nostr/bridge.ts` | `signViaEstivaId`, a third |
 *
 * Three implementations of the one call that decides who authored an event, and
 * they had already drifted on the thing that matters most — see the guard below.
 *
 * ## Two exports over one round trip
 *
 * The consumers genuinely want different shapes, and this is not the same kind
 * of difference as `storage` or `clientId`. Peek signs *per request* with a token
 * it reads fresh each time (`signViaEstivaId`); Ship builds a `Signer` **once**,
 * at module scope, which then holds a live bearer for the life of the page and
 * renews it on a `401`. Neither can be expressed as the other without one of
 * them getting worse, so both are here, over one implementation of the round
 * trip and one copy of the guard.
 *
 * `@estiva-app/protocol` is a **peer** dependency, following `@estiva-app/interop`.
 * Nothing here calls a protocol function — only its types are used — so the
 * emitted `.js` imports nothing, and `dist/` keeps the property SHA-4's seam was
 * verified by: the complete list of imports in the shipped JavaScript is
 * `./client.js` and `./shell.js`.
 */
import type { SignedEvent, Signer, UnsignedEvent } from '@estiva-app/protocol'

/**
 * `fetch`, again, and for the same reason as in `client.ts` — `lib.es2022` has
 * no such global, and this package compiles with `types: []` and no `lib: dom`
 * so one published `.d.ts` works in every consumer (ADR 0002 §4a).
 *
 * Note this module needs a *slightly* wider `fetch` than `client.ts` does: it
 * reads `text()` rather than `json()`, because `/sign`'s error bodies are not
 * reliably JSON and the raw text is the only thing worth showing a person.
 */
declare const fetch: (
  url: string,
  init: { method: string; headers: Record<string, string>; body: string },
) => Promise<{ ok: boolean; status: number; text(): Promise<string> }>

/** Just the part of `fetch` this module uses. A parameter as well as a global. */
export type SignFetchLike = typeof fetch

/** Distinguishes "sign in again" from "this event was refused". */
export class SignerTokenExpired extends Error {
  constructor() {
    super('The signing token has expired')
    this.name = 'SignerTokenExpired'
  }
}

export interface SignViaEstivaIdOptions {
  /** Origin of the identity service, e.g. `https://id.estiva.app`. */
  base: string
  /** A bearer token from `POST /token`, audience-bound to this app. */
  token: string
  /**
   * The pubkey the returned event **must** be authored by.
   *
   * Not a request. `/sign` ignores any pubkey it is handed and signs as the
   * token's subject, always — so this is a *check*, and the reason one is needed
   * at all is that a mismatch comes back as **HTTP 200 with a perfectly valid
   * event authored by somebody else**. Without it the failure is invisible at
   * the call site and surfaces later as a message attributed to the wrong
   * person, which is not a bug anybody can debug from the symptom.
   *
   * Optional only because `estivaIdSigner` always supplies it and a caller with
   * genuinely no expectation should be able to say so out loud. Supply it.
   */
  expectedPubkey?: string
  fetch?: SignFetchLike
}

/**
 * One `POST /sign`.
 *
 * **`/sign` refuses `kind:0` for every app, always.** Profiles belong to the
 * identity service (PEEK-31); a refusal here is the policy working rather than
 * something to route around.
 *
 * A `401` is thrown as {@link SignerTokenExpired} rather than a generic failure,
 * because "obtain a new token" and "this event was refused" call for completely
 * different responses from the caller and the status code is the only thing that
 * distinguishes them.
 */
export async function signViaEstivaId(
  unsigned: UnsignedEvent,
  options: SignViaEstivaIdOptions,
): Promise<SignedEvent> {
  const send = options.fetch ?? fetch
  const origin = options.base.replace(/\/+$/, '')

  const response = await send(`${origin}/sign`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      authorization: `Bearer ${options.token}`,
    },
    /*
      Only the four fields that go into the signature input. The unsigned event
      may carry a `pubkey` — Peek's NIP-98 path passes an empty one on purpose —
      and sending it would imply `/sign` honours it, which it does not.
    */
    body: JSON.stringify({
      event: {
        kind: unsigned.kind,
        created_at: unsigned.created_at,
        tags: unsigned.tags,
        content: unsigned.content,
      },
    }),
  })

  const text = await response.text()
  if (response.status === 401) throw new SignerTokenExpired()
  if (!response.ok) {
    let reason = text.slice(0, 200)
    try {
      const body = JSON.parse(text) as { error?: { message?: string } }
      reason = body.error?.message ?? reason
    } catch {
      // Keep the raw text. `/sign`'s error bodies are not reliably JSON, and the
      // raw text is more use to a person than "unparseable response".
    }
    throw new Error(`Estiva ID refused to sign kind:${unsigned.kind} — ${reason}`)
  }

  const event = (JSON.parse(text) as { event?: SignedEvent }).event
  if (!event) throw new Error('POST /sign returned no event')

  if (options.expectedPubkey && event.pubkey !== options.expectedPubkey) {
    throw new Error(
      `POST /sign returned an event authored by ${event.pubkey}, expected ${options.expectedPubkey}. ` +
        'That token belongs to a different identity — refusing to publish under the wrong author.',
    )
  }

  return event
}

export interface EstivaIdSignerOptions {
  /** Origin of the identity service, e.g. `https://id.estiva.app`. */
  base: string
  /** The pubkey the token was issued for — `sub` in the JWT. */
  pubkey: string
  /** A bearer token from `POST /token`, audience-bound to this app. */
  token: string
  /**
   * Renew the token, once, when `/sign` says it has expired (PEEK-108).
   *
   * Optional: without it a `401` surfaces as {@link SignerTokenExpired} for the
   * caller to deal with, exactly as before. With it, an expiry is invisible —
   * which matters more than it used to, because access tokens live ten minutes
   * rather than an hour, so a session of any length crosses one.
   *
   * Returning `null` means renewal failed and the expiry is real.
   *
   * Pass `client.refreshAccessToken` and nothing else: it coalesces concurrent
   * callers, and a refresh token is single-use with a replay read as theft.
   */
  renew?: () => Promise<string | null>
  fetch?: SignFetchLike
}

/**
 * A {@link Signer} that signs by asking Estiva ID.
 *
 * Holds the live bearer, so a renewal replaces it for every later signature
 * rather than being rediscovered on each one.
 */
export function estivaIdSigner({ base, pubkey, token, renew, fetch: send }: EstivaIdSignerOptions): Signer {
  let bearer = token

  return {
    pubkey,
    kind: 'estiva-id',
    async sign(unsigned) {
      const once = (auth: string) =>
        signViaEstivaId(unsigned, {
          base,
          token: auth,
          // The guard, unconditionally. Ship's copy of this signer never had it
          // and Peek's `signViaEstivaId` did, which is exactly the drift three
          // copies produce: the app that publishes every issue, comment and
          // status change was the one that could not tell it had signed as
          // somebody else. SHA-4's Traps section says both must keep it.
          expectedPubkey: pubkey,
          ...(send ? { fetch: send } : {}),
        })

      try {
        return await once(bearer)
      } catch (error) {
        /*
          Renew once and retry, never twice.

          A second 401 after a successful renewal is not an expiry — it is a
          token the service will not accept, and retrying that in a loop is how
          one refused signature becomes a hot loop against the identity service.
          Anything that is not an expiry is rethrown untouched, so a wrong-author
          refusal is never mistaken for something a new token would fix.
        */
        if (!(error instanceof SignerTokenExpired) || !renew) throw error
        const renewed = await renew()
        if (!renewed) throw error
        bearer = renewed
        return await once(bearer)
      }
    },
  }
}

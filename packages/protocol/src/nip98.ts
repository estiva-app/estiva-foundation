/**
 * NIP-98 HTTP auth for Buzz's REST bridge.
 *
 * Buzz's bridge (`POST /events`, `POST /query`) authenticates with NIP-98, **not**
 * NIP-42 — no challenge/response and no persistent connection, which is what
 * makes it usable from a request-scoped server runtime that cannot hold a socket,
 * and from a plain `fetch` in a browser.
 *
 * Written against the relay's actual verifier, `verify_nip98_event`
 * (crates/buzz-auth/src/nip98.rs:55). Its rules, in order:
 *
 *   1. kind must be 27235
 *   2. valid Schnorr signature + id hash
 *   3. `created_at` within ±60s of the relay's clock
 *   4. `u` tag must equal the expected URL after normalization
 *   5. `method` tag must match (case-insensitive)
 *   6. if a `payload` tag is present AND a body was sent, sha256(body) must match
 *
 * Two things that bite in practice:
 *
 * - **No loopback aliasing.** `localhost`, `127.0.0.1` and `::1` are distinct
 *   hosts to the verifier (deliberately — it is the row-zero community binding).
 *   The `u` tag must use the same host string as the request's Host header.
 * - **Single use, and "fresh" is not enough.** Each auth event id is recorded in
 *   a Redis seen-set (`check_nip98_replay`, bridge.rs:135). Rebuilding the header
 *   per request does *not* guarantee a new id: `created_at` has one-second
 *   resolution, so two requests with the same URL, method and body inside the
 *   same second produce a byte-identical event and the second is rejected with
 *   `NIP-98: replay detected`. Verified against the live relay. Hence the
 *   `nonce` tag below — it is what makes each auth event unique.
 *
 * ## Why the builder is unsigned, and the signer is somebody else's problem
 *
 * Before SHA-3 this existed twice with a real divergence: Peek had split the
 * builder into `buildUnsignedAuthEvent` plus a signing step, because Peek holds
 * no keys and must sign through Estiva ID; Ship still had the combined
 * build-and-sign form. **Peek's shape is what ships**, because it is the one that
 * works for a keyless app — and a keyed app composes it with `signEvent` in one
 * line. The tag layout then has exactly one definition, which is the point: it is
 * part of the event id preimage, and two copies drifting would produce ids the
 * relay computes differently.
 *
 * `nostr-tools/nip98` was evaluated and does **not** fit: its `getToken` emits
 * `u`, `method` and `payload` and no nonce, so identical requests in one second
 * collide on Buzz's replay set. Measured, not assumed — see the README.
 */
import { sha256 } from '@noble/hashes/sha256'
import { bytesToHex, randomBytes, utf8ToBytes } from '@noble/hashes/utils'
import { KIND, type NostrTag, type SignedEvent, type UnsignedEvent } from './events.js'
import type { Signer } from './sign.js'

/** The relay rejects auth events outside ±60s (`TIMESTAMP_TOLERANCE_SECS`). */
export const TIMESTAMP_TOLERANCE_SECS = 60

/**
 * `URL` and `btoa` are not in `lib.es2022`, and this package compiles with
 * `types: []` and no `lib: dom` (ADR 0002 §4a). Declared inside this module so
 * nothing lands in a consumer's global scope, and read inside function bodies so
 * importing this module touches no global.
 */
declare const URL: { new (raw: string): { pathname: string; toString(): string } }
declare const btoa: (binary: string) => string

/**
 * Buzz's `normalize_url` (nip98.rs:145): parse, strip trailing slashes from the
 * path, re-serialize. We only need it to keep our own `u` tag canonical.
 */
export function normalizeUrl(raw: string): string {
  try {
    const parsed = new URL(raw)
    parsed.pathname = parsed.pathname.replace(/\/+$/, '')
    return parsed.toString()
  } catch {
    return raw.toLowerCase()
  }
}

/** What `buildUnsignedAuthEvent` needs. Named so callers can pass it around. */
export interface AuthEventArgs {
  /** Left empty when a remote signer will overwrite it with the token's subject. */
  pubkey: string
  url: string
  method: string
  /** Request body, when there is one — adds the `payload` tag. */
  body?: string
  /** Override for tests; defaults to now. */
  nowMs?: number
  /** Override for tests; defaults to random. Must differ per request. */
  nonce?: string
}

/**
 * Build the unsigned kind:27235 event backing an `Authorization: Nostr …` header.
 *
 * `url` must be the full request URL with the same host the relay will see —
 * `nip98_expected_url` (bridge.rs:195) reconstructs it as
 * `{http|https}://{host}{path}` from the request's own Host header.
 */
export function buildUnsignedAuthEvent(args: AuthEventArgs): UnsignedEvent {
  const tags: NostrTag[] = [
    ['u', normalizeUrl(args.url)],
    ['method', args.method.toUpperCase()],
    // Uniqueness, not security: without it, two identical requests in the same
    // second collide on the event id and the relay rejects the second as a
    // replay. The verifier ignores tags it does not know (it looks up `u`,
    // `method` and `payload` by name), so this is safe to add.
    ['nonce', args.nonce ?? bytesToHex(randomBytes(16))],
  ]
  if (args.body !== undefined) {
    tags.push(['payload', bytesToHex(sha256(utf8ToBytes(args.body)))])
  }
  return {
    pubkey: args.pubkey,
    created_at: Math.floor((args.nowMs ?? Date.now()) / 1000),
    kind: KIND.HTTP_AUTH,
    tags,
    content: '',
  }
}

/**
 * Base64 without Node's `Buffer`, so this works in a browser, in Convex's
 * default runtime and under Node from one build.
 */
export function base64(input: string): string {
  const bytes = utf8ToBytes(input)
  let binary = ''
  for (const b of bytes) binary += String.fromCharCode(b)
  return btoa(binary)
}

/**
 * The full header value: `Nostr <base64(signed kind-27235 event JSON)>`
 * (bridge.rs:81-93 strips the `Nostr ` prefix and base64-decodes the rest).
 *
 * Uses the utf8-aware `base64` above rather than a bare `btoa`, which throws on
 * any code point above U+00FF.
 */
export function authorizationHeaderFor(signed: SignedEvent): string {
  return `Nostr ${base64(JSON.stringify(signed))}`
}

/**
 * Build, sign and encode the header in one step.
 *
 * **The auth event is signed by the same signer as the content**, which is what
 * makes a keyless signer work at all: Buzz's bridge authenticates with NIP-98,
 * so an app holding a perfectly signed issue and no way to sign a `27235` can
 * still publish nothing. Signing content but not auth leaves the seam
 * half-built, and it looks finished (PEEK-44).
 *
 * That rule has exactly one definition, here, and {@link Relay} uses it rather
 * than inlining it — because an app with its own transport needs the same rule
 * and would otherwise write it out again.
 *
 * Async for the same reason `Signer.sign` is: a remote signer or a browser
 * extension cannot answer synchronously.
 */
export async function authorizationHeader(
  signer: Signer,
  args: Omit<AuthEventArgs, 'pubkey'>,
): Promise<string> {
  return authorizationHeaderFor(await signer.sign(buildUnsignedAuthEvent({ ...args, pubkey: signer.pubkey })))
}

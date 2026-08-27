/**
 * BIP-340 Schnorr signing, and the signer seam every publish path goes through.
 *
 * Signing needs entropy (`@noble/curves` draws auxiliary randomness per
 * signature), so `signEvent` only works where a CSPRNG is available — a browser,
 * Node, Convex's Node runtime. That is a *runtime* requirement rather than a type
 * one: nothing here reads a global, and importing this module is safe anywhere.
 *
 * ## What is deliberately not here
 *
 * `estivaIdSigner` — the signer that posts to Estiva ID's `/sign` and holds no
 * key at all — is **identity**, and belongs to `@estiva-app/identity` (SHA-4).
 * This package defines the {@link Signer} interface it will implement, because
 * the relay clients need something to sign with and the interface is the seam
 * between "the bytes" and "who is allowed to sign them". Keeping the interface
 * here and the implementations there is what stops `protocol` growing a
 * dependency on an identity service.
 */
import { schnorr } from '@noble/curves/secp256k1'
import { bytesToHex, hexToBytes } from '@noble/hashes/utils'
import { computeEventId, type SignedEvent, type UnsignedEvent } from './events.js'

/** Derive the 64-char hex x-only public key for a secret key. */
export function publicKeyFromSecret(secretKeyHex: string): string {
  return bytesToHex(schnorr.getPublicKey(hexToBytes(secretKeyHex)))
}

/**
 * Compute the event id and sign it, producing a relay-submittable event.
 *
 * Throws if `unsigned.pubkey` does not match the secret key — a mismatch would
 * produce an event the relay silently rejects as an invalid signature, which is
 * painful to debug from the other side.
 */
export function signEvent(unsigned: UnsignedEvent, secretKeyHex: string): SignedEvent {
  const derived = publicKeyFromSecret(secretKeyHex)
  if (derived !== unsigned.pubkey) {
    throw new Error(
      `pubkey mismatch: event declares ${unsigned.pubkey.slice(0, 16)}… but the secret key derives ${derived.slice(0, 16)}…`,
    )
  }
  const id = computeEventId(unsigned)
  const sig = bytesToHex(schnorr.sign(id, hexToBytes(secretKeyHex)))
  return { ...unsigned, id, sig }
}

/**
 * Who signs, decided once and injected everywhere (PEEK-44).
 *
 * ## Why this exists at all
 *
 * The suite claims apps built by different people, sharing no code and no
 * database, can work on the same data. Wiring an app directly to one login
 * service would quietly undercut that — it would only work for people with an
 * Estiva account.
 *
 * Depending on a *signer* does not. Separating the signer from the client is
 * ordinary Nostr architecture (NIP-07, NIP-46), so an app stays honest for
 * anyone who wants to point their own signer at it, and "sign in with Estiva ID"
 * becomes one implementation among several rather than an assumption baked into
 * the data layer. It is also the seam that lets this package stay ignorant of
 * identity: `@estiva-app/identity` implements this interface, and nothing here
 * knows that it exists.
 *
 * ## The two decisions in the interface
 *
 * **`pubkey` is synchronous.** Every event builder needs it before there is
 * anything to sign — `buildMessage(pubkey, …)` — so making it a promise would
 * put an `await` in front of every construction site for no benefit. You know
 * who you are before you sign; implementations that must ask (NIP-07) resolve it
 * once, at construction.
 *
 * **`sign` is asynchronous**, because two of the three implementations are: a
 * remote call to `/sign` and a round trip to a browser extension. The local key
 * is the odd one out, and it is cheaper for it to return a resolved promise than
 * for the interface to pretend signing is always instant.
 *
 * ## What a signer deliberately cannot do
 *
 * Sign as somebody else. Every implementation attributes the event to its own
 * `pubkey` and ignores whatever the caller put there, which is the same
 * guarantee `/sign` makes server-side. Code that genuinely needs to produce a
 * mismatched event — Ship's `scripts/verify.ts` forges one to prove the relay
 * rejects it — uses {@link signEvent} directly and holds a raw key to do it.
 */

/** How the current signer authenticates, for anything that needs to say so. */
export type SignerKind = 'local' | 'estiva-id' | 'nip07'

export interface Signer {
  /** The pubkey every event from this signer is attributed to. */
  readonly pubkey: string
  readonly kind: SignerKind
  /** Attributes the event to {@link pubkey}, whatever the caller supplied. */
  sign(unsigned: UnsignedEvent): Promise<SignedEvent>
}

/**
 * A signer holding a raw secret key.
 *
 * The honest name for what a script has always done. Used directly by scripts,
 * which have no `localStorage`, and underneath an app's per-browser identity.
 */
export function secretKeySigner(secretKeyHex: string, kind: SignerKind = 'local'): Signer {
  const pubkey = publicKeyFromSecret(secretKeyHex)
  return {
    pubkey,
    kind,
    async sign(unsigned) {
      return signEvent({ ...unsigned, pubkey }, secretKeyHex)
    },
  }
}

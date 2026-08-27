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

/** How the current signer authenticates, for anything that needs to say so. */
export type SignerKind = 'local' | 'estiva-id' | 'nip07'

/**
 * Something that can turn an unsigned event into a signed one.
 *
 * Async because the interesting implementations are: a remote signer over HTTP,
 * a browser extension. A local secret key answers synchronously and is wrapped
 * to match.
 */
export interface Signer {
  /** The pubkey every event this signer produces will be authored by. */
  pubkey: string
  kind: SignerKind
  sign(unsigned: UnsignedEvent): Promise<SignedEvent>
}

/** A {@link Signer} backed by a raw secret key. Server scripts and seeds. */
export function secretKeySigner(secretKeyHex: string, kind: SignerKind = 'local'): Signer {
  const pubkey = publicKeyFromSecret(secretKeyHex)
  return {
    pubkey,
    kind,
    sign: (unsigned) => Promise.resolve(signEvent({ ...unsigned, pubkey }, secretKeyHex)),
  }
}

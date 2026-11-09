/**
 * Whose agent a key is, from the owner's NIP-OA tag on the agent's profile
 * (PEE-79).
 *
 * Estiva ID signs `["auth", owner, conditions, sig]` with the owner's key over
 * `nostr:agent-auth:<agent>:<conditions>` and puts it on the agent's `kind:0`.
 * Any app checks the signature against the agent's own key, with no list kept
 * by Estiva. A message by an agent you own then counts as your own (SPEC §11.8).
 *
 * Only an attestation with **no conditions** names an owner here. Conditions
 * narrow which events an agent may sign for its owner (kinds, a time window);
 * ownership of the agent does not vary by event, and an app that half-applied
 * them would be wrong in both directions. Estiva ID issues none.
 *
 * why: https://github.com/estiva-app/estiva-docs/blob/main/decisions/an-agents-profile-says-whose-it-is.md
 */
import { schnorr } from '@noble/curves/secp256k1'
import { sha256 } from '@noble/hashes/sha256'
import { hexToBytes, utf8ToBytes } from '@noble/hashes/utils'

const HEX64 = /^[0-9a-f]{64}$/
const HEX128 = /^[0-9a-f]{128}$/

/**
 * The owner a profile's NIP-OA tag proves, or undefined: no tag, a tag with
 * conditions, a malformed one, a key vouching for itself, or a signature that
 * does not verify against `event.pubkey`. Never throws.
 */
export function ownerOf(event: { pubkey?: string; tags?: readonly (readonly string[])[] }): string | undefined {
  const agent = event.pubkey
  if (!agent || !HEX64.test(agent)) return undefined
  for (const tag of event.tags ?? []) {
    if (tag[0] !== 'auth') continue
    const [, owner, conditions, sig] = tag
    if (!owner || !HEX64.test(owner) || owner === agent || conditions !== '' || !sig || !HEX128.test(sig)) continue
    try {
      const digest = sha256(utf8ToBytes(`nostr:agent-auth:${agent}:`))
      if (schnorr.verify(hexToBytes(sig), digest, hexToBytes(owner))) return owner
    } catch {
      // A point off the curve is a tag that proves nothing, not an error.
    }
  }
  return undefined
}

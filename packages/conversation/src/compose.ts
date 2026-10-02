/**
 * What a composer's pick writes — SPEC §13.1, for `@`, `!@` and `[` (CON-27).
 *
 * The menus that offer a person or a message are an editor's, and live in
 * `@estiva-app/ui/editor`; this is the half that is the same in every client,
 * React or not: the text a pick becomes in the body, and the tags the body
 * then earns. Peek wrote these itself until CON-27, and every byte below is
 * the one it wrote.
 *
 * | pick | body | tags |
 * | --- | --- | --- |
 * | a person (`@`) | `nostr:npub…`, or `@Name` with no key | `p`, from {@link mentionTagsFor} |
 * | a person, urgently (`!@`) | the same `nostr:npub…`, or `!@Name` | `p`, and {@link urgentTagsFor}'s `["urgent", <pubkey>]` |
 * | a message (`[`) | `nostr:nevent…` with its kind and no relay | none |
 */
import { encodeNevent, encodeNpub, type NostrTag } from '@estiva-app/protocol'
import { mentionTagsFor } from './strength.js'

/**
 * A person as the body names them.
 *
 * The key, when there is one: it survives a rename and resolves for a reader
 * who holds no directory. Somebody with no key is still mentioned by name,
 * which is what every message before §13.1 carried — and an urgent one by
 * `!@Name`, the old text form a reader still takes as urgent.
 *
 * **The urgency is not in the text when there is a key.** It is the tag
 * beside the `p` ({@link urgentTagsFor}), so another app draws an ordinary
 * mention rather than a stray `!`.
 */
export function mentionText(person: { pubkey?: string | null; label: string }, urgent = false): string {
  if (person.pubkey) return `nostr:${encodeNpub(person.pubkey)}`
  return `${urgent ? '!@' : '@'}${person.label}`
}

/**
 * A message as the body references it: `nostr:nevent…` carrying the event's
 * kind, so a reader can fetch the manifest and the event together rather than
 * one after the other.
 *
 * No relay hint: a reader on this relay needs none, and one elsewhere cannot
 * read the event anyway — the omission every `naddr` an app writes makes.
 */
export function messageReference(eventId: string, kind: number): string {
  return `nostr:${encodeNevent({ id: eventId, relays: [], kind })}`
}

/** SPEC §13.1's urgent mention: `["urgent", <pubkey>]` beside that person's `p` (CON-17). */
export const URGENT_TAG = 'urgent'

/**
 * The `urgent` tags for a body: one per person in `urgent` the body names, so
 * each carries a `p` beside it (§13.1). A person the body no longer names —
 * their chip deleted — is dropped rather than paged.
 *
 * `urgent` is what the composer's urgent picks name, by pubkey; the text alone
 * cannot say which of the people it names were urgent.
 */
export function urgentTagsFor(body: string, urgent: readonly string[] | undefined): NostrTag[] {
  if (!urgent || urgent.length === 0) return []
  const named = new Set(mentionTagsFor(body).map((tag) => tag[1]))
  return [...new Set(urgent)].filter((pubkey) => named.has(pubkey)).map((pubkey) => [URGENT_TAG, pubkey])
}

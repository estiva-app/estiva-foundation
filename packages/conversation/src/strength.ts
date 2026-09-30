/**
 * Which object a conversation is about, and how strongly — SPEC §6.4.
 *
 * A thread attaches to every object anyone in it referenced, and that is only
 * defensible because attachment has **two strengths** an app MUST present
 * apart:
 *
 * | on the thread's root | strength |
 * | --- | --- |
 * | a `kind:1111`'s `A` | **comment**: NIP-22's root object |
 * | a `kind:1111`'s `a` that is not its `A` | **mention**: the index of an address the body names |
 * | a `kind:9`'s `a`, or a `nostr:naddr…` in any body | **mention** |
 * | any tag on a reply | nothing: only the root decides |
 *
 * A `kind:1111` with no `A` is malformed; a reader takes **every** `a` it
 * carries as an `A` rather than dropping the thread (clarified 2026-09-29).
 *
 * **A `kind:9` is not a comment** (SPEC §6.4, corrected 2026-09-30, CON-20):
 * every comment-shaped `kind:9` on production was republished as a
 * `kind:1111`, so a channel's chat lists under no object whatever `a` it
 * carries (C10). Ship's `anchorIndex` and interop's `isCommentOn` read a
 * `kind:9` whose `a` the body does not name as a pre-REW-10 comment; that row
 * is gone, except for an app whose manifest still declares such a history
 * (`emits.alsoRead`, §7.3) — see {@link isCommentOn}'s `declaredKinds`.
 *
 * **A reply is never a root** (added 2026-09-29, CON-5). An event carrying a
 * reply `e` — a `kind:9` with any `e`, a `kind:1111` with a lowercase `e` that
 * differs from its `E` — is not a comment of its own, whatever `a` it carries.
 */
import { decodeNaddr, decodeNpub, findNaddrs, findNostrUris, pointerToAddress, type NostrTag, type SignedEvent } from '@estiva-app/protocol'
import { KIND_COMMENT } from './kinds.js'

type Tagged = Pick<SignedEvent, 'kind' | 'tags'>
type Readable = Pick<SignedEvent, 'kind' | 'tags' | 'content'>

/** Presented as the object's own discussion, or as *Mentioned in*. */
export type Strength = 'comment' | 'mention'

const values = (event: Pick<SignedEvent, 'tags'>, name: string): string[] =>
  event.tags.filter((t) => t[0] === name && typeof t[1] === 'string' && t[1] !== '').map((t) => t[1])

/** The addresses a body names by `nostr:naddr…`. A pointer that will not decode is prose. */
export function namedInBody(body: string): Set<string> {
  const addresses = new Set<string>()
  for (const naddr of findNaddrs(body)) {
    try {
      addresses.add(pointerToAddress(decodeNaddr(naddr)))
    } catch {
      // A malformed pointer is prose.
    }
  }
  return addresses
}

/**
 * Whether the event answers another: a `kind:9` with any `e`, or a
 * `kind:1111` with a lowercase `e` that differs from its `E`.
 *
 * A top-level comment on an *event* root carries `E` and `e` naming the same
 * event and is not a reply. On an address root it carries no `e` at all.
 */
export function isReply(event: Pick<SignedEvent, 'kind' | 'tags'>): boolean {
  // A NIP-10 `mention`-marked `e` quotes an event; it answers nothing.
  const es = event.tags.filter((t) => t[0] === 'e' && typeof t[1] === 'string' && t[1] !== '' && t[3] !== 'mention').map((t) => t[1])
  if (es.length === 0) return false
  if (event.kind !== KIND_COMMENT) return true
  const root = values(event, 'E')[0]
  return es.some((e) => e !== root)
}

/**
 * The addresses the event's thread is **about** — its `A` tags, or every `a`
 * when it carries no `A`. Only a `kind:1111` has any.
 *
 * On a reply this is the thread's object, not the reply's own strength: a
 * reply copies the comment's `A` (§6.4 *Replies*). {@link isCommentOn} is the
 * test for whether the event itself lists as a comment.
 */
export function anchorsOf(event: Tagged): string[] {
  if (event.kind !== KIND_COMMENT) return []
  const roots = values(event, 'A')
  return [...new Set(roots.length > 0 ? roots : values(event, 'a'))]
}

/**
 * Is the event a **comment** on the address: a root whose thread is about it
 * (C10, C11).
 *
 * `declaredKinds` is the object's owner's comment kinds, as its manifest
 * declares them (§7.3: `emits.kind` and `emits.alsoRead`); the default is
 * NIP-22's alone. A kind other than `1111` is a comment only when its owner
 * declares it — the history §7.3 says an app declares when it has *not*
 * migrated it — and is then read the way such a comment was written: by an
 * `a` its body does not name. Undeclared, a `kind:9` is chat and lists under
 * no object whatever `a` it carries (§6.4, CON-20).
 */
export function isCommentOn(event: Readable, address: string, declaredKinds: readonly number[] = [KIND_COMMENT]): boolean {
  if (isReply(event)) return false
  if (event.kind === KIND_COMMENT) return anchorsOf(event).includes(address)
  if (!declaredKinds.includes(event.kind)) return false
  return event.tags.some((t) => t[0] === 'a' && t[1] === address) && !namedInBody(event.content).has(address)
}

/** Does the event name the address at all — any `a` or `A`, or a `nostr:naddr…` in its body. */
export function referencesAddress(event: Readable, address: string): boolean {
  if (event.tags.some((t) => (t[0] === 'a' || t[0] === 'A') && t[1] === address)) return true
  return namedInBody(event.content).has(address)
}

/**
 * How one event attaches to the address on its own: a comment, a mention, or
 * nothing. A reply is always nothing (C11): its tags name its parent or repeat
 * the root's, and only the root decides.
 *
 * For a whole thread — which attaches as a mention when any message in it
 * names the address — see {@link threadStrength}.
 */
export function strengthOn(event: Readable, address: string): Strength | null {
  if (isReply(event)) return null
  if (isCommentOn(event, address)) return 'comment'
  return referencesAddress(event, address) ? 'mention' : null
}

/**
 * How a thread attaches to the address: a **comment** when its root is one,
 * else a **mention** when any message in it — the root or a reply — names the
 * address, else nothing.
 *
 * Thread-wide on purpose (§6.4): a discussion that names an object halfway
 * through is from then on about that object, and the earlier messages are the
 * context somebody needs. Pass `root` undefined when the root is outside the
 * read; the thread can then only be a mention, since only the root decides
 * the comment.
 */
export function threadStrength(root: Readable | undefined, replies: readonly Readable[], address: string): Strength | null {
  if (root && isCommentOn(root, address)) return 'comment'
  const all = root ? [root, ...replies] : replies
  return all.some((event) => referencesAddress(event, address)) ? 'mention' : null
}

/**
 * The `a` tags a body earns: every address it names by `nostr:naddr…`, except
 * `own` (the object the event is already a comment on, which is its `A`).
 *
 * §6.4: a writer MUST NOT put an address in a `kind:1111`'s `a` that the body
 * does not name, unless it is the `A` — which is what keeps the mention row
 * readable without decoding the body.
 */
export function referenceTagsFor(body: string, own = ''): NostrTag[] {
  const addresses = namedInBody(body)
  addresses.delete(own)
  return [...addresses].map((a) => ['a', a])
}

/** The most `p` tags a message carries — Buzz's cap, and `buildMessage`'s. */
export const MAX_MENTIONED_PEOPLE = 50

/** The people a body mentions by `nostr:npub…`, as `p` tags, capped at {@link MAX_MENTIONED_PEOPLE}. */
export function mentionTagsFor(body: string): NostrTag[] {
  const pubkeys = new Set<string>()
  for (const uri of findNostrUris(body)) {
    if (!/^nostr:npub1/i.test(uri)) continue
    try {
      pubkeys.add(decodeNpub(uri))
    } catch {
      // A malformed key is prose.
    }
  }
  return [...pubkeys].slice(0, MAX_MENTIONED_PEOPLE).map((p) => ['p', p])
}

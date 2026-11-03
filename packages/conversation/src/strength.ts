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
import { decodeNaddr, decodeNpub, findNaddrs, findNostrUris, FILE_KINDS, fileIdFormOf, fileIdOf, pointerToAddress, type NostrTag, type SignedEvent } from '@estiva-app/protocol'
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
  if (event.kind !== KIND_COMMENT || crossed(event)) return []
  const roots = values(event, 'A')
  return [...new Set(roots.length > 0 ? roots : values(event, 'a'))]
}

/**
 * The ids of the files the event's thread is about by its `O` tags (§6.4, "A
 * comment in both forms"), beside {@link anchorsOf}'s addresses. Empty for a
 * comment whose `A` and `O` name different files: that one is about neither.
 */
export function anchorIdsOf(event: Tagged): string[] {
  if (event.kind !== KIND_COMMENT || crossed(event)) return []
  return [...new Set(values(event, 'O'))]
}

/**
 * A comment §6.4 ignores, as a change is (§6.2): two `O`s or two `A`s, or a
 * root and an `O` that name different files, or it would show under one file
 * for a reader asking by address and under another for one asking `#O`. The
 * root is its `A`, or its `a` when it carries no `A`, as {@link anchorsOf}
 * reads it, and names the `O`'s file only as a file kind's address with that
 * id. That the author is the file's is {@link isAbout}'s to check: the
 * comment is about its root.
 */
function crossed(event: Pick<SignedEvent, 'tags'>): boolean {
  const ids = new Set(values(event, 'O'))
  const roots = new Set(values(event, 'A'))
  if (ids.size > 1 || roots.size > 1) return true
  if (ids.size === 0) return false
  const [id] = ids
  return [...(roots.size > 0 ? roots : values(event, 'a'))].some(
    (address) => !FILE_KINDS.includes(Number(address.split(':')[0])) || fileIdOf(address) !== id,
  )
}

/** Whether the event is a comment whose root and `O` name different files: one ignored under every file (§6.4). */
export function isCrossedComment(event: Tagged): boolean {
  return event.kind === KIND_COMMENT && crossed(event)
}

/**
 * {@link isCrossedComment}, or a comment whose `O` has the id of the file at
 * `address` under a root that is not that address (another author's): its
 * root and `O` disagree for this file, so under it it is nothing, not even a
 * mention (§6.4).
 */
export function isCrossedCommentOn(event: Tagged, address: string): boolean {
  if (event.kind !== KIND_COMMENT) return false
  if (crossed(event)) return true
  const roots = anchorsOf(event)
  return roots.length > 0 && !roots.includes(address) && values(event, 'O').some((id) => namesById(id, address))
}

/**
 * Whether a `kind:1111`'s thread is about the file at `address`: by its
 * {@link anchorsOf} root when it has one, so an `O` with the file's id under
 * an address of another author is not about it; by its `O` only when it
 * carries neither `A` nor `a` (§6.4). A root or a reply alike;
 * {@link isCommentOn} adds the root test.
 */
export function isAbout(event: Tagged, address: string): boolean {
  const roots = anchorsOf(event)
  if (roots.length > 0) return roots.includes(address)
  // No root: neither `A` nor `a`, or an ignored comment, whose `O`s are none.
  return anchorIdsOf(event).some((id) => namesById(id, address))
}

/** Whether a tag naming a file by its id (`O`, `o`) names the file at `address`. */
const namesById = (id: string, address: string) => fileIdOf(address) === id

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
 *
 * why: https://github.com/estiva-app/estiva-docs/blob/main/decisions/early-shapes-are-migrated-or-deleted.md
 */
export function isCommentOn(event: Readable, address: string, declaredKinds: readonly number[] = [KIND_COMMENT]): boolean {
  if (isReply(event)) return false
  if (event.kind === KIND_COMMENT) return isAbout(event, address)
  if (!declaredKinds.includes(event.kind)) return false
  return event.tags.some((t) => t[0] === 'a' && t[1] === address) && !namedInBody(event.content).has(address)
}

/**
 * Does the event name the address at all — any `a` or `A`, an `o` or `O` with
 * the file's id (§6.4), or a `nostr:naddr…` in its body. A comment whose `A`
 * and `O` disagree names nothing: it is ignored under every file (§6.4), and
 * one whose `O` has this file's id under another address is about that one.
 */
export function referencesAddress(event: Readable, address: string): boolean {
  if (isCrossedCommentOn(event, address)) return false
  if (event.tags.some((t) => (t[0] === 'a' || t[0] === 'A') && t[1] === address)) return true
  if (event.tags.some((t) => (t[0] === 'o' || t[0] === 'O') && typeof t[1] === 'string' && namesById(t[1], address))) return true
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
 *
 * A file whose type the relay keeps in order (`inOrder`) earns an `o` with
 * its id after its `a` (§6.4).
 */
export function referenceTagsFor(body: string, own = '', inOrder: readonly string[] = []): NostrTag[] {
  const addresses = namedInBody(body)
  addresses.delete(own)
  return [...addresses].flatMap((a) => {
    const byId = fileIdFormOf(inOrder, a)
    return byId ? [['a', a], ['o', byId.id]] : [['a', a]]
  })
}

/** The most `p` tags a message carries — Buzz's cap, and `buildMessage`'s. */
export const MAX_MENTIONED_PEOPLE = 50

/** The people a body mentions by `nostr:npub…` (§13.1), in the order it names them. */
export function peopleNamedInBody(body: string): Set<string> {
  const pubkeys = new Set<string>()
  for (const uri of findNostrUris(body)) {
    if (!/^nostr:npub1/i.test(uri)) continue
    try {
      pubkeys.add(decodeNpub(uri))
    } catch {
      // A malformed key is prose.
    }
  }
  return pubkeys
}

/** The people a body mentions by `nostr:npub…`, as `p` tags, capped at {@link MAX_MENTIONED_PEOPLE}. */
export function mentionTagsFor(body: string): NostrTag[] {
  return [...peopleNamedInBody(body)].slice(0, MAX_MENTIONED_PEOPLE).map((p) => ['p', p])
}

/**
 * Buzz-shaped Nostr event builders.
 *
 * Every builder here mirrors a function in Buzz's own SDK
 * (`crates/buzz-sdk/src/builders.rs`) exactly — same kind, same tags, **same tag
 * order**. Tag order is part of the NIP-01 id preimage, so a reordered tag
 * produces a different event id. Where a shape was verified against Buzz's code,
 * the Rust function is named in the comment.
 *
 * Verified: `buildMessage` + `buildCreateChannel` output was compared against
 * `build_message` / `build_create_channel` by running Buzz's own crates over this
 * emitter's output — byte-identical event ids (Peek's
 * docs/buzz-compat/INTEROP_PROOF.md §4).
 *
 * ## This file used to exist three times
 *
 * Until SHA-3 the same builders lived in `peek/convex/nostr/`, `ship/lib/nostr/`
 * and `estiva-agent/lib/nostr/`, and a `diff -r` somebody had to remember to run
 * was what kept two of them honest. They had already drifted: Peek's
 * `buildMessage` grew an `about` parameter emitting `a` tags and Ship's never
 * did, so the same logical message produced different bytes depending on which
 * app sent it. Nothing failed, because each copy was self-consistent — which is
 * the failure mode this package exists to remove.
 *
 * The union is what ships here. Where the two disagreed, Peek's shape won, and
 * `test/wire-vectors.test.ts` pins the bytes both apps were producing *before*
 * the extraction so the merge cannot have moved either one.
 *
 * ## Pure, and global-free
 *
 * No signing, no I/O, no randomness, no ambient globals. That is what lets this
 * run in Convex's default runtime, in a browser bundle, and under `tsx` from the
 * same published artifact. Signing lives in `./sign.ts`, which needs entropy.
 */
import { sha256 } from '@noble/hashes/sha256'
import { bytesToHex, utf8ToBytes } from '@noble/hashes/utils'
import { type BlockDocument, serializeBlockDocument } from './blocks.js'

/** A Nostr tag: an array of strings whose first element is the tag name. */
export type NostrTag = string[]

/** An event before signing. `pubkey` is 64-char lowercase hex. */
export interface UnsignedEvent {
  pubkey: string
  created_at: number
  kind: number
  tags: NostrTag[]
  content: string
}

/** A signed event, ready to submit to the relay. */
export interface SignedEvent extends UnsignedEvent {
  id: string
  sig: string
}

/**
 * Buzz kind numbers used across the suite (crates/buzz-core/src/kind.rs).
 *
 * The union of what Peek and Ship each declared before SHA-3. A kind number is
 * a fact about the relay, not about an app, so there is no reason for two apps
 * to hold different subsets of it — and a subset is how an app ends up unable to
 * *read* a kind its neighbour writes.
 */
export const KIND = {
  PROFILE: 0,
  DELETION: 5,
  REACTION: 7,
  STREAM_MESSAGE: 9,
  NIP29_PUT_USER: 9000,
  NIP29_EDIT_METADATA: 9002,
  NIP29_CREATE_GROUP: 9007,
  NIP29_DELETE_GROUP: 9008,
  /**
   * Estiva assertion — a statement *about* something in the channel, rather
   * than a message in it (PEEK-128). `resolution` is the first and, for now,
   * only subtype; the `t` tag names it so later subtypes can join without a
   * new kind.
   *
   * The number sits in the **regular** range (1000–9999), which is what makes
   * it stored and append-only. A replaceable kind would overwrite the previous
   * assertion and destroy exactly the history this exists to keep. It clears
   * NIP-29's 9000–9030 block on purpose.
   */
  ASSERTION: 9101,
  /**
   * NIP-22 comment (REW-10). Ship's comments are posted into the project's
   * Folder — which *is* a Peek topic's channel — so they arrive in a channel as
   * ordinary messages and must be read alongside `STREAM_MESSAGE`.
   *
   * Both kinds, permanently: a `kind:9` is not replaceable, so every comment
   * written before Ship flipped stays `kind:9` forever and this pair can never
   * shrink to one.
   */
  COMMENT: 1111,
  /** NIP-84 highlight. */
  HIGHLIGHT: 9802,
  /**
   * NIP-78 arbitrary custom app data — and **it is not reserved for read state**,
   * despite the relay naming its own constant `KIND_READ_STATE`.
   *
   * The relay's NIP-RS handling is a narrow predicate: kind 30078, exactly one
   * `d` matching `read-state:<32 lowercase hex>`, and exactly one
   * `["t","read-state"]`. Ingest performs no other `d`-tag validation on the
   * kind, so anything outside that predicate is an ordinary addressable event
   * with ordinary replaceable semantics.
   *
   * Two uses in the suite, and the constant is here so neither invents its own
   * number: NIP-RS read state (SPEC §11.6) and app-private user-owned storage
   * (SPEC §12). A `d` beginning `read-state:` brings hard-deletion of superseded
   * blobs with it, which is a property app data must not acquire by accident.
   */
  APP_DATA: 30078,
  /** NIP-FC File — see docs/buzz-compat/nips/NIP-FC.md in the Peek repo. */
  FILE: 30840,
  /** NIP-FC Component. */
  COMPONENT: 30841,
  /**
   * NIP-42 relay auth — the challenge response that turns a connected socket
   * into an authenticated one (`Kind::Authentication`, PEE-5).
   *
   * Unlike every other kind here, this one is **never published**: Buzz builds
   * it into `buzz-auth/src/nip42.rs`, never stores it, and never logs it —
   * "AUTH events are never stored or logged (may contain bearer tokens)" is a
   * comment in that file. It goes over the socket and is gone.
   */
  RELAY_AUTH: 22242,
  HTTP_AUTH: 27235,
  /**
   * Blossom authorization (BUD-01/BUD-11) — `HTTP_AUTH` for blobs.
   *
   * Never stored and never published: it is signed, carried in an
   * `Authorization: Nostr <base64url(event)>` header, and read once. See
   * `media.ts`, which builds it and the `imeta` tag that references the blob.
   */
  BLOSSOM_AUTH: 24242,
  /**
   * Buzz's message edit (`KIND_STREAM_MESSAGE_EDIT`) — RFC 0.4 §7.2.1.
   *
   * A `kind:9` and a `kind:1111` are both non-replaceable, so an edit cannot
   * overwrite what it edits. It is a separate event naming its target, and what
   * an app shows as "edited" is a fold over the pair.
   *
   * **Channel-scoped.** 40003 is in the relay's `requires_h_channel_scope`, so
   * an edit without an `h` comes back `accepted: false` even when the kind is
   * granted and the signature is fine — two gates, and the kind ceiling is only
   * the first.
   */
  MESSAGE_EDIT: 40003,
  /**
   * Open a DM — `KIND_DM_OPEN` (`buzz-core/src/kind.rs:423`).
   *
   * A **command**, not a record, and the difference decides how a client uses
   * it. There is no `h`, because the channel does not exist yet and the client
   * does not choose its id: the relay mints it and answers with it. A topic
   * mints its own uuid client-side and creates it with a `9007`; a DM cannot,
   * and {@link buildDmOpen} is the whole of the client's side of that.
   *
   * **The uuid is random, and only the lookup is by participants.**
   * `create_dm` takes `Uuid::new_v4()` (`buzz-db/src/dm.rs`); what
   * `compute_participant_hash` — sha256 over the sorted, deduplicated pubkey
   * bytes of self + the `p` tags — produces is the *key* `find_dm_by_participants`
   * resolves, not the id itself. So re-opening is idempotent, because the same
   * participants always hash to the same row and therefore name the same
   * channel; but the uuid cannot be computed offline from the participants,
   * and a client that tried would be inventing a channel nobody else has.
   *
   * Idempotence is what the caller gets to rely on: "message this person" never
   * has to ask whether a DM already exists. Publish and use what comes back —
   * see `commandPayload`, including the one case where nothing comes back.
   */
  DM_OPEN: 41010,
  /**
   * Hide a DM from the signer's own sidebar — `KIND_DM_HIDE`
   * (`buzz-core/src/kind.rs`). A command like {@link KIND.DM_OPEN}: one `h`
   * naming the DM channel, no content, and the caller must be a member of it.
   *
   * **Hiding is neither leaving nor deleting.** `handle_dm_hide` sets the
   * caller's own `hidden_at` on their membership row and nothing else: the
   * channel, every participant and every message survive, and the other
   * participants are not told. What changes is the signer's
   * {@link KIND.DM_VISIBILITY} snapshot, which the relay republishes after the
   * hide.
   *
   * **There is no unhide command.** `open_dm` clears the caller's `hidden_at`
   * when the DM already exists (`buzz-db/src/dm.rs`), so re-publishing the
   * same {@link buildDmOpen} is how a hidden DM comes back — the relay
   * republishes the snapshot on that path too. A message arriving in a hidden
   * DM does *not* resurface it: nothing on the `kind:9` path touches
   * `hidden_at`.
   */
  DM_HIDE: 41012,
  /**
   * The relay's per-viewer hidden-DM set — `KIND_DM_VISIBILITY`
   * (`buzz-core/src/kind.rs`). **Relay-signed, and only ever read.** There is
   * no builder for it here on purpose: `ingest.rs` refuses a client-authored
   * one, and an app that signed one would be forging the relay's answer.
   *
   * Parameterized replaceable with `d` = the viewer's pubkey, carrying one `h`
   * per hidden DM channel and a `p` = the viewer. It is result-gated on that
   * `p` (`RESULT_GATED_KINDS`, `filter.rs:reader_authorized_for_event`): the
   * read that works is `{ kinds: [30622], '#p': [me], limit: 1 }`, and a
   * `#p` naming anybody else is refused rather than answered empty.
   *
   * The newest event is the whole set. The relay writes it again after every
   * hide and every re-open, so a client applies the latest one wholesale and
   * never merges successive snapshots.
   */
  DM_VISIBILITY: 30622,
} as const

/** `build_reaction` (builders.rs:463) caps the emoji at 64 chars. */
export const MAX_EMOJI_CHARS = 64

/** kind:9 content cap — `check_content(content, 64 * 1024)` in build_message. */
export const MAX_MESSAGE_BYTES = 64 * 1024

/** `mention_tags` in builders.rs rejects more than this many mentions. */
export const MAX_MENTIONS = 50

/**
 * NIP-01 event id: sha256 over the canonical serialization
 * `[0, pubkey, created_at, kind, tags, content]`.
 *
 * `JSON.stringify` produces exactly the escaping NIP-01 requires (`\n`, `\"`,
 * `\\`, `\r`, `\t`, `\b`, `\f`, `\uXXXX` for other control chars) with no
 * insignificant whitespace, so no custom serializer is needed.
 *
 * Cross-checked against `nostr-tools/pure`'s `getEventHash` over 103 events
 * recorded from production: all 103 ids agree. See `test/oracle.test.ts` — the
 * third-party implementation is a devDependency of this package and a dependency
 * of nothing, so the check costs consumers no bytes.
 */
export function computeEventId(e: UnsignedEvent): string {
  const serialized = JSON.stringify([0, e.pubkey, e.created_at, e.kind, e.tags, e.content])
  return bytesToHex(sha256(utf8ToBytes(serialized)))
}

/** Apps store ms; Nostr `created_at` is seconds. */
export function toNostrSeconds(ms: number): number {
  return Math.floor(ms / 1000)
}

function assertHex64(value: string, label: string): void {
  if (!/^[0-9a-f]{64}$/.test(value)) {
    throw new Error(`${label} must be 64 lowercase hex chars, got: ${value.slice(0, 16)}…`)
  }
}

/**
 * Buzz's `canonical_channel_name` (crates/buzz-core/src/channel.rs:15):
 * strip leading '#' and whitespace, then trim the end. Applied by
 * `build_create_channel` before the name reaches the tag, so we must match it or
 * our ids diverge for any title with a leading '#' or space.
 */
export function canonicalChannelName(name: string): string {
  return name.replace(/^[#\s]+/, '').replace(/\s+$/, '')
}

/** NIP-01 addressable reference: `<kind>:<pubkey>:<d-tag>`. */
export function addr(kind: number, pubkey: string, dTag: string): string {
  return `${kind}:${pubkey}:${dTag}`
}

/**
 * kind:0 profile — mirrors `build_profile` (builders.rs:537).
 *
 * Buzz builds the content with `serde_json::Map`, which is a `BTreeMap` unless
 * the `preserve_order` feature is enabled. It is not enabled in Buzz's
 * workspace, so **keys serialize in alphabetical order**: about, display_name,
 * name, nip05, picture. We sort to match; getting this wrong changes the content
 * string and therefore the event id.
 *
 * An app must not call this: the identity service is the sole publisher of
 * `kind:0` and refuses it for every app before consulting any allowlist
 * (SPEC §4.2). It is here because the *identity service* and the seed scripts
 * need it, and because a second copy of this key ordering is the kind of thing
 * that drifts.
 */
export function buildProfile(
  pubkey: string,
  createdAtMs: number,
  fields: {
    display_name?: string
    name?: string
    picture?: string
    about?: string
    nip05?: string
  },
): UnsignedEvent {
  assertHex64(pubkey, 'pubkey')
  const present = Object.entries(fields).filter(([, v]) => v !== undefined && v !== '')
  present.sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
  const content = `{${present.map(([k, v]) => `${JSON.stringify(k)}:${JSON.stringify(v)}`).join(',')}}`
  return {
    pubkey,
    created_at: toNostrSeconds(createdAtMs),
    kind: KIND.PROFILE,
    tags: [],
    content,
  }
}

/** Who a pubkey belongs to, as far as the relay knows. */
export interface Profile {
  /** kind:0 `display_name` or `name`. Absent when nobody has published one. */
  displayName?: string
  /** kind:0 `picture` — an avatar URL chosen by whichever app published it. */
  picture?: string
}

/**
 * The inverse of `buildProfile`: a kind:0 event to the fields an app shows.
 *
 * Both name keys are read because both are written: Peek publishes
 * `display_name`, Ship publishes `name`, and a person who has used both apps
 * should resolve either way rather than on a coin flip. Anything that will not
 * parse costs a name, never the read that asked for it.
 *
 * One parser is what keeps a person from having two names depending on which
 * app they appear in — which is the whole reason this is not left to each
 * consumer.
 */
export function parseProfile(event: { content: string } | undefined): Profile {
  if (!event) return {}
  try {
    const meta = JSON.parse(event.content)
    const str = (value: unknown) => (typeof value === 'string' && value ? value : undefined)
    return { displayName: str(meta.display_name) ?? str(meta.name), picture: str(meta.picture) }
  } catch {
    return {}
  }
}

export type ChannelVisibility = 'open' | 'private'
export type ChannelKind = 'stream' | 'forum' | 'dm'

/**
 * kind:9007 create channel — mirrors `build_create_channel` (builders.rs:674).
 * Tag order is fixed: h, name, [visibility], [channel_type], [about], [ttl].
 */
export function buildCreateChannel(
  pubkey: string,
  createdAtMs: number,
  args: {
    channelUuid: string
    name: string
    visibility?: ChannelVisibility
    channelType?: ChannelKind
    about?: string
    ttlSeconds?: number
  },
): UnsignedEvent {
  assertHex64(pubkey, 'pubkey')
  const name = canonicalChannelName(args.name)
  if (name.trim() === '') throw new Error('channel name is required')
  const tags: NostrTag[] = [
    ['h', args.channelUuid],
    ['name', name],
  ]
  if (args.visibility) tags.push(['visibility', args.visibility])
  if (args.channelType) tags.push(['channel_type', args.channelType])
  if (args.about) tags.push(['about', args.about])
  if (args.ttlSeconds !== undefined) tags.push(['ttl', String(args.ttlSeconds)])
  return {
    pubkey,
    created_at: toNostrSeconds(createdAtMs),
    kind: KIND.NIP29_CREATE_GROUP,
    tags,
    content: '',
  }
}

/**
 * kind:9008 NIP-29 delete-group — what makes a deleted container actually gone.
 *
 * Deleting a topic in Peek used to remove it and its messages from Convex and
 * publish nothing at all. Create propagated as a 9007; delete propagated
 * nowhere. So a conversation somebody deleted, believing it gone, stayed
 * readable to every admitted member indefinitely — measured on production at 145
 * messages across 37 channels with zero deletion requests against any of them
 * (PEEK-170).
 *
 * **9008 rather than a kind:5 per message**, and the difference is capability
 * rather than efficiency. Buzz rejects a multi-target kind:5 outright, and
 * NIP-09 is honoured only for the key that signed the original — so
 * per-message deletion could never reach anybody else's messages in the
 * container. Delete-group soft-deletes the channel, and Buzz's read guards
 * (`c.deleted_at IS NULL` in both `get_accessible_channels` and `is_member`)
 * then hide the whole container regardless of who wrote what is in it.
 *
 * Requires the channel's **owner** — Buzz enforces "only owner can delete
 * group" in `validate_admin_event`, and a container's creator becomes its owner
 * at create. Anybody else is refused, which the caller reports rather than hides.
 */
export function buildDeleteChannel(
  pubkey: string,
  createdAtMs: number,
  args: { channelUuid: string },
): UnsignedEvent {
  assertHex64(pubkey, 'pubkey')
  return {
    pubkey,
    created_at: toNostrSeconds(createdAtMs),
    kind: KIND.NIP29_DELETE_GROUP,
    tags: [['h', args.channelUuid]],
    content: '',
  }
}

/**
 * kind:9002 edit metadata — renaming a channel (PEE-2).
 *
 * Buzz applies each recognised tag it finds (`name`, `about`, `archived`,
 * `topic`, `purpose`, `visibility`, `ttl`) and refuses an event carrying none
 * of them, so this builds exactly the fields asked for and nothing else.
 *
 * The name goes through `canonicalChannelName` for the same reason
 * `buildCreateChannel` does: Buzz canonicalises before storing, so sending the
 * raw string means the app and the relay disagree about what the container is
 * called. A name that canonicalises away to nothing is not a rename, and
 * throwing here is better than a round trip to be told so.
 *
 * Requires the channel's owner or admin — the relay refuses anyone else.
 */
export function buildEditChannelMetadata(
  pubkey: string,
  createdAtMs: number,
  args: { channelUuid: string; name?: string; about?: string },
): UnsignedEvent {
  assertHex64(pubkey, 'pubkey')
  const tags: NostrTag[] = [['h', args.channelUuid]]
  if (args.name !== undefined) {
    const name = canonicalChannelName(args.name)
    if (name.trim() === '') throw new Error('channel name is required')
    tags.push(['name', name])
  }
  if (args.about !== undefined) tags.push(['about', args.about])
  if (tags.length === 1) throw new Error('nothing to edit')
  return {
    pubkey,
    created_at: toNostrSeconds(createdAtMs),
    kind: KIND.NIP29_EDIT_METADATA,
    tags,
    content: '',
  }
}

export type MemberRole = 'owner' | 'admin' | 'member'

/**
 * kind:9000 add member — mirrors `build_add_member` (builders.rs:565).
 * Tag order: h, p, [role]. The target pubkey is lowercased by Buzz.
 */
export function buildAddMember(
  pubkey: string,
  createdAtMs: number,
  args: { channelUuid: string; targetPubkey: string; role?: MemberRole },
): UnsignedEvent {
  assertHex64(pubkey, 'pubkey')
  const target = args.targetPubkey.toLowerCase()
  assertHex64(target, 'targetPubkey')
  const tags: NostrTag[] = [
    ['h', args.channelUuid],
    ['p', target],
  ]
  if (args.role) tags.push(['role', args.role])
  return {
    pubkey,
    created_at: toNostrSeconds(createdAtMs),
    kind: KIND.NIP29_PUT_USER,
    tags,
    content: '',
  }
}

/** `handle_dm_open` (command_executor.rs:328) rejects more than this many `p` tags. */
export const MAX_DM_OTHERS = 8

/**
 * kind:41010 open a DM — mirrors `build_dm_open` (builders.rs:1544).
 *
 * One `p` per **other** participant, in the order given; no `h`, no content.
 *
 * **Do not include your own pubkey.** The relay adds the signer to the set
 * itself, so passing it once is harmless — `handle_dm_open` deduplicates before
 * hashing — but it spends one of the eight slots the relay counts, because the
 * cap is checked on the `p` tags as sent, before deduplication.
 *
 * The cap is rejected here rather than by the relay so nine participants fail
 * where the caller can say something useful about it, instead of arriving as
 * `invalid: pubkeys may contain at most 8 other participants` after a round
 * trip. `p_tags.is_empty()` is refused the same way.
 */
export function buildDmOpen(pubkey: string, createdAtMs: number, args: { otherPubkeys: string[] }): UnsignedEvent {
  assertHex64(pubkey, 'pubkey')
  const others = args.otherPubkeys.map((p) => p.toLowerCase())
  if (others.length === 0) throw new Error('a DM needs at least one other participant')
  if (others.length > MAX_DM_OTHERS) {
    throw new Error(`a DM takes at most ${MAX_DM_OTHERS} other participants (${others.length} given)`)
  }
  for (const other of others) assertHex64(other, 'otherPubkey')
  return {
    pubkey,
    created_at: toNostrSeconds(createdAtMs),
    kind: KIND.DM_OPEN,
    tags: others.map((other): NostrTag => ['p', other]),
    content: '',
  }
}

/**
 * kind:41012 hide a DM — mirrors `build_dm_hide` (`desktop/src-tauri/src/events.rs`).
 *
 * One `h` naming the DM channel, no content. The channel uuid is the one the
 * relay answered a {@link buildDmOpen} with — there is no other way to hold
 * one — and the relay rejects the hide unless the signer is a member of it.
 *
 * Undone by publishing the same `buildDmOpen` again, not by any event of this
 * kind: see {@link KIND.DM_HIDE}.
 */
export function buildDmHide(pubkey: string, createdAtMs: number, args: { channelUuid: string }): UnsignedEvent {
  assertHex64(pubkey, 'pubkey')
  if (!args.channelUuid) throw new Error('a DM hide names the channel to hide')
  return {
    pubkey,
    created_at: toNostrSeconds(createdAtMs),
    kind: KIND.DM_HIDE,
    tags: [['h', args.channelUuid]],
    content: '',
  }
}

/**
 * kind:7 reaction — mirrors `build_reaction` (builders.rs:463).
 *
 * Note there is **no `h` tag**: Buzz derives the channel from the *target's*
 * `#e` tag and explicitly ignores a client-supplied `#h` (`NOSTR.md`). Adding one
 * would change the event id for no benefit.
 */
export function buildReaction(
  pubkey: string,
  createdAtMs: number,
  args: { targetEventId: string; emoji: string },
): UnsignedEvent {
  assertHex64(pubkey, 'pubkey')
  assertHex64(args.targetEventId, 'targetEventId')
  if ([...args.emoji].length > MAX_EMOJI_CHARS) {
    throw new Error(`emoji longer than ${MAX_EMOJI_CHARS} chars`)
  }
  return {
    pubkey,
    created_at: toNostrSeconds(createdAtMs),
    kind: KIND.REACTION,
    tags: [['e', args.targetEventId]],
    content: args.emoji,
  }
}

/**
 * kind:5 deletion — mirrors `build_remove_reaction` (builders.rs:495).
 *
 * A NIP-09 *request*: it removes the record rather than the work, and a relay
 * may decline it.
 *
 * **It is not author-scoped**, and this comment said it was until 2026-09-07.
 * `validate_standard_deletion_event` accepts the target's **effective** author
 * *or* the NIP-OA owner of an authoring agent, on the `a` branch and the `e`
 * branch alike. And no client can evaluate the second half — ownership is
 * written from the attestation and read server-side only — so an app MUST NOT
 * gate the control on an author check of its own; it offers it, attempts the
 * write, and reports the refusal (SPEC §6.5, corrected).
 *
 * That the wrong rule sat *here* is why it is worth calling out: this package
 * is what a third app reads, so a mistaken MUST propagates to every adopter
 * before anyone notices.
 */
export function buildDeletion(
  pubkey: string,
  createdAtMs: number,
  args: { targetEventId: string },
): UnsignedEvent {
  assertHex64(pubkey, 'pubkey')
  assertHex64(args.targetEventId, 'targetEventId')
  return {
    pubkey,
    created_at: toNostrSeconds(createdAtMs),
    kind: KIND.DELETION,
    tags: [['e', args.targetEventId]],
    content: '',
  }
}

/**
 * kind:40003 message edit — mirrors `build_edit` (builders.rs:378), plus `ts`.
 *
 * An edit never rewrites. `kind:9` and `kind:1111` are non-replaceable, so this
 * is a separate event naming its target, and what a reader shows as "edited" is
 * a fold over the pair — latest edit wins.
 *
 * ## `ts`, and why this adds a tag Buzz's builder does not
 *
 * `build_edit` emits `h` and `e` only, which leaves two edits published in the
 * same second with no defined order. That is worse here than for a change
 * event: `kind:1851` is last-write-wins **per field**, so a collision costs one
 * field, whereas two disagreeing edits of one message resolve to whichever the
 * reader happens to sort first.
 *
 * So an edit carries `ts` in epoch **milliseconds**, under exactly the rule
 * SPEC §6.2 already gives it: a reader honours `ts` only when it agrees with
 * `created_at` to the second, and ignores it otherwise. An app that does not
 * implement `ts` still folds correctly, at one-second resolution.
 *
 * Adding a tag the relay has no rule for is safe in the direction that matters
 * — it validates the kind, the `h` and the ownership, and ignores the rest.
 *
 * ## Who may edit is the relay's answer
 *
 * `validate_edit_ownership` accepts the target's effective author or the NIP-OA
 * owner of an authoring agent, and on the author path re-checks channel
 * membership — so somebody removed from a private channel cannot go back and
 * rewrite what they said while they were in it. No client can evaluate that, so
 * an app MUST NOT gate the control on an author check of its own. Same rule as
 * `buildDeletion` above, and wrong in the same way until it was corrected.
 *
 * ## The `h` is required
 *
 * 40003 is in the relay's `requires_h_channel_scope`. An edit without one is
 * refused with `accepted: false` while the kind is granted and the signature is
 * fine — which is why it is an argument here rather than an option.
 */
export function buildEdit(
  pubkey: string,
  createdAtMs: number,
  args: {
    /** The target's channel. REQUIRED — see above. */
    channelUuid: string
    /** The event being edited. */
    targetEventId: string
    /** The new body, in the target's own format. */
    body: string
  },
): UnsignedEvent {
  assertHex64(pubkey, 'pubkey')
  assertHex64(args.targetEventId, 'targetEventId')
  const bytes = utf8ToBytes(args.body).length
  if (bytes > MAX_MESSAGE_BYTES) {
    throw new Error(`content is ${bytes} bytes, max ${MAX_MESSAGE_BYTES}`)
  }
  return {
    pubkey,
    created_at: toNostrSeconds(createdAtMs),
    kind: KIND.MESSAGE_EDIT,
    tags: [
      ['h', args.channelUuid],
      ['e', args.targetEventId],
      // Floor, not round: `created_at` is `toNostrSeconds` of the same instant,
      // and a rounded `ts` could land in the next second and be discarded by
      // its own agreement rule.
      ['ts', String(Math.floor(createdAtMs))],
    ],
    content: args.body,
  }
}

/**
 * NIP-10 reply context.
 *
 * Mirrors Buzz's `ThreadRef` + `thread_tags` (builders.rs:173), which has a
 * detail that is easy to get wrong: for a **direct** reply (parent is the root)
 * Buzz emits a SINGLE tag marked `"reply"` — not a `"root"` tag. Only a nested
 * reply emits both. Getting this wrong changes the event id and, worse, produces
 * threads Buzz's clients read differently.
 */
export interface ThreadRef {
  /** Thread root event id (64-hex). */
  rootId: string
  /** Direct parent event id. Equal to `rootId` for a direct reply. */
  parentId: string
}

/** Exactly Buzz's `thread_tags` (builders.rs:173). */
export function threadTags(ref: ThreadRef): NostrTag[] {
  if (ref.rootId === ref.parentId) {
    return [['e', ref.rootId, '', 'reply']]
  }
  return [
    ['e', ref.rootId, '', 'root'],
    ['e', ref.parentId, '', 'reply'],
  ]
}

/**
 * kind:9 stream message — mirrors `build_message` (builders.rs:219).
 * Tag order: h, [thread tags], [a about], [p mentions], [broadcast], [imeta].
 *
 * **This is the shape verified byte-identical against Buzz's SDK** — see Peek's
 * docs/buzz-compat/INTEROP_PROOF.md §4.
 *
 * **`about` is where the two copies had drifted.** Peek grew it so a pasted
 * NIP-19 pointer could carry its address as an `a` tag and Ship could route the
 * conversation to the issue directly; Ship's copy never received it and could
 * not emit one at all. Peek's shape is what ships. Omitting `about` produces
 * byte-identical output to Ship's old builder — pinned by
 * `test/wire-vectors.test.ts`, because "the change is a no-op for Ship" is
 * exactly the kind of claim that deserves a fixture rather than a sentence.
 */
export function buildMessage(
  pubkey: string,
  createdAtMs: number,
  args: {
    channelUuid: string
    content: string
    threadRef?: ThreadRef
    /** Addressable objects this conversation concerns (for cross-app routing). */
    about?: string[]
    /** Mentioned pubkeys (64-hex). Deduplicated, lowercased, capped at 50. */
    mentions?: string[]
    broadcast?: boolean
    /** Raw `imeta` tag vectors for media attachments. */
    mediaTags?: NostrTag[]
  },
): UnsignedEvent {
  assertHex64(pubkey, 'pubkey')
  const bytes = utf8ToBytes(args.content).length
  if (bytes > MAX_MESSAGE_BYTES) {
    throw new Error(`content is ${bytes} bytes, max ${MAX_MESSAGE_BYTES}`)
  }

  const tags: NostrTag[] = [['h', args.channelUuid]]

  if (args.threadRef) tags.push(...threadTags(args.threadRef))

  // Keep a pasted NIP-19 pointer in content for portable display, and carry
  // its address here so a consumer can route the conversation to the object.
  for (const address of [...new Set(args.about ?? [])]) tags.push(['a', address])

  if (args.mentions && args.mentions.length > 0) {
    if (args.mentions.length > MAX_MENTIONS) {
      throw new Error(`too many mentions: ${args.mentions.length} > ${MAX_MENTIONS}`)
    }
    const seen = new Set<string>()
    for (const hex of args.mentions) {
      const lower = hex.toLowerCase()
      assertHex64(lower, 'mention pubkey')
      if (!seen.has(lower)) {
        seen.add(lower)
        tags.push(['p', lower])
      }
    }
  }

  if (args.broadcast) tags.push(['broadcast', '1'])
  for (const mt of args.mediaTags ?? []) tags.push(mt)

  return {
    pubkey,
    created_at: toNostrSeconds(createdAtMs),
    kind: KIND.STREAM_MESSAGE,
    tags,
    content: args.content,
  }
}

/** Assertion subtypes. Only `resolution` exists today (PEEK-128). */
export const ASSERTION_SUBTYPE = { RESOLUTION: 'resolution' } as const

/** What a resolution assertion says happened. */
export type ResolutionAction = 'resolved' | 'reopened'

/** Rationale cap — the same 64 KiB ceiling a message content carries. */
export const MAX_RATIONALE_BYTES = MAX_MESSAGE_BYTES

/**
 * kind:9101 resolution assertion — "this thread is resolved", said on the wire
 * so any Estiva app reading the channel can see it (PEEK-128).
 *
 * **Append-only.** A reopen is another assertion, never a deletion of the
 * resolve that preceded it; current state is folded from the ordered run, not
 * read off a single canonical event. That is why this is a regular kind rather
 * than a replaceable one — see `KIND.ASSERTION`.
 *
 * The event carries the claim and who made it. It does **not** carry authority:
 * there is no "proposed" or "endorsed" mode here, because how much weight a
 * given actor's assertion deserves is a policy question that belongs to the app
 * reading it, not to the protocol. That is also why the *fold* of these
 * assertions is not in this package — see the README on the line this package
 * does not cross.
 *
 * Tag order is fixed so the event id is reproducible: h, e(target), t, action,
 * [e(support)].
 */
export function buildResolution(
  pubkey: string,
  createdAtMs: number,
  args: {
    channelUuid: string
    /** Event id of the message whose resolution state this asserts. */
    targetEventId: string
    action: ResolutionAction
    /** Optional reply that carried the resolution, for readers that want it. */
    supportingEventId?: string
    /** Optional free text. */
    rationale?: string
  },
): UnsignedEvent {
  assertHex64(pubkey, 'pubkey')
  assertHex64(args.targetEventId, 'targetEventId')
  if (args.supportingEventId) assertHex64(args.supportingEventId, 'supportingEventId')
  if (args.action !== 'resolved' && args.action !== 'reopened') {
    throw new Error(`unknown resolution action: ${String(args.action)}`)
  }
  const rationale = args.rationale ?? ''
  const bytes = utf8ToBytes(rationale).length
  if (bytes > MAX_RATIONALE_BYTES) {
    throw new Error(`rationale is ${bytes} bytes, max ${MAX_RATIONALE_BYTES}`)
  }

  const tags: NostrTag[] = [
    ['h', args.channelUuid],
    ['e', args.targetEventId],
    ['t', ASSERTION_SUBTYPE.RESOLUTION],
    ['action', args.action],
  ]
  // Marked so a reader can tell the supporting reply from the target, which
  // share the `e` tag name.
  if (args.supportingEventId) tags.push(['e', args.supportingEventId, '', 'support'])

  return {
    pubkey,
    created_at: toNostrSeconds(createdAtMs),
    kind: KIND.ASSERTION,
    tags,
    content: rationale,
  }
}

/** NIP-32 self-label: a namespace and a value, both indexable. */
export interface Label {
  /** Namespace, e.g. "nfb.highlight". */
  namespace: string
  /** Value within that namespace, e.g. "insight". */
  value: string
}

/**
 * kind:30840 — the bare file. SPEC §6.7, decided in RFC 0.5 §10.7.
 *
 * A file **no app owns**. A Peek topic is one; so is any subject nobody has
 * built a specialized app for. Typed kinds — a project, an issue — add
 * properties on top of this shape; the bare file adds none, and that absence is
 * the point: its projection is built into `@estiva-app/interop` rather than
 * published, so no `kind:31990` can claim it.
 *
 * **Tag order is normative** (SPEC §6.1 — it is part of the id preimage):
 * `d`, `title`, `h`, then `a` if the file sits under another. The `h` is
 * REQUIRED by SPEC even though the relay only says SHOULD: several apps write
 * bare files, and one forgetting it would put an unreachable object in the
 * shared space, which is the argument the relay already makes for issues.
 *
 * The parent may be of **any kind** — a project, an issue, another bare file,
 * or a kind this package has never heard of. Re-parenting later is a `parent`
 * change event (`kind:1851`), not a republish; the root tag seeds the value.
 *
 * `content` is a §13.3 block document, or empty. A topic that is only a
 * conversation has nothing here; the day somebody types a brief at the top,
 * this is where it goes, and nothing about the file "converts".
 *
 * This replaces the NIP-FC `buildFile`, whose component list was made
 * redundant by blocks having ids (RIC-5) and attachments being blocks
 * (RFC 0.6 §3). Zero NIP-FC files existed on production when the shape
 * changed (measured 2026-09-10), and no consumer called the old builder.
 */
export function buildBareFile(
  pubkey: string,
  createdAtMs: number,
  args: {
    /** Stable id, an opaque uuid (RFC 0.4 §4.3). Never a slug. */
    fileId: string
    title: string
    /** The team's channel. Required — see above. */
    channelUuid: string
    /** Address of the file this one sits under, of any kind. At most one. */
    parent?: string
    /** The body, when there is one. Serialized with `serializeBlockDocument`. */
    document?: BlockDocument
  },
): UnsignedEvent {
  assertHex64(pubkey, 'pubkey')
  if (!args.channelUuid) throw new Error('a bare file must name the team channel it lives in (h)')
  if (args.parent !== undefined && !/^\d+:[0-9a-f]{64}:/.test(args.parent)) {
    throw new Error(`parent must be an address "<kind>:<pubkey>:<d>", got "${args.parent}"`)
  }
  const tags: NostrTag[] = [
    ['d', args.fileId],
    ['title', args.title],
    ['h', args.channelUuid],
  ]
  if (args.parent) tags.push(['a', args.parent])
  return {
    pubkey,
    created_at: toNostrSeconds(createdAtMs),
    kind: KIND.FILE,
    tags,
    content: args.document ? serializeBlockDocument(args.document) : '',
  }
}

/**
 * kind:30841 Component — NIP-FC.
 *
 * `type` must be namespaced `<namespace>/<name>`. The protocol defines the
 * container; the payload shape belongs to the type.
 *
 * @deprecated Nothing publishes one and nothing reads one: blocks carry their
 * own ids (SPEC §13.3), attachments are blocks (RFC 0.6 §3), and the bare file
 * above needs no component list. Kept until COM-3 decides whether `30841` is
 * retired or repurposed; do not build on it.
 */
export function buildComponent(
  pubkey: string,
  createdAtMs: number,
  args: {
    componentId: string
    /** Parent File's `d` tag. */
    fileId: string
    /** Namespaced, e.g. `nfb/todo`. */
    type: string
    payload: Record<string, unknown>
    channelUuid?: string
    labels?: Label[]
  },
): UnsignedEvent {
  assertHex64(pubkey, 'pubkey')
  if (!args.type.includes('/')) {
    throw new Error(`component type must be namespaced "<namespace>/<name>", got "${args.type}"`)
  }
  const tags: NostrTag[] = [
    ['d', args.componentId],
    ['a', addr(KIND.FILE, pubkey, args.fileId)],
    ['type', args.type],
  ]
  if (args.channelUuid) tags.push(['h', args.channelUuid])
  for (const label of args.labels ?? []) {
    tags.push(['L', label.namespace])
    tags.push(['l', label.value, label.namespace])
  }
  return {
    pubkey,
    created_at: toNostrSeconds(createdAtMs),
    kind: KIND.COMPONENT,
    tags,
    content: JSON.stringify(args.payload),
  }
}

/**
 * kind:9802 highlight — NIP-84.
 *
 * `.content` is the excerpt itself. `e`/`a` tags point at a source event, `r` at
 * a URL; `p` attributes the original author.
 *
 * Optional NIP-32 `L`/`l` self-labels categorise the highlight. NIP-32 §52
 * allows those tags on non-1985 events for exactly this ("self-reporting"), so
 * a highlight can say *what kind* of highlight it is without a bespoke kind.
 */
export function buildHighlight(
  pubkey: string,
  createdAtMs: number,
  args: {
    /** The excerpt. */
    content: string
    /** Channel to post into (Buzz scopes by `h`). */
    channelUuid?: string
    /** Source event being highlighted. */
    sourceEventId?: string
    /** Source URL, when the highlight came from outside Nostr. */
    sourceUrl?: string
    /** Original author(s) of the highlighted material. */
    attribution?: string[]
    labels?: Label[]
  },
): UnsignedEvent {
  assertHex64(pubkey, 'pubkey')
  const tags: NostrTag[] = []
  if (args.channelUuid) tags.push(['h', args.channelUuid])
  if (args.sourceEventId) {
    assertHex64(args.sourceEventId, 'sourceEventId')
    tags.push(['e', args.sourceEventId])
  }
  if (args.sourceUrl) tags.push(['r', args.sourceUrl])
  for (const p of args.attribution ?? []) {
    const lower = p.toLowerCase()
    assertHex64(lower, 'attribution pubkey')
    tags.push(['p', lower, '', 'author'])
  }
  // NIP-32: the `L` namespace declaration precedes its `l` values.
  for (const label of args.labels ?? []) {
    tags.push(['L', label.namespace])
    tags.push(['l', label.value, label.namespace])
  }
  return {
    pubkey,
    created_at: toNostrSeconds(createdAtMs),
    kind: KIND.HIGHLIGHT,
    tags,
    content: args.content,
  }
}

/**
 * The relay's clock tolerance for a NIP-42 AUTH event, in seconds.
 *
 * `TIMESTAMP_TOLERANCE_SECS` in `crates/buzz-auth/src/nip42.rs` — the same ±60s
 * NIP-98 uses, checked against the *relay's* clock. It is the one failure here
 * a correct client can still hit: a browser whose clock is more than a minute
 * out signs a perfectly valid event that is refused every time, and the socket
 * is left open and permanently unauthenticated rather than closed.
 */
export const RELAY_AUTH_TOLERANCE_SECS = 60

/**
 * The relay URL a NIP-42 `relay` tag must carry, as Buzz computes it.
 *
 * `nip42_expected_relay_url` (`buzz-relay/src/api/bridge.rs:225`) is literally
 * `format!("{scheme}://{}", tenant.host())` — scheme from the deployment, host
 * from **the tenant the connection arrived on**, never the deployment-wide
 * `config.relay_url`. Buzz has a test asserting exactly that
 * (`nip42_expected_relay_url_uses_tenant_host_not_config_host`), because it
 * regressed once.
 *
 * So: an origin, with no path and no trailing slash, derived from the URL we
 * actually connected to. `normalize_relay_url` on the relay side would forgive
 * a trailing slash, but it would not forgive a path or a different host.
 */
export function relayAuthUrl(connectUrl: string): string {
  return new URL(connectUrl).origin
}

/**
 * `URL` is not in `lib.es2022`, and this package compiles with `types: []` and
 * no `lib: dom` so that one published `.d.ts` works in Peek's Convex tree,
 * Peek's browser bundle and the agent's `tsx` run (ADR 0002 §4a).
 *
 * Declared **inside this module**, so nothing is added to the global scope of
 * any consumer, and read **inside a function body**, so importing this module
 * touches no global at all. Both matter: an eager `const C = URL` at module
 * scope would throw on import in a runtime that lacks it, which is the failure
 * `test/runtime-agnostic.test.ts` exists to catch.
 */
declare const URL: { new (raw: string): { origin: string } }

/**
 * An unsigned kind:22242 answering a relay's AUTH challenge.
 *
 * Built here rather than at a call site because the tag layout is part of the
 * event id preimage, and a second copy would be a silent divergence the relay
 * notices and we do not.
 *
 * **Tag order is not load-bearing for this one kind**, unusually for this file.
 * Buzz looks both tags up by name — `tags.find(TagKind::Challenge)` and
 * `tags.find(TagKind::Relay)` in `verify_nip42_event` — and the two reference
 * clients disagree anyway: rust-nostr's `EventBuilder::auth` emits challenge
 * first, nostr-tools' `makeAuthEvent` emits relay first. NIP-42's own example
 * uses relay-then-challenge, which is what this follows. Nothing downstream
 * compares this event's id to anything, because nothing ever stores it.
 */
export function buildUnsignedRelayAuthEvent(args: {
  /** Left empty for `/sign`, which overwrites it with the token's subject. */
  pubkey: string
  /** The URL the socket connected to. Reduced to an origin — see above. */
  relayUrl: string
  /** The challenge exactly as the relay sent it. Compared byte for byte. */
  challenge: string
  /** Override for tests; defaults to now. `Date.now` is in `lib.es2022`. */
  nowMs?: number
}): UnsignedEvent {
  return {
    pubkey: args.pubkey,
    created_at: Math.floor((args.nowMs ?? Date.now()) / 1000),
    kind: KIND.RELAY_AUTH,
    tags: [
      ['relay', relayAuthUrl(args.relayUrl)],
      ['challenge', args.challenge],
    ],
    content: '',
  }
}

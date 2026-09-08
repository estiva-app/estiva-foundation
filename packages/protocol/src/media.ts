/**
 * Blobs — Blossom authorization and the `imeta` tag that references one.
 *
 * ## Why this is here and not in an app
 *
 * A message's attachment has to be readable by an app that did not post it,
 * which is the whole of CON-12: Peek stored files in Convex, so every other
 * reader saw a message with nothing on it. The wire form is Buzz's own — a
 * content-addressed blob plus an `imeta` tag — and two apps writing that by
 * hand is exactly the drift SHA-3 spent 5,400 lines removing.
 *
 * Nothing here talks to the network. These are the bytes; the fetching belongs
 * to whoever holds a token.
 */
import type { NostrTag, SignedEvent, UnsignedEvent } from './events.js'
import { KIND, toNostrSeconds } from './events.js'
import { authorizationHeaderFor } from './nip98.js'

/** What a Blossom authorization permits. One verb per event. */
export type BlossomVerb = 'upload' | 'get' | 'list' | 'delete'

/** How long an authorization stays valid unless the caller says otherwise. */
export const BLOSSOM_AUTH_TTL_SECS = 300

/**
 * A `kind:24242` Blossom authorization — BUD-01/BUD-11.
 *
 * **It is `27235` for blobs.** Never stored and never published: signed, put in
 * an `Authorization: Nostr <base64url(event)>` header, read once and discarded.
 * `buildUnsignedAuthEvent` is its NIP-98 sibling and the same shape of thing.
 *
 * The relay verifies more of this than is obvious, and each of these is a
 * refusal rather than a default (`verify_blossom_auth_event_for_verb`):
 *
 * - **`content` must be non-empty.** BUD-11 calls it a human-readable string,
 *   and an empty one is rejected — the easiest of these to omit, because
 *   nothing reads it.
 * - **`t` must match the verb being attempted**, so an upload token cannot
 *   fetch and a fetch token cannot upload.
 * - **`expiration` is required and must be in the future.**
 * - **`created_at` must sit inside the window**: no more than 5 s ahead of the
 *   relay's clock, and no older than its `max_age` (3600 s for a GET).
 * - **`x` must include the blob's sha256** for an upload — BUD-11 §6 asks that
 *   *at least one* `x` matches, which is why this takes one and emits one.
 *
 * `server` is optional and omitted by default. The relay accepts a token with
 * no `server` tag; one that carries a *mismatched* host is refused, so a caller
 * that cannot be sure of the canonical host is safer leaving it out.
 */
export function buildBlossomAuth(
  pubkey: string,
  createdAtMs: number,
  args: {
    verb: BlossomVerb
    /** The blob, lowercase hex. */
    sha256: string
    /** Human-readable, and **required** — the relay refuses an empty one. */
    reason?: string
    /** Seconds from now. Defaults to {@link BLOSSOM_AUTH_TTL_SECS}. */
    ttlSecs?: number
    /** The relay's host, when the caller knows it canonically. */
    server?: string
  },
): UnsignedEvent {
  if (!/^[0-9a-f]{64}$/.test(args.sha256)) {
    throw new Error('sha256 must be 64 lowercase hex characters')
  }
  const createdAt = toNostrSeconds(createdAtMs)
  const tags: NostrTag[] = [
    ['t', args.verb],
    ['x', args.sha256],
    ['expiration', String(createdAt + (args.ttlSecs ?? BLOSSOM_AUTH_TTL_SECS))],
  ]
  if (args.server) tags.push(['server', args.server])
  return {
    pubkey,
    created_at: createdAt,
    kind: KIND.BLOSSOM_AUTH,
    tags,
    // Defaulted rather than left to the caller: an empty content is a refusal,
    // and the failure reads as a signature problem rather than a missing field.
    content: args.reason?.trim() || `${args.verb} blob`,
  }
}

/**
 * The header a Blossom request carries: `Nostr <base64(signed event JSON)>`.
 *
 * **The same encoding NIP-98 uses**, and deliberately the same function. BUD-01
 * specifies base64url-without-padding, so a first version of this hand-rolled
 * one — but the relay decodes `URL_SAFE_NO_PAD` and **falls back to `STANDARD`**
 * (`extract_blossom_auth`), so the encoder already in this package is accepted
 * as-is. One encoder, already covered by the NIP-98 tests, rather than a second
 * that differs only in its edge cases.
 */
export function blossomAuthHeader(signed: SignedEvent): string {
  return authorizationHeaderFor(signed)
}

/** What a message says about one attached blob. */
export interface Imeta {
  /** The relay-local path, e.g. `/media/<sha256>.jpg`. */
  url: string
  /** MIME type. */
  m: string
  /** sha256, lowercase hex — the blob's identity. */
  x: string
  /** Bytes. */
  size: number
  /** `<width>x<height>`, where the app knows it. */
  dim?: string
  /** Alt text. */
  alt?: string
  /** The relay's generated thumbnail path, `<sha256>.thumb.jpg`. */
  thumb?: string
  /** The name a person gave it. Display only — storage is content-addressed. */
  filename?: string
}

/**
 * One `imeta` tag — NIP-92, as Buzz validates it.
 *
 * Emitted as `["imeta", "url …", "m …", …]`: space-separated key/value pairs
 * inside a single tag, not one tag per field.
 *
 * The relay's allowlist is `url m x size dim blurhash alt thumb fallback
 * duration bitrate image filename`, each at most once, and it checks two things
 * this cannot: that `url` is a **local** `/media/` path, and — through
 * `verify_imeta_blobs` — that **the blob is already stored**. So the upload has
 * to land before the message that names it, and a dangling reference cannot be
 * published at all.
 */
export function imetaTag(meta: Imeta): NostrTag {
  const parts = [`url ${meta.url}`, `m ${meta.m}`, `x ${meta.x}`, `size ${meta.size}`]
  if (meta.dim) parts.push(`dim ${meta.dim}`)
  if (meta.alt) parts.push(`alt ${meta.alt}`)
  if (meta.thumb) parts.push(`thumb ${meta.thumb}`)
  if (meta.filename) parts.push(`filename ${meta.filename}`)
  return ['imeta', ...parts]
}

/**
 * Read the `imeta` tags off an event.
 *
 * The reader's half, and the reason this file is shared: Ship has to draw what
 * Peek attached without re-deriving the format. Anything missing the four
 * required fields is skipped rather than half-rendered — a tag the relay would
 * not have accepted is not one to guess at.
 */
export function imetaOf(event: { tags: NostrTag[] }): Imeta[] {
  const out: Imeta[] = []
  for (const tag of event.tags) {
    if (tag[0] !== 'imeta') continue
    const fields: Record<string, string> = {}
    for (const part of tag.slice(1)) {
      const space = part.indexOf(' ')
      if (space <= 0) continue
      const key = part.slice(0, space)
      // First wins: the relay rejects duplicates, so a second is a malformed
      // event rather than an override.
      if (!(key in fields)) fields[key] = part.slice(space + 1)
    }
    const size = Number.parseInt(fields.size ?? '', 10)
    if (!fields.url || !fields.m || !fields.x || !Number.isFinite(size)) continue
    out.push({
      url: fields.url,
      m: fields.m,
      x: fields.x,
      size,
      dim: fields.dim,
      alt: fields.alt,
      thumb: fields.thumb,
      filename: fields.filename,
    })
  }
  return out
}

/**
 * The sha256 a media path names.
 *
 * `/media/<sha256>.<ext>` and `/media/<sha256>.thumb.jpg` both answer the same
 * hash — the thumbnail is a derivative of its parent, and an authorization is
 * issued against the parent. Returns undefined for anything that is not
 * media-shaped, so a caller cannot accidentally sign for a path it misread.
 */
export function sha256FromMediaUrl(url: string): string | undefined {
  const afterMedia = url.split('/media/')[1]
  if (afterMedia === undefined) return undefined
  const hash = afterMedia.split('.')[0]
  return /^[0-9a-f]{64}$/.test(hash) ? hash : undefined
}

/** A response carrying bytes. Narrower than `Response`, so no DOM lib is needed. */
export interface BlobResponseLike {
  status: number
  arrayBuffer(): Promise<ArrayBuffer>
  text(): Promise<string>
  headers: { get(name: string): string | null }
}

/**
 * A transport that can return bytes.
 *
 * Separate from {@link FetchLike}, which `Relay` uses: that one sends a string
 * body and reads a string back, which is right for `POST /query` and cannot
 * express a binary GET. Widening it would change `Relay`'s contract for every
 * caller to serve this one.
 */
export type BlobFetchLike = (
  url: string,
  init: { method: string; headers: Record<string, string> },
) => Promise<BlobResponseLike>

/** See {@link BlobFetchLike}. Read inside the function, so importing touches no global. */
declare const fetch: BlobFetchLike

/** What came back, and what it is. */
export interface FetchedBlob {
  bytes: ArrayBuffer
  /** The relay's stored MIME, which is authoritative over anything a tag said. */
  contentType: string
}

/**
 * Fetch a blob the relay is holding — CON-12's read half.
 *
 * **An `<img src>` cannot do this**, which is the whole reason this exists.
 * Media GET is unconditionally authenticated on the deployed relay: the
 * `BUZZ_REQUIRE_MEDIA_GET_AUTH` flag reads like an opt-in and is inert, and a
 * GET with no header answers 401 rather than 404 (probed 2026-09-08). So every
 * reader — Peek showing its own attachment, Ship showing Peek's — has to sign a
 * `get` authorization, fetch, and turn the bytes into something renderable.
 *
 * Shared because both apps need exactly this and neither should re-derive it:
 * the hash the authorization must name is inside the path, the verb has to be
 * `get` rather than `upload`, and getting either wrong fails as a 401 that
 * looks like a session problem.
 *
 * Returns the bytes rather than an object URL: `URL.createObjectURL` is a DOM
 * API and its lifetime belongs to whoever will revoke it.
 */
export async function fetchBlob(args: {
  /** The relay origin, used when `url` is a bare `/media/…` path. */
  relayUrl: string
  /** `/media/<sha256>.<ext>`, or the absolute form of the same. */
  url: string
  sign: (unsigned: UnsignedEvent) => Promise<SignedEvent>
  pubkey: string
  transport?: BlobFetchLike
}): Promise<FetchedBlob> {
  const sha256 = sha256FromMediaUrl(args.url)
  if (!sha256) throw new Error(`not a media url: ${args.url}`)

  const auth = await args.sign(
    buildBlossomAuth(args.pubkey, Date.now(), { verb: 'get', sha256, reason: 'Read attachment' }),
  )

  const absolute = args.url.startsWith('http')
    ? args.url
    : `${args.relayUrl.replace(/\/+$/, '')}${args.url.startsWith('/') ? '' : '/'}${args.url}`

  const send = args.transport ?? fetch
  const response = await send(absolute, {
    method: 'GET',
    headers: { authorization: blossomAuthHeader(auth) },
  })
  if (response.status < 200 || response.status >= 300) {
    const detail = await response.text().catch(() => '')
    throw new Error(`blob read failed: ${response.status} ${detail.slice(0, 200)}`)
  }
  return {
    bytes: await response.arrayBuffer(),
    contentType: response.headers.get('content-type') ?? 'application/octet-stream',
  }
}

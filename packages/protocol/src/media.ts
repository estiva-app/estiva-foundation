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
import { sha256 } from '@noble/hashes/sha256'
import { bytesToHex } from '@noble/hashes/utils'

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

/**
 * The platform `fetch`, in the two shapes this file asks of it.
 *
 * An intersection rather than two declarations, because there is one global and
 * TypeScript will not let a module name it twice. It really does accept both
 * calls — a GET with no body and a PUT with bytes — so an overloaded type is
 * the accurate description rather than a convenience.
 *
 * Read inside a function, so importing this module touches no global.
 */
declare const fetch: BlobFetchLike & BlobUploadFetchLike

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

/**
 * A blob's identity: its sha256, lowercase hex.
 *
 * `@noble/hashes` rather than `crypto.subtle`, which is async, absent from
 * older Node without a flag, and unavailable on an insecure origin. This
 * package already hashes every event id with it.
 */
export function sha256Of(bytes: ArrayBuffer | Uint8Array): string {
  return bytesToHex(sha256(bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes)))
}

/** What the relay hands back once it holds the bytes — BUD-02 descriptor. */
export interface UploadedBlob {
  /** Where the bytes are. Already rewritten for the tenant, so it goes straight into `imeta`. */
  url: string
  sha256: string
  size: number
  /** MIME **as the relay stored it**. `imeta`'s `m` must equal this exactly. */
  type: string
  /** `<width>x<height>`, computed by the relay rather than by the client. */
  dim?: string
  /** The relay's generated thumbnail, when it made one. */
  thumb?: string
}

/**
 * A transport that can send bytes.
 *
 * A third shape, and for the third reason: {@link FetchLike} sends a string
 * body, {@link BlobFetchLike} sends none and reads bytes, this one sends bytes
 * and reads a string. One type that did all three would be loose enough to let
 * any of them be called wrongly.
 */
export type BlobUploadFetchLike = (
  url: string,
  init: { method: string; headers: Record<string, string>; body: ArrayBuffer },
) => Promise<{ status: number; text(): Promise<string> }>

/**
 * Put a file on the relay — CON-12's write half, BUD-01/BUD-11.
 *
 * **The upload must land before the message that names it.** Ingest runs
 * `verify_imeta_blobs` and refuses a message whose blob it does not already
 * hold, so this is not an optimisation to reorder — it is the only order that
 * works. A dangling attachment reference cannot be published at all, which is
 * a constraint worth being glad about.
 *
 * The hash is computed here rather than read off the response, because it is
 * what the authorization has to name: BUD-11 requires the `x` tag to match, so
 * the client must know the digest *before* it may ask permission to send the
 * bytes. `x-sha-256` carries it again on the PUT, where the relay checks the
 * bytes against it rather than trusting either side's arithmetic.
 *
 * Takes bytes rather than a `File`: `File` is a DOM type, this package builds
 * without `lib.dom`, and a caller that has one passes `await file.arrayBuffer()`.
 *
 * Throws with the relay's own words. What that means is the caller's to decide.
 */
export async function uploadBlob(args: {
  /** The relay origin. `/upload` is appended. */
  relayUrl: string
  bytes: ArrayBuffer
  /** The MIME to send. The relay stores its own answer, which wins — see {@link UploadedBlob.type}. */
  contentType?: string
  /** Display name. Goes in the authorization's human-readable reason, nowhere else. */
  filename?: string
  sign: (unsigned: UnsignedEvent) => Promise<SignedEvent>
  pubkey: string
  transport?: BlobUploadFetchLike
}): Promise<UploadedBlob> {
  const digest = sha256Of(args.bytes)
  const auth = await args.sign(
    buildBlossomAuth(args.pubkey, Date.now(), {
      verb: 'upload',
      sha256: digest,
      reason: args.filename ? `Upload ${args.filename}` : 'Upload attachment',
    }),
  )

  const send = args.transport ?? fetch
  const response = await send(`${args.relayUrl.replace(/\/+$/, '')}/upload`, {
    method: 'PUT',
    headers: {
      authorization: blossomAuthHeader(auth),
      // BUD-11 makes this mandatory on PUT /upload.
      'x-sha-256': digest,
      'content-type': args.contentType || 'application/octet-stream',
    },
    body: args.bytes,
  })

  const body = await response.text()
  if (response.status < 200 || response.status >= 300) {
    throw new Error(`upload failed: ${response.status} ${body.slice(0, 200)}`)
  }

  let descriptor: Partial<UploadedBlob>
  try {
    descriptor = JSON.parse(body) as Partial<UploadedBlob>
  } catch {
    throw new Error('upload returned no blob descriptor')
  }
  // `url` is the relay's own, already rewritten for the tenant — assembling a
  // host here would produce something `validate_imeta_tags` rejects as
  // non-local on any deployment whose tenant host is not the configured one.
  if (!descriptor.url || !descriptor.sha256) throw new Error('upload returned no blob descriptor')
  return {
    url: descriptor.url,
    sha256: descriptor.sha256,
    size: descriptor.size ?? args.bytes.byteLength,
    type: descriptor.type ?? args.contentType ?? 'application/octet-stream',
    dim: descriptor.dim,
    thumb: descriptor.thumb,
  }
}

/**
 * An uploaded blob as the `imeta` that references it.
 *
 * Shared because the mapping has one trap in it: `m` and `x` must be the
 * **relay's** answers, not the client's. `validate_imeta_tags` compares them
 * against what it stored, and a browser that re-encoded a file on the way in —
 * or simply guessed a MIME from an extension — publishes a message the relay
 * refuses, with nothing to say which field was wrong.
 */
export function imetaFor(blob: UploadedBlob, extra?: { alt?: string; filename?: string }): Imeta {
  return {
    url: blob.url,
    m: blob.type,
    x: blob.sha256,
    size: blob.size,
    dim: blob.dim,
    thumb: blob.thumb,
    alt: extra?.alt,
    filename: extra?.filename,
  }
}

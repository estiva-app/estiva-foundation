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
  /** Skip {@link canonicalizeImage}. Default `true`; see the note below. */
  canonicalize?: boolean
}): Promise<UploadedBlob> {
  /*
    Canonicalized first, and the hash taken after — SHA-25.

    The relay refuses media carrying metadata, so an unmodified screenshot 422s:
    capture tools write a `pHYs` and a `tEXt` software tag, and neither is on
    Buzz's rendering allowlist. Doing it here rather than asking each caller to
    remember means there is one place the relay's rule is understood, which is
    the same argument that put `uploadBlob` in this package at all.

    The order is forced. `x` in the authorization, `x-sha-256` on the PUT and
    `x` in the `imeta` must all be the digest of the bytes the relay actually
    stores, so hashing before stripping would name a blob that never existed.

    `canonicalize: false` is for a caller that has already done it, or is
    sending something this does not understand and does not want touched. It is
    not a way round a refusal: the relay's answer does not change.
  */
  const canonical =
    args.canonicalize === false
      ? args.bytes instanceof Uint8Array
        ? args.bytes
        : new Uint8Array(args.bytes)
      : canonicalizeImage(args.bytes)
  /*
    A standalone `ArrayBuffer`, because the transport's `body` is one and a
    `Uint8Array` may be a window onto a larger buffer — sending `.buffer` would
    upload whatever else is in it. One copy, against a network PUT.
  */
  const payload = canonical.buffer.slice(
    canonical.byteOffset,
    canonical.byteOffset + canonical.byteLength,
  ) as ArrayBuffer
  const digest = sha256Of(payload)
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
    body: payload,
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

/* ────────────────────────────────────────────────────────────────────────────
   Canonicalizing an image before it is uploaded — SHA-25
   ──────────────────────────────────────────────────────────────────────────── */

/**
 * PNG ancillary chunks the relay treats as rendering rather than metadata.
 *
 * Exactly `known_rendering` in `buzz-media`'s `validate_png_metadata_free`.
 * **`pHYs` is not on it**, deliberately: the relay's comment calls arbitrary
 * values an identity channel, and nearly every screen-capture tool writes one.
 * That single omission is why an ordinary screenshot is refused.
 */
const PNG_RENDERING_CHUNKS: ReadonlySet<string> = new Set([
  'cHRM', 'gAMA', 'sBIT', 'sRGB', 'bKGD', 'hIST', 'tRNS', 'sPLT', 'acTL', 'fcTL', 'fdAT',
])

/**
 * `tEXt` keywords the relay exempts — Buzz agent/team snapshot manifests.
 *
 * A deliberate product payload rather than metadata, so it is kept. Stripping
 * it would leave a `.agent.png` that still looks like an image and silently no
 * longer carries the thing it exists to carry, which is worse than a refusal.
 */
const PNG_SNAPSHOT_KEYWORDS = ['buzz_agent_snapshot', 'buzz_team_snapshot'] as const

const PNG_SIGNATURE = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]

/** A `tEXt` payload is `<keyword>\0<text>`. Only an allowlisted keyword survives. */
function isSnapshotText(payload: Uint8Array): boolean {
  return PNG_SNAPSHOT_KEYWORDS.some((keyword) => {
    if (payload.length <= keyword.length || payload[keyword.length] !== 0) return false
    for (let i = 0; i < keyword.length; i++) if (payload[i] !== keyword.charCodeAt(i)) return false
    return true
  })
}

function canonicalizePng(bytes: Uint8Array): Uint8Array {
  const kept: Uint8Array[] = [new Uint8Array(PNG_SIGNATURE)]
  let i = PNG_SIGNATURE.length
  let sawSnapshot = false
  let sawIend = false

  while (i < bytes.length) {
    if (i + 12 > bytes.length) throw new Error('malformed PNG: truncated chunk header')
    const length = (bytes[i] << 24) | (bytes[i + 1] << 16) | (bytes[i + 2] << 8) | bytes[i + 3]
    const type = String.fromCharCode(bytes[i + 4], bytes[i + 5], bytes[i + 6], bytes[i + 7])
    const end = i + 12 + length
    if (length < 0 || end > bytes.length) throw new Error(`malformed PNG: truncated ${type} chunk`)

    // Bit 5 of the first byte: lowercase means ancillary, and ancillary means
    // droppable. Critical chunks are the image and are never touched.
    const ancillary = (bytes[i + 4] & 0x20) !== 0
    let keep = !ancillary || PNG_RENDERING_CHUNKS.has(type)
    if (type === 'tEXt') {
      // One snapshot manifest survives; a second is a metadata channel again.
      keep = !sawSnapshot && isSnapshotText(bytes.subarray(i + 8, end - 4))
      if (keep) sawSnapshot = true
    }
    if (keep) kept.push(bytes.subarray(i, end))

    i = end
    if (type === 'IEND') {
      sawIend = true
      break // Anything after IEND is trailing data, which the relay refuses.
    }
  }
  if (!sawIend) throw new Error('malformed PNG: no IEND')
  return concatBytes(kept)
}

/**
 * A JPEG segment the relay accepts.
 *
 * `APP0` and `APP14` are allowed only in their canonical colour-header forms —
 * accepting an arbitrary payload under those markers would leave exactly the
 * side channel the ban is for. `APP1`–`APP13`, `APP15` and `COM` are refused
 * outright, and `APP1` is where EXIF lives.
 */
function keepJpegSegment(marker: number, payload: Uint8Array): boolean {
  if (marker === 0xe0) {
    const jfif = payload.length >= 14 && String.fromCharCode(...payload.subarray(0, 5)) === 'JFIF\0'
    return jfif && payload.length === 14 + 3 * payload[12] * payload[13]
  }
  if (marker === 0xee) {
    return payload.length === 12 && String.fromCharCode(...payload.subarray(0, 5)) === 'Adobe'
  }
  if ((marker >= 0xe1 && marker <= 0xed) || marker === 0xef || marker === 0xfe) return false
  return true
}

function canonicalizeJpeg(bytes: Uint8Array): Uint8Array {
  if (bytes[0] !== 0xff || bytes[1] !== 0xd8) throw new Error('malformed JPEG: no SOI')
  const kept: Uint8Array[] = [new Uint8Array([0xff, 0xd8])]
  let i = 2
  let inScan = false

  while (i < bytes.length) {
    if (bytes[i] !== 0xff) {
      // Entropy-coded data between SOS and the next marker. Copied verbatim —
      // it is the image.
      if (!inScan) throw new Error('malformed JPEG: expected a marker')
      const start = i
      while (i < bytes.length && bytes[i] !== 0xff) i++
      kept.push(bytes.subarray(start, i))
      continue
    }
    // Fill bytes: any run of 0xFF before a marker. One is emitted.
    while (i < bytes.length && bytes[i] === 0xff) i++
    if (i >= bytes.length) throw new Error('malformed JPEG: marker ran off the end')
    const marker = bytes[i++]

    // 0x00 is a stuffed byte inside the scan, not a marker; RSTn and TEM are
    // standalone. All three are part of the image and carry no payload.
    if ((inScan && marker === 0x00) || (marker >= 0xd0 && marker <= 0xd7) || marker === 0x01) {
      kept.push(new Uint8Array([0xff, marker]))
      continue
    }
    if (marker === 0xd9) {
      // EOI. Stop here rather than copying on: the relay refuses trailing
      // bytes after EOI, and that is where a stripped-EXIF editor leaves them.
      kept.push(new Uint8Array([0xff, 0xd9]))
      return concatBytes(kept)
    }
    if (marker === 0xd8) throw new Error('malformed JPEG: a second SOI')

    if (i + 2 > bytes.length) throw new Error('malformed JPEG: truncated segment length')
    const length = (bytes[i] << 8) | bytes[i + 1]
    if (length < 2) throw new Error('malformed JPEG: bad segment length')
    const end = i + length
    if (end > bytes.length) throw new Error('malformed JPEG: truncated segment')

    if (keepJpegSegment(marker, bytes.subarray(i + 2, end))) {
      kept.push(new Uint8Array([0xff, marker]), bytes.subarray(i, end))
    }
    i = end
    inScan = marker === 0xda
  }
  throw new Error('malformed JPEG: no EOI')
}

function concatBytes(parts: readonly Uint8Array[]): Uint8Array {
  let size = 0
  for (const part of parts) size += part.length
  const out = new Uint8Array(size)
  let at = 0
  for (const part of parts) {
    out.set(part, at)
    at += part.length
  }
  return out
}

/**
 * Strip an image down to what the relay will store — SHA-25.
 *
 * Buzz refuses media carrying metadata, and refuses it *structurally* rather
 * than by scrubbing it: `validate_image_metadata_free` returns
 * `MetadataForbidden` and the whole upload 422s. Its video path names the piece
 * that was missing — "only the canonical primary stream produced by the **client
 * sanitizer** is permitted" — and until this there was no client sanitizer, in
 * either app. An unmodified screenshot was refused, every time, because capture
 * tools write `pHYs` and a `tEXt` software tag.
 *
 * ## Chunks are dropped, never re-encoded
 *
 * The obvious implementation is a canvas round trip, and it does not work: the
 * browser's encoder **adds an ICC profile back**, which the relay refuses
 * identically. Dropping chunks is also lossless — every chunk removed here is
 * ancillary by the format's own definition — where a re-encode would quietly
 * degrade a screenshot to make it acceptable.
 *
 * ## PNG and JPEG only
 *
 * GIF and WebP are accepted by the relay and are **passed through untouched**.
 * Their metadata is not a droppable chunk: WebP records EXIF/ICC/XMP presence
 * in `VP8X` flags that have to stay consistent with the chunks, and GIF hides
 * it in extension blocks. Rewriting either wrongly produces a corrupt image,
 * which is worse than the refusal it replaces — so they keep today's behaviour
 * and the relay's own words. Screenshots are PNG or JPEG, which is the case
 * that was actually costing anything.
 *
 * Throws on malformed input rather than returning the bytes unchanged: an image
 * this cannot parse is one it cannot vouch for, and uploading it anyway would
 * turn a clear failure here into an opaque 422 later.
 */
export function canonicalizeImage(bytes: ArrayBuffer | Uint8Array): Uint8Array {
  const view = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes)
  /*
    Sniffed from the bytes, with no `contentType` argument at all. The MIME a
    caller has is the browser's guess from a file extension — a `.png` that is
    really a JPEG is ordinary — and this has the actual bytes in hand. Taking
    the parameter would invite trusting it.
  */
  if (PNG_SIGNATURE.every((byte, at) => view[at] === byte)) return canonicalizePng(view)
  if (view[0] === 0xff && view[1] === 0xd8) return canonicalizeJpeg(view)
  return view
}

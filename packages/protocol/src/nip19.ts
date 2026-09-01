/**
 * NIP-19 `naddr` — bech32-encoded pointers to addressable events.
 *
 * This is how an object gets *out of* the app that owns it and *into* another:
 * Ship encodes an issue as `nostr:naddr1…`, somebody pastes it into a Peek
 * message (NIP-21 for the URI scheme, NIP-27 for the convention of embedding one
 * in a text body), and Peek resolves it back to an address.
 *
 * ## Two implementations, and they already agreed
 *
 * Before SHA-3 this existed twice: Ship wrote an encoder, Peek wrote a decoder,
 * and each grew the other half later. Their outputs were checked byte for byte
 * during the extraction and were **identical** for the same pointer — so this
 * merge is a deduplication and not a reconciliation. What each copy had that the
 * other lacked is all kept: Ship's generic bech32 primitives and
 * `addrToNaddr`/`naddrToAddr`, Peek's `pointerToAddress`/`addressToPointer`,
 * `referenceToPointer` and `stripNaddrs`.
 *
 * ## Three things about the format that are easy to get wrong
 *
 * **Not bech32m.** NIP-19 predates bech32m and uses the original constant
 * (`^ 1`). Encoding with bech32m produces a string that looks right, passes a
 * casual eyeball, and fails every other implementation's checksum. A round-trip
 * test cannot catch it — it would be wrong in both directions — which is why
 * `bech32Encode`/`bech32Decode` are exported and pinned against the canonical
 * NIP-19 `npub` vector from the specification itself.
 *
 * **The 90-character limit does not apply.** BIP-173 caps a bech32 string at 90
 * characters for QR-code reasons; an `naddr` carrying a UUID `d` tag, a 32-byte
 * pubkey and a relay hint runs to ~180. NIP-19 explicitly lifts the cap, so no
 * length check appears here.
 *
 * **TLV order is not normative, and other implementations differ.** This encoder
 * emits identifier, relays, author, kind. `nostr-tools` emits a different order,
 * so the same pointer encodes to a *different string* — measured. Every decoder
 * involved (this one, Ship's old one, Peek's old one, `nostr-tools`) reads TLVs
 * by type and is order-tolerant, so the strings interoperate; but they are not
 * comparable as strings, and nothing here should ever compare two naddrs for
 * equality. Compare the addresses they decode to.
 */
import { bytesToHex, hexToBytes, utf8ToBytes } from '@noble/hashes/utils'

/**
 * `TextDecoder` is not in `lib.es2022`, and this package compiles with
 * `types: []` and no `lib: dom` (ADR 0002 §4a). Declared inside this module so
 * nothing lands in a consumer's global scope, and read inside a function body so
 * importing this module touches no global.
 */
declare const TextDecoder: { new (): { decode(input: Uint8Array): string } }

const CHARSET = 'qpzry9x8gf2tvdw0s3jn54khce6mua7l'
const GENERATOR = [0x3b6a57b2, 0x26508e6d, 0x1ea119fa, 0x3d4233dd, 0x2a1462b3]

function polymod(values: number[]): number {
  let chk = 1
  for (const value of values) {
    const top = chk >>> 25
    chk = ((chk & 0x1ffffff) << 5) ^ value
    for (let i = 0; i < 5; i++) {
      if ((top >>> i) & 1) chk ^= GENERATOR[i]
    }
  }
  return chk >>> 0
}

function hrpExpand(hrp: string): number[] {
  const high: number[] = []
  const low: number[] = []
  for (const char of hrp) {
    high.push(char.charCodeAt(0) >>> 5)
    low.push(char.charCodeAt(0) & 31)
  }
  return [...high, 0, ...low]
}

function checksum(hrp: string, data: number[]): number[] {
  const values = [...hrpExpand(hrp), ...data, 0, 0, 0, 0, 0, 0]
  // `^ 1` is bech32. bech32m would use `^ 0x2bc830a3` — see the note above.
  const mod = polymod(values) ^ 1
  return [0, 1, 2, 3, 4, 5].map((i) => (mod >>> (5 * (5 - i))) & 31)
}

/** Regroup bytes between bit widths, e.g. 8-bit bytes → 5-bit bech32 symbols. */
export function convertBits(data: ArrayLike<number>, from: number, to: number, pad: boolean): number[] {
  let acc = 0
  let bits = 0
  const out: number[] = []
  const maxv = (1 << to) - 1
  for (let i = 0; i < data.length; i++) {
    const value = data[i]
    if (value < 0 || value >> from !== 0) throw new Error(`value out of range: ${value}`)
    acc = (acc << from) | value
    bits += from
    while (bits >= to) {
      bits -= to
      out.push((acc >>> bits) & maxv)
    }
  }
  if (pad) {
    if (bits > 0) out.push((acc << (to - bits)) & maxv)
  } else if (bits >= from || ((acc << (to - bits)) & maxv) !== 0) {
    throw new Error('invalid padding')
  }
  return out
}

/**
 * Exported for the bare NIP-19 types (`npub`, `note`) and for tests.
 *
 * The checksum layer is the part worth testing directly: a wrong constant still
 * round-trips against itself, so only an external vector catches it.
 *
 * Strict about case, deliberately — BIP-173 forbids mixing. `decodeNaddr` is the
 * forgiving entry point, because what reaches it was typed or pasted by a person.
 */
export function bech32Encode(hrp: string, data: number[]): string {
  const combined = [...data, ...checksum(hrp, data)]
  return `${hrp}1${combined.map((d) => CHARSET[d]).join('')}`
}

export function bech32Decode(encoded: string): { hrp: string; data: number[] } {
  const lower = encoded.toLowerCase()
  if (lower !== encoded && encoded.toUpperCase() !== encoded) {
    throw new Error('mixed case bech32 string')
  }
  const split = lower.lastIndexOf('1')
  if (split < 1 || split + 7 > lower.length) throw new Error('malformed bech32 string')
  const hrp = lower.slice(0, split)
  const data: number[] = []
  for (const char of lower.slice(split + 1)) {
    const index = CHARSET.indexOf(char)
    if (index === -1) throw new Error(`invalid bech32 character: ${char}`)
    data.push(index)
  }
  if (polymod([...hrpExpand(hrp), ...data]) !== 1) throw new Error('bad bech32 checksum')
  return { hrp, data: data.slice(0, -6) }
}

/** A decoded `naddr` — everything needed to fetch the event it points at. */
export interface AddressPointer {
  /** The `d` tag of the addressable event. */
  identifier: string
  pubkey: string
  kind: number
  /** Relay hints, in the order they appeared. May be empty. */
  relays: string[]
}

/**
 * TLV types for `naddr` (NIP-19 §"Shareable identifiers with extra metadata").
 * The numbers are the protocol; the names are ours.
 */
const TLV_IDENTIFIER = 0
const TLV_RELAY = 1
const TLV_AUTHOR = 2
const TLV_KIND = 3

/**
 * Encode an address as `naddr1…`.
 *
 * TLV order is identifier, relays, author, kind — see the header on why that is
 * a choice rather than a rule.
 */
/**
 * A pointer to **one event**, by its id — NIP-19 `nevent`.
 *
 * The counterpart to `AddressPointer`, and the two are not interchangeable.
 * An address names *whatever is currently at* `(kind, pubkey, d)` and survives
 * its author replacing the event. An event id names one immutable event and
 * nothing else: a `kind:9` message has no `d`, so an address cannot be built
 * for it at all.
 *
 * `author` and `kind` are optional in the format and worth including whenever
 * they are known — a reader that has them can query by author and kind rather
 * than scanning, and a consumer can find the manifest that renders the kind
 * before it has the event.
 */
export interface EventPointer {
  /** 32-byte event id, hex. */
  id: string
  relays: string[]
  /** Optional in NIP-19; include it when known. */
  pubkey?: string
  /** Optional in NIP-19; include it when known. */
  kind?: number
}

/**
 * `nevent1…` for one event.
 *
 * The TLV layout is `naddr`'s with one difference that matters: type 0 holds
 * the event id as **32 raw bytes**, where an naddr holds the `d` identifier as
 * UTF-8. Encoding an id as text produces a bech32 string every decoder accepts
 * and no relay can answer — the same silent-but-invalid shape the author-length
 * guard below was added for.
 */
export function encodeNevent(pointer: EventPointer): string {
  const bytes: number[] = []
  const push = (type: number, value: Uint8Array) => {
    if (value.length > 255) throw new Error(`TLV value too long for type ${type}`)
    bytes.push(type, value.length, ...value)
  }

  const id = hexToBytes(pointer.id)
  if (id.length !== 32) throw new Error(`event id must be 32 bytes, got ${id.length}`)
  push(TLV_IDENTIFIER, id)

  for (const relay of pointer.relays) push(TLV_RELAY, utf8ToBytes(relay))

  if (pointer.pubkey !== undefined) {
    const author = hexToBytes(pointer.pubkey)
    if (author.length !== 32) throw new Error(`author must be 32 bytes, got ${author.length}`)
    push(TLV_AUTHOR, author)
  }

  if (pointer.kind !== undefined) {
    push(
      TLV_KIND,
      new Uint8Array([
        (pointer.kind >>> 24) & 0xff,
        (pointer.kind >>> 16) & 0xff,
        (pointer.kind >>> 8) & 0xff,
        pointer.kind & 0xff,
      ]),
    )
  }

  return bech32Encode('nevent', convertBits(bytes, 8, 5, true))
}

/** The inverse of `encodeNevent`. Throws on anything that is not an `nevent`. */
export function decodeNevent(encoded: string): EventPointer {
  const { hrp, data } = bech32Decode(encoded.replace(/^nostr:/i, '').toLowerCase())
  if (hrp !== 'nevent') throw new Error(`expected an nevent, got ${hrp}`)
  const bytes = convertBits(data, 5, 8, false)

  let id: string | undefined
  let pubkey: string | undefined
  let kind: number | undefined
  const relays: string[] = []

  for (let i = 0; i < bytes.length; ) {
    const type = bytes[i]
    const length = bytes[i + 1]
    const value = bytes.slice(i + 2, i + 2 + length)
    if (value.length !== length) throw new Error('truncated TLV')
    i += 2 + length

    switch (type) {
      case TLV_IDENTIFIER:
        if (length !== 32) throw new Error(`event id must be 32 bytes, got ${length}`)
        id = bytesToHex(new Uint8Array(value))
        break
      case TLV_RELAY:
        relays.push(new TextDecoder().decode(new Uint8Array(value)))
        break
      case TLV_AUTHOR:
        if (length !== 32) throw new Error(`author must be 32 bytes, got ${length}`)
        pubkey = bytesToHex(new Uint8Array(value))
        break
      case TLV_KIND:
        if (length !== 4) throw new Error(`kind must be 4 bytes, got ${length}`)
        kind = ((value[0] << 24) | (value[1] << 16) | (value[2] << 8) | value[3]) >>> 0
        break
      // Unknown TLV types are skipped rather than rejected, as in `decodeNaddr`.
    }
  }

  // Only the id is required. An `nevent` carrying nothing else is legal and
  // still resolvable — by scanning, which is why the optional fields are worth
  // writing when they are known.
  if (id === undefined) throw new Error('nevent is missing its event id')
  return { id, relays, ...(pubkey !== undefined ? { pubkey } : {}), ...(kind !== undefined ? { kind } : {}) }
}

export function encodeNaddr(pointer: AddressPointer): string {
  const bytes: number[] = []
  const push = (type: number, value: Uint8Array) => {
    if (value.length > 255) throw new Error(`TLV value too long for type ${type}`)
    bytes.push(type, value.length, ...value)
  }

  push(TLV_IDENTIFIER, utf8ToBytes(pointer.identifier))
  for (const relay of pointer.relays) push(TLV_RELAY, utf8ToBytes(relay))
  // Peek's encoder checked the author's length and Ship's did not, and the
  // difference is not cosmetic: `hexToBytes` is happy with any even-length hex,
  // so a 20-byte author encoded into a *valid* naddr that every decoder then
  // refused as "author must be 32 bytes". A pointer that cannot be read back is
  // worse than an error, because it is produced silently and only fails at
  // whoever pastes it. Peek's guard is the one that ships.
  const author = hexToBytes(pointer.pubkey)
  if (author.length !== 32) throw new Error(`author must be 32 bytes, got ${author.length}`)
  push(TLV_AUTHOR, author)
  // Kind is a 4-byte big-endian integer, not a decimal string.
  push(
    TLV_KIND,
    new Uint8Array([
      (pointer.kind >>> 24) & 0xff,
      (pointer.kind >>> 16) & 0xff,
      (pointer.kind >>> 8) & 0xff,
      pointer.kind & 0xff,
    ]),
  )

  return bech32Encode('naddr', convertBits(bytes, 8, 5, true))
}

/**
 * Decode `naddr1…`, with or without a `nostr:` prefix, in any case.
 *
 * Forgiving on purpose: what arrives here was pasted by a person, sometimes out
 * of an email client that capitalised the first letter. `bech32Decode` is the
 * strict primitive underneath — this lowercases first, so a mixed-case string
 * that would be refused there is accepted here.
 */
export function decodeNaddr(encoded: string): AddressPointer {
  const { hrp, data } = bech32Decode(encoded.replace(/^nostr:/i, '').toLowerCase())
  if (hrp !== 'naddr') throw new Error(`expected an naddr, got ${hrp}`)
  const bytes = convertBits(data, 5, 8, false)

  let identifier: string | undefined
  let pubkey: string | undefined
  let kind: number | undefined
  const relays: string[] = []

  for (let i = 0; i < bytes.length; ) {
    const type = bytes[i]
    const length = bytes[i + 1]
    const value = bytes.slice(i + 2, i + 2 + length)
    if (value.length !== length) throw new Error('truncated TLV')
    i += 2 + length

    switch (type) {
      case TLV_IDENTIFIER:
        identifier = new TextDecoder().decode(new Uint8Array(value))
        break
      case TLV_RELAY:
        relays.push(new TextDecoder().decode(new Uint8Array(value)))
        break
      case TLV_AUTHOR:
        if (length !== 32) throw new Error(`author must be 32 bytes, got ${length}`)
        pubkey = bytesToHex(new Uint8Array(value))
        break
      case TLV_KIND:
        if (length !== 4) throw new Error(`kind must be 4 bytes, got ${length}`)
        kind = ((value[0] << 24) | (value[1] << 16) | (value[2] << 8) | value[3]) >>> 0
        break
      // Unknown TLV types are skipped, not rejected — that is what lets the
      // format gain fields without breaking existing decoders.
    }
  }

  if (identifier === undefined || pubkey === undefined || kind === undefined) {
    throw new Error('naddr is missing identifier, author or kind')
  }
  return { identifier, pubkey, kind, relays }
}

/** `<kind>:<pubkey>:<d>` — the form used in `a` tags and relay filters. */
export function pointerToAddress(pointer: AddressPointer): string {
  return `${pointer.kind}:${pointer.pubkey}:${pointer.identifier}`
}

/**
 * The inverse: `<kind>:<pubkey>:<d>` back to a pointer.
 *
 * An address carries no relay hints — `naddr` has a TLV for them and an `a` tag
 * does not — so the relays come back empty. That is a real loss of information,
 * not an oversight: it is why the two forms are not interchangeable and why the
 * encoder is not simply run in reverse.
 *
 * The `d` identifier may itself contain colons, so only the first two are
 * separators.
 */
export function addressToPointer(address: string): AddressPointer {
  const first = address.indexOf(':')
  const second = address.indexOf(':', first + 1)
  if (first < 1 || second < 0) throw new Error(`not an address: ${address.slice(0, 40)}`)
  const kind = Number(address.slice(0, first))
  const pubkey = address.slice(first + 1, second)
  const identifier = address.slice(second + 1)
  if (!Number.isInteger(kind) || !/^[0-9a-f]{64}$/i.test(pubkey)) {
    throw new Error(`not an address: ${address.slice(0, 40)}`)
  }
  return { kind, pubkey: pubkey.toLowerCase(), identifier, relays: [] }
}

/** `<kind>:<pubkey>:<d>` → `naddr1…`. */
export function addrToNaddr(address: string, relays: string[] = []): string {
  const [kind, pubkey, ...rest] = address.split(':')
  return encodeNaddr({ kind: Number(kind), pubkey, identifier: rest.join(':'), relays })
}

/** `naddr1…` → `<kind>:<pubkey>:<d>`. */
export function naddrToAddr(encoded: string): string {
  return pointerToAddress(decodeNaddr(encoded))
}

/**
 * A pointer from *either* form a reference arrives in.
 *
 * A message composed in an app carries `nostr:naddr1…` in its body. The same
 * message read back off the relay carries the same reference as an `a` tag,
 * which is a plain `<kind>:<pubkey>:<d>` address — that is what the NIP says a
 * tag holds.
 *
 * Both name one object. Accepting only the first is what made a reference stop
 * rendering the moment its own message came back from the relay (FEE-2).
 */
export function referenceToPointer(input: string): AddressPointer {
  const trimmed = input.replace(/^nostr:/i, '')
  return trimmed.toLowerCase().startsWith('naddr1')
    ? decodeNaddr(trimmed)
    : addressToPointer(trimmed)
}

/**
 * Every `nostr:naddr1…` in a body of text (NIP-27).
 *
 * The character class is bech32's own alphabet, which excludes `1`, `b`, `i`
 * and `o`, so a match ends cleanly at punctuation without a lookahead.
 */
export const NADDR_RE = /nostr:(naddr1[023456789acdefghjklmnpqrstuvwxyz]+)/gi

export function findNaddrs(text: string): string[] {
  return [...text.matchAll(NADDR_RE)].map((m) => m[1])
}

/**
 * The same text with every `nostr:naddr1…` taken out (PEEK-18).
 *
 * A reference that resolves into a widget should not also sit in the prose as
 * sixty characters of bech32: the widget *is* the reference, rendered. Ship
 * appends one to every thread it starts about an issue, so leaving it in means
 * most cross-app messages open with a wall of noise nobody reads.
 *
 * Whitespace is repaired rather than merely removed. A pointer is usually
 * trailing or on a line of its own, and deleting it in place otherwise leaves a
 * double space mid-sentence or a hole between paragraphs — both of which look
 * like the message itself is broken. Runs of blanks collapse *within* a line
 * only, so indentation and paragraph breaks survive.
 *
 * Display-only. The stored body keeps the pointer, which is what lets the
 * reference still be found, resolved and followed.
 */
export function stripNaddrs(text: string): string {
  // Text with no pointer comes back byte-identical. The repairs below are only
  // ever justified by a removal, and a display helper that reflows somebody's
  // indentation for free would be a bug wearing a tidy-up's clothes.
  if (findNaddrs(text).length === 0) return text

  return (
    text
      // Take the blanks on either side along with the pointer, then put a single
      // space back only when it stood between words on one line. Doing it in one
      // pass is what keeps the repair local to the hole.
      .replace(
        new RegExp(`([^\\S\\n]*)${NADDR_RE.source}([^\\S\\n]*)`, 'gi'),
        (_match, before: string, _addr: string, after: string) => (before && after ? ' ' : ''),
      )
      // A pointer alone on its line leaves the line's newlines behind on both
      // sides, which reads as an unexplained gap.
      .replace(/\n{3,}/g, '\n\n')
      .trim()
  )
}

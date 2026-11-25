/**
 * Negentropy range-based set reconciliation, protocol version 1 (`0x61`), the
 * message format NIP-77 carries in `NEG-OPEN` and `NEG-MSG`.
 *
 * Ported from nostr-tools' `nip77.ts` (public domain, The Unlicense), itself a
 * port of the reference implementation (github.com/hoytech/negentropy). The relay
 * runs the Rust `negentropy` 0.5 crate, which speaks the same version. Only what a
 * client needs is kept: build a sealed set, open, and answer the relay's rounds.
 * nostr-tools exports no `./nip77` path and npm's `negentropy` is an empty
 * placeholder, so the code lives here rather than as a dependency.
 */
import { sha256 } from '@noble/hashes/sha256'
import { bytesToHex, hexToBytes } from '@noble/hashes/utils'

const PROTOCOL_VERSION = 0x61
const ID_SIZE = 32
const FINGERPRINT_SIZE = 16
/** A timestamp past every real one: the open upper end of the range. */
const INFINITY = Number.MAX_VALUE

const enum Mode {
  Skip = 0,
  Fingerprint = 1,
  IdList = 2,
}

interface Item {
  timestamp: number
  id: Uint8Array
}

/** A growable byte buffer that is also read from the front. */
class Buf {
  private raw: Uint8Array
  length: number

  constructor(bytes?: Uint8Array) {
    this.raw = bytes ? new Uint8Array(bytes) : new Uint8Array(512)
    this.length = bytes ? bytes.length : 0
  }

  unwrap(): Uint8Array {
    return this.raw.subarray(0, this.length)
  }

  extend(bytes: Uint8Array | Buf): void {
    const add = bytes instanceof Buf ? bytes.unwrap() : bytes
    const target = this.length + add.length
    if (this.raw.byteLength < target) {
      const grown = new Uint8Array(Math.max(this.raw.byteLength * 2, target))
      grown.set(this.raw.subarray(0, this.length))
      this.raw = grown
    }
    this.raw.set(add, this.length)
    this.length += add.length
  }

  take(n: number): Uint8Array {
    if (this.length < n) throw new Error('negentropy: message ends prematurely')
    const head = this.raw.subarray(0, n)
    this.raw = this.raw.subarray(n)
    this.length -= n
    return head
  }
}

function decodeVarInt(buf: Buf): number {
  let result = 0
  for (;;) {
    const byte = buf.take(1)[0]
    result = result * 128 + (byte & 0x7f)
    if ((byte & 0x80) === 0) return result
  }
}

function encodeVarInt(n: number): Uint8Array {
  if (n === 0) return new Uint8Array([0])
  const out: number[] = []
  while (n > 0) {
    out.push(n % 128)
    n = Math.floor(n / 128)
  }
  out.reverse()
  for (let i = 0; i < out.length - 1; i++) out[i] |= 0x80
  return new Uint8Array(out)
}

function compareBytes(a: Uint8Array, b: Uint8Array): number {
  const n = Math.min(a.byteLength, b.byteLength)
  for (let i = 0; i < n; i++) if (a[i] !== b[i]) return a[i] < b[i] ? -1 : 1
  return a.byteLength - b.byteLength
}

function compareItems(a: Item, b: Item): number {
  return a.timestamp === b.timestamp ? compareBytes(a.id, b.id) : a.timestamp - b.timestamp
}

/** The sum of ids mod 2^256, little-endian, hashed with the count. */
function fingerprint(items: Item[], begin: number, end: number): Uint8Array {
  const sum = new Uint8Array(ID_SIZE)
  const view = new DataView(sum.buffer)
  for (let i = begin; i < end; i++) {
    const id = items[i].id
    const other = new DataView(id.buffer, id.byteOffset, ID_SIZE)
    let carry = 0
    for (let w = 0; w < 8; w++) {
      const next = view.getUint32(w * 4, true) + other.getUint32(w * 4, true) + carry
      view.setUint32(w * 4, next >>> 0, true)
      carry = next > 0xffffffff ? 1 : 0
    }
  }
  const count = encodeVarInt(end - begin)
  const input = new Uint8Array(ID_SIZE + count.length)
  input.set(sum)
  input.set(count, ID_SIZE)
  return sha256(input).subarray(0, FINGERPRINT_SIZE)
}

/** What a client holds for one question: each event's `created_at` and id. */
export class NegentropySet {
  private readonly items: Item[] = []
  private sealed = false

  insert(timestamp: number, id: string): void {
    if (this.sealed) throw new Error('negentropy: set already sealed')
    const bytes = hexToBytes(id)
    if (bytes.byteLength !== ID_SIZE) throw new Error('negentropy: an id is 32 bytes')
    this.items.push({ timestamp, id: bytes })
  }

  /** Sort and freeze; a duplicate id is dropped rather than refused. */
  seal(): Item[] {
    if (!this.sealed) {
      this.items.sort(compareItems)
      for (let i = this.items.length - 1; i > 0; i--) {
        if (compareItems(this.items[i - 1], this.items[i]) === 0) this.items.splice(i, 1)
      }
      this.sealed = true
    }
    return this.items
  }

  get size(): number {
    return this.seal().length
  }
}

/**
 * The client side of one reconciliation. `initiate()` gives the `NEG-OPEN`
 * message; each relay message goes to `reconcile()`, which reports what the
 * relay has that the set lacks (`need`) and what the set holds that the relay
 * does not (`have`), and returns the next message or `null` when done.
 */
export class Negentropy {
  private readonly items: Item[]
  private lastTimestampIn = 0
  private lastTimestampOut = 0
  /** Set by {@link initiate}: the client's side. A set that never initiates answers as the relay does. */
  private initiator = false

  /** `frameSizeLimit` bounds each outgoing message, in bytes (at least 4,096; 0 for none). */
  constructor(
    set: NegentropySet,
    private readonly frameSizeLimit = 60_000,
  ) {
    if (frameSizeLimit !== 0 && frameSizeLimit < 4096) throw new Error('negentropy: frameSizeLimit too small')
    this.items = set.seal()
  }

  initiate(): string {
    this.initiator = true
    const out = new Buf()
    out.extend(new Uint8Array([PROTOCOL_VERSION]))
    this.lastTimestampOut = 0
    this.splitRange(0, this.items.length, { timestamp: INFINITY, id: new Uint8Array(0) }, out)
    return bytesToHex(out.unwrap())
  }

  reconcile(message: string, onHave: (id: string) => void, onNeed: (id: string) => void): string | null {
    const query = new Buf(hexToBytes(message))
    this.lastTimestampIn = this.lastTimestampOut = 0
    const full = new Buf()
    full.extend(new Uint8Array([PROTOCOL_VERSION]))

    const version = query.take(1)[0]
    if (version < 0x60 || version > 0x6f) throw new Error('negentropy: not a negentropy message')
    if (version !== PROTOCOL_VERSION) throw new Error(`negentropy: unsupported version ${version - 0x60}`)

    const size = this.items.length
    let prevBound: Item = { timestamp: 0, id: new Uint8Array(0) }
    let prevIndex = 0
    let skip = false

    while (query.length !== 0) {
      const o = new Buf()
      const flushSkip = () => {
        if (!skip) return
        skip = false
        o.extend(this.encodeBound(prevBound))
        o.extend(encodeVarInt(Mode.Skip))
      }

      const currBound = this.decodeBound(query)
      const mode = decodeVarInt(query)
      const lower = prevIndex
      let upper = this.lowerBound(prevIndex, size, currBound)

      if (mode === Mode.Skip) {
        skip = true
      } else if (mode === Mode.Fingerprint) {
        const theirs = query.take(FINGERPRINT_SIZE)
        if (compareBytes(theirs, fingerprint(this.items, lower, upper)) !== 0) {
          flushSkip()
          this.splitRange(lower, upper, currBound, o)
        } else {
          skip = true
        }
      } else if (mode === Mode.IdList) {
        const count = decodeVarInt(query)
        const theirs = new Set<string>()
        for (let i = 0; i < count; i++) theirs.add(bytesToHex(query.take(ID_SIZE)))
        if (this.initiator) {
          skip = true
          for (let i = lower; i < upper; i++) {
            const id = bytesToHex(this.items[i].id)
            if (!theirs.delete(id)) onHave(id)
          }
          for (const id of theirs) onNeed(id)
        } else {
          // The relay's side (tests play it): answer with our ids in the range, as many as fit.
          flushSkip()
          const ids = new Buf()
          let sent = 0
          let endBound = currBound
          for (let i = lower; i < upper; i++) {
            if (this.frameSizeLimit !== 0 && full.length + ids.length > this.frameSizeLimit - 200) {
              endBound = this.items[i]
              upper = i
              break
            }
            ids.extend(this.items[i].id)
            sent += 1
          }
          o.extend(this.encodeBound(endBound))
          o.extend(encodeVarInt(Mode.IdList))
          o.extend(encodeVarInt(sent))
          o.extend(ids)
          // Already sized to fit: it goes out whole, and the frame check below sees nothing more.
          full.extend(o)
          o.length = 0
        }
      } else {
        throw new Error('negentropy: unexpected mode')
      }

      if (this.frameSizeLimit !== 0 && full.length + o.length > this.frameSizeLimit - 200) {
        // Too big for one frame: ask about the rest by one fingerprint next round.
        full.extend(this.encodeBound({ timestamp: INFINITY, id: new Uint8Array(0) }))
        full.extend(encodeVarInt(Mode.Fingerprint))
        full.extend(fingerprint(this.items, upper, size))
        break
      }
      full.extend(o)
      prevIndex = upper
      prevBound = currBound
    }

    // The client is done when it has nothing left to ask; the relay's side always answers.
    return this.initiator && full.length === 1 ? null : bytesToHex(full.unwrap())
  }

  private splitRange(lower: number, upper: number, upperBound: Item, o: Buf): void {
    const count = upper - lower
    const buckets = 16
    if (count < buckets * 2) {
      o.extend(this.encodeBound(upperBound))
      o.extend(encodeVarInt(Mode.IdList))
      o.extend(encodeVarInt(count))
      for (let i = lower; i < upper; i++) o.extend(this.items[i].id)
      return
    }
    const perBucket = Math.floor(count / buckets)
    const withExtra = count % buckets
    let curr = lower
    for (let i = 0; i < buckets; i++) {
      const bucketSize = perBucket + (i < withExtra ? 1 : 0)
      const print = fingerprint(this.items, curr, curr + bucketSize)
      curr += bucketSize
      const nextBound = curr === upper ? upperBound : this.minimalBound(this.items[curr - 1], this.items[curr])
      o.extend(this.encodeBound(nextBound))
      o.extend(encodeVarInt(Mode.Fingerprint))
      o.extend(print)
    }
  }

  private lowerBound(first: number, last: number, bound: Item): number {
    let count = last - first
    while (count > 0) {
      const step = Math.floor(count / 2)
      const it = first + step
      if (compareItems(this.items[it], bound) < 0) {
        first = it + 1
        count -= step + 1
      } else {
        count = step
      }
    }
    return first
  }

  private decodeBound(buf: Buf): Item {
    let timestamp = decodeVarInt(buf)
    timestamp = timestamp === 0 ? INFINITY : timestamp - 1
    if (this.lastTimestampIn === INFINITY || timestamp === INFINITY) {
      this.lastTimestampIn = INFINITY
      timestamp = INFINITY
    } else {
      timestamp += this.lastTimestampIn
      this.lastTimestampIn = timestamp
    }
    const length = decodeVarInt(buf)
    if (length > ID_SIZE) throw new Error('negentropy: bound key too long')
    return { timestamp, id: buf.take(length) }
  }

  private encodeBound(bound: Item): Uint8Array {
    const out = new Buf()
    if (bound.timestamp === INFINITY) {
      this.lastTimestampOut = INFINITY
      out.extend(encodeVarInt(0))
    } else {
      const delta = bound.timestamp - this.lastTimestampOut
      this.lastTimestampOut = bound.timestamp
      out.extend(encodeVarInt(delta + 1))
    }
    out.extend(encodeVarInt(bound.id.length))
    out.extend(bound.id)
    return out.unwrap()
  }

  private minimalBound(prev: Item, curr: Item): Item {
    if (curr.timestamp !== prev.timestamp) return { timestamp: curr.timestamp, id: new Uint8Array(0) }
    let shared = 0
    while (shared < ID_SIZE && curr.id[shared] === prev.id[shared]) shared++
    return { timestamp: curr.timestamp, id: curr.id.subarray(0, shared + 1) }
  }
}

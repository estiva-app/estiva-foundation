/**
 * `nevent` — one event, by id.
 *
 * Checked against **nostr-tools**, not only against itself. A self-consistent
 * encoder is exactly the failure this format invites: a bech32 string that
 * round-trips here and that no other client can read is produced silently and
 * fails at whoever pastes it. `encodeNaddr`'s author-length guard exists for
 * the same reason and its comment says so.
 */
import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { nip19 } from 'nostr-tools'
import { decodeNevent, encodeNaddr, encodeNevent } from '../dist/index.js'

const ID = '9f2a1b3c4d5e6f708192a3b4c5d6e7f8091a2b3c4d5e6f708192a3b4c5d6e7f8'
const AUTHOR = 'b38fd2687b17bbde2e8079577cba601936acfe1b731d2d2ba7cdef29a063db46'
const RELAY = 'wss://estiva.estiva.app'

describe('encodeNevent', () => {
  it('produces something nostr-tools reads identically — not the same bytes', () => {
    /*
      **Not byte-equal, and that is correct.** NIP-19 fixes the TLV *types*, not
      their order: we write id, relay, author, kind; nostr-tools writes kind,
      author, relay, id. Both are legal and each decodes the other, which is the
      property that matters.

      Asserting byte equality would have been asserting that we match one other
      client's arbitrary choice — green until nostr-tools reordered its writer,
      and red for a reason that is nobody's bug. The interop claim is mutual
      decodability, so that is what is checked.
    */
    const ours = encodeNevent({ id: ID, relays: [RELAY], pubkey: AUTHOR, kind: 9 })
    const theirs = nip19.neventEncode({ id: ID, relays: [RELAY], author: AUTHOR, kind: 9 })
    assert.notEqual(ours, theirs, 'if these ever match, the note above is stale')

    assert.deepEqual(decodeNevent(theirs), decodeNevent(ours))
    const readByThem = nip19.decode(ours).data as { id: string }
    assert.equal(readByThem.id, (nip19.decode(theirs).data as { id: string }).id)
  })

  it('is byte-equal to nostr-tools for the minimal form', () => {
    // One TLV, so there is no order to disagree about — which is also the
    // evidence that the difference above is ordering and nothing else.
    assert.equal(encodeNevent({ id: ID, relays: [] }), nip19.neventEncode({ id: ID }))
  })

  it('is read back by nostr-tools with every field intact', () => {
    const decoded = nip19.decode(encodeNevent({ id: ID, relays: [RELAY], pubkey: AUTHOR, kind: 9 }))
    assert.equal(decoded.type, 'nevent')
    const data = decoded.data as { id: string; author?: string; kind?: number; relays?: string[] }
    assert.equal(data.id, ID)
    assert.equal(data.author, AUTHOR)
    assert.equal(data.kind, 9)
    assert.deepEqual(data.relays, [RELAY])
  })

  it('refuses an id that is not 32 bytes', () => {
    // The silent-but-invalid case: hex of any even length encodes happily and
    // fails only in whoever tries to resolve it.
    assert.throws(() => encodeNevent({ id: 'abcd', relays: [] }), /32 bytes/)
  })

  it('refuses an author that is not 32 bytes', () => {
    assert.throws(() => encodeNevent({ id: ID, relays: [], pubkey: 'abcd' }), /32 bytes/)
  })
})

describe('decodeNevent', () => {
  it('reads what nostr-tools wrote', () => {
    const theirs = nip19.neventEncode({ id: ID, relays: [RELAY], author: AUTHOR, kind: 9 })
    assert.deepEqual(decodeNevent(theirs), { id: ID, relays: [RELAY], pubkey: AUTHOR, kind: 9 })
  })

  it('round-trips the minimal form', () => {
    assert.deepEqual(decodeNevent(encodeNevent({ id: ID, relays: [] })), { id: ID, relays: [] })
  })

  it('tolerates the nostr: prefix, as a pasted reference carries one', () => {
    assert.equal(decodeNevent(`nostr:${encodeNevent({ id: ID, relays: [] })}`).id, ID)
  })

  it('refuses an naddr rather than half-reading it', () => {
    // The two are not interchangeable: an address names whatever is currently
    // at (kind, pubkey, d); an id names one immutable event. Accepting the
    // wrong one here would resolve to the wrong thing rather than error.
    // Built rather than pasted: the string here was a truncated fixture and
    // failed the bech32 checksum, so the test passed on the wrong error and
    // said nothing about the hrp check it was written for.
    const naddr = encodeNaddr({ kind: 30851, pubkey: AUTHOR, identifier: 'i1', relays: [] })
    assert.throws(() => decodeNevent(naddr), /expected an nevent, got naddr/)
  })
})

/**
 * Mentions that resolve without a shared directory — SPEC §13.1's `reference`
 * mark, and RIC-2's whole point.
 *
 * A display name in a message body needs the reader to hold the writer's
 * directory, and message content is immutable, so a rename desynchronises the
 * text from the `p` tags for ever. An `npub` needs nothing and survives a
 * rename, because it never said the name in the first place.
 */
import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import {
  addrToNaddr,
  decodeNpub,
  encodeNpub,
  findNostrUris,
  markersToInlineNodes,
  inlineNodesToMarkers,
  parseInlineMarks,
  toRenderTree,
} from '../dist/index.js'

const PUBKEY = 'b38fd2687b17bbde2e8079577cba601936acfe1b731d2d2ba7cdef29a063db46'
const NPUB = encodeNpub(PUBKEY)

describe('npub', () => {
  it('round-trips a pubkey', () => {
    assert.ok(NPUB.startsWith('npub1'))
    assert.equal(decodeNpub(NPUB), PUBKEY)
  })

  it('accepts the nostr: prefix and any case, as a pasted one arrives', () => {
    assert.equal(decodeNpub(`nostr:${NPUB}`.toUpperCase()), PUBKEY)
  })

  it('refuses a key that is not 32 bytes rather than encoding one nobody can read', () => {
    assert.throws(() => encodeNpub('ab'.repeat(20)), /32 bytes/)
  })

  it('refuses another bech32 form, on the prefix rather than the checksum', () => {
    // A real naddr, so the failure is "that is not an npub" and not "that is
    // not bech32" — the second would pass this test while proving nothing.
    const naddr = addrToNaddr(`30851:${PUBKEY}:an-issue`)
    assert.throws(() => decodeNpub(naddr), /expected an npub/)
  })
})

describe('a reference in marker text', () => {
  it('is its own run, carrying what it points at', () => {
    assert.deepEqual(parseInlineMarks(`ask nostr:${NPUB} about it`), [
      { text: 'ask ' },
      { text: `nostr:${NPUB}`, reference: `nostr:${NPUB}` },
      { text: ' about it' },
    ])
  })

  it('keeps the marks around it', () => {
    const spans = parseInlineMarks(`**ask nostr:${NPUB} now**`)
    assert.ok(spans.every((s) => s.bold))
    assert.equal(spans.find((s) => s.reference)?.reference, `nostr:${NPUB}`)
  })

  it('is NOT split out of code — a quoted example is not a link', () => {
    const spans = parseInlineMarks(`\`nostr:${NPUB}\``)
    assert.equal(spans.length, 1)
    assert.equal(spans[0].code, true)
    assert.equal(spans[0].reference, undefined)
  })

  it('leaves the text as the URI, so an app that resolves nothing shows something', () => {
    // §13.1: "render the URI's own label or its shortened form, never blank."
    assert.equal(parseInlineMarks(`nostr:${NPUB}`)[0].text, `nostr:${NPUB}`)
  })

  it('round-trips back to exactly what was written', () => {
    const body = `ask nostr:${NPUB} and see nostr:${NPUB}`
    assert.equal(inlineNodesToMarkers(markersToInlineNodes(body)), body)
  })
})

describe('a reference in the JSON encoding', () => {
  it('is a mark carrying its uri', () => {
    const nodes = markersToInlineNodes(`ask nostr:${NPUB}`)
    assert.deepEqual(nodes[1].marks, [{ type: 'reference', attrs: { uri: `nostr:${NPUB}` } }])
  })

  it('combines with the marks around it', () => {
    const nodes = markersToInlineNodes(`**nostr:${NPUB}**`)
    assert.deepEqual(nodes[0].marks, [
      { type: 'bold' },
      { type: 'reference', attrs: { uri: `nostr:${NPUB}` } },
    ])
  })
})

describe('a reference in the render tree', () => {
  it('reaches a consumer with the uri attached', () => {
    const [para] = toRenderTree(`ask nostr:${NPUB}`, 'marker')
    assert.equal(para.inline?.[1].reference, `nostr:${NPUB}`)
    assert.equal(para.inline?.[1].text, `nostr:${NPUB}`)
  })

  it('arrives the same way from a block document', () => {
    const doc = JSON.stringify({
      type: 'doc',
      content: [{
        type: 'paragraph', id: 'b1',
        content: [{ type: 'text', text: `nostr:${NPUB}`, marks: [{ type: 'reference', attrs: { uri: `nostr:${NPUB}` } }] }],
      }],
    })
    const [para] = toRenderTree(doc, 'blocks')
    assert.equal(para.inline?.[0].reference, `nostr:${NPUB}`)
    assert.deepEqual(para.inline?.[0].marks, [])
  })
})

describe('findNostrUris', () => {
  it('finds people as well as objects, which findNaddrs does not', () => {
    const body = `nostr:${NPUB} filed nostr:${addrToNaddr(`30851:${PUBKEY}:an-issue`)}`
    const found = findNostrUris(body)
    assert.equal(found.length, 2)
    assert.equal(found[0], `nostr:${NPUB}`)
  })

  it('finds nothing in a body with none', () => {
    assert.deepEqual(findNostrUris('just words'), [])
  })
})

/**
 * Blossom authorization and `imeta`, against what the relay actually checks.
 *
 * Every assertion here mirrors a refusal in `buzz-media/src/auth.rs` or
 * `buzz-relay/src/handlers/imeta.rs`. The relay verifies more of a 24242 than
 * its shape suggests, and each of those is a rejection rather than a default —
 * so the value of these is that they fail *here* rather than at a publish.
 */
import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { buildBlossomAuth, blossomAuthHeader, imetaTag, imetaOf, KIND, type BlossomVerb } from '../dist/index.js'

const PUBKEY = 'a'.repeat(64)
const SHA = 'b'.repeat(64)
const at = (s: number) => s * 1000

describe('a Blossom authorization', () => {
  it('is a kind:24242 naming one verb and one blob', () => {
    const e = buildBlossomAuth(PUBKEY, at(1_000_000), { verb: 'upload', sha256: SHA })
    assert.equal(e.kind, 24242)
    assert.equal(e.kind, KIND.BLOSSOM_AUTH)
    assert.deepEqual(
      e.tags.filter((t) => t[0] !== 'expiration'),
      [['t', 'upload'], ['x', SHA]],
    )
  })

  /* BUD-11: content is a "human readable string", and the relay REFUSES an
     empty one. Nothing reads it, which is exactly why it is easy to omit. */
  it('never has empty content, which the relay rejects', () => {
    const e = buildBlossomAuth(PUBKEY, at(1_000_000), { verb: 'get', sha256: SHA })
    assert.ok(e.content.trim().length > 0)
    const given = buildBlossomAuth(PUBKEY, at(1_000_000), { verb: 'get', sha256: SHA, reason: '  ' })
    assert.ok(given.content.trim().length > 0, 'a blank reason must not become empty content')
  })

  it('expires in the future, and by default not far into it', () => {
    const e = buildBlossomAuth(PUBKEY, at(1_000_000), { verb: 'upload', sha256: SHA })
    const exp = Number(e.tags.find((t) => t[0] === 'expiration')![1])
    assert.ok(exp > e.created_at, 'expiration must be after created_at or the relay refuses it')
    assert.equal(exp, e.created_at + 300)
  })

  it('carries the verb it was asked for, since a get token cannot upload', () => {
    for (const verb of ['upload', 'get', 'list', 'delete'] as BlossomVerb[]) {
      const e = buildBlossomAuth(PUBKEY, at(1_000_000), { verb, sha256: SHA })
      assert.equal(e.tags.find((t) => t[0] === 't')![1], verb)
    }
  })

  /* Omitted by default on purpose: the relay accepts a token with no `server`,
     and refuses one whose host does not match. Absent is the safe default. */
  it('omits server unless told, and includes it when told', () => {
    const without = buildBlossomAuth(PUBKEY, at(1_000_000), { verb: 'get', sha256: SHA })
    assert.equal(without.tags.some((t) => t[0] === 'server'), false)
    const with_ = buildBlossomAuth(PUBKEY, at(1_000_000), { verb: 'get', sha256: SHA, server: 'estiva.estiva.app' })
    assert.equal(with_.tags.find((t) => t[0] === 'server')![1], 'estiva.estiva.app')
  })

  it('refuses a hash that is not 64 lowercase hex', () => {
    assert.throws(() => buildBlossomAuth(PUBKEY, at(1), { verb: 'get', sha256: 'B'.repeat(64) }), /64 lowercase hex/)
    assert.throws(() => buildBlossomAuth(PUBKEY, at(1), { verb: 'get', sha256: 'abc' }), /64 lowercase hex/)
  })

  it('encodes as the same header shape NIP-98 uses', () => {
    const signed = { ...buildBlossomAuth(PUBKEY, at(1_000_000), { verb: 'get', sha256: SHA }), id: 'c'.repeat(64), sig: '0'.repeat(128) }
    const header = blossomAuthHeader(signed)
    assert.ok(header.startsWith('Nostr '))
    // The relay decodes URL_SAFE_NO_PAD and falls back to STANDARD, so standard
    // base64 — what this package already emits for NIP-98 — is accepted.
    const decoded = JSON.parse(Buffer.from(header.slice(6), 'base64').toString('utf8'))
    assert.equal(decoded.kind, 24242)
  })
})

describe('the imeta tag', () => {
  const meta = { url: '/media/' + SHA + '.jpg', m: 'image/jpeg', x: SHA, size: 1234 }

  it('is one tag of space-separated pairs, not one tag per field', () => {
    const tag = imetaTag(meta)
    assert.equal(tag[0], 'imeta')
    assert.deepEqual(tag.slice(1), ['url /media/' + SHA + '.jpg', 'm image/jpeg', 'x ' + SHA, 'size 1234'])
  })

  it('round-trips through the reader', () => {
    assert.deepEqual(imetaOf({ tags: [imetaTag(meta)] }), [{ ...meta, dim: undefined, alt: undefined, thumb: undefined, filename: undefined }])
  })

  it('carries the optional fields only when they are set', () => {
    const full = imetaTag({ ...meta, dim: '800x600', alt: 'a chart', thumb: SHA + '.thumb.jpg', filename: 'chart.jpg' })
    const read = imetaOf({ tags: [full] })[0]
    assert.equal(read.dim, '800x600')
    assert.equal(read.alt, 'a chart')
    assert.equal(read.filename, 'chart.jpg')
  })

  /* A value can contain spaces — alt text and filenames do. Splitting on every
     space would truncate them, so only the FIRST space separates key from
     value. */
  it('keeps a value that contains spaces', () => {
    const read = imetaOf({ tags: [imetaTag({ ...meta, alt: 'two words here' })] })[0]
    assert.equal(read.alt, 'two words here')
  })

  it('skips a tag missing any required field rather than half-reading it', () => {
    assert.deepEqual(imetaOf({ tags: [['imeta', 'url /media/x.jpg', 'm image/jpeg']] }), [])
    assert.deepEqual(imetaOf({ tags: [['imeta', 'x ' + SHA, 'size 1']] }), [])
    assert.deepEqual(imetaOf({ tags: [['imeta', 'url /a', 'm image/jpeg', 'x ' + SHA, 'size not-a-number']] }), [])
  })

  it('ignores every tag that is not an imeta', () => {
    assert.deepEqual(imetaOf({ tags: [['h', 'folder'], ['e', 'id']] }), [])
  })

  it('reads several attachments on one message', () => {
    const second = { ...meta, x: 'c'.repeat(64), url: '/media/' + 'c'.repeat(64) + '.png', m: 'image/png' }
    assert.equal(imetaOf({ tags: [imetaTag(meta), imetaTag(second)] }).length, 2)
  })
})

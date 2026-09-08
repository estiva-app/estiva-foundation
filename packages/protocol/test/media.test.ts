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
import {
  buildBlossomAuth,
  blossomAuthHeader,
  imetaTag,
  imetaOf,
  sha256FromMediaUrl,
  fetchBlob,
  KIND,
  type BlossomVerb,
  type BlobFetchLike,
  sha256Of,
  uploadBlob,
  imetaFor,
  type BlobUploadFetchLike,
  type UploadedBlob,
} from '../dist/index.js'

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

describe('the sha256 a media path names', () => {
  it('reads the hash out of a media url', () => {
    assert.equal(sha256FromMediaUrl(`/media/${SHA}.jpg`), SHA)
    assert.equal(sha256FromMediaUrl(`https://buzz.estiva.app/media/${SHA}.png`), SHA)
  })

  /* A thumbnail is a derivative of its parent and the relay issues no separate
     hash for it, so an authorization for `.thumb.jpg` names the PARENT. Reading
     up to the last dot instead of the first would produce `<sha>.thumb`, which
     signs for a blob that does not exist and answers 401. */
  it('reads the parent hash out of a thumbnail path', () => {
    assert.equal(sha256FromMediaUrl(`/media/${SHA}.thumb.jpg`), SHA)
  })

  it('refuses anything not media-shaped, rather than signing for a misread path', () => {
    assert.equal(sha256FromMediaUrl('/media/not-a-hash.jpg'), undefined)
    assert.equal(sha256FromMediaUrl(`/files/${SHA}.jpg`), undefined)
    assert.equal(sha256FromMediaUrl(`/media/${SHA.toUpperCase()}.jpg`), undefined)
    assert.equal(sha256FromMediaUrl(''), undefined)
  })
})

describe('fetching a blob', () => {
  const sign = async (u: { kind: number; tags: string[][]; content: string; created_at: number }) => ({
    ...u,
    pubkey: PUBKEY,
    id: 'd'.repeat(64),
    sig: 'e'.repeat(128),
  })
  const ok = (body = 'bytes', type = 'image/jpeg') => ({
    status: 200,
    arrayBuffer: async () => new TextEncoder().encode(body).buffer as ArrayBuffer,
    text: async () => body,
    headers: { get: (n: string) => (n.toLowerCase() === 'content-type' ? type : null) },
  })

  const recording = () => {
    const calls: { url: string; headers: Record<string, string> }[] = []
    const transport: BlobFetchLike = async (url, init) => {
      calls.push({ url, headers: init.headers })
      return ok()
    }
    return { calls, transport }
  }

  /* The whole reason this function exists: an <img src> sends no header, and
     media GET is unconditionally authenticated on the deployed relay — so a
     plain fetch answers 401, which reads like a session problem. */
  it('sends a Blossom authorization', async () => {
    const { calls, transport } = recording()
    await fetchBlob({ relayUrl: 'https://buzz.estiva.app', url: `/media/${SHA}.jpg`, sign, pubkey: PUBKEY, transport })
    assert.equal(calls.length, 1)
    const header = calls[0].headers.authorization
    assert.ok(header?.startsWith('Nostr '), 'the relay looks for a Nostr scheme')
    const event = JSON.parse(Buffer.from(header.slice('Nostr '.length), 'base64').toString())
    assert.equal(event.kind, KIND.BLOSSOM_AUTH)
    assert.deepEqual(event.tags.find((t: string[]) => t[0] === 't'), ['t', 'get'])
    assert.deepEqual(event.tags.find((t: string[]) => t[0] === 'x'), ['x', SHA])
  })

  it('authorizes a thumbnail against its parent blob', async () => {
    const { calls, transport } = recording()
    await fetchBlob({ relayUrl: 'https://buzz.estiva.app', url: `/media/${SHA}.thumb.jpg`, sign, pubkey: PUBKEY, transport })
    const event = JSON.parse(Buffer.from(calls[0].headers.authorization.slice(6), 'base64').toString())
    assert.deepEqual(event.tags.find((t: string[]) => t[0] === 'x'), ['x', SHA])
  })

  it('resolves a bare path against the relay, and leaves an absolute url alone', async () => {
    const { calls, transport } = recording()
    await fetchBlob({ relayUrl: 'https://buzz.estiva.app/', url: `/media/${SHA}.jpg`, sign, pubkey: PUBKEY, transport })
    await fetchBlob({ relayUrl: 'https://buzz.estiva.app', url: `https://other.example/media/${SHA}.jpg`, sign, pubkey: PUBKEY, transport })
    assert.equal(calls[0].url, `https://buzz.estiva.app/media/${SHA}.jpg`, 'a trailing slash must not double')
    assert.equal(calls[1].url, `https://other.example/media/${SHA}.jpg`)
  })

  it('returns the bytes and the type the relay stored', async () => {
    const transport: BlobFetchLike = async () => ok('hello', 'image/png')
    const got = await fetchBlob({ relayUrl: 'https://b', url: `/media/${SHA}.png`, sign, pubkey: PUBKEY, transport })
    assert.equal(new TextDecoder().decode(got.bytes), 'hello')
    assert.equal(got.contentType, 'image/png')
  })

  it('falls back to a generic type when the relay sends none', async () => {
    const transport: BlobFetchLike = async () => ({ ...ok(), headers: { get: () => null } })
    const got = await fetchBlob({ relayUrl: 'https://b', url: `/media/${SHA}.png`, sign, pubkey: PUBKEY, transport })
    assert.equal(got.contentType, 'application/octet-stream')
  })

  /* A 401 body is bytes too. Without a status check the caller would render
     the error text as if it were the image. */
  it('throws on a refusal rather than returning the error body as content', async () => {
    const transport: BlobFetchLike = async () => ({ ...ok('unauthorized'), status: 401 })
    await assert.rejects(
      () => fetchBlob({ relayUrl: 'https://b', url: `/media/${SHA}.jpg`, sign, pubkey: PUBKEY, transport }),
      /401/,
    )
  })

  it('refuses a url it cannot read a hash out of, without signing anything', async () => {
    let signed = false
    await assert.rejects(
      () =>
        fetchBlob({
          relayUrl: 'https://b',
          url: '/media/nope.jpg',
          sign: async (u) => {
            signed = true
            return sign(u)
          },
          pubkey: PUBKEY,
          transport: async () => ok(),
        }),
      /not a media url/,
    )
    assert.equal(signed, false)
  })
})

describe('a blob\'s identity', () => {
  it('is the sha256 of its bytes, lowercase hex', () => {
    // The empty string's sha256 — a value with an answer outside this repo.
    assert.equal(sha256Of(new Uint8Array()), 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855')
  })

  it('reads an ArrayBuffer and a Uint8Array the same way', () => {
    const bytes = new TextEncoder().encode('abc')
    assert.equal(sha256Of(bytes), sha256Of(bytes.buffer as ArrayBuffer))
    assert.equal(sha256Of(bytes), 'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad')
  })
})

describe('uploading a blob', () => {
  const sign = async (u: { kind: number; tags: string[][]; content: string; created_at: number }) => ({
    ...u,
    pubkey: PUBKEY,
    id: 'd'.repeat(64),
    sig: 'e'.repeat(128),
  })
  const bytes = new TextEncoder().encode('a picture').buffer as ArrayBuffer
  const digest = sha256Of(bytes)
  const descriptor = {
    url: `https://buzz.estiva.app/media/${digest}.jpg`,
    sha256: digest,
    size: 9,
    type: 'image/jpeg',
    thumb: `https://buzz.estiva.app/media/${digest}.thumb.jpg`,
    dim: '800x600',
  }

  const recording = (body = JSON.stringify(descriptor), status = 201) => {
    const calls: { url: string; init: { method: string; headers: Record<string, string>; body: ArrayBuffer } }[] = []
    const transport: BlobUploadFetchLike = async (url, init) => {
      calls.push({ url, init })
      return { status, text: async () => body }
    }
    return { calls, transport }
  }

  it('PUTs to /upload with the bytes', async () => {
    const { calls, transport } = recording()
    await uploadBlob({ relayUrl: 'https://buzz.estiva.app/', bytes, contentType: 'image/jpeg', sign, pubkey: PUBKEY, transport })
    assert.equal(calls[0].url, 'https://buzz.estiva.app/upload', 'a trailing slash must not double')
    assert.equal(calls[0].init.method, 'PUT')
    assert.equal(calls[0].init.body, bytes)
  })

  /* BUD-11 makes `x-sha-256` mandatory on the PUT, and the `x` tag on the
     authorization must be the same digest — so the client has to know the hash
     before it may ask permission to send the bytes. */
  it('names the same digest in the header and the authorization', async () => {
    const { calls, transport } = recording()
    await uploadBlob({ relayUrl: 'https://b', bytes, contentType: 'image/jpeg', sign, pubkey: PUBKEY, transport })
    assert.equal(calls[0].init.headers['x-sha-256'], digest)
    const event = JSON.parse(Buffer.from(calls[0].init.headers.authorization.slice('Nostr '.length), 'base64').toString())
    assert.equal(event.kind, KIND.BLOSSOM_AUTH)
    assert.deepEqual(event.tags.find((t: string[]) => t[0] === 't'), ['t', 'upload'])
    assert.deepEqual(event.tags.find((t: string[]) => t[0] === 'x'), ['x', digest])
  })

  it('falls back to a generic content type rather than sending none', async () => {
    const { calls, transport } = recording()
    await uploadBlob({ relayUrl: 'https://b', bytes, sign, pubkey: PUBKEY, transport })
    assert.equal(calls[0].init.headers['content-type'], 'application/octet-stream')
  })

  it('returns the relay\'s descriptor', async () => {
    const { transport } = recording()
    const blob = await uploadBlob({ relayUrl: 'https://b', bytes, contentType: 'image/jpeg', sign, pubkey: PUBKEY, transport })
    assert.deepEqual(blob, descriptor as UploadedBlob)
  })

  it('throws the relay\'s own words on a refusal', async () => {
    const { transport } = recording('blob already exists elsewhere', 403)
    await assert.rejects(
      () => uploadBlob({ relayUrl: 'https://b', bytes, sign, pubkey: PUBKEY, transport }),
      /403.*blob already exists/,
    )
  })

  /* A 200 with a body that is not a descriptor is the shape that would
     otherwise produce an `imeta` with `url: undefined`, which the relay refuses
     with nothing to say the upload was at fault. */
  it('refuses a success that carried no descriptor', async () => {
    for (const body of ['not json', '{}', JSON.stringify({ url: '/media/x.jpg' })]) {
      const { transport } = recording(body, 200)
      await assert.rejects(
        () => uploadBlob({ relayUrl: 'https://b', bytes, sign, pubkey: PUBKEY, transport }),
        /no blob descriptor/,
      )
    }
  })
})

describe('an uploaded blob as an imeta', () => {
  const blob: UploadedBlob = {
    url: `https://buzz.estiva.app/media/${SHA}.jpg`,
    sha256: SHA,
    size: 4096,
    type: 'image/jpeg',
    dim: '800x600',
    thumb: `https://buzz.estiva.app/media/${SHA}.thumb.jpg`,
  }

  /* `m` and `x` must be the RELAY's answers. `validate_imeta_tags` compares
     them against what it stored, so a client that guessed a MIME from an
     extension publishes a message the relay refuses with nothing to say which
     field was wrong. */
  it('takes the type and the hash from the relay, not from the caller', () => {
    const meta = imetaFor(blob)
    assert.equal(meta.m, blob.type)
    assert.equal(meta.x, blob.sha256)
    assert.equal(meta.url, blob.url)
    assert.equal(meta.size, blob.size)
  })

  it('carries the relay\'s thumbnail and dimensions through', () => {
    const meta = imetaFor(blob)
    assert.equal(meta.thumb, blob.thumb)
    assert.equal(meta.dim, blob.dim)
  })

  it('takes alt text and a filename from the caller, since the relay has neither', () => {
    const meta = imetaFor(blob, { alt: 'the failing dialog', filename: 'shot.jpg' })
    assert.equal(meta.alt, 'the failing dialog')
    assert.equal(meta.filename, 'shot.jpg')
  })

  it('round-trips through the tag it becomes', () => {
    const meta = imetaFor(blob, { filename: 'shot.jpg' })
    assert.deepEqual(imetaOf({ tags: [imetaTag(meta)] })[0], meta)
  })
})

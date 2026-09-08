/**
 * `POST /sign`, and the guard three copies of it had already drifted on.
 *
 * Collapsed here from `ship/lib/nostr/signer.ts`, its byte-identical twin in
 * `estiva-agent`, and `peek/src/nostr/bridge.ts`. The tests that matter most are
 * the wrong-author ones: `/sign` signs as the token's subject regardless of what
 * it is handed, so a mismatch is **HTTP 200 with a valid event by somebody
 * else** — and Ship's copy, the one that publishes every issue, comment and
 * status change, had no check for it at all.
 */
import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import type { UnsignedEvent } from '@estiva-app/protocol'
import { SignerTokenExpired, estivaIdSigner, signViaEstivaId } from '../dist/index.js'

const MINE = 'a1'.repeat(32)
const SOMEBODY_ELSE = 'ff'.repeat(32)

/**
 * `pubkey: ''` is not laziness — it is what Peek's NIP-98 path actually passes.
 * `/sign` overwrites it with the token's subject, so filling it in would be
 * theatre, and the test below asserts it is not forwarded at all.
 */
const UNSIGNED: UnsignedEvent = { pubkey: '', kind: 1111, created_at: 1_787_142_018, tags: [['h', 'folder']], content: 'hello' }

interface Call {
  url: string
  headers: Record<string, string>
  body: { event: Record<string, unknown> }
}

/** Answers each call from `replies`, in order, and records what was asked. */
function fakeSign(replies: Array<{ status?: number; body: unknown }>) {
  const calls: Call[] = []
  let i = 0
  const fetch = async (url: string, init: { method: string; headers: Record<string, string>; body: string }) => {
    calls.push({ url, headers: init.headers, body: JSON.parse(init.body) })
    const reply = replies[Math.min(i++, replies.length - 1)]
    const status = reply.status ?? 200
    return {
      ok: status >= 200 && status < 300,
      status,
      text: async () => (typeof reply.body === 'string' ? reply.body : JSON.stringify(reply.body)),
    }
  }
  return { calls, fetch }
}

const signedBy = (pubkey: string) => ({ event: { ...UNSIGNED, pubkey, id: 'de'.repeat(32), sig: 'ab'.repeat(64) } })

describe('POST /sign', () => {
  it('sends the bearer and only the four fields that go into the signature', async () => {
    const f = fakeSign([{ body: signedBy(MINE) }])
    await signViaEstivaId(UNSIGNED, { base: 'https://id.estiva.app/', token: 'at', expectedPubkey: MINE, fetch: f.fetch })

    // The trailing slash on `base` is stripped rather than doubled into `//sign`.
    assert.equal(f.calls[0].url, 'https://id.estiva.app/sign')
    assert.equal(f.calls[0].headers.authorization, 'Bearer at')
    /*
      No `pubkey` in the body. An unsigned event may carry one — Peek's NIP-98
      path passes an empty string on purpose — and sending it would imply /sign
      honours it, which it never does.
    */
    assert.deepEqual(Object.keys(f.calls[0].body.event).sort(), ['content', 'created_at', 'kind', 'tags'])
  })

  it('returns the signed event', async () => {
    const f = fakeSign([{ body: signedBy(MINE) }])
    const event = await signViaEstivaId(UNSIGNED, { base: 'https://id.estiva.app', token: 'at', expectedPubkey: MINE, fetch: f.fetch })
    assert.equal(event.pubkey, MINE)
    assert.equal(event.content, 'hello')
  })

  it('REFUSES an event authored by somebody else, on HTTP 200', async () => {
    /*
      The reason the check exists. This is not an error path the service reports
      — it is a success the service reports, carrying an event signed by the
      wrong person. Ship's copy of this signer returned it. The symptom arrives
      much later, as a comment attributed to a colleague, with nothing in any log
      to connect it to the call that made it.
    */
    const f = fakeSign([{ body: signedBy(SOMEBODY_ELSE) }])
    await assert.rejects(
      signViaEstivaId(UNSIGNED, { base: 'https://id.estiva.app', token: 'at', expectedPubkey: MINE, fetch: f.fetch }),
      /authored by ff.*expected a1.*refusing to publish under the wrong author/s,
    )
  })

  it('throws SignerTokenExpired on 401, distinctly', async () => {
    // "Obtain a new token" and "this event was refused" call for completely
    // different things from the caller, and the status is all that separates them.
    const f = fakeSign([{ status: 401, body: { error: { message: 'expired' } } }])
    await assert.rejects(
      signViaEstivaId(UNSIGNED, { base: 'https://id.estiva.app', token: 'at', fetch: f.fetch }),
      SignerTokenExpired,
    )
  })

  it('carries the refusal reason, and falls back to raw text when it is not JSON', async () => {
    const json = fakeSign([{ status: 403, body: { error: { message: 'kind:0 belongs to the identity service' } } }])
    await assert.rejects(
      signViaEstivaId(UNSIGNED, { base: 'https://id.estiva.app', token: 'at', fetch: json.fetch }),
      /refused to sign kind:1111 — kind:0 belongs to the identity service/,
    )

    // /sign's error bodies are not reliably JSON, and raw text is more use to a
    // person than "unparseable response".
    const plain = fakeSign([{ status: 502, body: 'upstream unavailable' }])
    await assert.rejects(
      signViaEstivaId(UNSIGNED, { base: 'https://id.estiva.app', token: 'at', fetch: plain.fetch }),
      /refused to sign kind:1111 — upstream unavailable/,
    )
  })

  it('refuses a 200 that carries no event', async () => {
    const f = fakeSign([{ body: {} }])
    await assert.rejects(
      signViaEstivaId(UNSIGNED, { base: 'https://id.estiva.app', token: 'at', fetch: f.fetch }),
      /returned no event/,
    )
  })
})

describe('estivaIdSigner', () => {
  it('supplies the author guard whether or not the caller thought about it', async () => {
    /*
      The guard is not optional on this path. Ship builds this signer once, at
      module scope, and every write in the app goes through it — so if the stored
      pubkey and the stored token ever describe different people, this is the only
      place that can notice.
    */
    const f = fakeSign([{ body: signedBy(SOMEBODY_ELSE) }])
    const signer = estivaIdSigner({ base: 'https://id.estiva.app', pubkey: MINE, token: 'at', fetch: f.fetch })
    await assert.rejects(signer.sign(UNSIGNED), /refusing to publish under the wrong author/)
  })

  it('reports the pubkey and kind synchronously', () => {
    const f = fakeSign([{ body: signedBy(MINE) }])
    const signer = estivaIdSigner({ base: 'https://id.estiva.app', pubkey: MINE, token: 'at', fetch: f.fetch })
    assert.equal(signer.pubkey, MINE)
    assert.equal(signer.kind, 'estiva-id')
  })

  it('renews once on a 401 and retries, invisibly', async () => {
    const f = fakeSign([{ status: 401, body: {} }, { body: signedBy(MINE) }])
    let renewals = 0
    const signer = estivaIdSigner({
      base: 'https://id.estiva.app',
      pubkey: MINE,
      token: 'stale',
      renew: async () => (renewals++, 'fresh'),
      fetch: f.fetch,
    })

    const event = await signer.sign(UNSIGNED)

    assert.equal(event.pubkey, MINE)
    assert.equal(renewals, 1)
    assert.equal(f.calls[0].headers.authorization, 'Bearer stale')
    assert.equal(f.calls[1].headers.authorization, 'Bearer fresh')
  })

  it('keeps the renewed bearer for later signatures', async () => {
    // Rediscovering the expiry on every subsequent signature would spend a
    // single-use refresh token per event, which Estiva ID reads as theft.
    const f = fakeSign([{ status: 401, body: {} }, { body: signedBy(MINE) }])
    let renewals = 0
    const signer = estivaIdSigner({
      base: 'https://id.estiva.app',
      pubkey: MINE,
      token: 'stale',
      renew: async () => (renewals++, 'fresh'),
      fetch: f.fetch,
    })

    await signer.sign(UNSIGNED)
    await signer.sign(UNSIGNED)

    assert.equal(renewals, 1, 'the second signature must not renew again')
    assert.equal(f.calls[2].headers.authorization, 'Bearer fresh')
  })

  it('renews once and never twice', async () => {
    // A second 401 after a successful renewal is not an expiry — it is a token
    // the service will not accept, and retrying it is how one refused signature
    // becomes a hot loop against the identity service.
    const f = fakeSign([{ status: 401, body: {} }])
    let renewals = 0
    const signer = estivaIdSigner({
      base: 'https://id.estiva.app',
      pubkey: MINE,
      token: 'stale',
      renew: async () => (renewals++, 'fresh'),
      fetch: f.fetch,
    })

    await assert.rejects(signer.sign(UNSIGNED), SignerTokenExpired)
    assert.equal(renewals, 1)
    assert.equal(f.calls.length, 2, 'one attempt, one renewal, one retry, and then stop')
  })

  it('reports the expiry when renewal fails', async () => {
    const f = fakeSign([{ status: 401, body: {} }])
    const signer = estivaIdSigner({
      base: 'https://id.estiva.app',
      pubkey: MINE,
      token: 'stale',
      renew: async () => null,
      fetch: f.fetch,
    })
    await assert.rejects(signer.sign(UNSIGNED), SignerTokenExpired)
    assert.equal(f.calls.length, 1, 'a failed renewal must not be retried against')
  })

  it('behaves exactly as before with no renew callback', async () => {
    const f = fakeSign([{ status: 401, body: {} }])
    const signer = estivaIdSigner({ base: 'https://id.estiva.app', pubkey: MINE, token: 'at', fetch: f.fetch })
    await assert.rejects(signer.sign(UNSIGNED), SignerTokenExpired)
    assert.equal(f.calls.length, 1)
  })

  it('does NOT renew on anything that is not an expiry', async () => {
    /*
      The control, and the one that makes the retry safe to have. A wrong-author
      refusal and a policy refusal are not fixed by a new token, and treating
      them as expiries would spend a single-use refresh token on every one of
      them.
    */
    const wrongAuthor = fakeSign([{ body: signedBy(SOMEBODY_ELSE) }])
    let renewals = 0
    const signer = estivaIdSigner({
      base: 'https://id.estiva.app',
      pubkey: MINE,
      token: 'at',
      renew: async () => (renewals++, 'fresh'),
      fetch: wrongAuthor.fetch,
    })

    await assert.rejects(signer.sign(UNSIGNED), /wrong author/)
    assert.equal(renewals, 0)
    assert.equal(wrongAuthor.calls.length, 1)
  })
})

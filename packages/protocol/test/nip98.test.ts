/**
 * NIP-98 auth-header rules, checked against the relay's verifier
 * (crates/buzz-auth/src/nip98.rs:55).
 *
 * Ported from `peek-app/convex/nostr/nip98.test.ts` with SHA-3, and one thing
 * changed on the way. Peek exported a `buildAuthEvent(args & { secretKeyHex })`
 * that built and signed in one call, "because custodial publishing holds a raw
 * secret and has no reason to go near the identity service" — a path that had
 * already gone. PEEK-40 killed the custodied-key branch and `convex/nostr/
 * config.ts` records the rest of that file going with the actions that used it,
 * so the wrapper's only remaining caller was this test.
 *
 * It is not in the package. The composition is one line — `signEvent(
 * buildUnsignedAuthEvent(args), secret)` — and a convenience wrapper kept alive
 * by its own test is how a dead code path looks maintained. Every assertion
 * below is the one Peek made; only the two lines that construct the event moved.
 */
import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { sha256 } from '@noble/hashes/sha256'
import { bytesToHex, utf8ToBytes } from '@noble/hashes/utils'
import {
  authorizationHeaderFor,
  buildUnsignedAuthEvent,
  computeEventId,
  normalizeUrl,
  publicKeyFromSecret,
  signEvent,
  type AuthEventArgs,
} from '../dist/index.js'

const SECRET = bytesToHex(sha256(utf8ToBytes('nip98-test')))
const PUBKEY = publicKeyFromSecret(SECRET)
const URL_ = 'http://localhost:3000/events'

const auth = (over: Partial<AuthEventArgs> = {}) =>
  signEvent(buildUnsignedAuthEvent({ pubkey: PUBKEY, url: URL_, method: 'POST', ...over }), SECRET)

describe('NIP-98 auth events', () => {
  it('is kind 27235 with a valid self-consistent id', () => {
    const e = auth()
    assert.equal(e.kind, 27235)
    assert.equal(computeEventId(e), e.id)
  })

  it('carries u and method tags the verifier looks up by name', () => {
    const e = auth()
    const byName = (n: string) => e.tags.find((t) => t[0] === n)?.[1]
    assert.equal(byName('u'), URL_)
    assert.equal(byName('method'), 'POST')
  })

  it('uppercases the method (the verifier compares case-insensitively)', () => {
    assert.equal(auth({ method: 'post' }).tags.find((t) => t[0] === 'method')?.[1], 'POST')
  })

  it('adds a payload tag with sha256 of the body when one is sent', () => {
    const body = '{"hello":"world"}'
    const e = auth({ body })
    assert.equal(e.tags.find((t) => t[0] === 'payload')?.[1], bytesToHex(sha256(utf8ToBytes(body))))
  })

  it('omits the payload tag entirely when there is no body', () => {
    assert.equal(auth().tags.some((t) => t[0] === 'payload'), false)
  })

  /**
   * The regression that matters. `created_at` has one-second resolution, so
   * without a nonce two identical requests inside the same second produce a
   * byte-identical event — and the relay rejects the second with
   * `NIP-98: replay detected` (observed live before this fix).
   */
  it('produces a unique event id for identical requests in the same second', () => {
    const now = 1_753_300_200_000
    const a = auth({ nowMs: now, body: 'same' })
    const b = auth({ nowMs: now, body: 'same' })
    assert.equal(a.created_at, b.created_at)
    assert.notEqual(a.id, b.id)
  })

  it('is deterministic when the nonce is pinned, proving the nonce is the only variable', () => {
    const args = { nowMs: 1_753_300_200_000, body: 'same', nonce: 'fixed' }
    assert.equal(auth(args).id, auth(args).id)
  })

  it('formats the header as `Nostr <base64 event json>`', () => {
    const header = authorizationHeaderFor(auth())
    assert.equal(header.startsWith('Nostr '), true)
    const decoded = JSON.parse(atob(header.slice('Nostr '.length)))
    assert.equal(decoded.kind, 27235)
    assert.equal(decoded.pubkey, PUBKEY)
  })

  it('strips trailing slashes but keeps loopback hosts distinct', () => {
    assert.equal(normalizeUrl('http://localhost:3000/events/'), 'http://localhost:3000/events')
    // The relay deliberately does NOT alias these — the u-tag host is the
    // community binding, so collapsing them would be a host-binding side door.
    assert.notEqual(normalizeUrl('http://localhost:3000/events'), normalizeUrl('http://127.0.0.1:3000/events'))
  })
})

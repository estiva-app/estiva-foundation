/**
 * Verify @estiva-app/protocol against the live relay, not against its own tests.
 *
 * A green suite is compatible with a rejected event. The relay is the only
 * authority on whether the wire format is right, so this publishes REAL signed
 * events built by the package's `dist/` and reads the `accepted` field back.
 *
 * Four arms, and the negative ones are the point — without them "it works" is
 * indistinguishable from "the rule was removed":
 *
 *   1. POSITIVE, no new state: a `kind:9007` naming a channel that already
 *      exists. The relay answers `200 {"accepted":false,"duplicate:…"}`, which
 *      proves the event was parsed, its id recomputed and its signature verified
 *      — it got far enough to be recognised as a duplicate. Nothing is created.
 *   2. NEGATIVE, tampered bytes: the same signed event with two tags swapped,
 *      `id` and `sig` left alone. The relay must refuse. This is the control that
 *      makes arm 1 mean something: it shows the relay really does recompute the
 *      id, so agreement is agreement and not indifference.
 *   3. NEGATIVE, a kind outside the ceiling: `kind:0`. SPEC §4.2 says the
 *      identity service refuses it for every app unconditionally. Proves the
 *      gates are live rather than open.
 *   4. POSITIVE READ: query the relay for a real event and check the package
 *      recomputes the id the relay is storing it under.
 *
 * Publishes nothing new and mutates nothing.
 *
 * ## Why this is not in CI
 *
 * It needs a real workspace credential, and a credential in CI is the standing
 * secret ADR 0002 §4c spent a failed release deciding not to have. So it is a
 * hand-run check, and the release checklist is where it belongs:
 *
 *   cd ~/estiva-foundation && npm run build -w packages/protocol
 *   set -a && . ~/.estiva-agent.env && set +a
 *   node packages/protocol/scripts/verify-live.mjs
 *
 * Run it before tagging any release whose "Wire behaviour" line is not
 * "unchanged" — and once after, against the published tarball rather than the
 * workspace, because built is not published.
 */
import { readFileSync } from 'node:fs'

const P = await import(process.argv[2] ?? '../dist/index.js')
const RELAY = process.env.RELAY_URL ?? 'https://estiva.estiva.app'
const ID_BASE = process.env.ESTIVA_ID_BASE ?? 'https://id.estiva.app'
/** The "Shared foundation packages" project Folder — SHA-3's own container. */
const EXISTING_CHANNEL = '24f5c271-3ed4-47f7-92e4-e9d6cf7f42d1'

let failures = 0
const check = (label, ok, detail = '') => {
  console.log(`${ok ? '✅' : '❌'} ${label}${detail ? ` — ${detail}` : ''}`)
  if (!ok) failures++
}

// ── credential ─────────────────────────────────────────────────────────────
const tokenRes = await fetch(`${ID_BASE}/token`, {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify({
    grantType: 'client_credentials',
    clientId: process.env.ESTIVA_ID_CLIENT_ID,
    clientSecret: process.env.ESTIVA_ID_CLIENT_SECRET,
  }),
})
const token = await tokenRes.json()
check('got a token from Estiva ID', tokenRes.ok, `pubkey ${token.pubkey?.slice(0, 12)}…`)

/**
 * A Signer that signs through `/sign` — the keyless path, which is the one both
 * apps use. `expectedPubkey` is a check, not a request: `/sign` signs as the
 * token's subject whatever it is handed, so a mismatch comes back as HTTP 200
 * with an event authored by somebody else.
 */
const signer = {
  pubkey: token.pubkey,
  kind: 'estiva-id',
  async sign(unsigned) {
    const res = await fetch(`${ID_BASE}/sign`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${token.access_token}` },
      body: JSON.stringify({ event: { ...unsigned, pubkey: '' } }),
    })
    const text = await res.text()
    if (!res.ok) throw new Error(`POST /sign -> ${res.status} ${text.slice(0, 200)}`)
    const { event } = JSON.parse(text)
    if (event.pubkey !== this.pubkey) throw new Error(`/sign returned an event authored by ${event.pubkey}`)
    return event
  },
}

const headers = () => (token.owner_attestation ? { 'x-auth-tag': token.owner_attestation } : {})
const relay = new P.Relay(RELAY, signer, { headers })

// ── arm 1: a real signed 9007 the relay already has ────────────────────────
const unsigned = P.buildCreateChannel(signer.pubkey, Date.now(), {
  channelUuid: EXISTING_CHANNEL,
  name: 'Shared foundation packages',
})
const signed = await signer.sign(unsigned)
check(
  'the package recomputes the id /sign signed',
  P.computeEventId({ ...unsigned, pubkey: signer.pubkey }) === signed.id,
  signed.id.slice(0, 16),
)

const dup = await relay.publish(signed)
console.log(`   relay said: accepted=${dup.duplicate ? 'false (duplicate)' : dup.ok} message=${JSON.stringify(dup.reason)}`)
check(
  'a real signed event reached the relay and was recognised',
  dup.duplicate === true,
  'HTTP 200 with accepted:false and a duplicate message — parsed, id recomputed, signature verified',
)
check('and the client reports a duplicate as ok, because it is the desired end state', dup.ok === true)

// ── arm 2: the negative control — tampered bytes ───────────────────────────
const tampered = { ...signed, tags: [signed.tags[1], signed.tags[0], ...signed.tags.slice(2)] }
check(
  'swapping two tags really does change the id we compute',
  P.computeEventId(tampered) !== signed.id,
  `${P.computeEventId(tampered).slice(0, 16)} ≠ ${signed.id.slice(0, 16)}`,
)
const bad = await relay.publish(tampered)
console.log(`   relay said: ok=${bad.ok} status=${bad.httpStatus} message=${JSON.stringify(bad.reason)}`)
check(
  'NEGATIVE CONTROL: the relay refuses an event whose bytes no longer match its id',
  bad.ok === false,
  'so arm 1 is agreement about the bytes, not indifference to them',
)

// ── arm 3: the negative control — a kind outside the ceiling ───────────────
let kindZeroRefused = false
let kindZeroDetail = ''
try {
  await signer.sign(P.buildProfile(signer.pubkey, Date.now(), { name: 'should never be signed' }))
} catch (error) {
  kindZeroRefused = true
  kindZeroDetail = String(error.message).slice(0, 120)
}
check('NEGATIVE CONTROL: /sign refuses kind:0 for every app, unconditionally (SPEC §4.2)', kindZeroRefused, kindZeroDetail)

// ── arm 4: read back, and recompute what the relay is storing ─────────────
const stored = await relay.query([{ kinds: [30851], limit: 5 }])
check('a NIP-98-authenticated /query came back', stored.length > 0, `${stored.length} kind:30851 events`)
const mismatches = stored.filter((e) => P.computeEventId(e) !== e.id)
check(
  "the package reproduces the relay's own id for every event it handed back",
  mismatches.length === 0,
  mismatches.length ? `mismatched: ${mismatches.map((e) => e.id.slice(0, 12)).join(', ')}` : `${stored.length}/${stored.length}`,
)

// And the vectors this package pins are events this relay is actually holding.
const vectors = JSON.parse(readFileSync(new URL('../test/wire-vectors.json', import.meta.url), 'utf8'))
const pinned = vectors.production.events.map((e) => e.id)
const found = await relay.query([{ ids: pinned }])
check(
  'the production vectors in the test suite are events this relay still holds',
  found.length > 0,
  `${found.length} of ${pinned.length} found; ids reproduce: ${found.every((e) => P.computeEventId(e) === e.id)}`,
)

console.log(
  failures === 0
    ? '\nThe live relay agrees with @estiva-app/protocol, and refuses what it should.'
    : `\n${failures} check(s) failed.`,
)
process.exit(failures === 0 ? 0 : 1)

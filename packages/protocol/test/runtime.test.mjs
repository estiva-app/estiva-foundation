/**
 * Importing this package must not require a DOM.
 *
 * Peek imports these modules from **both** its Convex tree and its browser
 * bundle, and the agent runs them under `tsx`. `WebSocket` does not exist in
 * Convex's default runtime. An eager `const WS = WebSocket` at module scope would
 * throw at *import* time in a backend that only wanted the event builders — a
 * deploy-time failure, invisible to typecheck and to unit tests, which is
 * exactly the shape `peek/convex/nostr/sync.ts` documents having hit once
 * already.
 *
 * `tsconfig.base.json` guards the type side (`types: []`, no `lib: dom`, so a
 * global reference is a compile error unless it is declared module-locally).
 * This guards the runtime side, which the compiler cannot see: the globals are
 * declared inside the modules that need them and read inside function bodies.
 *
 * ## What is deliberately NOT removed, and why
 *
 * `TextEncoder`, `TextDecoder` and `URL` stay. Not because this package would
 * mind losing them — it reads all three lazily — but because **`@noble/curves`
 * reads `TextEncoder` at module-initialization time** (`abstract/hash-to-curve.js`
 * calls `utf8ToBytes` while the module body runs). Found by writing this test
 * with a longer list. So "no globals at all" is not a property this package can
 * have while it depends on `@noble/*`, and claiming it would be a test that
 * passes for the wrong reason.
 *
 * That is a fair line rather than a concession: the three are WHATWG universals
 * present in every runtime the suite targets — browsers, Node, Convex's default
 * and Node runtimes, Deno, workers. The ones below are the ones a real target
 * genuinely lacks.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'

/** Globals a target runtime really may not have. Each is read lazily or not at all. */
const REMOVED = ['WebSocket', 'fetch', 'btoa', 'atob', 'setTimeout', 'clearTimeout', 'setInterval', 'process', 'Buffer', 'document', 'window', 'localStorage', 'sessionStorage', 'navigator']

test('the barrel imports and works with every browser-and-Node-only global removed', async () => {
  // Resolved BEFORE the globals go: this test needs `URL`, and the query string
  // makes it a fresh module so an earlier test file cannot answer out of cache.
  const fresh = new URL(`../dist/index.js?runtime-probe=${Math.random()}`, import.meta.url).href
  const saved = {}
  for (const name of REMOVED) {
    if (name in globalThis) {
      saved[name] = globalThis[name]
      delete globalThis[name]
    }
  }
  try {
    const P = await import(fresh)
    assert.equal(typeof P.createLiveRelay, 'function', 'the socket client must import even where WebSocket does not exist')
    assert.equal(typeof P.Relay, 'function', 'the bridge client must import even where fetch does not exist')

    // And the pure half must still *work*, with nothing restored. These are the
    // functions Peek's Convex tree actually calls.
    assert.equal(P.computeEventId({ pubkey: 'a'.repeat(64), created_at: 1, kind: 1, tags: [], content: '' }).length, 64)
    assert.equal(P.canonicalChannelName('  # x  '), 'x')
    assert.equal(P.toNostrSeconds(1787142018561), 1787142018)
    assert.deepEqual(P.threadTags({ rootId: 'r', parentId: 'r' }), [['e', 'r', '', 'reply']])
    assert.equal(P.buildMessage('a'.repeat(64), 1, { channelUuid: 'c', content: 'x' }).kind, 9)
    assert.equal(P.naddrToAddr(P.addrToNaddr(`30851:${'b'.repeat(64)}:d`)), `30851:${'b'.repeat(64)}:d`)
    // NIP-98's builder needs no transport, only a clock and a hash.
    assert.equal(P.buildUnsignedAuthEvent({ pubkey: 'a'.repeat(64), url: 'https://r/events', method: 'POST', nonce: 'n' }).kind, 27235)
  } finally {
    for (const [name, value] of Object.entries(saved)) globalThis[name] = value
  }
})

/*
  The negative control: if deleting the globals did nothing — a stub left behind,
  a bundler having inlined them — the test above would pass no matter what the
  package did.
*/
test('deleting the globals really does break code that reads them', () => {
  const saved = globalThis.WebSocket
  delete globalThis.WebSocket
  try {
    assert.throws(() => new globalThis.WebSocket('wss://x'), TypeError)
  } finally {
    if (saved !== undefined) globalThis.WebSocket = saved
  }
})

test('base64 needs btoa, and says so plainly rather than at a distance', async () => {
  const P = await import('../dist/index.js')
  const saved = globalThis.btoa
  delete globalThis.btoa
  try {
    // Documenting the seam rather than defending it: `btoa` is present in every
    // runtime the suite targets, and a helper that silently fell back to Buffer
    // would be a Node assumption smuggled into a browser package.
    assert.throws(() => P.base64('x'), ReferenceError)
  } finally {
    globalThis.btoa = saved
  }
  assert.equal(P.base64('hello'), 'aGVsbG8=')
  // utf8-aware, unlike a bare btoa, which throws above U+00FF.
  assert.equal(P.base64('café'), 'Y2Fmw6k=')
})

test('the version constant agrees with package.json', async () => {
  const { readFileSync } = await import('node:fs')
  const { version } = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'))
  const { PROTOCOL_VERSION } = await import('../dist/index.js')
  // The constant is what makes "the upgrade reached the app" checkable by
  // grepping a built bundle. If it drifts from the published version, that check
  // silently starts lying.
  assert.equal(PROTOCOL_VERSION, version)
})

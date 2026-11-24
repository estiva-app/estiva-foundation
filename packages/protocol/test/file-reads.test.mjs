// What a relay says about finding files (SPEC §6.13), and a search's or a
// times read's answer. Every relay keeps every file type in order since the
// close (2026-11-24), so the only thing an app reads from NIP-11 is search.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import * as protocol from '../dist/index.js'

const { Relay, parseQueryResponse, relayFileReadsOf, secretKeySigner } = protocol

const SECRET = '1'.repeat(64)

// The NIP-11 document production served on 2026-11-24.
const PRODUCTION = {
  files: { requires_prev: ['osnova.project', 'osnova.issue', 'osnova.document', 'osnova.topic'] },
  file_list: { newest: true, text: true, times: true },
  file_search: { max_page_size: 20, types: ['osnova.project', 'osnova.document'] },
}

test('an app reads from a relay only which types it finds by their words', () => {
  assert.deepEqual(relayFileReadsOf(PRODUCTION), { search: ['osnova.project', 'osnova.document'] })
  assert.deepEqual(relayFileReadsOf({ name: 'a relay that finds nothing' }), { search: [] })
  assert.deepEqual(relayFileReadsOf(undefined), { search: [] })
})

test('a times answer is read as times', () => {
  const body = JSON.stringify({
    times: [
      { a: '30851:pk:i', created_at: 5, h: 'team', under: '30850:pk:p', changes: [{ id: 'c', created_at: 9, fields: ['status', 'description'] }] },
      { a: 'not a file', changes: 'no' },
      { a: '30851:pk:j', created_at: 5, h: null, changes: [{ id: 'd', created_at: 9, fields: { status: 'done' } }] },
    ],
  })
  const result = parseQueryResponse(200, body)
  assert.equal(result.ok, true)
  assert.deepEqual(result.events, [])
  assert.deepEqual(result.times?.map((t) => t.a), ['30851:pk:i'])
  assert.deepEqual(protocol.timesOf({ status: 200, text: body })[0].changes[0].fields, ['status', 'description'])
  assert.throws(() => protocol.timesOf({ status: 200, text: '[]' }), /not a times answer/)
})

test('a search answer keeps its events and the files it found, in rank order', () => {
  const body = JSON.stringify({
    events: [{ id: 'e1' }],
    matches: [
      { a: '30850:pk:one', match: { fields: ['title', 'text'], around: 'the launch plan' } },
      { a: 42, match: { fields: ['title'] } },
      { a: '30850:pk:two', match: { fields: ['summary'] } },
    ],
  })
  const result = parseQueryResponse(200, body)
  assert.deepEqual(result.events, [{ id: 'e1' }])
  assert.deepEqual(result.matches.map((m) => m.a), ['30850:pk:one', '30850:pk:two'], 'a malformed match is dropped, the rest keep their order')
})

test('Relay.info reads the NIP-11 document from the relay\'s own address, unauthenticated', async () => {
  const seen = []
  const relay = new Relay('https://estiva.estiva.app/', secretKeySigner(SECRET), {
    fetch: async (url, init) => {
      seen.push({ url, init })
      return { status: 200, text: async () => JSON.stringify(PRODUCTION) }
    },
  })
  assert.deepEqual(relayFileReadsOf(await relay.info()).search, ['osnova.project', 'osnova.document'])
  assert.equal(seen[0].url, 'https://estiva.estiva.app')
  assert.equal(seen[0].init.method, 'GET')
  assert.equal(seen[0].init.headers.accept, 'application/nostr+json')
  assert.equal(seen[0].init.headers.authorization, undefined)
})

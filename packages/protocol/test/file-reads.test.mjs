// What a relay says about reading files (SPEC §6.13), and a search's answer.
// The NIP-11 document is the one production served on 2026-11-02 (buzz#46).
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { Relay, parseQueryResponse, relayFileReadsOf, secretKeySigner } from '../dist/index.js'

const SECRET = '1'.repeat(64)

test('a relay advertising file_list with text is read with the list and opened with its text, before the switch', () => {
  const reads = relayFileReadsOf({ file_list: { newest: true, text: true }, file_search: { types: ['osnova.project'], max_page_size: 20 } })
  assert.deepEqual(reads, { list: true, text: true, switched: false, inOrder: [], search: ['osnova.project'] })
})

test('a relay that says nothing about files is read change by change, and never sent "text"', () => {
  assert.deepEqual(relayFileReadsOf({ name: 'an older relay' }), { list: false, text: false, switched: false, inOrder: [], search: [] })
  assert.deepEqual(relayFileReadsOf(undefined), { list: false, text: false, switched: false, inOrder: [], search: [] })
})

test('"text" without the list is not the open read', () => {
  assert.equal(relayFileReadsOf({ file_list: { text: true } }).text, false)
})

test('a relay that made the switch says which types it keeps in order', () => {
  const reads = relayFileReadsOf({ files: { newest: true, requires_prev: ['osnova.project'] } })
  assert.equal(reads.switched, true)
  assert.equal(reads.list, true)
  assert.deepEqual(reads.inOrder, ['osnova.project'])
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
      return { status: 200, text: async () => JSON.stringify({ file_list: { newest: true, text: true } }) }
    },
  })
  assert.deepEqual(relayFileReadsOf(await relay.info()).text, true)
  assert.equal(seen[0].url, 'https://estiva.estiva.app')
  assert.equal(seen[0].init.method, 'GET')
  assert.equal(seen[0].init.headers.accept, 'application/nostr+json')
  assert.equal(seen[0].init.headers.authorization, undefined)
})

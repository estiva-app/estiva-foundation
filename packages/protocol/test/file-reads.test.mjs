// What a relay says about reading files (SPEC §6.13), and a search's answer.
// The NIP-11 document is the one production served on 2026-11-02 (buzz#46).
import { test } from 'node:test'
import assert from 'node:assert/strict'
// By namespace, so on a build without the switch only its tests fail.
import * as protocol from '../dist/index.js'

const { Relay, parseQueryResponse, relayFileReadsOf, secretKeySigner } = protocol
const missing = (name) => () => assert.fail(`${name} is not exported`)
const projectFieldsOf = protocol.projectFieldsOf ?? missing('projectFieldsOf')
const fieldsOptedIn = protocol.fieldsOptedIn ?? missing('fieldsOptedIn')

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

// ALO-6: the switch Ship, Leaf and Peek share, read as production announced it on 2026-11-04.
const ANNOUNCED = { files: { requires_prev: ['osnova.project'] }, file_list: { newest: true, text: true }, file_search: { max_page_size: 20, types: ['osnova.project'] } }

test('a relay that keeps projects in order and finds them by their words switches projects on, with `[` by their fields', () => {
  assert.deepEqual(projectFieldsOf(relayFileReadsOf(ANNOUNCED), false), { text: true, search: true })
  assert.deepEqual(projectFieldsOf(relayFileReadsOf({ ...ANNOUNCED, file_search: { types: ['osnova.issue'] } }), false), { text: true })
})

test('a relay that has not made the switch turns projects on only for a tab that opted in, and never without the opened text', () => {
  const before = { file_list: { newest: true, text: true }, file_search: ANNOUNCED.file_search }
  assert.equal(projectFieldsOf(relayFileReadsOf(before), false), undefined)
  assert.deepEqual(projectFieldsOf(relayFileReadsOf(before), true), { text: true, search: true })
  assert.equal(projectFieldsOf(relayFileReadsOf({ ...ANNOUNCED, file_list: { newest: true } }), true), undefined)
  // The rule itself, apart from how NIP-11 is parsed: types kept in order count only once the relay has switched.
  assert.equal(projectFieldsOf({ list: true, text: true, switched: false, inOrder: ['osnova.project'], search: [] }, false), undefined)
})

test('a tab opts in with ?fields=on, keeps it on reload, and leaves with ?fields=off', () => {
  const held = new Map()
  const storage = { getItem: (k) => held.get(k) ?? null, setItem: (k, v) => held.set(k, v), removeItem: (k) => held.delete(k) }
  assert.equal(fieldsOptedIn('', storage), false)
  assert.equal(fieldsOptedIn('?fields=on', storage), true)
  assert.equal(fieldsOptedIn('?x=1', storage), true, 'kept for the tab')
  assert.equal(fieldsOptedIn('?fields=off', storage), false)
  assert.equal(fieldsOptedIn('?fields=on', undefined), false, 'no storage, no opt-in')
  assert.equal(fieldsOptedIn('#/project/x?tab=a&fields=on', storage), true, 'a hash route’s query counts')
  held.clear()
  assert.equal(fieldsOptedIn('?subfields=on', storage), false, 'only the key itself')
})

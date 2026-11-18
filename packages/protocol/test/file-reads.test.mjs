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
const fileFieldsOf = protocol.fileFieldsOf ?? missing('fileFieldsOf')
const typeFieldsOptedIn = protocol.typeFieldsOptedIn ?? missing('typeFieldsOptedIn')

const SECRET = '1'.repeat(64)

test('a relay advertising file_list with text is read with the list and opened with its text, before the switch', () => {
  const reads = relayFileReadsOf({ file_list: { newest: true, text: true }, file_search: { types: ['osnova.project'], max_page_size: 20 } })
  assert.deepEqual(reads, { list: true, text: true, switched: false, inOrder: [], search: ['osnova.project'], times: false })
})

test('a relay that says nothing about files is read change by change, and never sent "text"', () => {
  const none = { list: false, text: false, switched: false, inOrder: [], search: [], times: false }
  assert.deepEqual(relayFileReadsOf({ name: 'an older relay' }), none)
  assert.deepEqual(relayFileReadsOf(undefined), none)
})

test('a relay advertising file_list.times is asked for times, and a times answer is read as times', () => {
  assert.equal(relayFileReadsOf({ file_list: { newest: true, text: true, times: true } }).times, true)
  assert.equal(relayFileReadsOf({ file_list: { times: true } }).times, false)
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

// ISS-3: each type switches on its own. Production on 2026-11-18 keeps projects in order and finds issues by their words.
const PROD_18_NOV = { files: { requires_prev: ['osnova.project'] }, file_list: { newest: true, text: true, times: true }, file_search: { max_page_size: 20, types: ['osnova.project', 'osnova.issue'] } }

test('a relay keeping projects in order but not issues switches projects on and leaves issues off', () => {
  const reads = relayFileReadsOf(PROD_18_NOV)
  assert.deepEqual(fileFieldsOf(reads, 'osnova.project', false), { text: true, search: true })
  assert.equal(fileFieldsOf(reads, 'osnova.issue', false), undefined)
  assert.deepEqual(fileFieldsOf(reads, 'osnova.issue', true), { text: true, search: true }, 'a tab trying issues on a fenced team')
})

test('once the relay keeps issues in order too, issues switch on without any opt-in', () => {
  const reads = relayFileReadsOf({ ...PROD_18_NOV, files: { requires_prev: ['osnova.project', 'osnova.issue'] } })
  assert.deepEqual(fileFieldsOf(reads, 'osnova.issue', false), { text: true, search: true })
  assert.equal(fileFieldsOf(reads, 'osnova.document', false), undefined, 'a type it does not name stays off')
})

test('a tab opts in to issues with ?issueFields=on, apart from projects’ ?fields=on', () => {
  const held = new Map()
  const storage = { getItem: (k) => held.get(k) ?? null, setItem: (k, v) => held.set(k, v), removeItem: (k) => held.delete(k) }
  assert.equal(typeFieldsOptedIn('osnova.project', '?fields=on', storage), true)
  assert.equal(typeFieldsOptedIn('osnova.issue', '?fields=on', storage), false, 'the projects’ word does not switch issues')
  assert.equal(typeFieldsOptedIn('osnova.issue', '?issueFields=on', storage), true)
  assert.equal(typeFieldsOptedIn('osnova.issue', '', storage), true, 'kept for the tab')
  assert.equal(typeFieldsOptedIn('osnova.issue', '?issueFields=off', storage), false)
  assert.equal(typeFieldsOptedIn('osnova.project', '', storage), true, 'leaving issues leaves projects on')
})

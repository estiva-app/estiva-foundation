/**
 * A comment built from a manifest's `comment` action names, in `p`, the people
 * its body mentions by `nostr:npub…` (SPEC §13.1, 8e8d4b68).
 *
 * Ship's and Peek's composers write `buildComment` with `mentionTagsFor(body)`;
 * the runtime wrote only the object's author, so the agent's "@Miky" drew a
 * chip and notified nobody — `#p` is how a reader finds it was named (§11.8).
 */
import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import { encodeNpub } from '@estiva-app/protocol'
import { buildActionEvent } from '../dist/index.js'

const AUTHOR = 'a'.repeat(64)
const ACTOR = 'c'.repeat(64)
const PERSON = '3bb30d683788016b85c83604dd5660e4e172e95d46d4e3ebab623ff5847b1f71'
const OTHER = 'd'.repeat(64)
const ISSUE = 30851
const FOLDER = '7b32200c-e4c0-4216-b79a-8490fc05e0bd'
const I1 = `${ISSUE}:${AUTHOR}:i1`
const NOW = 1_700_000_000_000

const manifest = {
  records: { changeKind: 1851, targetTag: 'a', fieldTag: 'field', valueTag: 'value', order: ['ts', 'created_at', 'id'] },
  actions: [
    { id: 'comment', label: 'Comment', appliesTo: String(ISSUE), emits: { kind: 1111, scope: 'address' } },
    { id: 'retitle', label: 'Rename', appliesTo: String(ISSUE), emits: { kind: 1851, field: 'title' }, input: { type: 'string' } },
  ],
}

const build = (actionId, value, extra = {}) =>
  buildActionEvent({ manifest, kind: ISSUE, address: I1, objectAuthor: AUTHOR, folder: FOLDER, actionId, value, pubkey: ACTOR, createdAtMs: NOW, ...extra })

const ps = (event) => event.tags.filter((t) => t[0] === 'p').map((t) => t[1])
const named = (pubkey) => `nostr:${encodeNpub(pubkey)}`

describe('a comment that mentions people', () => {
  test('each person the body names gets a p, after the object author’s, in the order named', () => {
    const event = build('comment', `${named(OTHER)} and ${named(PERSON)}: which one?`)
    assert.deepEqual(ps(event), [AUTHOR, OTHER, PERSON])
    assert.deepEqual(event.tags.at(-2), ['p', OTHER])
  })

  test('a person named twice, or who is the author, is tagged once', () => {
    const event = build('comment', `${named(PERSON)} ${named(AUTHOR)} ${named(PERSON)}`)
    assert.deepEqual(ps(event), [AUTHOR, PERSON])
  })

  test('a body that names nobody is the comment it always was', () => {
    const event = build('comment', 'Plain words, @Miky as text.')
    assert.deepEqual(ps(event), [AUTHOR])
  })

  test('a reply names its parent’s author, then the people it mentions', () => {
    const event = build('comment', `${named(PERSON)} yes`, { replyTo: { id: 'e'.repeat(64), kind: 1111, author: OTHER } })
    assert.deepEqual(ps(event), [OTHER, PERSON])
  })

  test('a change whose value names somebody earns no p — only a comment body is a mention', () => {
    const event = build('retitle', `About ${named(PERSON)}`)
    assert.deepEqual(ps(event), [])
  })
})

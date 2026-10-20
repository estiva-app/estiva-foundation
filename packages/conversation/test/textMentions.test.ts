/*
  SPEC §11.8 *A mention in a file's text* — C28 in §9, as fixtures: the
  writer's Adds on the wire, then the membership fold reading them back.
*/
import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { encodeNpub, type SignedEvent } from '@estiva-app/protocol'
import { buildMembershipChange, mentionAddsFor, membershipOf, peopleNamedInText } from '../dist/index.js'

const ALICE = 'a'.repeat(64)
const BOB = 'b'.repeat(64)
const CAROL = 'c'.repeat(64)
const FOLDER = '85db5b59-9e49-4ea1-8e93-3d2a2d78c048'
const ISSUE = `30851:${ALICE}:d68a8c78-5ec7-4652-b236-89ab57ac5b1e`
const T0 = 1_700_000_000
const BLOCKS = 'estiva-blocks-1'
const uri = (pubkey: string) => `nostr:${encodeNpub(pubkey)}`

/** A description as Ship and Leaf save it: one paragraph, `@Name` chips as reference runs. */
const doc = (...people: { pubkey: string; label?: string }[]) =>
  JSON.stringify({
    type: 'doc',
    content: [
      {
        type: 'paragraph',
        id: 'p1',
        content: [
          { type: 'text', text: 'Plan for Friday ' },
          ...people.map((p) => ({ type: 'text', text: p.label ?? '@someone', marks: [{ type: 'reference', attrs: { uri: uri(p.pubkey) } }] })),
        ],
      },
    ],
  })
const text = (...people: string[]) => ({ content: doc(...people.map((pubkey) => ({ pubkey }))), format: BLOCKS })

let seq = 0
const signed = (unsigned: { pubkey: string; kind: number; tags: string[][]; content: string }, at: number): SignedEvent => ({
  ...unsigned,
  id: (++seq).toString(16).padStart(64, '0'),
  sig: '',
  created_at: at,
})
const root = signed({ pubkey: ALICE, kind: 30851, tags: [['d', 'd68a8c78-5ec7-4652-b236-89ab57ac5b1e'], ['h', FOLDER]], content: '' }, T0)
const save = (writer: string, at: number, saved: ReturnType<typeof text>, editedFrom: ReturnType<typeof text> | null) =>
  mentionAddsFor(writer, at * 1000, { file: ISSUE, folder: FOLDER, saved, editedFrom }).map((e) => signed(e, at))
const leave = (person: string, at: number) =>
  signed(buildMembershipChange(person, at * 1000, { file: ISSUE, folder: FOLDER, person, member: false }), at)

/** Whether Bob's app lists him as a member of the file. */
const bobIsMember = (events: SignedEvent[]) => membershipOf(ISSUE, BOB, events).member

describe('C28 — a mention in a file’s text', () => {
  it('a save that newly names Bob writes one Add for him, signed by the writer, with his p', () => {
    const adds = mentionAddsFor(ALICE, (T0 + 10) * 1000, { file: ISSUE, folder: FOLDER, saved: text(BOB), editedFrom: text() })
    assert.equal(adds.length, 1)
    assert.equal(adds[0].pubkey, ALICE)
    assert.equal(adds[0].kind, 1851)
    assert.deepEqual(adds[0].tags, [
      ['a', ISSUE],
      ['field', `member:${BOB}`],
      ['value', 'true'],
      ['h', FOLDER],
      ['ts', String((T0 + 10) * 1000)],
      ['p', BOB],
    ])
  })

  it('Bob is then a member of the file', () => {
    assert.equal(bobIsMember([root]), false)
    assert.equal(bobIsMember([root, ...save(ALICE, T0 + 10, text(BOB), text())]), true)
  })

  it('Bob leaves; a typo fix that still names him writes no Add, and he stays out', () => {
    const first = save(ALICE, T0 + 10, text(BOB), text())
    const typo = save(CAROL, T0 + 30, text(BOB), text(BOB))
    assert.deepEqual(typo, [])
    assert.equal(bobIsMember([root, ...first, leave(BOB, T0 + 20), ...typo]), false)
  })

  it('a save that drops Bob removes nobody, and naming him again adds him again', () => {
    const first = save(ALICE, T0 + 10, text(BOB), text())
    const dropped = save(ALICE, T0 + 30, text(), text(BOB))
    assert.deepEqual(dropped, [])
    assert.equal(bobIsMember([root, ...first, ...dropped]), true)
    const again = save(CAROL, T0 + 40, text(BOB), text())
    assert.equal(again.length, 1)
    assert.equal(bobIsMember([root, ...first, leave(BOB, T0 + 20), ...dropped, ...again]), true)
  })

  it('a creation naming Bob adds him; one naming only its writer adds nobody', () => {
    assert.deepEqual(save(ALICE, T0, text(BOB), null).map((e) => e.tags.find((t) => t[0] === 'p')?.[1]), [BOB])
    assert.deepEqual(save(ALICE, T0, text(ALICE), null), [])
  })
})

describe('who a file’s text names', () => {
  it('reads a reference run’s uri, not its label; a bare key in a document’s plain run names nobody', () => {
    const content = JSON.stringify({
      type: 'doc',
      content: [
        { type: 'paragraph', id: 'a', content: [{ type: 'text', text: '@Bob', marks: [{ type: 'reference', attrs: { uri: uri(BOB) } }] }] },
        { type: 'bulletList', id: 'b', content: [{ type: 'listItem', id: 'c', content: [{ type: 'text', text: `ask ${uri(CAROL)}` }] }] },
      ],
    })
    assert.deepEqual([...peopleNamedInText({ content, format: BLOCKS })], [BOB])
  })

  it('a key in code or a code block names nobody', () => {
    const content = JSON.stringify({
      type: 'doc',
      content: [
        { type: 'paragraph', id: 'a', content: [{ type: 'text', text: uri(BOB), marks: [{ type: 'code' }] }] },
        { type: 'codeBlock', id: 'b', content: [{ type: 'text', text: uri(CAROL) }] },
      ],
    })
    assert.deepEqual([...peopleNamedInText({ content, format: BLOCKS })], [])
    assert.deepEqual([...peopleNamedInText({ content: `key: \`${uri(BOB)}\`` })], [])
  })

  it('marker text, a parsed document and a mislabelled one all read', () => {
    assert.deepEqual([...peopleNamedInText({ content: `hi ${uri(BOB)}` })], [BOB])
    assert.deepEqual([...peopleNamedInText({ content: JSON.parse(doc({ pubkey: BOB })) })], [BOB])
    assert.deepEqual([...peopleNamedInText({ content: `not json ${uri(BOB)}`, format: BLOCKS })], [BOB])
  })
})

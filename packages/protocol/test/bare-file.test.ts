/*
  The bare file — `kind:30840`, SPEC §6.7. What a Peek topic is on the wire.

  Tag order is asserted exactly, because SPEC §6.1 makes it normative: the id
  is a hash over the tags, so two builders that agree on the set and not the
  order produce two different events for one file.
*/
import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { KIND, buildBareFile, buildDocument, parseBlockDocument } from '../dist/index.js'

const AUTHOR = 'a'.repeat(64)
const TEAM = '7b32200c-e4c0-4216-b79a-8490fc05e0bd'
const PROJECT = `30850:${'b'.repeat(64)}:launch`
const NAMING = '3f6d2a1e-8c4b-4d7a-9e21-5b0c7f8a6d13'
const BRIEF = 'c0a1e5d2-7b9f-4e36-a8c4-21f3d9e6b750'

/**
 * Ids the relay refuses as `bad-file-id` (SPEC §6.1): not a uuid, a uuid in
 * capitals, and uuids that are not version 4 or not of the random variant.
 */
const ODD_IDS: Record<string, string> = {
  'a key a person knows': 'PROJ-1',
  'a slug': 'naming',
  'a v4 uuid in capitals': '3F6D2A1E-8C4B-4D7A-9E21-5B0C7F8A6D13',
  'a version 1 uuid': '6ba7b810-9dad-11d1-80b4-00c04fd430c8',
  'a version 7 uuid': '01936b2e-8a3c-7c4d-9e5f-0a1b2c3d4e5f',
  'the nil uuid': '00000000-0000-0000-0000-000000000000',
  'a v4 uuid of the wrong variant': '3f6d2a1e-8c4b-4d7a-ce21-5b0c7f8a6d13',
  'a v4 uuid with a space': ' 3f6d2a1e-8c4b-4d7a-9e21-5b0c7f8a6d13',
}

describe('buildBareFile', () => {
  it('writes d, title, h, a — in that order, and nothing else', () => {
    const ev = buildBareFile(AUTHOR, 1_700_000_000_123, {
      fileId: NAMING,
      title: 'Launch naming',
      channelUuid: TEAM,
      parent: PROJECT,
    })
    assert.equal(ev.kind, KIND.FILE)
    assert.equal(ev.kind, 30840)
    assert.deepEqual(ev.tags, [
      ['d', NAMING],
      ['title', 'Launch naming'],
      ['h', TEAM],
      ['a', PROJECT],
    ])
    assert.equal(ev.content, '')
    assert.equal(ev.created_at, 1_700_000_000)
  })

  it('omits the a tag when the file sits under nothing', () => {
    const ev = buildBareFile(AUTHOR, 1_700_000_000_000, {
      fileId: NAMING,
      title: 'Launch naming',
      channelUuid: TEAM,
    })
    assert.deepEqual(
      ev.tags.map((t) => t[0]),
      ['d', 'title', 'h'],
    )
  })

  it('refuses a file with no Folder', () => {
    // The relay only says SHOULD; SPEC says MUST, for the reason issues do.
    assert.throws(
      () =>
        buildBareFile(AUTHOR, 1_700_000_000_000, {
          fileId: NAMING,
          title: 'Launch naming',
          channelUuid: '',
        }),
      /name the Folder it lives in/,
    )
  })

  it('refuses a parent that is not an address', () => {
    // A `d` alone would assume the parent shares this author's pubkey — the
    // guess interop refuses to make when it reads the tag back.
    assert.throws(
      () =>
        buildBareFile(AUTHOR, 1_700_000_000_000, {
          fileId: NAMING,
          title: 'Launch naming',
          channelUuid: TEAM,
          parent: 'launch',
        }),
      /address/,
    )
  })

  for (const [label, fileId] of Object.entries(ODD_IDS)) {
    it(`refuses ${label} as the id, before any event exists`, () => {
      assert.throws(
        () => buildBareFile(AUTHOR, 1_700_000_000_000, { fileId, title: 'Launch naming', channelUuid: TEAM }),
        /random \(version 4\) lowercase uuid/,
      )
    })
  }

  it('carries a block document as content, round-trippable', () => {
    const document = {
      type: 'doc' as const,
      content: [
        {
          type: 'paragraph' as const,
          id: 'b1',
          content: [{ type: 'text' as const, text: 'Ship Friday.' }],
        },
      ],
    }
    const ev = buildBareFile(AUTHOR, 1_700_000_000_000, {
      fileId: NAMING,
      title: 'Launch naming',
      channelUuid: TEAM,
      document,
    })
    assert.equal(parseBlockDocument(ev.content).content[0].id, 'b1')
  })
})

// The document — `kind:30842`: the bare file's shape under a kind an app owns
// (Miky, 2026-10-14). Leaf's "New document" writes it; a topic stays a 30840.
describe('buildDocument', () => {
  it('writes the bare file’s tags, in its order, as kind 30842', () => {
    const ev = buildDocument(AUTHOR, 1_700_000_000_123, {
      fileId: BRIEF,
      title: 'Launch brief',
      channelUuid: TEAM,
      parent: PROJECT,
    })
    assert.equal(ev.kind, KIND.DOCUMENT)
    assert.equal(ev.kind, 30842)
    assert.deepEqual(ev.tags, [
      ['d', BRIEF],
      ['title', 'Launch brief'],
      ['h', TEAM],
      ['a', PROJECT],
    ])
    assert.equal(ev.content, '')
  })

  it('refuses a document with no Folder', () => {
    assert.throws(() => buildDocument(AUTHOR, 0, { fileId: BRIEF, title: 'X', channelUuid: '' }), /a document must name the Folder/)
  })

  for (const [label, fileId] of Object.entries(ODD_IDS)) {
    it(`refuses ${label} as the id`, () => {
      assert.throws(
        () => buildDocument(AUTHOR, 0, { fileId, title: 'Launch brief', channelUuid: TEAM }),
        /random \(version 4\) lowercase uuid/,
      )
    })
  }
})

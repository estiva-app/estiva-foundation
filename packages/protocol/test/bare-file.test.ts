/*
  The bare file — `kind:30840`, SPEC §6.7. What a Peek topic is on the wire.

  Tag order is asserted exactly, because SPEC §6.1 makes it normative: the id
  is a hash over the tags, so two builders that agree on the set and not the
  order produce two different events for one file.
*/
import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { KIND, buildBareFile, parseBlockDocument } from '../dist/index.js'

const AUTHOR = 'a'.repeat(64)
const TEAM = '7b32200c-e4c0-4216-b79a-8490fc05e0bd'
const PROJECT = `30850:${'b'.repeat(64)}:launch`

describe('buildBareFile', () => {
  it('writes d, title, h, a — in that order, and nothing else', () => {
    const ev = buildBareFile(AUTHOR, 1_700_000_000_123, {
      fileId: 'naming',
      title: 'Launch naming',
      channelUuid: TEAM,
      parent: PROJECT,
    })
    assert.equal(ev.kind, KIND.FILE)
    assert.equal(ev.kind, 30840)
    assert.deepEqual(ev.tags, [
      ['d', 'naming'],
      ['title', 'Launch naming'],
      ['h', TEAM],
      ['a', PROJECT],
    ])
    assert.equal(ev.content, '')
    assert.equal(ev.created_at, 1_700_000_000)
  })

  it('omits the a tag when the file sits under nothing', () => {
    const ev = buildBareFile(AUTHOR, 1_700_000_000_000, {
      fileId: 'naming',
      title: 'Launch naming',
      channelUuid: TEAM,
    })
    assert.deepEqual(
      ev.tags.map((t) => t[0]),
      ['d', 'title', 'h'],
    )
  })

  it('refuses a file with no team channel', () => {
    // The relay only says SHOULD; SPEC says MUST, for the reason issues do.
    assert.throws(
      () =>
        buildBareFile(AUTHOR, 1_700_000_000_000, {
          fileId: 'naming',
          title: 'Launch naming',
          channelUuid: '',
        }),
      /team channel/,
    )
  })

  it('refuses a parent that is not an address', () => {
    // A `d` alone would assume the parent shares this author's pubkey — the
    // guess interop refuses to make when it reads the tag back.
    assert.throws(
      () =>
        buildBareFile(AUTHOR, 1_700_000_000_000, {
          fileId: 'naming',
          title: 'Launch naming',
          channelUuid: TEAM,
          parent: 'launch',
        }),
      /address/,
    )
  })

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
      fileId: 'naming',
      title: 'Launch naming',
      channelUuid: TEAM,
      document,
    })
    assert.equal(parseBlockDocument(ev.content).content[0].id, 'b1')
  })
})

/**
 * Anchoring a comment to one block — SPEC §13.6.
 *
 * Almost all of this is the unhappy path, which is where §13.6 puts almost all
 * of its normative weight. The happy case is one assertion; the four-way
 * distinction is the feature.
 */
import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import {
  BLOCK_ANCHOR_TAG,
  blockAnchorOf,
  blockIds,
  markerTextToBlockDocument,
  resolveBlockAnchor,
  serializeBlockDocument,
} from '../dist/index.js'

const document = markerTextToBlockDocument('# Title\n\nfirst\n\nsecond')
const body = serializeBlockDocument(document)
const [headingId, firstId] = blockIds(document)

const comment = (tags: string[][]) => ({ tags })

describe('reading the anchor off a comment', () => {
  it('finds the block tag', () => {
    assert.equal(blockAnchorOf(comment([['a', '30851:x:1'], [BLOCK_ANCHOR_TAG, 'abc']])), 'abc')
  })

  it('is undefined when there is none, and when it is empty', () => {
    assert.equal(blockAnchorOf(comment([['a', '30851:x:1']])), undefined)
    assert.equal(blockAnchorOf(comment([[BLOCK_ANCHOR_TAG, '']])), undefined)
  })
})

describe('the four states §13.6 requires a reader to tell apart', () => {
  it('unanchored — a comment about the whole object', () => {
    assert.deepEqual(resolveBlockAnchor(undefined, body, 'blocks'), { state: 'unanchored' })
  })

  it('resolved — the block is there', () => {
    const anchor = resolveBlockAnchor(firstId, body, 'blocks')
    assert.equal(anchor.state, 'resolved')
    if (anchor.state !== 'resolved') return
    assert.equal(anchor.id, firstId)
    assert.equal(anchor.block.type, 'paragraph')
  })

  it('unaddressable — marker text has no parts to point at', () => {
    // §13.1 gives marker text no addressable sub-unit. Permanent for this body,
    // and not a failure: it is what two content models means.
    assert.deepEqual(resolveBlockAnchor(firstId, '# Title\n\nfirst', 'marker'), {
      state: 'unaddressable',
      id: firstId,
    })
  })

  it('detached — the block is gone', () => {
    const edited = serializeBlockDocument(markerTextToBlockDocument('# Title\n\nsecond', document))
    assert.deepEqual(resolveBlockAnchor(firstId, edited, 'blocks'), { state: 'detached', id: firstId })
  })

  it('keeps the anchor when an edit leaves the block alone — the whole point', () => {
    const edited = serializeBlockDocument(
      markerTextToBlockDocument('# Title\n\nfirst\n\nsecond, edited', document),
    )
    assert.equal(resolveBlockAnchor(firstId, edited, 'blocks').state, 'resolved')
    assert.equal(resolveBlockAnchor(headingId, edited, 'blocks').state, 'resolved')
  })
})

describe('states that must not be collapsed into each other', () => {
  it('detached is not unanchored', () => {
    // The defect §13.6 exists to prevent: one is a remark about the object, the
    // other a remark about a paragraph somebody deleted.
    const gone = resolveBlockAnchor('a-block-that-never-existed', body, 'blocks')
    assert.notDeepEqual(gone, { state: 'unanchored' })
    assert.equal(gone.state, 'detached')
  })

  it('unaddressable is not detached', () => {
    // Nothing was deleted; this body never had parts. A reader that says "that
    // paragraph is gone" about a marker-text description is wrong twice.
    assert.equal(resolveBlockAnchor('anything', 'plain text', 'marker').state, 'unaddressable')
  })

  it('an unknown content format is unaddressable, not detached', () => {
    assert.equal(resolveBlockAnchor('anything', body, 'unknown').state, 'unaddressable')
  })
})

describe('a body that cannot be parsed', () => {
  it('is unaddressable rather than an exception', () => {
    // Tagged `blocks` and not one. A reader that throws renders nothing at all,
    // which is worse than saying the comment points at something unreachable.
    assert.equal(resolveBlockAnchor('abc', '{"type":"doc", not json', 'blocks').state, 'unaddressable')
  })

  it('never decides the format by looking at the body — §13.4', () => {
    // A legacy description that happens to be valid JSON is still marker text
    // if that is what its event declared, so an anchor on it is unaddressable
    // rather than resolvable.
    assert.equal(resolveBlockAnchor(firstId, body, 'marker').state, 'unaddressable')
  })
})

describe('nested blocks are addressable too', () => {
  it('resolves a list item, not only a top-level block', () => {
    const listDoc = markerTextToBlockDocument('- one\n- two')
    const ids = blockIds(listDoc)
    // bulletList, then its two listItems.
    assert.equal(ids.length, 3)
    const anchor = resolveBlockAnchor(ids[2], serializeBlockDocument(listDoc), 'blocks')
    assert.equal(anchor.state, 'resolved')
    if (anchor.state === 'resolved') assert.equal(anchor.block.type, 'listItem')
  })
})

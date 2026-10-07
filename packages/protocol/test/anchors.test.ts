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
  PART_TAG,
  absenceOf,
  blockAnchorOf,
  blockIds,
  markerTextToBlockDocument,
  partTag,
  partsOf,
  resolveBlockAnchor,
  resolvePart,
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

describe('only a kind:1111 anchors — §13.6, narrowed by COM-2', () => {
  it('reads the block tag on a comment', () => {
    assert.equal(blockAnchorOf({ kind: 1111, tags: [[BLOCK_ANCHOR_TAG, 'abc']] }), 'abc')
  })

  it('refuses it on a kind:9, which has no A to say whose block it is', () => {
    assert.equal(blockAnchorOf({ kind: 9, tags: [[BLOCK_ANCHOR_TAG, 'abc']] }), undefined)
  })
})

const pk = 'a'.repeat(64)
const other = 'b'.repeat(64)
const issue = `30851:${pk}:issue-1`

describe('a message pointing at a block of another object — §13.6.1', () => {
  it('reads one part per address, the first winning', () => {
    const event = {
      tags: [['a', issue], partTag(issue, 'p1'), partTag(issue, 'p2'), [PART_TAG, `30850:${pk}:proj`, 'p3']],
    }
    assert.deepEqual(partsOf(event), [
      { address: issue, block: 'p1' },
      { address: `30850:${pk}:proj`, block: 'p3' },
    ])
  })

  it('ignores a part with no block, or an address that is not one', () => {
    assert.deepEqual(partsOf({ tags: [[PART_TAG, issue], [PART_TAG, issue, ''], [PART_TAG, 'issue-1', 'p1']] }), [])
  })

  it('drops a block id that is not safe in a fragment or a selector', () => {
    assert.deepEqual(partsOf({ tags: [partTag(issue, '<img>'), partTag(issue, 'a#b'), partTag(issue, '8373a025427f')] }), [
      { address: issue, block: '8373a025427f' },
    ])
  })

  it('is not an anchor: a block tag and a part tag do not read as each other', () => {
    const event = { kind: 1111, tags: [[BLOCK_ANCHOR_TAG, 'mine'], partTag(issue, 'theirs')] }
    assert.equal(blockAnchorOf(event), 'mine')
    assert.deepEqual(partsOf(event), [{ address: issue, block: 'theirs' }])
  })
})

describe('the five states of a part, none collapsed', () => {
  it('resolved', () => {
    const part = resolvePart(firstId, { value: body, format: 'blocks' })
    assert.equal(part.state, 'resolved')
    if (part.state === 'resolved') assert.equal(part.block.id, firstId)
  })

  it('detached — the object is readable and the block is gone', () => {
    assert.deepEqual(resolvePart('gone', { value: body, format: 'blocks' }), { state: 'detached' })
  })

  it('unaddressable — the body has no parts', () => {
    assert.deepEqual(resolvePart(firstId, { value: 'plain', format: 'marker' }), { state: 'unaddressable' })
  })

  it('deleted and unreadable stay apart', () => {
    assert.deepEqual(resolvePart(firstId, 'deleted'), { state: 'deleted' })
    assert.deepEqual(resolvePart(firstId, 'unreadable'), { state: 'unreadable' })
  })
})

describe('why a read by address came back empty', () => {
  const deletion = (pubkey: string, tags: string[][]) => ({ kind: 5, pubkey, tags })

  it('deleted, when its author deleted it by address', () => {
    assert.equal(absenceOf(issue, [deletion(pk, [['a', issue]])]), 'deleted')
  })

  it('unreadable, when nothing says it was deleted', () => {
    assert.equal(absenceOf(issue, []), 'unreadable')
  })

  it("counts a deletion signed by the author's owner — §6.5, the relay adjudicates", () => {
    assert.equal(absenceOf(issue, [deletion(other, [['a', issue]])]), 'deleted')
  })

  it('ignores a kind that is not a deletion', () => {
    assert.equal(absenceOf(issue, [{ kind: 1, pubkey: pk, tags: [['a', issue]] }]), 'unreadable')
  })

  it('ignores a deletion of another address', () => {
    assert.equal(absenceOf(issue, [deletion(pk, [['a', `30851:${pk}:issue-2`]])]), 'unreadable')
  })
})

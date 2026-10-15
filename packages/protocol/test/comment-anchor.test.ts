/**
 * A comment on a selection — SPEC §13.3 "A run of blocks" and §13.6 (LEAF-7).
 *
 * The writer half is asserted on the tags that go on the wire; the reader half
 * on which of the five states a person is shown, against the page as it is
 * after somebody else's edit. The state that matters most is `reworded`: the
 * blocks are there and the words are not, and it must never read as detached.
 */
import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import {
  type BlockDocument,
  blockAnchorOf,
  blockRunOf,
  blockRunTag,
  readRunIds,
  resolveBlockAnchor,
  resolveCommentAnchor,
  selectionAnchorTags,
  serializeBlockDocument,
} from '../dist/index.js'

const p = (id: string, text: string) => ({ type: 'paragraph', id, content: [{ type: 'text', text }] })
const doc = (...content: unknown[]) => ({ type: 'doc', content }) as BlockDocument
const body = (d: BlockDocument) => serializeBlockDocument(d)
const comment = (tags: string[][]) => ({ kind: 1111, tags: [['A', '30842:x:d'], ...tags] })

const page = doc(p('p1', 'We ship on Friday.'), p('p2', 'QA signs off.'), p('p3', 'Then we announce it.'))

describe('writing the anchor for a selection', () => {
  it('quotes exactly the words of a selection inside one block, untrimmed', () => {
    const tags = selectionAnchorTags(page, ['p1'], { start: { block: 'p1', offset: 7 }, end: { block: 'p1', offset: 18 } })
    assert.deepEqual(tags, [['block', 'p1'], ['quote', ' on Friday.']])
  })

  it('carries no words for a selection of whole blocks, and lists every block', () => {
    assert.deepEqual(selectionAnchorTags(page, ['p1', 'p2']), [['block', 'p1', 'p2']])
    const whole = selectionAnchorTags(page, ['p1', 'p2'], { start: { block: 'p1', offset: 0 }, end: { block: 'p2', offset: 13 } })
    assert.deepEqual(whole, [['block', 'p1', 'p2']])
  })

  it('quotes the words where a selection across blocks starts and where it ends, not the middle', () => {
    const tags = selectionAnchorTags(page, ['p1', 'p2', 'p3'], { start: { block: 'p1', offset: 8 }, end: { block: 'p3', offset: 7 } })
    assert.deepEqual(tags, [['block', 'p1', 'p2', 'p3'], ['quote', 'on Friday.', 'Then we']])
  })

  it('keeps about 150 characters at each end of a selection longer than 1,000', () => {
    const words = Array.from({ length: 300 }, (_, i) => `w${i}`).join(' ')
    const long = doc(p('l1', words))
    const [, quote] = selectionAnchorTags(long, ['l1'], { start: { block: 'l1', offset: 3 }, end: { block: 'l1', offset: words.length - 2 } })
    assert.equal(quote.length, 3)
    assert.ok(quote[1].length <= 150 && quote[2].length <= 150)
    assert.ok(words.includes(quote[1]) && words.includes(quote[2]))
    assert.ok(quote[1].startsWith('w1') && quote[2].endsWith('w2'))
  })

  it('adds the text around words that repeat in their block, and only then', () => {
    const repeated = doc(p('r1', 'the cat and the dog'))
    const tags = selectionAnchorTags(repeated, ['r1'], { start: { block: 'r1', offset: 12 }, end: { block: 'r1', offset: 15 } })
    assert.deepEqual(tags[1], ['quote', 'the', '', 'the cat and ', ' dog'])
  })

  it('leaves out a last block the selection ends at the very start of, rather than hanging', { timeout: 5000 }, () => {
    const tags = selectionAnchorTags(page, ['p1', 'p2', 'p3'], { start: { block: 'p1', offset: 8 }, end: { block: 'p3', offset: 0 } })
    assert.deepEqual(tags, [['block', 'p1', 'p2'], ['quote', 'on Friday.', 'QA signs off.']])
  })

  it('leaves out a first block the selection starts at the very end of', () => {
    const tags = selectionAnchorTags(page, ['p1', 'p2', 'p3'], { start: { block: 'p1', offset: 18 }, end: { block: 'p3', offset: 7 } })
    assert.deepEqual(tags, [['block', 'p2', 'p3'], ['quote', 'QA signs off.', 'Then we']])
  })

  it('refuses a selection whose ends are not in the run\'s first and last blocks', () => {
    assert.throws(() => selectionAnchorTags(page, ['p1', 'p2'], { start: { block: 'p2', offset: 0 }, end: { block: 'p2', offset: 4 } }))
  })

  it('lists the first 32 and the last 32 of a run longer than 64 blocks', () => {
    const ids = Array.from({ length: 70 }, (_, i) => `b${i}`)
    const tag = blockRunTag(ids)
    assert.equal(tag.length, 65)
    assert.deepEqual([tag[1], tag[32], tag[33], tag[64]], ['b0', 'b31', 'b38', 'b69'])
  })
})

describe('reading the run', () => {
  it('voids a run whose first id is invalid, and skips invalid and repeated later ones', () => {
    assert.equal(readRunIds(['bad id', 'p1']), undefined)
    assert.deepEqual(readRunIds(['p1', 'bad id', 'p2', 'p1']), ['p1', 'p2'])
  })

  it('reads a stranger\'s huge list quickly, no further than its first 1,024 entries', { timeout: 5000 }, () => {
    const ids = Array.from({ length: 80_000 }, (_, i) => `x${i}`)
    const run = readRunIds(ids)
    assert.deepEqual([run?.length, run?.[0], run?.at(-1)], [64, 'x0', 'x1023'])
  })

  it('ignores a block tag on anything but a comment', () => {
    assert.equal(blockRunOf({ kind: 9, tags: [['block', 'p1']] }), undefined)
  })

  it('leaves a one-block reader with the first block of a run', () => {
    assert.equal(blockAnchorOf(comment([['block', 'p1', 'p2', 'p3']])), 'p1')
  })
})

describe('resolving a comment against the page as it is now', () => {
  const words = comment([['block', 'p1'], ['quote', 'on Friday.']])
  const across = comment([['block', 'p1', 'p2', 'p3'], ['quote', 'on Friday.', 'Then we']])

  it('finds the quoted words in their block', () => {
    const anchor = resolveCommentAnchor(words, body(page), 'blocks')
    assert.equal(anchor.state, 'resolved')
    assert.deepEqual(anchor.state === 'resolved' && anchor.words, { start: { block: 'p1', offset: 8 }, end: { block: 'p1', offset: 18 } })
  })

  it('keeps a selection across blocks highlighted when the middle is edited or grows', () => {
    const edited = doc(p('p1', 'We ship on Friday.'), p('p2', 'QA sign off.'), p('px', 'Inserted.'), p('p3', 'Then we announce it.'))
    const anchor = resolveCommentAnchor(across, body(edited), 'blocks')
    assert.equal(anchor.state, 'resolved')
    assert.deepEqual(anchor.state === 'resolved' && anchor.blocks.map((b) => b.id), ['p1', 'p2', 'px', 'p3'])
    assert.deepEqual(anchor.state === 'resolved' && anchor.words, { start: { block: 'p1', offset: 8 }, end: { block: 'p3', offset: 7 } })
  })

  it('reads as reworded, not detached, when the words where it starts are rewritten', () => {
    const edited = doc(p('p1', 'We ship next week.'), p('p2', 'QA signs off.'), p('p3', 'Then we announce it.'))
    const anchor = resolveCommentAnchor(across, body(edited), 'blocks')
    assert.equal(anchor.state, 'reworded')
    assert.deepEqual(anchor.state === 'reworded' && anchor.quote, { start: 'on Friday.', end: 'Then we' })
    assert.deepEqual(anchor.state === 'reworded' && anchor.blocks.map((b) => b.id), ['p1', 'p2', 'p3'])
  })

  it('reads as reworded, not resolved, when the words where it ends are rewritten', () => {
    const edited = doc(p('p1', 'We ship on Friday.'), p('p2', 'QA signs off.'), p('p3', 'After that we announce it.'))
    assert.equal(resolveCommentAnchor(across, body(edited), 'blocks').state, 'reworded')
  })

  it('reads as reworded when the block holding the start words is gone but the rest of the run is not', () => {
    const edited = doc(p('p2', 'QA signs off.'), p('p3', 'Then we announce it.'))
    assert.equal(resolveCommentAnchor(across, body(edited), 'blocks').state, 'reworded')
  })

  it('reads as reworded when the first block is moved after the last', () => {
    const moved = doc(p('p2', 'QA signs off.'), p('p3', 'Then we announce it.'), p('p1', 'We ship on Friday.'))
    assert.equal(resolveCommentAnchor(across, body(moved), 'blocks').state, 'reworded')
  })

  it('reads as detached only when no block of the run is left', () => {
    const anchor = resolveCommentAnchor(across, body(doc(p('q1', 'Something else.'))), 'blocks')
    assert.equal(anchor.state, 'detached')
  })

  it('picks the repeated words whose surrounding text matches, not the first', () => {
    const repeated = doc(p('r1', 'the cat and the dog'))
    const c = comment([['block', 'r1'], ['quote', 'the', '', 'the cat and ', ' dog']])
    const anchor = resolveCommentAnchor(c, body(repeated), 'blocks')
    assert.deepEqual(anchor.state === 'resolved' && anchor.words?.start, { block: 'r1', offset: 12 })
  })

  it('ignores context longer than a writer sends, and stays fast on words repeated through a large page', { timeout: 5000 }, () => {
    const big = doc(p('b1', 'a'.repeat(200_000)))
    const hostile = comment([['block', 'b1'], ['quote', 'a', '', 'x'.repeat(10_000)]])
    const anchor = resolveCommentAnchor(hostile, body(big), 'blocks')
    assert.deepEqual(anchor.state === 'resolved' && anchor.words?.start, { block: 'b1', offset: 0 })
    const unmatched = comment([['block', 'b1'], ['quote', 'a', '', 'zz']])
    assert.equal(resolveCommentAnchor(unmatched, body(big), 'blocks').state, 'resolved')
  })

  it('treats a quote longer than any writer sends as no words, so it cannot stall a reader', { timeout: 5000 }, () => {
    const big = doc(p('b1', 'a'.repeat(200_000)))
    const hostile = comment([['block', 'b1'], ['quote', 'a'.repeat(100_000)]])
    const anchor = resolveCommentAnchor(hostile, body(big), 'blocks')
    assert.deepEqual(anchor.state === 'resolved' && anchor.words, undefined)
  })

  it('matches a mention as the text it is stored as, not the name it is drawn with', () => {
    const withMention = doc(p('m1', 'ask nostr:npub1abc about it'))
    const c = comment([['block', 'm1'], ['quote', 'nostr:npub1abc about']])
    assert.equal(resolveCommentAnchor(c, body(withMention), 'blocks').state, 'resolved')
    const drawn = comment([['block', 'm1'], ['quote', '@Miky about']])
    assert.equal(resolveCommentAnchor(drawn, body(withMention), 'blocks').state, 'reworded')
  })

  it('reads a whole-block comment as resolved with no words, and lets it grow with the run', () => {
    const blocksOnly = comment([['block', 'p1', 'p3']])
    const anchor = resolveCommentAnchor(blocksOnly, body(page), 'blocks')
    assert.equal(anchor.state, 'resolved')
    assert.deepEqual(anchor.state === 'resolved' && [anchor.blocks.map((b) => b.id), anchor.words], [['p1', 'p2', 'p3'], undefined])
  })

  it('resolves a one-block comment with no words exactly as the one-block reader does', () => {
    const today = comment([['block', 'p2']])
    const anchor = resolveCommentAnchor(today, body(page), 'blocks')
    const old = resolveBlockAnchor(blockAnchorOf(today), body(page), 'blocks')
    assert.equal(anchor.state, old.state)
    assert.deepEqual(anchor.state === 'resolved' && anchor.blocks, old.state === 'resolved' && [old.block])
  })

  it('ignores words with no block, and a body with no blocks', () => {
    assert.equal(resolveCommentAnchor(comment([['quote', 'on Friday.']]), body(page), 'blocks').state, 'unanchored')
    assert.equal(resolveCommentAnchor(words, 'We ship on Friday.', 'marker').state, 'unaddressable')
  })

  it('takes the run under the parent most of its blocks sit under', () => {
    const list = doc(p('a', 'intro'), {
      type: 'bulletList', id: 'L', content: [
        { type: 'listItem', id: 'i1', content: [{ type: 'text', text: 'one' }] },
        { type: 'listItem', id: 'i2', content: [{ type: 'text', text: 'two' }] },
        { type: 'listItem', id: 'i3', content: [{ type: 'text', text: 'three' }] },
      ],
    })
    const c = comment([['block', 'a', 'i1', 'i3']])
    const anchor = resolveCommentAnchor(c, body(list), 'blocks')
    assert.deepEqual(anchor.state === 'resolved' && anchor.blocks.map((b) => b.id), ['i1', 'i2', 'i3'])
  })
})

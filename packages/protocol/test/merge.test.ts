/**
 * Merging two changes to one text — SPEC §13.3, conformance C41 and C42.
 *
 * Three texts: the base the refused save named as `prev`, theirs (now
 * current) and mine (refused). What a person sees is the merged document, or
 * the blocks that ask; these tests assert on both.
 */
import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { mergeBlockDocuments, mergeTexts, serializeBlockDocument, type Block, type BlockDocument } from '../dist/index.js'

const p = (id: string, text: string): Block => ({ type: 'paragraph', id, content: [{ type: 'text', text }] })
const doc = (...content: Block[]): BlockDocument => ({ type: 'doc', content })
const ids = (d: BlockDocument | undefined) => d?.content.map((b) => b.id)
const words = (d: BlockDocument | undefined) => d?.content.map((b) => (b.content as { text: string }[])[0].text)

describe('mergeBlockDocuments — §13.3', () => {
  it('C41: a moved, an added and a rewritten block merge onto theirs in mine\'s places, nothing asks', () => {
    const base = doc(p('b1', 'one'), p('b2', 'two'), p('b3', 'three'), p('b4', 'four'))
    const theirs = doc(p('b1', 'one'), p('b2', 'two, theirs'), p('b3', 'three'), p('n1', 'new, theirs'), p('b4', 'four'))
    const mine = doc(p('b2', 'two'), p('b3', 'three'), p('m1', 'new, mine'), p('b1', 'one'), p('b4', 'four, mine'))
    const result = mergeBlockDocuments(base, theirs, mine)
    assert.equal(result.asks, undefined)
    assert.deepEqual(ids(result.merged), ['b2', 'b3', 'n1', 'm1', 'b1', 'b4'])
    assert.deepEqual(words(result.merged), ['two, theirs', 'three', 'new, theirs', 'new, mine', 'one', 'four, mine'])
  })

  it('C42: edited against deleted asks, and changed differently by both asks', () => {
    const base = doc(p('b1', 'one'), p('b2', 'two'), p('b3', 'three'))
    const theirs = doc(p('b1', 'one'), p('b3', 'three, theirs'))
    const mine = doc(p('b1', 'one'), p('b2', 'two, mine'), p('b3', 'three, mine'))
    const result = mergeBlockDocuments(base, theirs, mine)
    assert.equal(result.merged, undefined)
    assert.deepEqual(
      result.asks?.map((a) => [a.block, a.why, a.theirs, a.mine]),
      [
        ['b2', 'edited-and-deleted', undefined, 'two, mine'],
        ['b3', 'changed-by-both', 'three, theirs', 'three, mine'],
      ],
    )
  })

  it('a block both changed the same way is kept once, without asking', () => {
    const base = doc(p('b1', 'one'))
    const both = doc(p('b1', 'uno'))
    assert.deepEqual(words(mergeBlockDocuments(base, both, both).merged), ['uno'])
  })

  it('a block one side deleted and the other only moved is deleted', () => {
    const base = doc(p('b1', 'one'), p('b2', 'two'), p('b3', 'three'))
    const theirs = doc(p('b1', 'one'), p('b3', 'three'))
    const mine = doc(p('b2', 'two'), p('b1', 'one'), p('b3', 'three'))
    const result = mergeBlockDocuments(base, theirs, mine)
    assert.deepEqual(ids(result.merged), ['b1', 'b3'])
  })

  it('a block mine deleted that theirs did not touch is deleted', () => {
    const base = doc(p('b1', 'one'), p('b2', 'two'), p('b3', 'three'))
    const theirs = doc(p('b1', 'one, theirs'), p('b2', 'two'), p('b3', 'three'))
    const mine = doc(p('b1', 'one'), p('b3', 'three'))
    assert.deepEqual(words(mergeBlockDocuments(base, theirs, mine).merged), ['one, theirs', 'three'])
  })

  it('a block mine moved and theirs edited takes their words at mine\'s place', () => {
    const base = doc(p('b1', 'one'), p('b2', 'two'), p('b3', 'three'))
    const theirs = doc(p('b1', 'one, theirs'), p('b2', 'two'), p('b3', 'three'))
    const mine = doc(p('b2', 'two'), p('b3', 'three'), p('b1', 'one'))
    assert.deepEqual(words(mergeBlockDocuments(base, theirs, mine).merged), ['two', 'three', 'one, theirs'])
  })

  it('a block both moved to different places stands where theirs put it', () => {
    const base = doc(p('b1', 'one'), p('b2', 'two'), p('b3', 'three'), p('b4', 'four'))
    const theirs = doc(p('b2', 'two'), p('b3', 'three'), p('b1', 'one'), p('b4', 'four'))
    const mine = doc(p('b2', 'two'), p('b3', 'three'), p('b4', 'four'), p('b1', 'one'))
    assert.deepEqual(ids(mergeBlockDocuments(base, theirs, mine).merged), ['b2', 'b3', 'b1', 'b4'])
  })

  it('two blocks added at one place are both kept, theirs first', () => {
    const base = doc(p('b1', 'one'), p('b2', 'two'))
    const theirs = doc(p('b1', 'one'), p('n1', 'theirs'), p('b2', 'two'))
    const mine = doc(p('b1', 'one'), p('m1', 'mine'), p('b2', 'two'))
    assert.deepEqual(ids(mergeBlockDocuments(base, theirs, mine).merged), ['b1', 'n1', 'm1', 'b2'])
  })

  it('a block mine added first in the text goes first, after theirs\' additions there', () => {
    const base = doc(p('b1', 'one'))
    const theirs = doc(p('n1', 'theirs'), p('b1', 'one'))
    const mine = doc(p('m1', 'mine'), p('b1', 'one'))
    assert.deepEqual(ids(mergeBlockDocuments(base, theirs, mine).merged), ['n1', 'm1', 'b1'])
  })

  it('an item mine added to a list theirs deleted asks, as an edit against a delete', () => {
    const list = (id: string, ...items: Block[]): Block => ({ type: 'bulletList', id, content: items })
    const item = (id: string, text: string): Block => ({ type: 'listItem', id, content: [p(`${id}p`, text)] })
    const base = doc(p('b1', 'one'), list('l', item('i1', 'first')))
    const theirs = doc(p('b1', 'one'))
    const mine = doc(p('b1', 'one'), list('l', item('i1', 'first'), item('i2', 'second')))
    const result = mergeBlockDocuments(base, theirs, mine)
    assert.equal(result.merged, undefined)
    assert.ok(result.asks?.some((a) => a.block === 'i2' && a.why === 'edited-and-deleted'))
  })

  it('an item theirs edited inside a list mine moved keeps both: their words, mine\'s place', () => {
    const list = (id: string, ...items: Block[]): Block => ({ type: 'bulletList', id, content: items })
    const item = (id: string, text: string): Block => ({ type: 'listItem', id, content: [p(`${id}p`, text)] })
    const base = doc(p('b1', 'one'), list('l', item('i1', 'first')))
    const theirs = doc(p('b1', 'one'), list('l', item('i1', 'first, theirs')))
    const mine = doc(list('l', item('i1', 'first')), p('b1', 'one'))
    const merged = mergeBlockDocuments(base, theirs, mine).merged!
    assert.deepEqual(ids(merged), ['l', 'b1'])
    assert.equal(JSON.stringify(merged.content[0]).includes('first, theirs'), true)
  })
})

describe('mergeTexts — §13.3', () => {
  const blocks = (d: BlockDocument) => ({ value: serializeBlockDocument(d), format: 'estiva-blocks-1' })

  it('merges block documents block by block and returns a block document', () => {
    const base = doc(p('b1', 'one'), p('b2', 'two'))
    const result = mergeTexts(blocks(base), blocks(doc(p('b1', 'uno'), p('b2', 'two'))), blocks(doc(p('b1', 'one'), p('b2', 'dos'))))
    assert.equal(result.merged?.format, 'estiva-blocks-1')
    assert.deepEqual(words(JSON.parse(result.merged!.value)), ['uno', 'dos'])
  })

  it('C42: a marker text changed by both asks as one block', () => {
    const result = mergeTexts({ value: 'the plan' }, { value: 'the plan, theirs' }, { value: 'the plan, mine' })
    assert.deepEqual(result.asks, [
      { block: null, why: 'changed-by-both', base: 'the plan', theirs: 'the plan, theirs', mine: 'the plan, mine' },
    ])
  })

  it('a marker text changed by one side only takes that change', () => {
    assert.deepEqual(mergeTexts({ value: 'a' }, { value: 'a' }, { value: 'b' }).merged, { value: 'b' })
    assert.deepEqual(mergeTexts({ value: 'a' }, { value: 'c' }, { value: 'a' }).merged, { value: 'c' })
  })
})

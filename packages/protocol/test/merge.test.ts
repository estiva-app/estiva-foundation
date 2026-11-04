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
import * as protocol from '../dist/index.js'

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

  it('two blocks each nested inside the other by one side keep their words, as theirs nested them', () => {
    const quote = (id: string, ...content: Block[]): Block => ({ type: 'blockquote', id, content })
    const base = doc(quote('x', p('p1', 'Alpha')), quote('y', p('p2', 'Beta')), p('z', 'Zed'))
    const theirs = doc(quote('y', p('p2', 'Beta'), quote('x', p('p1', 'Alpha'))), p('z', 'Zed'))
    const mine = doc(quote('x', p('p1', 'Alpha'), quote('y', p('p2', 'Beta'))), p('z', 'Zed, mine'))
    const result = mergeBlockDocuments(base, theirs, mine)
    const text = JSON.stringify(result.merged)
    assert.ok(text.includes('Alpha') && text.includes('Beta') && text.includes('Zed, mine'), text)
    assert.deepEqual(ids(result.merged), ['y', 'z'])
  })

  it('a list mine emptied and theirs deleted is deleted, without asking', () => {
    const base = doc(p('b1', 'one'), { type: 'bulletList', id: 'l', content: [{ type: 'listItem', id: 'i1', content: [p('i1p', 'first')] }] })
    const theirs = doc(p('b1', 'one'))
    const mine = doc(p('b1', 'one'), { type: 'bulletList', id: 'l', content: [] })
    const result = mergeBlockDocuments(base, theirs, mine)
    assert.equal(result.asks, undefined)
    assert.deepEqual(ids(result.merged), ['b1'])
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

describe('textAsksOf — what the editor holds while a save asks (ALO-1\'s story)', () => {
  const blocks = (d: BlockDocument) => ({ value: serializeBlockDocument(d), format: 'estiva-blocks-1' })
  // By namespace, so on a build without it only these tests fail.
  const textAsksOf = (...args: unknown[]) => {
    assert.equal(typeof protocol.textAsksOf, 'function', 'textAsksOf is exported')
    return (protocol.textAsksOf as (...a: unknown[]) => { value: string; theirs: string; mine: string; blocks: string[]; sinceOpened?: boolean })(...args)
  }

  it('opens on their text with my other changes merged in and their words in the block that asks, beside mine as saved', () => {
    const base = blocks(doc(p('b1', 'one'), p('b2', 'two'), p('b3', 'three')))
    const theirs = blocks(doc(p('b1', 'one, theirs'), p('b2', 'two'), p('b3', 'three, theirs')))
    const mine = blocks(doc(p('b1', 'one, mine'), p('b2', 'two, mine'), p('b3', 'three')))
    const { asks } = mergeTexts(base, theirs, mine)
    const held = textAsksOf(base, theirs, mine, asks!)
    assert.deepEqual(words(JSON.parse(held.value)), ['one, theirs', 'two, mine', 'three, theirs'])
    assert.deepEqual(held.blocks, ['b1'])
    assert.equal(held.mine, mine.value, 'mine as I saved it, to choose from')
    assert.equal(held.theirs, theirs.value)
    assert.equal(held.sinceOpened, undefined, 'no "changed since you opened it": my changes are in')
  })

  it('a block I deleted that they changed holds their text alone and says the page changed, losing none of their words', () => {
    const base = blocks(doc(p('b1', 'one'), p('b2', 'two')))
    const theirs = blocks(doc(p('b1', 'one'), p('b2', 'two, theirs')))
    const mine = blocks(doc(p('b1', 'one, mine')))
    const { asks } = mergeTexts(base, theirs, mine)
    const held = textAsksOf(base, theirs, mine, asks!)
    assert.equal(held.value, theirs.value)
    assert.deepEqual(held.blocks, ['b2'])
    assert.equal(held.sinceOpened, true)
  })

  it('a list whose numbering both changed asks for the list alone, and my words in its items are kept', () => {
    const list = (start: number, ...items: Block[]): Block => ({ type: 'orderedList', id: 'l', attrs: { start }, content: items })
    const item = (id: string, text: string): Block => ({ type: 'listItem', id, content: [p(`${id}p`, text)] })
    const base = blocks(doc(list(1, item('i1', 'first'), item('i2', 'second'))))
    const theirs = blocks(doc(list(2, item('i1', 'first'), item('i2', 'second, theirs'))))
    const mine = blocks(doc(list(3, item('i1', 'first, mine'), item('i2', 'second'))))
    const { asks } = mergeTexts(base, theirs, mine)
    assert.deepEqual(asks?.map((a) => a.block), ['l'])
    const held = textAsksOf(base, theirs, mine, asks!)
    assert.ok(held.value.includes('first, mine'), 'my words in an item are not lost')
    assert.ok(held.value.includes('second, theirs'))
    assert.equal(JSON.parse(held.value).content[0].attrs.start, 2, 'the asked list holds theirs until chosen')
  })

  it('a block theirs deleted and I changed is left out of the text it opens on', () => {
    const base = blocks(doc(p('b1', 'one'), p('b2', 'two')))
    const theirs = blocks(doc(p('b1', 'one, theirs')))
    const mine = blocks(doc(p('b1', 'one'), p('b2', 'two, mine')))
    const { asks } = mergeTexts(base, theirs, mine)
    const held = textAsksOf(base, theirs, mine, asks!)
    assert.deepEqual(held.blocks, ['b2'])
    assert.deepEqual(words(JSON.parse(held.value)), ['one, theirs'])
    assert.equal(held.sinceOpened, undefined)
  })

  it('a marker text both changed holds their text and says the page changed, with no block to point at', () => {
    const base = { value: 'the plan' }, theirs = { value: 'the plan, theirs' }, mine = { value: 'the plan, mine' }
    const held = textAsksOf(base, theirs, mine, mergeTexts(base, theirs, mine).asks!)
    assert.deepEqual(held, { value: 'the plan, theirs', theirs: 'the plan, theirs', mine: 'the plan, mine', blocks: [], sinceOpened: true })
  })
})

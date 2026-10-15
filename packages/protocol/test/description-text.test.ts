/**
 * A description's text read whole (SPEC §13.3 "A description as text"), tables
 * included — the one reader the agent's `edit-issue` and an editor's markdown
 * paste both use (LEAF-10).
 */
import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import {
  descriptionTextToBlockDocument,
  inlineTextOf,
  markerTextToBlockDocument,
  tableToDescriptionText,
  validateBlockDocument,
  type Block,
  type BlockDocument,
} from '../dist/index.js'

const children = (block: Block | undefined): Block[] => (block?.content ?? []) as Block[]
const cellText = (cell: Block): string => children(cell).map((p) => children(p).map((t) => (t as { text?: string }).text ?? '').join('')).join('')
const shape = (table: Block | undefined): string =>
  children(table)
    .map((row) => children(row).map((cell) => (cell.type === 'tableHeader' ? '#' : '') + cellText(cell)).join('|'))
    .join(' / ')
const types = (doc: BlockDocument) => doc.content.map((b) => b.type).join()

describe('descriptionTextToBlockDocument — a GFM pipe table is a table', () => {
  it('reads a header row, a delimiter row and rows as a table of header and body cells', () => {
    const doc = descriptionTextToBlockDocument('| Name | Since |\n| --- | :-: |\n| Miky | 2026 |\n| Katerina | 2026 |')
    assert.equal(types(doc), 'table')
    assert.equal(shape(doc.content[0]), '#Name|#Since / Miky|2026 / Katerina|2026')
    assert.deepEqual(validateBlockDocument(doc), [])
  })

  it('reads the table in the middle of prose, and every other block a description spells around it', () => {
    const doc = descriptionTextToBlockDocument('# Plan\n\nBefore.\n\n| A | B |\n| --- | --- |\n| 1 | 2 |\n\n- [ ] task\n- [x] done\n\n> [!NOTE]\n> Read this')
    assert.equal(types(doc), 'heading,paragraph,table,bulletList,blockquote')
    assert.deepEqual(children(doc.content[3]).map((item) => item.attrs?.checked), [false, true])
    assert.equal(doc.content[4].attrs?.tone, 'note')
  })

  it('keeps a cell’s inline marks and reads `\\|` as a pipe', () => {
    const doc = descriptionTextToBlockDocument('| Option | Note |\n| --- | --- |\n| **Blocks** | a \\| pipe |')
    const [bold, pipe] = children(children(doc.content[0])[1])
    assert.deepEqual(children(children(bold)[0])[0], { type: 'text', text: 'Blocks', marks: [{ type: 'bold' }] })
    assert.equal(cellText(pipe), 'a | pipe')
  })

  it('gives every row the header’s width, a short row padded with empty cells', () => {
    const doc = descriptionTextToBlockDocument('| A | B | C |\n| --- | --- | --- |\n| 1 |')
    assert.equal(shape(doc.content[0]), '#A|#B|#C / 1||')
  })

  it('widens the table to its widest row, so a cell past the header’s width keeps its text', () => {
    const doc = descriptionTextToBlockDocument('| A |\n| --- |\n| 1 | 2 |')
    assert.equal(shape(doc.content[0]), '#A|# / 1|2')
  })

  it('reads a table written without outer pipes', () => {
    const doc = descriptionTextToBlockDocument('A | B\n--- | ---\n1 | 2\n\nAfter.')
    assert.equal(types(doc), 'table,paragraph')
    assert.equal(shape(doc.content[0]), '#A|#B / 1|2')
  })

  it('ends the table at the first line without a pipe, and keeps that line', () => {
    const doc = descriptionTextToBlockDocument('| A | B |\n| --- | --- |\n| 1 | 2 |\nAfter.')
    assert.equal(types(doc), 'table,paragraph')
    assert.equal(shape(doc.content[0]), '#A|#B / 1|2')
    assert.equal(inlineTextOf(doc.content[1]), 'After.')
  })

  it('leaves pipes that are not a table as text: no delimiter row, a width mismatch, inside a code fence', () => {
    assert.equal(types(descriptionTextToBlockDocument('| A | B |\n| 1 | 2 |')), 'paragraph')
    assert.equal(types(descriptionTextToBlockDocument('| A | B |\n| --- |\n| 1 | 2 |')), 'paragraph')
    assert.equal(types(descriptionTextToBlockDocument('```\n| A | B |\n| --- | --- |\n```')), 'codeBlock')
  })

  it('reads a table after a closed code fence, and past three backticks that never close', () => {
    assert.equal(types(descriptionTextToBlockDocument('```\nx\n```\n\n| A | B |\n| --- | --- |\n| 1 | 2 |')), 'codeBlock,table')
    assert.equal(types(descriptionTextToBlockDocument('```\n\n| A | B |\n| --- | --- |\n| 1 | 2 |')), 'paragraph,table')
  })

  it('reads the table in text that holds every private-use character', () => {
    let every = ''
    for (let code = 0xe000; code <= 0xf8ff; code++) every += String.fromCharCode(code)
    const doc = descriptionTextToBlockDocument(`${every}\n\n| A |\n| --- |\n| 1 |`)
    assert.equal(types(doc), 'paragraph,table')
    assert.equal(inlineTextOf(doc.content[0]), every)
  })

  it('reads text with no table exactly as markerTextToBlockDocument reads a description', () => {
    const text = '# Heading\n\nA paragraph with **bold**.\n\n- one\n  - nested\n- [ ] box\n\n> [!WARNING]\n> careful'
    const strip = (doc: BlockDocument) => JSON.stringify(doc, (key, value) => (key === 'id' ? undefined : value))
    assert.equal(strip(descriptionTextToBlockDocument(text)), strip(markerTextToBlockDocument(text, undefined, { description: true })))
  })

  it('leaves text that spells a table’s placeholder as text, not a second copy of the table', () => {
    const doc = descriptionTextToBlockDocument('| A |\n| --- |\n\n0')
    assert.equal(types(doc), 'table,paragraph')
    assert.equal(doc.content[1].content?.[0] && (doc.content[1].content[0] as { text: string }).text, '0')
  })
})

describe('descriptionTextToBlockDocument — ids carried from the previous document', () => {
  const first = descriptionTextToBlockDocument('Intro.\n\n| A | B |\n| --- | --- |\n| 1 | 2 |')
  const table = first.content[1]

  it('a table edited in one cell keeps its id, its rows’ and its other cells’', () => {
    const next = descriptionTextToBlockDocument('Intro.\n\n| A | B |\n| --- | --- |\n| 1 | 3 |', first)
    const after = next.content[1]
    assert.equal(after.id, table.id)
    assert.deepEqual(children(after).map((r) => r.id), children(table).map((r) => r.id))
    assert.equal(children(children(after)[1])[0].id, children(children(table)[1])[0].id)
    assert.equal(next.content[0].id, first.content[0].id)
  })

  it('a table added or removed above an edited paragraph leaves that paragraph its id', () => {
    const plain = descriptionTextToBlockDocument('Intro.\n\nDetails.')
    const added = descriptionTextToBlockDocument('Intro.\n\n| A |\n| --- |\n| 1 |\n\nDetails, edited.', plain)
    assert.equal(types(added), 'paragraph,table,paragraph')
    assert.equal(added.content[2].id, plain.content[1].id)
    const removed = descriptionTextToBlockDocument('Intro.\n\nDetails, edited again.', added)
    assert.equal(removed.content[1].id, plain.content[1].id)
  })

  it('deleting one of two tables never hands its ids to the other', () => {
    const two = descriptionTextToBlockDocument('| A |\n| --- |\n| 1 |\n\n| B |\n| --- |\n| 2 |')
    const next = descriptionTextToBlockDocument('| B |\n| --- |\n| 3 |', two)
    assert.notEqual(next.content[0].id, two.content[0].id)
  })
})

describe('tableToDescriptionText', () => {
  it('prints a table it read back as the same GFM, `|` escaped', () => {
    const text = '| Option | Note |\n| --- | --- |\n| **Blocks** | a \\| pipe |'
    assert.equal(tableToDescriptionText(descriptionTextToBlockDocument(text).content[0]), text)
  })

  it('prints a cell whose run ends in a long stretch of whitespace as its text alone', () => {
    const read = descriptionTextToBlockDocument('| A |\n| --- |\n| 1 |').content[0]
    const [header, body] = children(read)
    const cell = children(body)[0]
    const long = `a${' '.repeat(100_000)}b${' '.repeat(100_000)}\n`
    const table = { ...read, content: [header, { ...body, content: [{ ...cell, content: [{ ...children(cell)[0], content: [{ type: 'text', text: long }] }] }] }] }
    assert.equal(tableToDescriptionText(table as Block), `| A |\n| --- |\n| a${' '.repeat(100_000)}b |`)
  })

  it('gives no spelling for a table whose first row is not a header, or whose cell holds a heading', () => {
    const read = descriptionTextToBlockDocument('| A |\n| --- |\n| 1 |').content[0]
    const [header, body] = children(read)
    const noHeader = { ...read, content: [body, body] }
    const headingCell = { ...read, content: [header, { ...body, content: [{ ...children(body)[0], content: [{ type: 'heading', id: 'h', attrs: { level: 2 }, content: [{ type: 'text', text: 'H' }] }] }] }] }
    assert.equal(tableToDescriptionText(noHeader), undefined)
    assert.equal(tableToDescriptionText(headingCell as Block), undefined)
  })
})

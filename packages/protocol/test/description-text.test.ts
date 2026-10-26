/**
 * A description's text read whole (SPEC §13.3 "A description as text"), tables
 * included — the one reader the agent's `edit-issue` and an editor's markdown
 * paste both use (LEAF-10).
 */
import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import {
  blockDocumentToMarkerText,
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

describe('a link on words in a description’s text (§13.1, §13.3)', () => {
  const runs = (block: Block | undefined) => children(block) as unknown as { text: string; marks?: unknown[] }[]
  const link = (href: string) => ({ type: 'link', attrs: { href } })
  const printed = (text: string) => blockDocumentToMarkerText(descriptionTextToBlockDocument(text), { description: true })

  it('reads `[words](url)` as the words marked with a link to the url, the way an editor saves one', () => {
    const doc = descriptionTextToBlockDocument('See [the plan](https://leaf.estiva.app/document/plan-1) today.')
    assert.deepEqual(runs(doc.content[0]), [
      { type: 'text', text: 'See ' },
      { type: 'text', text: 'the plan', marks: [link('https://leaf.estiva.app/document/plan-1')] },
      { type: 'text', text: ' today.' },
    ])
    assert.deepEqual(validateBlockDocument(doc), [])
  })

  it('keeps marks inside and around the words, and every character of a url holding `*` or `__`', () => {
    const [inside, around, url] = descriptionTextToBlockDocument('[**bold** words](https://x.example/a)\n\n**see [it](mailto:a@x.example)**\n\n[odd](https://x.example/*b*/__c__)').content
    assert.deepEqual(runs(inside), [
      { type: 'text', text: 'bold', marks: [{ type: 'bold' }, link('https://x.example/a')] },
      { type: 'text', text: ' words', marks: [link('https://x.example/a')] },
    ])
    assert.deepEqual(runs(around), [
      { type: 'text', text: 'see ', marks: [{ type: 'bold' }] },
      { type: 'text', text: 'it', marks: [{ type: 'bold' }, link('mailto:a@x.example')] },
    ])
    assert.deepEqual(runs(url), [{ type: 'text', text: 'odd', marks: [link('https://x.example/*b*/__c__')] }])
  })

  it('reads a link on words in backticks as the link, since code combines with no other mark', () => {
    const doc = descriptionTextToBlockDocument('See [`estiva-agent` repo](https://github.com/estiva-app/estiva-agent).')
    assert.deepEqual(runs(doc.content[0]), [
      { type: 'text', text: 'See ' },
      { type: 'text', text: 'estiva-agent repo', marks: [link('https://github.com/estiva-app/estiva-agent')] },
      { type: 'text', text: '.' },
    ])
  })

  it('leaves a link whose url holds an unclosed `(` as text, never a link to a cut url', () => {
    const text = '[Foo](https://en.wikipedia.org/wiki/Foo_(bar)) is cited'
    const all = runs(descriptionTextToBlockDocument(text).content[0])
    assert.equal(all.map((r) => r.text).join(''), text)
    assert.ok(!JSON.stringify(all).includes('"link"'))
  })

  it('puts each link on its own words when an emoji comes before it', () => {
    const doc = descriptionTextToBlockDocument('😀😀 [Pay invoice](https://good.example) and [b](https://other.example) done')
    assert.deepEqual(runs(doc.content[0]), [
      { type: 'text', text: '😀😀 ' },
      { type: 'text', text: 'Pay invoice', marks: [link('https://good.example')] },
      { type: 'text', text: ' and ' },
      { type: 'text', text: 'b', marks: [link('https://other.example')] },
      { type: 'text', text: ' done' },
    ])
  })

  it('reads links in a heading, a checklist item, a callout and a table cell', () => {
    const doc = descriptionTextToBlockDocument('# [H](https://x.example/h)\n\n- [ ] [task](https://x.example/t)\n\n> [!NOTE]\n> [note](https://x.example/n)\n\n| A |\n| --- |\n| [cell](https://x.example/c) |')
    const hrefs = JSON.stringify(doc).match(/"href":"[^"]+"/g)
    assert.deepEqual(hrefs, ['"href":"https://x.example/h"', '"href":"https://x.example/t"', '"href":"https://x.example/n"', '"href":"https://x.example/c"'])
  })

  it('leaves as text a link in code, a scheme §13.1 refuses, and words in brackets with no url', () => {
    for (const text of ['`[a](https://x.example)`', '[a](javascript:alert(1))', '[a](ftp://x.example)', '[a] (https://x.example)', 'A picture: ![a](https://x.example/a.png)']) {
      const all = runs(descriptionTextToBlockDocument(text).content[0])
      assert.equal(all.map((r) => r.text).join(''), text.replace(/`/g, ''), text)
      assert.ok(!JSON.stringify(all).includes('"link"'), text)
    }
  })

  it('prints a link on words back as `[words](url)`, so the text reads back to the same document', () => {
    for (const text of [
      'See [the **plan**](https://x.example/p) today.',
      '- [x] [done](https://x.example/d)\n  - [nested](https://x.example/n)',
      '[https://x.example/u](https://x.example/u)',
    ]) {
      assert.match(JSON.stringify(descriptionTextToBlockDocument(text)), /"type":"link"/, text)
      assert.equal(printed(text), text)
    }
    const table = '| A |\n| --- |\n| [cell](https://x.example/c) |'
    assert.equal(tableToDescriptionText(descriptionTextToBlockDocument(table).content[0]), table)
  })

  it('prints a link whose words hold a bracket as its words, never as text that would read back as other words', () => {
    const bracketed: BlockDocument = { type: 'doc', content: [{ type: 'paragraph', id: 'p', content: [{ type: 'text', text: 'see [draft] notes', marks: [{ type: 'link', attrs: { href: 'https://x.example/d' } }] }] } as Block] }
    assert.equal(blockDocumentToMarkerText(bracketed, { description: true }), 'see [draft] notes')
  })

  it('prints a card’s link as its url alone, as before: §13.3 gives a card no spelling', () => {
    const card: BlockDocument = { type: 'doc', content: [{ type: 'paragraph', id: 'p', content: [{ type: 'text', text: 'https://x.example/u', marks: [{ type: 'link', attrs: { href: 'https://x.example/u', embed: 'detailed' } }] }] } as Block] }
    assert.equal(blockDocumentToMarkerText(card, { description: true }), 'https://x.example/u')
  })

  it('leaves `[words](url)` as text in a message, whose readers find the link in the text', () => {
    const doc = markerTextToBlockDocument('See [the plan](https://x.example/p).')
    assert.deepEqual(runs(doc.content[0]), [{ type: 'text', text: 'See [the plan](https://x.example/p).' }])
  })
})

/**
 * A reference's card in a block document — SPEC §13.3, conformance C22 and C23.
 *
 * The writer's choice is `attrs.embed` on the reference mark itself, so it
 * moves and goes with its link. A reader draws each line by where the link
 * sits: alone on its line, its row, or with `detailed` its card in the row's
 * place; in a sentence, its chip. An editor carries the choice, and any key it
 * does not know, through a save.
 */
import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import {
  addrToNaddr,
  blockCards,
  cardLayout,
  documentLineDrawOf,
  fromEditorDocument,
  linesOf,
  parseBlockDocument,
  serializeBlockDocument,
  toEditorDocument,
  toRenderTree,
  type BlockDocument,
  type DocumentLineDraw,
  type RenderBlock,
} from '../dist/index.js'

const PK = 'b38fd2687b17bbde2e8079577cba601936acfe1b731d2d2ba7cdef29a063db46'
const ADDR = `30851:${PK}:an-issue`
const V = `nostr:${addrToNaddr(ADDR)}`
const W = `nostr:${addrToNaddr(`30851:${PK}:another-issue`)}`
const FOLDER = `nostr:${addrToNaddr(`39000:${PK}:a-folder`)}`
const PERSON = 'nostr:npub1kw8ay6rm0jlt6tsq09r03e4syxmfk5eyvwnx2edp2nq0v5zxc28s7tadn4'

const ref = (uri: string, attrs: Record<string, unknown> = {}, marks: { type: string }[] = []) => ({
  type: 'text' as const,
  text: uri,
  marks: [...marks, { type: 'reference', attrs: { uri, ...attrs } }],
})
const text = (t: string) => ({ type: 'text' as const, text: t })
const doc = (...content: unknown[]): BlockDocument => ({ type: 'doc', content }) as BlockDocument
const render = (d: BlockDocument) => toRenderTree(serializeBlockDocument(d), 'blocks')

/** Every line of a document as a reader draws it, walking into lists, quotes and tables. */
const draws = (d: BlockDocument): DocumentLineDraw[] => {
  const out: DocumentLineDraw[] = []
  const walk = (blocks: readonly RenderBlock[], inTableCell: boolean) => {
    for (const block of blocks) {
      if (block.inline) for (const line of linesOf(block)) out.push(documentLineDrawOf(line, { type: block.type, inTableCell }))
      if (block.children) walk(block.children, inTableCell || block.type === 'table')
    }
  }
  walk(render(d), false)
  return out
}
const row = { draw: 'row', value: ADDR }
const card = { draw: 'card', value: ADDR }
const sentence = { draw: 'sentence' }

describe('a document\'s lone link (C22)', () => {
  it('a paragraph, a list item and a checklist item that are only V draw its row', () => {
    assert.deepEqual(draws(doc(
      { type: 'paragraph', id: 'p1', content: [text('  '), ref(V), text(' ')] },
      { type: 'bulletList', id: 'l1', content: [{ type: 'listItem', id: 'i1', content: [ref(V)] }] },
      { type: 'bulletList', id: 'l2', content: [{ type: 'listItem', id: 'i2', attrs: { checked: false }, content: [ref(V)] }] },
    )), [row, row, row])
  })
  it('with embed detailed, its card in the row\'s place', () => {
    assert.deepEqual(draws(doc(
      { type: 'paragraph', id: 'p1', content: [ref(V, { embed: 'detailed' })] },
      { type: 'orderedList', id: 'l1', content: [{ type: 'listItem', id: 'i1', attrs: { checked: true }, content: [ref(V, { embed: 'detailed' })] }] },
    )), [card, card])
  })
  it('with no embed, none, compact, an unknown value or a non-string, the row', () => {
    const lone = [{}, { embed: 'none' }, { embed: 'compact' }, { embed: 'huge' }, { embed: { layout: 'detailed' } }, { embed: 3 }]
    assert.deepEqual(
      draws(doc(...lone.map((attrs, i) => ({ type: 'paragraph', id: `p${i}`, content: [ref(V, attrs)] })))),
      lone.map(() => row),
    )
  })
  it('a second line after a hard break that is only V draws its row, and the first stays a sentence', () => {
    assert.deepEqual(draws(doc({ type: 'paragraph', id: 'p1', content: [text('Blocked by:\n'), ref(V, { embed: 'detailed' }), text('\n'), ref(V)] })), [sentence, card, row])
  })
  it('detailed beside other words, inside bold, in a heading, a quote, a callout or a table cell draws the chip only', () => {
    const detailed = (marks: { type: string }[] = []) => ref(V, { embed: 'detailed' }, marks)
    const drawn = draws(doc(
      { type: 'paragraph', id: 'p1', content: [text('Blocked by '), detailed(), text(' for now')] },
      { type: 'paragraph', id: 'p2', content: [detailed(), text('.')] },
      { type: 'paragraph', id: 'p3', content: [detailed([{ type: 'bold' }])] },
      { type: 'heading', id: 'h1', attrs: { level: 2 }, content: [detailed()] },
      { type: 'blockquote', id: 'q1', content: [detailed()] },
      { type: 'blockquote', id: 'q2', attrs: { tone: 'warning' }, content: [detailed()] },
      { type: 'table', id: 't1', content: [{ type: 'tableRow', id: 'r1', content: [{ type: 'tableCell', id: 'c1', content: [{ type: 'paragraph', id: 'p4', content: [detailed()] }] }] }] },
    ))
    assert.deepEqual(drawn, drawn.map(() => sentence))
    assert.equal(drawn.length, 7)
  })
  it('two links on one line are a sentence', () => {
    assert.deepEqual(draws(doc({ type: 'paragraph', id: 'p1', content: [ref(V, { embed: 'detailed' }), text(' '), ref(W)] })), [sentence])
  })
  it('a person or a Folder alone on its line draws its chip, embed or not', () => {
    assert.deepEqual(draws(doc(
      { type: 'paragraph', id: 'p1', content: [ref(PERSON, { embed: 'detailed' })] },
      { type: 'paragraph', id: 'p2', content: [ref(FOLDER, { embed: 'detailed' })] },
    )), [sentence, sentence])
  })
  it('a lone reference to nothing readable draws the unreadable row, never a card', () => {
    assert.deepEqual(draws(doc({ type: 'paragraph', id: 'p1', content: [ref('nostr:naddr1garbage', { embed: 'detailed' })] })), [
      { draw: 'unreadable', reference: 'nostr:naddr1garbage' },
    ])
  })
})

describe('cardLayout', () => {
  it('reads compact and detailed as written, and none, absent and a non-string as no card', () => {
    assert.equal(cardLayout('compact'), 'compact')
    assert.equal(cardLayout('detailed'), 'detailed')
    assert.equal(cardLayout('none'), undefined)
    assert.equal(cardLayout(undefined), undefined)
    assert.equal(cardLayout(3), undefined)
  })
  it('draws a layout it does not know as compact', () => {
    assert.equal(cardLayout('huge'), 'compact')
  })
})

// The rule before 0.41.0, deprecated: Ship and Peek still draw cards by it until their readers move.
describe('blockCards (deprecated)', () => {
  it('a detailed reference in a sentence asks for its card after the paragraph', () => {
    const [p] = render(doc({ type: 'paragraph', id: 'p1', content: [text('Blocked by '), ref(V, { embed: 'detailed' }), text(' for now')] }))
    assert.deepEqual(blockCards(p), [{ reference: V, layout: 'detailed' }])
  })
  it('a reference alone on its line with no embed, or none, asks for no card', () => {
    const [a, b] = render(doc(
      { type: 'paragraph', id: 'p1', content: [ref(V)] },
      { type: 'paragraph', id: 'p2', content: [ref(V, { embed: 'none' })] },
    ))
    assert.deepEqual(blockCards(a), [])
    assert.deepEqual(blockCards(b), [])
    assert.equal(a.inline?.[0].reference, V, 'still its chip')
  })
  it('each occurrence is its own card, in the order written', () => {
    const [p, q] = render(doc(
      { type: 'paragraph', id: 'p1', content: [ref(W, { embed: 'compact' }), text(' and '), ref(V, { embed: 'detailed' }), text(' again '), ref(V, { embed: 'compact' })] },
      { type: 'paragraph', id: 'p2', content: [ref(V, { embed: 'compact' })] },
    ))
    assert.deepEqual(blockCards(p), [
      { reference: W, layout: 'compact' },
      { reference: V, layout: 'detailed' },
      { reference: V, layout: 'compact' },
    ])
    assert.deepEqual(blockCards(q), [{ reference: V, layout: 'compact' }])
  })
  it('a reference split across runs is one occurrence, with its first run\'s card', () => {
    const [p] = render(doc({ type: 'paragraph', id: 'p1', content: [
      { type: 'text', text: V.slice(0, 12), marks: [{ type: 'bold' }, { type: 'reference', attrs: { uri: V, embed: 'detailed' } }] },
      { type: 'text', text: V.slice(12), marks: [{ type: 'reference', attrs: { uri: V } }] },
    ] }))
    assert.deepEqual(blockCards(p), [{ reference: V, layout: 'detailed' }])
  })
  it('an unknown layout draws as compact', () => {
    const [p] = render(doc({ type: 'paragraph', id: 'p1', content: [ref(V, { embed: 'huge' })] }))
    assert.deepEqual(blockCards(p), [{ reference: V, layout: 'compact' }])
  })
  it('a list item\'s card hangs from the item, not the list', () => {
    const [list] = render(doc({ type: 'bulletList', id: 'l1', content: [
      { type: 'listItem', id: 'i1', content: [text('see '), ref(V, { embed: 'compact' })] },
    ] }))
    assert.deepEqual(blockCards(list), [])
    assert.deepEqual(blockCards(list.children![0]), [{ reference: V, layout: 'compact' }])
  })
  it('a marker body never asks for a card: a message\'s cards are its tags', () => {
    const [p] = toRenderTree(V, 'marker')
    assert.deepEqual(blockCards(p), [])
  })
})

describe('an editor keeps the card (C23)', () => {
  const original = doc(
    { type: 'paragraph', id: 'p1', content: [text('Blocked by '), ref(V, { embed: 'detailed', later: { x: 1 } }, [{ type: 'bold' }])] },
    { type: 'paragraph', id: 'p2', content: [text('other words')] },
  )

  it('round-trips embed and an unknown key on the mark, with the block id', () => {
    const editor = toEditorDocument(original)
    const node = (editor.content[0].content ?? []).find((n) => n.type === 'reference')!
    assert.equal(node.attrs?.embed, 'detailed')
    assert.deepEqual(node.attrs?.extra, { later: { x: 1 } })

    // An edit to another block, as a person makes it in the editor.
    editor.content[1].content = [{ type: 'text', text: 'changed words' }]
    const back = parseBlockDocument(serializeBlockDocument(fromEditorDocument(editor)))
    const p1 = back.content[0]
    assert.equal(p1.id, 'p1')
    const run = (p1.content as { marks?: { type: string; attrs?: Record<string, unknown> }[] }[])[1]
    assert.deepEqual(run.marks, [{ type: 'bold' }, { type: 'reference', attrs: { later: { x: 1 }, uri: V, embed: 'detailed' } }])
  })

  it('choosing none writes no attribute', () => {
    const editor = toEditorDocument(original)
    const node = (editor.content[0].content ?? []).find((n) => n.type === 'reference')!
    node.attrs = { ...node.attrs, embed: 'none' }
    const back = fromEditorDocument(editor)
    const run = (back.content[0].content as { marks?: { type: string; attrs?: Record<string, unknown> }[] }[])[1]
    assert.equal(run.marks?.find((m) => m.type === 'reference')?.attrs?.embed, undefined)
  })

  it('a key in extra cannot overwrite the uri', () => {
    const editor = toEditorDocument(doc({ type: 'paragraph', id: 'p1', content: [ref(V)] }))
    const node = editor.content[0].content![0]
    node.attrs = { ...node.attrs, extra: { uri: 'nostr:somewhere-else' } }
    const run = (fromEditorDocument(editor).content[0].content as { marks?: { type: string; attrs?: Record<string, unknown> }[] }[])[0]
    assert.equal(run.marks?.find((m) => m.type === 'reference')?.attrs?.uri, V)
  })

  it('a reference with nothing chosen stays exactly as it was', () => {
    const plain = doc({ type: 'paragraph', id: 'p1', content: [ref(V)] })
    assert.equal(serializeBlockDocument(fromEditorDocument(toEditorDocument(plain))), serializeBlockDocument(plain))
  })
})

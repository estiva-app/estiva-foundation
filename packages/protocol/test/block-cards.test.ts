/**
 * A reference's card in a block document — SPEC §13.3, conformance C22 and C23.
 *
 * The writer's choice is `attrs.embed` on the reference mark itself, so it
 * moves and goes with its link. A reader draws it after the block holding the
 * reference; an editor carries it, and any key it does not know, through a save.
 */
import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import {
  addrToNaddr,
  blockCards,
  cardLayout,
  fromEditorDocument,
  parseBlockDocument,
  serializeBlockDocument,
  toEditorDocument,
  toRenderTree,
  type BlockDocument,
} from '../dist/index.js'

const PK = 'b38fd2687b17bbde2e8079577cba601936acfe1b731d2d2ba7cdef29a063db46'
const V = `nostr:${addrToNaddr(`30851:${PK}:an-issue`)}`
const W = `nostr:${addrToNaddr(`30851:${PK}:another-issue`)}`

const ref = (uri: string, attrs: Record<string, unknown> = {}, marks: { type: string }[] = []) => ({
  type: 'text' as const,
  text: uri,
  marks: [...marks, { type: 'reference', attrs: { uri, ...attrs } }],
})
const text = (t: string) => ({ type: 'text' as const, text: t })
const doc = (...content: unknown[]): BlockDocument => ({ type: 'doc', content }) as BlockDocument
const render = (d: BlockDocument) => toRenderTree(serializeBlockDocument(d), 'blocks')

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

describe('blockCards (C22)', () => {
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

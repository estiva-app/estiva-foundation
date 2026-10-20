/**
 * A URL in a block document — SPEC §13.3, "A reference's card", conformance C24.
 *
 * A URL stays a URL on the wire. With no card it is plain text; with one, the
 * run whose text is the URL carries a `link` mark holding `href` and `embed`.
 * A reader with a link resolver draws it as the chip of what it names (and its
 * card); an editor turns it into a URL chip and back into the same bytes.
 */
import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import * as protocol from '../dist/index.js'
import {
  addrToNaddr,
  blockCards,
  fromEditorDocument,
  linesOf,
  linksAsReferences,
  parseBlockDocument,
  referenceOfLink,
  serializeBlockDocument,
  toEditorDocument,
  toRenderTree,
  urlRunsIn,
  type BlockDocument,
  type EditorDocument,
  type RenderBlock,
} from '../dist/index.js'

const PK = 'b38fd2687b17bbde2e8079577cba601936acfe1b731d2d2ba7cdef29a063db46'
const ADDR = `30851:${PK}:an-issue`
const V = `nostr:${addrToNaddr(ADDR)}`
const URL_ = 'https://ship.estiva.app/i/an-issue'
const BLOCK_URL = `${URL_}#block-b1`
// Read off the namespace, so this file still loads on a version without it and its editor cases run there.
const { documentLineDrawOf } = protocol
// An app names a link to one block of a file by the file (§7.7, C21).
const resolve = (url: string) => (url === URL_ || url === BLOCK_URL ? ADDR : undefined)

const text = (t: string, marks?: unknown[]) => ({ type: 'text' as const, text: t, ...(marks ? { marks } : {}) })
const link = (href: string, attrs: Record<string, unknown> = {}, marks: unknown[] = []) =>
  text(href, [...marks, { type: 'link', attrs: { href, ...attrs } }])
const doc = (...content: unknown[]): BlockDocument => ({ type: 'doc', content }) as BlockDocument
const render = (d: BlockDocument) => toRenderTree(serializeBlockDocument(d), 'blocks')
const roundTrip = (d: BlockDocument) => fromEditorDocument(toEditorDocument(d))

/** Each line of a one-paragraph document as a reader draws it: by `resolveLink`, or after `linksAsReferences`. */
const drawn = (content: unknown[], via: 'resolver' | 'linksAsReferences') => {
  const tree = render(doc({ type: 'paragraph', id: 'p1', content }))
  const [p]: RenderBlock[] = via === 'resolver' ? tree : linksAsReferences(tree, resolve)
  return linesOf(p).map((line) => documentLineDrawOf(line, p, via === 'resolver' ? { resolveLink: resolve } : {}))
}
const words = (t: string, attrs: Record<string, unknown> = {}) => text(t, [{ type: 'link', attrs: { href: URL_, ...attrs } }])

describe('a URL and a link on words in a document, drawn (C24)', () => {
  for (const via of ['resolver', 'linksAsReferences'] as const) {
    const url = via === 'resolver' ? { url: URL_ } : {}
    it(`a plain URL alone on its line draws V's row (${via})`, () => {
      assert.deepEqual(drawn([text(` ${URL_} `)], via), [{ draw: 'row', value: ADDR, ...url }])
    })
    it(`the URL marked with a link whose embed is detailed draws V's card in the row's place (${via})`, () => {
      assert.deepEqual(drawn([link(URL_, { embed: 'detailed' })], via), [{ draw: 'card', value: ADDR, ...url }])
      assert.deepEqual(drawn([link(URL_, { embed: 'compact' })], via), [{ draw: 'row', value: ADDR, ...url }])
    })
    it(`the same link beside other words draws no card (${via})`, () => {
      assert.deepEqual(drawn([text('See '), link(URL_, { embed: 'detailed' })], via), [{ draw: 'sentence' }])
    })
    it(`a link on words draws its words, alone on its line too: no row, no card (${via})`, () => {
      assert.deepEqual(drawn([words('the plan', { embed: 'detailed' })], via), [{ draw: 'sentence' }])
      assert.deepEqual(drawn([words(' the plan ')], via), [{ draw: 'sentence' }])
    })
  }
  it('a link to one block of V alone on its line draws V\'s row, which opens that URL', () => {
    const [p] = render(doc({ type: 'paragraph', id: 'p1', content: [text(BLOCK_URL)] }))
    assert.deepEqual(documentLineDrawOf(linesOf(p)[0], p, { resolveLink: resolve }), { draw: 'row', value: ADDR, url: BLOCK_URL })
  })
  it('a URL no app claims stays the URL, its embed drawing nothing', () => {
    const other = 'https://example.com/x'
    const [p] = render(doc({ type: 'paragraph', id: 'p1', content: [link(other, { embed: 'detailed' })] }))
    assert.deepEqual(documentLineDrawOf(linesOf(p)[0], p, { resolveLink: resolve }), { draw: 'url', url: other })
  })
})

describe('a URL in a document, read (C24)', () => {
  it('a plain URL alone on its line reads as its chip, with no card', () => {
    const [p] = linksAsReferences(render(doc({ type: 'paragraph', id: 'p1', content: [text(URL_)] })), resolve)
    assert.equal(p.inline?.[0].reference, V)
    assert.equal(p.inline?.[0].text, URL_)
    assert.deepEqual(blockCards(p), [])
  })
  it('a link mark on the URL keeps its card when it becomes the chip', () => {
    const [p] = linksAsReferences(render(doc({ type: 'paragraph', id: 'p1', content: [text('See '), link(URL_, { embed: 'detailed' })] })), resolve)
    assert.equal(p.inline?.[1].reference, V)
    assert.equal(p.inline?.[1].href, undefined)
    assert.deepEqual(blockCards(p), [{ reference: V, layout: 'detailed' }])
  })
  it('a URL nothing names stays a link, and asks for no card', () => {
    const other = 'https://example.com/x'
    const [p] = linksAsReferences(render(doc({ type: 'paragraph', id: 'p1', content: [link(other, { embed: 'compact' })] })), resolve)
    assert.equal(p.inline?.[0].reference, undefined)
    assert.equal(p.inline?.[0].href, other)
    assert.deepEqual(blockCards(p), [])
  })
  it('a link on words stays a link: its words are not the URL', () => {
    const [p] = linksAsReferences(render(doc({ type: 'paragraph', id: 'p1', content: [text('the issue', [{ type: 'link', attrs: { href: URL_, embed: 'compact' } }])] })), resolve)
    assert.equal(p.inline?.[0].reference, undefined)
    assert.equal(p.inline?.[0].text, 'the issue')
    assert.deepEqual(blockCards(p), [], 'names nothing without a resolver')
    assert.deepEqual(blockCards(p, resolve), [{ reference: V, layout: 'compact' }], 'its card, by what its href names')
  })
  it('a link mark never reaches a run\'s marks', () => {
    const [p] = render(doc({ type: 'paragraph', id: 'p1', content: [link(URL_, {}, [{ type: 'bold' }])] }))
    assert.deepEqual(p.inline?.[0].marks, ['bold'])
    assert.equal(p.inline?.[0].href, URL_)
  })
})

describe('a URL in a document, edited (C24)', () => {
  it('a URL with a card becomes a URL chip and comes back as the same bytes', () => {
    const d = doc({ type: 'paragraph', id: 'p1', content: [text('See '), link(URL_, { embed: 'detailed', later: 1 }, [{ type: 'bold' }]), text(' now')] })
    const editor = toEditorDocument(d)
    const chip = editor.content?.[0].content?.[1]
    assert.equal(chip?.type, 'reference')
    assert.equal(chip?.attrs?.href, URL_)
    assert.equal(chip?.attrs?.uri, '')
    assert.equal(chip?.attrs?.embed, 'detailed')
    // The same document; an unknown key may move within the mark's attrs.
    assert.deepEqual(fromEditorDocument(editor), d)
  })
  it('a plain URL is text in the editor, and saves as it was', () => {
    const d = doc({ type: 'paragraph', id: 'p1', content: [text(`See ${URL_} now`)] })
    assert.equal(serializeBlockDocument(roundTrip(d)), serializeBlockDocument(d))
  })
  it('a URL chip with no card saves as plain text, merged with its neighbours', () => {
    const editor: EditorDocument = {
      type: 'doc',
      content: [{
        type: 'paragraph',
        attrs: { blockId: 'p1' },
        content: [
          { type: 'text', text: 'See ' },
          { type: 'reference', attrs: { uri: V, href: URL_, marks: [], embed: null } },
          { type: 'text', text: ' now' },
        ],
      }],
    }
    assert.deepEqual(fromEditorDocument(editor).content[0].content, [text(`See ${URL_} now`)])
  })
  it('choosing a card writes a link mark on the URL, never a nostr: reference', () => {
    const editor: EditorDocument = {
      type: 'doc',
      content: [{ type: 'paragraph', attrs: { blockId: 'p1' }, content: [{ type: 'reference', attrs: { uri: V, href: URL_, marks: [], embed: 'compact' } }] }],
    }
    assert.deepEqual(fromEditorDocument(editor).content[0].content, [link(URL_, { embed: 'compact' })])
  })
  it('a URL chip followed by a typed word keeps its end, with a link mark', () => {
    const editor: EditorDocument = {
      type: 'doc',
      content: [{
        type: 'paragraph',
        attrs: { blockId: 'p1' },
        content: [
          { type: 'reference', attrs: { uri: V, href: URL_, marks: [], embed: null } },
          { type: 'text', text: 'abc. ' },
          { type: 'reference', attrs: { uri: V, href: URL_, marks: [], embed: null } },
          { type: 'reference', attrs: { uri: V, href: URL_, marks: [], embed: null } },
          { type: 'text', text: '. Done' },
        ],
      }],
    }
    assert.deepEqual(fromEditorDocument(editor).content[0].content, [
      link(URL_),
      text('abc. '),
      link(URL_),
      text(`${URL_}. Done`),
    ])
  })
  it('a URL somebody wrote with a link mark and no card saves the same bytes', () => {
    const d = doc({ type: 'paragraph', id: 'p1', content: [text('See '), link(URL_, { target: '_blank' }), text(' now')] })
    assert.equal(serializeBlockDocument(roundTrip(d)), serializeBlockDocument(d))
  })
  it('keeps an embed it cannot read, and reads an empty one as no card', () => {
    const odd = doc({ type: 'paragraph', id: 'p1', content: [link(URL_, { embed: { layout: 'x' } })] })
    assert.deepEqual(roundTrip(odd), odd)
    const [p] = render(doc({ type: 'paragraph', id: 'p1', content: [link(URL_, { embed: '' })] }))
    assert.equal(p.inline?.[0].embed, undefined)
  })
  it('an editor with no link mark keeps a link on words\' words only, so it never loads a mark it lacks', () => {
    const d = doc({ type: 'paragraph', id: 'p1', content: [text('the issue', [{ type: 'link', attrs: { href: URL_ } }])] })
    assert.deepEqual(roundTrip(d).content[0].content, [text('the issue')])
  })
  it('an editor with links writes an app link and a web link on words back, link and embed included, after an edit to another block', () => {
    const d = doc(
      { type: 'paragraph', id: 'p1', content: [
        text('Read '), words('the plan', { embed: 'detailed', later: { x: 1 } }), text(' and '),
        text('this', [{ type: 'bold' }, { type: 'link', attrs: { href: URL_ } }]), text(', then '),
        text('the docs', [{ type: 'link', attrs: { href: 'https://example.com/docs', target: '_blank' } }]),
      ] },
      { type: 'paragraph', id: 'p2', content: [text('other words')] },
    )
    const editor = toEditorDocument(d, { links: true })
    assert.deepEqual(editor.content[0].content?.[1], {
      type: 'text',
      text: 'the plan',
      marks: [{ type: 'link', attrs: { href: URL_, extra: { embed: 'detailed', later: { x: 1 } } } }],
    })
    editor.content[1].content = [{ type: 'text', text: 'changed words' }]
    const back = parseBlockDocument(serializeBlockDocument(fromEditorDocument(editor)))
    assert.deepEqual(back.content[0], d.content[0])
    assert.equal(back.content[0].id, 'p1')
  })
  it('an editor with links still opens a URL marked with its own link as the URL chip', () => {
    const editor = toEditorDocument(doc({ type: 'paragraph', id: 'p1', content: [link(URL_, { embed: 'detailed' })] }), { links: true })
    assert.equal(editor.content[0].content?.[0].type, 'reference')
  })
  it('a link on words to a scheme §13.1 does not allow is neither held nor written, its words kept', () => {
    const d = doc({ type: 'paragraph', id: 'p1', content: [text('the plan', [{ type: 'link', attrs: { href: 'javascript:alert(1)', embed: 'detailed' } }])] })
    assert.deepEqual(toEditorDocument(d, { links: true }).content[0].content, [{ type: 'text', text: 'the plan' }])
    const editor: EditorDocument = {
      type: 'doc',
      content: [{ type: 'paragraph', attrs: { blockId: 'p1' }, content: [
        { type: 'text', text: 'the plan', marks: [{ type: 'link', attrs: { href: 'java\tscript:alert(1)' } }] },
        { type: 'text', text: ' and a call', marks: [{ type: 'link', attrs: { href: 'tel:+420123' } }] },
      ] }],
    }
    assert.deepEqual(fromEditorDocument(editor).content[0].content, [text('the plan and a call')])
  })
  it('a link mark an editor hands back with no href is dropped, its words kept', () => {
    const editor: EditorDocument = {
      type: 'doc',
      content: [{ type: 'paragraph', attrs: { blockId: 'p1' }, content: [{ type: 'text', text: 'the plan', marks: [{ type: 'link', attrs: { href: '', extra: { href: URL_ } } }] }] }],
    }
    assert.deepEqual(fromEditorDocument(editor).content[0].content, [text('the plan')])
  })
})

describe('a malformed mark (security review)', () => {
  // The validator checks only a mark's `type`; somebody else's JSON must not take every reader down.
  const bad = [
    { type: 'link', attrs: null },
    { type: 'link' },
    { type: 'link', attrs: { href: 3 } },
    { type: 'reference', attrs: null },
    { type: 'reference', attrs: [] },
    // §13.1: only http, https, mailto and nostr.
    { type: 'link', attrs: { href: 'javascript:alert(1)' } },
    { type: 'link', attrs: { href: 'java\tscript:alert(1)' } },
    { type: 'link', attrs: { href: 'data:text/html,<script>alert(1)</script>' } },
  ]
  for (const mark of bad) {
    it(`reads ${JSON.stringify(mark)} as no mark, in the reader and the editor`, () => {
      const d = doc({ type: 'paragraph', id: 'p1', content: [text(URL_, [mark, { type: 'bold' }])] })
      const [p] = render(d)
      assert.equal(p.inline?.[0].text, URL_)
      assert.equal(p.inline?.[0].reference, undefined)
      assert.equal(p.inline?.[0].href, undefined)
      assert.deepEqual(p.inline?.[0].marks, ['bold'])
      const editor = toEditorDocument(d)
      assert.deepEqual(editor.content?.[0].content, [{ type: 'text', text: URL_, marks: [{ type: 'bold' }] }])
    })
  }
})

describe('referenceOfLink and urlRunsIn', () => {
  it('names the reference a resolved URL stands for, and nothing for one unanswered', () => {
    assert.equal(referenceOfLink(URL_, resolve), V)
    assert.equal(referenceOfLink('https://example.com', resolve), undefined)
  })
  it('finds bare URLs and where they sit, without trailing punctuation or a marker link', () => {
    assert.deepEqual(urlRunsIn(`See ${URL_}. And [x](https://a.b/c)`), [{ url: URL_, from: 4, to: 4 + URL_.length }])
  })
})

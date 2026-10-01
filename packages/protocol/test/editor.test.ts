/**
 * The seam between what is stored and what is edited — SPEC §13, RIC-14.
 *
 * Moved from Ship's `blockEditor.test.ts` with the translation (MAN-9), so the
 * two apps that edit a §13.3 document are held to one set of answers: which
 * saves write a document, which bodies are left as they are, and whether an
 * edit keeps the ids a comment is anchored to.
 *
 * The conversions underneath are tested against 152 real bodies in
 * `blocks.test.ts`. What is here is the translation to ProseMirror and the
 * three things it must not lose.
 */
import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import {
  documentForEditing,
  fromEditorDocument,
  parseBlockDocument,
  publishableFromEditor,
  toEditorDocument,
  type Block,
  type BlockDocument,
  type EditorDocument,
} from '../dist/index.js'

const idsOf = (json: string) => parseBlockDocument(json).content.map((b) => b.id)
const open = (value: string, format: 'marker' | 'blocks' = 'marker') =>
  toEditorDocument(documentForEditing(value, format))
/** Open a body, change nothing, save — the round trip every edit starts from. */
const reopen = (value: string, format: 'marker' | 'blocks' = 'marker') =>
  publishableFromEditor(open(value, format))

describe('what the editor opens with', () => {
  it('turns a legacy marker body into blocks to edit', () => {
    const doc = open('# Title\n\na **bold** word')
    assert.deepEqual(doc.content.map((n) => n.type), ['heading', 'paragraph'])
    assert.equal(doc.content[0].attrs?.level, 1)
    assert.equal(doc.content[1].content?.some((n) => n.marks?.some((m) => m.type === 'bold')), true)
  })

  it('reads a body that merely looks like a document as marker text — §13.4', () => {
    // No tag means marker text, however much the body resembles a document.
    // Guessing here would silently reclassify 731 published bodies.
    const looksLikeOne = '{"type":"doc","content":[]}'
    const doc = open(looksLikeOne)
    assert.ok(doc.content[0].content?.[0].text?.includes('"type":"doc"'))
  })

  it('shows what is stored when a body is tagged blocks and is not one', () => {
    // Losing anchors on an already-broken body beats showing an empty editor
    // over something that has text in it.
    const doc = open('not a document', 'blocks')
    assert.equal(doc.content[0].content?.[0].text, 'not a document')
  })

  it('opens an empty value as an empty document', () => {
    assert.deepEqual(open('   ').content, [])
  })
})

describe('what a save publishes', () => {
  it('writes a block document and declares the format', () => {
    const { value, contentFormat } = reopen('# Title\n\npara')
    assert.equal(contentFormat, 'estiva-blocks-1')
    const doc = parseBlockDocument(value)
    assert.deepEqual(doc.content.map((b) => b.type), ['heading', 'paragraph'])
    assert.equal(doc.content.every((b) => b.id.length >= 8), true)
  })

  it('declares nothing for an empty document, and writes empty text', () => {
    // `{"type":"doc","content":[]}` in a `value` tag is a worse thing for
    // another app to receive than "". An editor left empty is that case: it
    // holds one empty paragraph, not nothing.
    assert.deepEqual(publishableFromEditor({ type: 'doc', content: [{ type: 'paragraph' }] }), { value: '' })
    assert.deepEqual(publishableFromEditor({ type: 'doc', content: [] }), { value: '' })
  })

  it('round-trips a document unchanged, ids included', () => {
    const first = reopen('# T\n\none\n\ntwo')
    const again = publishableFromEditor(open(first.value, 'blocks'))
    assert.equal(again.value, first.value)
    assert.deepEqual(idsOf(again.value), idsOf(first.value))
  })
})

describe('the three things it must not lose', () => {
  it('keeps a block id when its text is edited', () => {
    /*
      An anchored comment binds to `<address> + <block id>` (RFC 0.4 §6), so an
      edit that re-mints ids detaches every comment on the page with nothing on
      screen to say so.
    */
    const stored = reopen('# Title\n\nfirst\n\nsecond').value
    const editing = open(stored, 'blocks')
    const second = editing.content[2]
    second.content = [{ type: 'text', text: 'second, edited' }]

    const saved = publishableFromEditor(editing)
    assert.deepEqual(idsOf(saved.value), idsOf(stored))
  })

  it('keeps ids when blocks are reordered, which position-matching could not', () => {
    /*
      `markerTextToBlockDocument` carries ids from the previous document **by
      position**, so moving a paragraph up moved every anchor with the slot
      rather than with the block — a comment silently reattached to different
      words. The id travels on the block here.
    */
    const stored = reopen('one\n\ntwo').value
    const [firstId, secondId] = idsOf(stored)
    const editing = open(stored, 'blocks')
    editing.content.reverse()

    const saved = parseBlockDocument(publishableFromEditor(editing).value)
    assert.deepEqual(saved.content.map((b) => b.id), [secondId, firstId])
    assert.equal((saved.content[0].content as { text: string }[] | undefined)?.[0].text, 'two')
  })

  it('re-mints a duplicated id rather than publishing a document with two', () => {
    // Copy a block, paste it, and both copies claim the same id — a document
    // `validateBlockDocument` rejects and an anchor pointing at two places.
    const editing = open(reopen('one').value, 'blocks')
    editing.content.push(structuredClone(editing.content[0]))

    const ids = idsOf(publishableFromEditor(editing).value)
    assert.equal(ids.length, 2)
    assert.equal(new Set(ids).size, 2)
  })

  describe('Enter inside an anchored block — MAN-10', () => {
    /*
      Tiptap copies a split node's attrs to both halves, so Enter gives two
      nodes with one `blockId`. This is what that looks like: the node at
      `at`, cut into `before` and `after`, both claiming its id.
    */
    const split = (doc: EditorDocument, at: number, before: string, after: string) => {
      const node = doc.content[at]
      const half = (text: string) => ({ ...structuredClone(node), content: text ? [{ type: 'text', text }] : [] })
      doc.content.splice(at, 1, half(before), half(after))
      return doc
    }
    const save = (doc: EditorDocument) =>
      parseBlockDocument(publishableFromEditor(doc).value).content.map((b) => ({
        id: b.id,
        text: ((b.content ?? []) as { text?: string }[]).map((n) => n.text ?? '').join(''),
      }))

    const stored = reopen('intro\n\nthe anchored paragraph').value
    const [introId, anchoredId] = idsOf(stored)

    it('keeps the id on the text when Enter is pressed at the start', () => {
      // The case that broke: the id went to the new empty line above, and the
      // comment with it.
      const saved = save(split(open(stored, 'blocks'), 1, '', 'the anchored paragraph'))
      assert.equal(saved[0].id, introId)
      assert.deepEqual(saved[2], { id: anchoredId, text: 'the anchored paragraph' })
      assert.notEqual(saved[1].id, anchoredId)
      assert.equal(new Set(saved.map((b) => b.id)).size, 3)
    })

    it('keeps the id on the first half when Enter is pressed in the middle', () => {
      const saved = save(split(open(stored, 'blocks'), 1, 'the anchored', ' paragraph'))
      assert.deepEqual(saved[1], { id: anchoredId, text: 'the anchored' })
      assert.notEqual(saved[2].id, anchoredId)
    })

    it('keeps the id on the text when Enter is pressed at the end', () => {
      const saved = save(split(open(stored, 'blocks'), 1, 'the anchored paragraph', ''))
      assert.deepEqual(saved[1], { id: anchoredId, text: 'the anchored paragraph' })
      assert.notEqual(saved[2].id, anchoredId)
    })

    it('does the same inside a list, where the repeat is a list item', () => {
      const list = reopen('- first\n- second').value
      const listId = idsOf(list)[0]
      const editing = open(list, 'blocks')
      const items = editing.content[0].content!
      const second = items[1]
      const secondId = second.attrs?.blockId
      const empty = { ...structuredClone(second), content: [{ type: 'paragraph' }] }
      items.splice(1, 0, empty)

      const saved = parseBlockDocument(publishableFromEditor(editing).value).content[0]
      assert.equal(saved.id, listId)
      const savedItems = saved.content as { id: string; content?: { text: string }[] }[]
      assert.equal(savedItems.length, 3)
      assert.notEqual(savedItems[1].id, secondId)
      assert.equal(savedItems[2].id, secondId)
      assert.equal(savedItems[2].content?.[0].text, 'second')
    })

    it('leaves the id on the first when no copy holds text', () => {
      const saved = save(split(open(stored, 'blocks'), 1, '', ''))
      assert.equal(saved[1].id, anchoredId)
      assert.notEqual(saved[2].id, anchoredId)
    })

    it('counts a line break on its own as holding something', () => {
      const editing = open(stored, 'blocks')
      const copy = { ...structuredClone(editing.content[1]), content: [{ type: 'text', text: 'typed later' }] }
      editing.content[1].content = [{ type: 'hardBreak' }]
      editing.content.push(copy)
      assert.equal(save(editing)[1].id, anchoredId)
    })

    it('does the same inside a table cell', () => {
      const table: BlockDocument = {
        type: 'doc',
        content: [
          {
            type: 'table',
            id: 't1',
            content: [
              {
                type: 'tableRow',
                id: 'r1',
                content: [
                  {
                    type: 'tableCell',
                    id: 'c1',
                    content: [{ type: 'paragraph', id: 'p1', content: [{ type: 'text', text: 'in a cell' }] }],
                  },
                ],
              },
            ],
          },
        ],
      }
      const editing = toEditorDocument(table)
      const cell = editing.content[0].content![0].content![0]
      cell.content!.unshift({ type: 'paragraph', attrs: { blockId: 'p1' } })

      const savedCell = (fromEditorDocument(editing).content[0].content as Block[])[0].content![0] as Block
      const paragraphs = savedCell.content as Block[]
      assert.notEqual(paragraphs[0].id, 'p1')
      assert.equal(paragraphs[1].id, 'p1')
    })

    it('never gives an unknown block’s id to an ordinary block, wherever it sits', () => {
      // The unknown block hands its id back untouched, so the other one must yield.
      const editing = toEditorDocument({
        type: 'doc',
        content: [
          { type: 'paragraph', id: 'w1', content: [{ type: 'text', text: 'claims the same id' }] },
          { type: 'widget', id: 'w1', content: [{ type: 'text', text: 'a widget' }] },
        ],
      })
      const ids = fromEditorDocument(editing).content.map((b) => b.id)
      assert.equal(ids[1], 'w1')
      assert.notEqual(ids[0], 'w1')
    })
  })

  const withWidget: BlockDocument = {
    type: 'doc',
    content: [
      { type: 'paragraph', id: 'p1', content: [{ type: 'text', text: 'before' }] },
      { type: 'widget', id: 'w1', content: [{ type: 'text', text: 'a widget no editor can draw' }] },
    ],
  }

  it('carries an unknown block through untouched, id and all', () => {
    /*
      §13.3: a reader MUST render an unknown block's inline text and MUST NOT
      drop it silently. An editor is the dangerous case — ProseMirror discards
      a node its schema does not know, and the save after it would delete
      somebody else's block with no error anywhere on the way.

      `widget` is the example now that `table` is editable (UIG-18). It is the
      one type §13.3 names that no editor has a design for.
    */
    const saved = fromEditorDocument(toEditorDocument(withWidget))
    assert.deepEqual(saved.content[1], withWidget.content[1])
  })

  it('hands an unknown block its inline text, so the node view needs no protocol', () => {
    // `@estiva-app/ui/editor`'s `UnknownBlock` draws `attrs.text`; the ui
    // package does not depend on this one.
    const node = toEditorDocument(withWidget).content[1]
    assert.equal(node.type, 'unknownBlock')
    assert.equal(node.attrs?.text, 'a widget no editor can draw')
    assert.equal(node.attrs?.blockId, 'w1')
  })

  /*
    A table, which the editor learnt in UIG-18.

    The protocol names `table` and not its parts, so the nesting is the
    editor's — ProseMirror's names — and what matters here is that the whole
    shape survives a round trip with every id on it. A row or a cell that was
    re-minted on save would detach any comment anchored to it, which is the
    same failure the attachment block had before SHI-2.
  */
  const table: BlockDocument = {
    type: 'doc',
    content: [
      {
        type: 'table',
        id: 't1',
        content: [
          {
            type: 'tableRow',
            id: 'r1',
            content: [
              { type: 'tableHeader', id: 'h1', content: [{ type: 'paragraph', id: 'hp1', content: [{ type: 'text', text: 'Stage' }] }] },
              { type: 'tableHeader', id: 'h2', content: [{ type: 'paragraph', id: 'hp2', content: [{ type: 'text', text: 'Who' }] }] },
            ],
          },
          {
            type: 'tableRow',
            id: 'r2',
            content: [
              { type: 'tableCell', id: 'c1', content: [{ type: 'paragraph', id: 'cp1', content: [{ type: 'text', text: 'Cut-over' }] }] },
              { type: 'tableCell', id: 'c2', content: [{ type: 'paragraph', id: 'cp2', content: [{ type: 'text', text: 'Ada' }] }] },
            ],
          },
        ],
      },
    ],
  }

  it('round-trips a table, every row, cell and id', () => {
    assert.deepEqual(fromEditorDocument(toEditorDocument(table)), table)
  })

  it('opens a table as editable nodes rather than one opaque block', () => {
    const node = toEditorDocument(table).content[0]
    assert.equal(node.type, 'table')
    assert.equal(node.content?.[0].type, 'tableRow')
    assert.equal(node.content?.[0].content?.[0].type, 'tableHeader')
  })
})

describe('the two spellings that differ', () => {
  it('moves a reference between a mark and an atom, and back', () => {
    const uri = 'nostr:naddr1qqjxzde5xfjnvdee943kzwrr956rswr995uxgd3s95unsvekvd3ns'
    const stored: BlockDocument = {
      type: 'doc',
      content: [
        {
          type: 'paragraph',
          id: 'p1',
          content: [
            { type: 'text', text: 'see ' },
            { type: 'text', text: uri, marks: [{ type: 'reference', attrs: { uri } }] },
          ],
        },
      ],
    }
    const editing = toEditorDocument(stored)
    // An atom in the editor: its text is the URI, so there is no prose in it
    // to keep editable, and it can be drawn as the thing it points at.
    assert.deepEqual(editing.content[0].content?.[1], { type: 'reference', attrs: { uri, marks: [] } })
    assert.deepEqual(fromEditorDocument(editing), stored)
  })

  it('keeps a bold reference bold', () => {
    const uri = 'nostr:npub1vankwem8vankwem8vankwem8vankwem8vankwem8vankwem8vankwem8v'
    const stored: BlockDocument = {
      type: 'doc',
      content: [
        {
          type: 'paragraph',
          id: 'p1',
          content: [{ type: 'text', text: uri, marks: [{ type: 'bold' }, { type: 'reference', attrs: { uri } }] }],
        },
      ],
    }
    assert.deepEqual(fromEditorDocument(toEditorDocument(stored)), stored)
  })

  it('moves a line break between a `\\n` and a hardBreak, and back', () => {
    const stored: BlockDocument = {
      type: 'doc',
      content: [{ type: 'paragraph', id: 'p1', content: [{ type: 'text', text: 'one\ntwo' }] }],
    }
    const editing = toEditorDocument(stored)
    assert.deepEqual(editing.content[0].content?.map((n) => n.type), ['text', 'hardBreak', 'text'])
    assert.deepEqual(fromEditorDocument(editing), stored)
  })

  it('unwraps a list item from the paragraph ProseMirror needs around it', () => {
    /*
      §13.3's list item holds inline runs and ProseMirror's holds blocks. It
      matters because `RichText` draws a list item's *inline* content — a list
      item that came back holding a paragraph would render as an empty bullet.
    */
    const stored = parseBlockDocument(reopen('- one\n- two').value)
    const editing = toEditorDocument(stored)
    assert.equal(editing.content[0].content?.[0].content?.[0].type, 'paragraph')
    assert.deepEqual(fromEditorDocument(editing), stored)
  })

  it('unwraps a quote the same way, and keeps its text', () => {
    /*
      Found 30 September: the quote's text sits in a paragraph inside the
      quote in ProseMirror, and was read off the quote itself — so a quote
      typed into a description or a message saved empty.
    */
    const stored = parseBlockDocument(reopen('> quoted').value)
    const editing = toEditorDocument(stored)
    assert.equal(editing.content[0].type, 'blockquote')
    assert.equal(editing.content[0].content?.[0].type, 'paragraph')
    assert.deepEqual(fromEditorDocument(editing), stored)

    // Typed in the editor: two paragraphs in one quote are two lines of it.
    const typed: EditorDocument = { type: 'doc', content: [{ type: 'blockquote', content: [{ type: 'paragraph', content: [{ type: 'text', text: 'one' }] }, { type: 'paragraph', content: [{ type: 'text', text: 'two' }] }] }] }
    const saved = fromEditorDocument(typed)
    assert.equal(saved.content[0].type, 'blockquote')
    assert.ok(JSON.stringify(saved.content[0].content).includes('one'))
    assert.ok(JSON.stringify(saved.content[0].content).includes('two'))
  })

  it('keeps a fence literal, newlines and all', () => {
    const stored = parseBlockDocument(reopen('```\nconst a = 1\nconst b = 2\n```').value)
    assert.deepEqual(fromEditorDocument(toEditorDocument(stored)), stored)
  })
})

describe('what a person sees is what is stored', () => {
  it('produces the same block ids the reader addresses', () => {
    /*
      RIC-9's shape, guarded: two surfaces meant to match with nothing making
      them. `RichText` puts `data-block-id` on each block and the editor puts
      the same id in `attrs.blockId`, so a comment anchored from the reading
      surface addresses the block the editor is about to save.
    */
    const stored = reopen('# T\n\none').value
    const editing = open(stored, 'blocks')
    assert.deepEqual(editing.content.map((n) => n.attrs?.blockId), idsOf(stored))
  })
})

/*
  A file in a document — SPEC §13.3's `attachment` block, SHI-2.

  Until SHI-2 this block was parked as an `unknownBlock`: preserved, never
  produced. Now the editor has a node for it, which moves it out of the
  "carried whole" path and into the converted one — so the questions are the
  converted path's questions. An attribute the schema forgets to declare is
  dropped by ProseMirror and vanishes on save, and that is silent.
*/
const SHA = 'f'.repeat(64)
const attachment = (attrs: Record<string, unknown>, id = 'b2') => ({ type: 'attachment', id, attrs })
const FILE = { url: `/media/${SHA}.png`, m: 'image/png', x: SHA, size: 4096 }

describe('a file in a document', () => {
  it('opens as an editable node rather than an opaque block', () => {
    const doc: BlockDocument = { type: 'doc', content: [attachment(FILE)] }
    const [node] = toEditorDocument(doc).content
    assert.equal(node.type, 'attachment')
    assert.deepEqual(node.attrs, { ...FILE, blockId: 'b2' })
  })

  it('round-trips every imeta field, which is the one that fails silently', () => {
    const rich = { ...FILE, dim: '800x600', thumb: `/media/${SHA}.thumb.jpg`, filename: 'shot.png', alt: 'a screenshot' }
    const doc: BlockDocument = { type: 'doc', content: [attachment(rich)] }
    const back = fromEditorDocument(toEditorDocument(doc))
    assert.deepEqual(back.content[0].attrs, rich)
  })

  it('keeps the block id, so a comment anchored to the file still resolves', () => {
    const doc: BlockDocument = { type: 'doc', content: [attachment(FILE, 'anchored')] }
    assert.equal(fromEditorDocument(toEditorDocument(doc)).content[0].id, 'anchored')
  })

  /*
    A ProseMirror attribute that was never set is `null`. §13.3's optional
    fields are *absent*, and `imetaTag` would serialise `thumb null` into a tag
    the relay then refuses — taking down a document that looked fine in the
    editor.
  */
  it('writes no null for an optional field the file does not have', () => {
    const doc: BlockDocument = { type: 'doc', content: [attachment(FILE)] }
    const editing = toEditorDocument(doc)
    // What ProseMirror hands back for the attributes the schema declares and the file lacks.
    Object.assign(editing.content[0].attrs!, { dim: null, thumb: null, alt: null, filename: null })
    const attrs = fromEditorDocument(editing).content[0].attrs ?? {}
    assert.deepEqual(Object.keys(attrs).sort(), ['m', 'size', 'url', 'x'])
    assert.ok(!JSON.stringify(attrs).includes('null'))
  })

  it('publishes as a block document, so the format tag is on the event', () => {
    const doc: BlockDocument = { type: 'doc', content: [attachment(FILE)] }
    const { value, contentFormat } = publishableFromEditor(toEditorDocument(doc))
    assert.equal(contentFormat, 'estiva-blocks-1')
    assert.equal(parseBlockDocument(value).content[0].type, 'attachment')
  })

  it('survives beside the text it was dropped into', () => {
    const doc: BlockDocument = {
      type: 'doc',
      content: [
        { type: 'paragraph', id: 'b1', content: [{ type: 'text', text: 'look at this' }] },
        attachment(FILE),
        { type: 'paragraph', id: 'b3', content: [{ type: 'text', text: 'and that' }] },
      ],
    }
    const back = fromEditorDocument(toEditorDocument(doc))
    assert.deepEqual(back.content.map((b) => b.type), ['paragraph', 'attachment', 'paragraph'])
  })
})

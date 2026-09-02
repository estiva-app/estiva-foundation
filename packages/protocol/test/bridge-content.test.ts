/**
 * The bridge between §13's two serialisations.
 *
 * The id carry-forward is what these tests are really about. Everything else
 * here is shape; that one is the difference between a comment anchor that
 * survives an edit and one that silently detaches, which is RIC-7's whole
 * subject and unobservable from the outside once it goes wrong.
 */
import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import {
  blockDocumentToMarkerText,
  blockIds,
  markerTextToBlockDocument,
  parseInlineMarks,
  toRenderTree,
  validateBlockDocument,
  type BlockDocument,
  type InlineMarkSpan,
} from '../dist/index.js'

const idsOf = (doc: BlockDocument) => doc.content.map((b) => b.id)

describe('marker text becomes a block document', () => {
  it('turns each construct into its block', () => {
    const doc = markerTextToBlockDocument('# Title\n\npara\n\n- a\n- b\n\n> quoted\n\n```ts\ncode\n```')
    assert.deepEqual(doc.content.map((b) => b.type), [
      'heading', 'paragraph', 'bulletList', 'blockquote', 'codeBlock',
    ])
    assert.equal(doc.content[0].attrs?.level, 1)
    assert.equal(doc.content[4].attrs?.language, 'ts')
  })

  it('is a valid document, ids and all', () => {
    const doc = markerTextToBlockDocument('# T\n\n- a\n- b')
    assert.deepEqual(validateBlockDocument(doc), [])
    // Nested list items are blocks too, so they need ids of their own.
    assert.equal(blockIds(doc).length, 4)
    assert.ok(blockIds(doc).every((id) => id.length >= 8))
  })

  it('carries the marks through, not just the text', () => {
    const doc = markerTextToBlockDocument('a **bold** and `code`')
    assert.deepEqual(doc.content[0].content, [
      { type: 'text', text: 'a ' },
      { type: 'text', text: 'bold', marks: [{ type: 'bold' }] },
      { type: 'text', text: ' and ' },
      { type: 'text', text: 'code', marks: [{ type: 'code' }] },
    ])
  })
})

describe('ids carry across an edit — the anchoring guarantee', () => {
  const original = markerTextToBlockDocument('# Title\n\nfirst\n\nsecond')

  it('editing one block leaves every other id alone', () => {
    const edited = markerTextToBlockDocument('# Title\n\nfirst, edited\n\nsecond', original)
    const before = idsOf(original)
    const after = idsOf(edited)
    assert.equal(after[0], before[0], 'the heading moved id')
    assert.equal(after[2], before[2], 'the untouched paragraph moved id')
    assert.equal(after[1], before[1], 'the edited paragraph should keep its id by position')
  })

  it('reordering blocks keeps their ids', () => {
    const reordered = markerTextToBlockDocument('# Title\n\nsecond\n\nfirst', original)
    assert.equal(reordered.content[1].id, original.content[2].id)
    assert.equal(reordered.content[2].id, original.content[1].id)
  })

  it('inserting a block does not disturb the others', () => {
    const inserted = markerTextToBlockDocument('# Title\n\nfirst\n\nnew one\n\nsecond', original)
    assert.equal(inserted.content[0].id, original.content[0].id)
    assert.equal(inserted.content[1].id, original.content[1].id)
    assert.equal(inserted.content[3].id, original.content[2].id)
    assert.ok(!idsOf(original).includes(inserted.content[2].id), 'the new block needs a new id')
  })

  it('deleting a block leaves the survivors anchored', () => {
    const deleted = markerTextToBlockDocument('# Title\n\nsecond', original)
    assert.deepEqual(idsOf(deleted), [original.content[0].id, original.content[2].id])
  })

  it('never reuses one id twice', () => {
    const doc = markerTextToBlockDocument('same\n\nsame\n\nsame', markerTextToBlockDocument('same\n\nsame'))
    assert.equal(new Set(idsOf(doc)).size, 3)
  })

  it('with no previous document, every id is fresh', () => {
    const a = markerTextToBlockDocument('one\n\ntwo')
    const b = markerTextToBlockDocument('one\n\ntwo')
    assert.notDeepEqual(idsOf(a), idsOf(b))
  })

  /*
    The documented limit. A block moved AND edited in one save matches neither
    pass, so its anchor breaks. Asserted so the rule's cost is visible in the
    suite rather than only in the prose — if a later change makes this pass,
    the header is out of date.
  */
  it('does NOT survive a block being moved and edited at once', () => {
    const moved = markerTextToBlockDocument('# Title\n\nsecond\n\nfirst, edited', original)
    assert.ok(!idsOf(original).includes(moved.content[2].id))
  })
})

describe('a block document goes back to marker text', () => {
  it('round-trips every construct the dialect can spell', () => {
    const text = '# Title\n\npara with **bold**\n\n- a\n- b\n\n1. one\n2. two\n\n> quoted\n\n```ts\ncode\n```'
    const doc = markerTextToBlockDocument(text)
    assert.equal(blockDocumentToMarkerText(doc), text)
  })

  it('is stable — a second pass changes nothing', () => {
    const once = blockDocumentToMarkerText(markerTextToBlockDocument('# T\n\n- a\n\nplain'))
    const twice = blockDocumentToMarkerText(markerTextToBlockDocument(once))
    assert.equal(twice, once)
  })

  it("keeps a list's own starting number, rather than renumbering what somebody wrote", () => {
    // One real body in the corpus has two numbered runs split by a paragraph,
    // the second written as `2.` to continue the first. Ship rendered it as `1.`
    // long before any of this — the round trip is what made it visible.
    const text = '1. first\n\nbetween\n\n2. second'
    const doc = markerTextToBlockDocument(text)
    assert.equal(doc.content[2].attrs?.start, 2)
    assert.equal(blockDocumentToMarkerText(doc), text)
    assert.equal(toRenderTree(text, 'marker')[2].start, 2)
  })

  it('carries no start when the list begins at 1', () => {
    const doc = markerTextToBlockDocument('1. a\n2. b')
    assert.equal(doc.content[0].attrs?.start, undefined)
    assert.equal(toRenderTree('1. a\n2. b', 'marker')[0].start, undefined)
  })

  it('degrades a block the dialect cannot spell to its text, rather than dropping it', () => {
    const doc: BlockDocument = {
      type: 'doc',
      content: [{ type: 'table', id: 't1', content: [{ type: 'text', text: 'a | b' }] }],
    }
    assert.equal(blockDocumentToMarkerText(doc), 'a | b')
  })
})

// The corpus, which is what any of this has to survive.

const corpus = JSON.parse(
  readFileSync(new URL('./corpus-bodies.json', import.meta.url), 'utf8'),
) as { bodies: string[] }

const marksPerChar = (line: string) => {
  const out: string[] = []
  for (const s of parseInlineMarks(line) as InlineMarkSpan[]) {
    const key = [s.bold && 'b', s.italic && 'i', s.underline && 'u', s.code && 'c'].filter(Boolean).join('')
    for (const ch of s.text) if (!/\s/.test(ch)) out.push(`${ch}:${key}`)
  }
  return out
}

describe('152 real published bodies survive the round trip', () => {
  it('every one becomes a valid block document', () => {
    for (const body of corpus.bodies) {
      const doc = markerTextToBlockDocument(body)
      assert.deepEqual(validateBlockDocument(doc), [], `invalid: ${JSON.stringify(body.slice(0, 70))}`)
    }
  })

  it('no character changes its marks going through blocks and back', () => {
    for (const body of corpus.bodies) {
      const back = blockDocumentToMarkerText(markerTextToBlockDocument(body))
      assert.deepEqual(marksPerChar(back), marksPerChar(body), `marks moved: ${JSON.stringify(body.slice(0, 70))}`)
    }
  })

  it('renders the same either way — the reader cannot tell which model it came from', () => {
    for (const body of corpus.bodies) {
      const asMarker = toRenderTree(body, 'marker')
      const asBlocks = toRenderTree(JSON.stringify(markerTextToBlockDocument(body)), 'blocks')
      const shape = (bs: ReturnType<typeof toRenderTree>): unknown =>
        bs.map((b) => ({ type: b.type, level: b.level, inline: b.inline, children: b.children && shape(b.children) }))
      assert.deepEqual(shape(asBlocks), shape(asMarker), `differs: ${JSON.stringify(body.slice(0, 70))}`)
    }
  })

  it('re-saving an unchanged body changes no id', () => {
    for (const body of corpus.bodies.slice(0, 40)) {
      const first = markerTextToBlockDocument(body)
      const again = markerTextToBlockDocument(body, first)
      assert.deepEqual(idsOf(again), idsOf(first), `ids moved: ${JSON.stringify(body.slice(0, 70))}`)
    }
  })
})

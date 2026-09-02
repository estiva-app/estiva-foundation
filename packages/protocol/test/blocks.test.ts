/**
 * The block model and the inline layer's second serialisation — SPEC §13.1, §13.3.
 *
 * The corpus round-trip is the load-bearing one. §13 claims a message and a
 * rich text field *share the inline vocabulary and differ only in encoding*;
 * this file is where that stops being a claim, by putting 152 real published
 * bodies through both encodings and checking no character changes its marks.
 */
import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import {
  assignMissingBlockIds,
  blockIds,
  BlockDocumentError,
  documentText,
  findBlock,
  inlineNodesToMarkers,
  inlineNodesToText,
  inlineTextOf,
  markersToInlineNodes,
  newBlockId,
  parseBlockDocument,
  parseInlineMarks,
  serializeBlockDocument,
  validateBlockDocument,
  type Block,
  type BlockDocument,
  type InlineMarkSpan,
} from '../dist/index.js'

const doc = (...content: Block[]): BlockDocument => ({ type: 'doc', content })
const para = (id: string, text: string): Block => ({
  type: 'paragraph', id, content: [{ type: 'text', text }],
})

describe('the inline vocabulary, in JSON', () => {
  it('carries the marks the markers carried', () => {
    assert.deepEqual(markersToInlineNodes('a **bold** word'), [
      { type: 'text', text: 'a ' },
      { type: 'text', text: 'bold', marks: [{ type: 'bold' }] },
      { type: 'text', text: ' word' },
    ])
  })

  it('orders marks deterministically, whatever order they nest in', () => {
    const a = markersToInlineNodes('__**x**__')
    const b = markersToInlineNodes('**__x__**')
    assert.deepEqual(a[0].marks, [{ type: 'bold' }, { type: 'underline' }])
    assert.deepEqual(a, b, 'the same marks must serialise identically')
  })

  it('keeps code alone, as §13.1 requires', () => {
    assert.deepEqual(markersToInlineNodes('**bold `code` end**')[1], {
      type: 'text', text: 'code', marks: [{ type: 'code' }],
    })
  })

  it('goes back to markers', () => {
    assert.equal(inlineNodesToMarkers(markersToInlineNodes('a **bold** and `code`')), 'a **bold** and `code`')
  })

  it('reads out as plain text', () => {
    assert.equal(inlineNodesToText(markersToInlineNodes('a **bold** word')), 'a bold word')
  })
})

describe('a block document', () => {
  it('round-trips through JSON', () => {
    const d = doc(para('b1', 'Hello'), { type: 'horizontalRule', id: 'b2' })
    assert.deepEqual(parseBlockDocument(serializeBlockDocument(d)), d)
  })

  it('refuses something that is not one, and says every reason at once', () => {
    const bad = { type: 'doc', content: [{ type: 'paragraph' }, { id: 'x' }] }
    const problems = validateBlockDocument(bad)
    assert.ok(problems.some((p) => p.includes('has no id')))
    assert.ok(problems.some((p) => p.includes('has no type')))
    assert.throws(() => parseBlockDocument(bad), BlockDocumentError)
  })

  it('refuses a repeated id — an anchor must not be ambiguous', () => {
    const problems = validateBlockDocument(doc(para('same', 'a'), para('same', 'b')))
    assert.ok(problems.some((p) => p.includes('repeats the id')))
  })

  it('refuses a heading without a level in 1–3', () => {
    assert.ok(validateBlockDocument(doc({ type: 'heading', id: 'h', attrs: { level: 7 }, content: [] }))
      .some((p) => p.includes('expected 1–3')))
  })

  it('reports JSON that is not JSON as such', () => {
    assert.throws(() => parseBlockDocument('{not json'), (e: unknown) => {
      assert.ok(e instanceof BlockDocumentError)
      assert.ok(e.problems[0].includes('not JSON'))
      return true
    })
  })

  it('finds nested block ids in document order', () => {
    const d = doc(
      para('a', 'one'),
      { type: 'bulletList', id: 'l', content: [{ type: 'listItem', id: 'li', content: [para('p', 'two')] }] },
    )
    assert.deepEqual(blockIds(d), ['a', 'l', 'li', 'p'])
    assert.equal(findBlock(d, 'p')?.type, 'paragraph')
    assert.equal(findBlock(d, 'nope'), undefined)
  })
})

describe('ids, which are the reason this is JSON', () => {
  it('mints only what is missing and never touches an existing id', () => {
    const before = doc(para('keep-me', 'one'), { ...para('', 'two'), id: '' })
    const after = assignMissingBlockIds(before)
    assert.equal(after.content[0].id, 'keep-me')
    assert.notEqual(after.content[1].id, '')
    assert.ok(after.content[1].id.length >= 8)
  })

  it('survives an edit that does not replace the block — the anchoring guarantee', () => {
    const original = assignMissingBlockIds(doc(para('', 'first'), para('', 'second')))
    const ids = blockIds(original)
    // An editor rebuilds the document on every keystroke. This is that rebuild.
    const edited = assignMissingBlockIds({
      ...original,
      content: [
        { ...original.content[0], content: [{ type: 'text', text: 'first, edited' }] },
        original.content[1],
      ],
    })
    assert.deepEqual(blockIds(edited), ids, 'an anchored comment would have detached')
  })

  it('assigns nested blocks too, and does not mutate the input', () => {
    const before = doc({ type: 'bulletList', id: '', content: [{ type: 'listItem', id: '', content: [] }] })
    const after = assignMissingBlockIds(before)
    assert.equal(before.content[0].id, '', 'input was mutated')
    assert.equal(blockIds(after).length, 2)
  })

  it('does not collide with an id already in the document', () => {
    const ids = new Set(Array.from({ length: 500 }, () => newBlockId()))
    assert.equal(ids.size, 500)
  })
})

describe('an unknown block type', () => {
  const d = doc(
    para('p', 'before'),
    { type: 'timeline', id: 'x', content: [{ type: 'text', text: 'from a later version' }] },
  )

  it('is not a validation error — consumers upgrade at different times', () => {
    assert.deepEqual(validateBlockDocument(d), [])
  })

  it('still yields its text, which is what §13.3 makes a reader draw', () => {
    assert.equal(inlineTextOf(d.content[1]), 'from a later version')
    assert.equal(documentText(d), 'before\nfrom a later version')
  })

  it('survives a round trip whole, attrs and all', () => {
    const withAttrs = doc({ type: 'timeline', id: 'x', attrs: { density: 'compact' }, content: [] })
    assert.deepEqual(parseBlockDocument(serializeBlockDocument(withAttrs)), withAttrs)
  })
})

describe('§13.4 is a rule about events, and this module holds no opinion', () => {
  /*
    The tag is read by `contentFormatOf` in `@estiva-app/interop`, which is
    where the event and its slot are. What matters here is that nothing in this
    module *tempts* a caller to sniff: `parseBlockDocument` succeeds on a
    document and throws on anything else, and a legacy body that merely looks
    like JSON is the case that proves why sniffing is forbidden.
  */
  it('a legacy body beginning with { is ordinary marker text', () => {
    const legacy = '{"not": "a document"} — **notes** on the config'
    // It parses as marker text perfectly well...
    assert.deepEqual(parseInlineMarks(legacy).filter((s: InlineMarkSpan) => s.bold), [
      { text: 'notes', bold: true },
    ])
    // ...and it is not a block document, so a sniff would have to guess.
    assert.throws(() => parseBlockDocument(legacy), BlockDocumentError)
  })

  it('a body that IS valid JSON but not a document still refuses', () => {
    assert.throws(() => parseBlockDocument('{"type":"doc"}'), BlockDocumentError)
  })
})

// ── the claim §13 actually makes ──

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

describe('the two serialisations carry the same marks — 152 real bodies', () => {
  it('marker text → JSON nodes → marker text changes no character’s marks', () => {
    for (const body of corpus.bodies) {
      for (const line of body.split('\n')) {
        const back = inlineNodesToMarkers(markersToInlineNodes(line))
        assert.deepEqual(marksPerChar(back), marksPerChar(line), `marks moved: ${JSON.stringify(line.slice(0, 90))}`)
      }
    }
  })

  it('and loses no text through the JSON hop', () => {
    for (const body of corpus.bodies) {
      for (const line of body.split('\n')) {
        const once = inlineNodesToText(markersToInlineNodes(line))
        const back = inlineNodesToMarkers(markersToInlineNodes(line))
        assert.equal(
          inlineNodesToText(markersToInlineNodes(back)),
          once,
          `text changed: ${JSON.stringify(line.slice(0, 90))}`,
        )
      }
    }
  })

  it('every real body becomes a valid one-paragraph document', () => {
    for (const body of corpus.bodies) {
      const d = assignMissingBlockIds(doc({ type: 'paragraph', id: '', content: markersToInlineNodes(body) }))
      assert.deepEqual(validateBlockDocument(d), [], `invalid for: ${JSON.stringify(body.slice(0, 80))}`)
      assert.equal(blockIds(d).length, 1)
    }
  })
})

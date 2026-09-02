/**
 * The resolved tree — SPEC §13.5.
 *
 * The point of this module is that an app receives nothing it has to
 * interpret. The corpus test at the bottom is what checks that claim: over 152
 * real published bodies, **every character of output comes from the input**.
 * A renderer that invented a character would be a renderer that could invent a
 * tag.
 */
import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import {
  assignMissingBlockIds,
  renderTreeText,
  serializeBlockDocument,
  toRenderTree,
  type BlockDocument,
  type RenderBlock,
} from '../dist/index.js'

describe('marker text resolves to the tree', () => {
  it('paragraphs, and a newline is the line break', () => {
    assert.deepEqual(toRenderTree('one\ntwo', 'marker'), [
      { type: 'paragraph', inline: [{ text: 'one\ntwo', marks: [] }] },
    ])
  })

  it('marks arrive decided', () => {
    assert.deepEqual(toRenderTree('a **b** c', 'marker')[0].inline, [
      { text: 'a ', marks: [] },
      { text: 'b', marks: ['bold'] },
      { text: ' c', marks: [] },
    ])
  })

  it('headings, quotes, lists and fences', () => {
    assert.equal(toRenderTree('# Big', 'marker')[0].level, 1)
    assert.equal(toRenderTree('> quoted', 'marker')[0].type, 'blockquote')
    const list = toRenderTree('- a\n- b', 'marker')[0]
    assert.equal(list.type, 'bulletList')
    assert.equal(list.children?.length, 2)
    assert.equal(list.children?.[0].type, 'listItem')
    const fence = toRenderTree('```ts\nconst a = 1\n```', 'marker')[0]
    assert.equal(fence.type, 'codeBlock')
    assert.equal(fence.language, 'ts')
    assert.deepEqual(fence.inline, [{ text: 'const a = 1', marks: [] }])
  })

  it('gives a marker body no block ids, because it has no addressable sub-unit', () => {
    for (const block of toRenderTree('# h\n\npara\n\n- x', 'marker')) {
      assert.equal(block.id, undefined)
    }
  })
})

describe('a block document resolves to the same tree', () => {
  const doc = (content: BlockDocument['content']): string =>
    serializeBlockDocument(assignMissingBlockIds({ type: 'doc', content }))

  it('carries the block id through, which marker text cannot', () => {
    const json = doc([{ type: 'paragraph', id: 'anchor-me', content: [{ type: 'text', text: 'hi' }] }])
    const [block] = toRenderTree(json, 'blocks')
    assert.equal(block.id, 'anchor-me')
    assert.deepEqual(block.inline, [{ text: 'hi', marks: [] }])
  })

  it('reads heading level and code language out of attrs', () => {
    const json = doc([
      { type: 'heading', id: 'h', attrs: { level: 2 }, content: [{ type: 'text', text: 'T' }] },
      { type: 'codeBlock', id: 'c', attrs: { language: 'rust' }, content: [{ type: 'text', text: 'fn main(){}' }] },
    ])
    const [h, c] = toRenderTree(json, 'blocks')
    assert.equal(h.level, 2)
    assert.equal(c.language, 'rust')
  })

  it('nests children', () => {
    const json = doc([
      { type: 'bulletList', id: 'l', content: [{ type: 'listItem', id: 'li', content: [{ type: 'text', text: 'one' }] }] },
    ])
    const [list] = toRenderTree(json, 'blocks')
    assert.equal(list.children?.[0].id, 'li')
  })

  it('keeps an unknown type visible, named, and readable', () => {
    const json = doc([{ type: 'timeline', id: 't', content: [{ type: 'text', text: 'from later' }] }])
    const [block] = toRenderTree(json, 'blocks')
    assert.equal(block.type, 'unknown')
    assert.equal(block.typeName, 'timeline')
    assert.deepEqual(block.inline, [{ text: 'from later', marks: [] }])
  })
})

describe('the formats a reader must not guess at', () => {
  it('renders an unknown format as its own plain text — §13.5', () => {
    const body = '{"type":"doc","content":[]}'
    assert.deepEqual(toRenderTree(body, 'unknown'), [
      { type: 'paragraph', inline: [{ text: body, marks: [] }] },
    ])
  })

  it('renders a legacy {-leading body as marker text, marks and all', () => {
    // §13.4's own example. The format came from the tag; the body looking like
    // JSON is exactly the coincidence that must not change the answer.
    const [block] = toRenderTree('{"a":1} and **bold**', 'marker')
    assert.deepEqual(block.inline?.at(-1), { text: 'bold', marks: ['bold'] })
  })

  it('degrades a mis-tagged body rather than throwing', () => {
    // A `blocks` tag on something that is not a document. Throwing renders an
    // empty field, which looks identical to a description nobody wrote.
    assert.deepEqual(toRenderTree('not a document', 'blocks'), [
      { type: 'paragraph', inline: [{ text: 'not a document', marks: [] }] },
    ])
  })

  it('renders an empty body as nothing at all', () => {
    for (const f of ['marker', 'blocks', 'unknown'] as const) {
      assert.deepEqual(toRenderTree('', f), [])
    }
  })
})

// ── the safety claim ──

const corpus = JSON.parse(
  readFileSync(new URL('./corpus-bodies.json', import.meta.url), 'utf8'),
) as { bodies: string[] }

const everyInline = (blocks: readonly RenderBlock[]): string[] =>
  blocks.flatMap((b) => [...(b.inline ?? []).map((i) => i.text), ...everyInline(b.children ?? [])])

describe('nothing is invented — 152 real published bodies', () => {
  it('every character of output came from the input', () => {
    for (const body of corpus.bodies) {
      for (const text of everyInline(toRenderTree(body, 'marker'))) {
        for (const line of text.split('\n')) {
          assert.ok(
            body.includes(line),
            `output not present in input: ${JSON.stringify(line.slice(0, 80))}`,
          )
        }
      }
    }
  })

  it('resolves every body without throwing, in all three formats', () => {
    for (const body of corpus.bodies) {
      for (const f of ['marker', 'blocks', 'unknown'] as const) toRenderTree(body, f)
    }
  })

  it('an unknown format never loses a character, which is what makes it safe', () => {
    for (const body of corpus.bodies) {
      assert.equal(renderTreeText(toRenderTree(body, 'unknown')), body)
    }
  })
})

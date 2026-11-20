/**
 * A document comes back as it went in (TES-3).
 *
 * A message, a description and a page are each a block document (SPEC §13.3),
 * and each takes a trip: a message and a description are edited as text and
 * read back, and every document is opened in an editor and saved. Each trip
 * must give back the same document. Each rule is tried on thousands of
 * documents `@estiva-app/protocol/testing` makes up: headings, lists nested
 * up to three deep, checklists, callouts, tables, code, rules, links on words,
 * mentions, pictures and blocks from a later version, with bold, italic,
 * underline and code on some words.
 *
 * Text carries no block ids, so a trip through text compares the document
 * without them (`documentShape`); the editor's trip keeps them, so it compares
 * everything.
 *
 * What text cannot carry is not made up here, and is listed with its reason
 * in `document-trips.md` beside this file.
 *
 * A failure prints the smallest document that breaks the rule and the seed
 * that replays it: `FC_SEED=<seed> npm test -w packages/protocol`.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import fc from 'fast-check'
import { documentArb, documentShape, runSettings } from '@estiva-app/protocol/testing'
import {
  blockDocumentToMarkerText,
  descriptionTextToBlockDocument,
  fromEditorDocument,
  markerTextToBlockDocument,
  parseBlockDocument,
  serializeBlockDocument,
  tableToDescriptionText,
  toEditorDocument,
  type BlockDocument,
} from '../dist/index.js'

// 1,000 documents a rule (measured 20 Nov 2026: about 0.5 s a rule).
const settings = runSettings(1000)
console.log(`fast-check seed ${settings.seed}, ${settings.numRuns} runs per rule`)

/** A description as the agent and a markdown paste write it: one chunk per block, a blank line apart, a table as GFM. */
const descriptionText = (doc: BlockDocument) =>
  doc.content
    .map((block) => (block.type === 'table' ? tableToDescriptionText(block) : undefined) ?? blockDocumentToMarkerText({ type: 'doc', content: [block] }, { description: true }))
    .join('\n\n')

test('a document goes on the wire and reads back the same, ids and all', () => {
  fc.assert(
    fc.property(documentArb(), (doc) => {
      assert.deepEqual(parseBlockDocument(serializeBlockDocument(doc)), doc)
    }),
    settings,
  )
})

test('a message turned into text and read back is the same message', () => {
  fc.assert(
    fc.property(documentArb({ form: 'message' }), (doc) => {
      const text = blockDocumentToMarkerText(doc)
      assert.deepEqual(documentShape(markerTextToBlockDocument(text)), documentShape(doc), `text:\n${text}`)
    }),
    settings,
  )
})

test('a description turned into text and read back is the same description', () => {
  fc.assert(
    fc.property(documentArb({ form: 'description' }), (doc) => {
      const text = descriptionText(doc)
      assert.deepEqual(documentShape(descriptionTextToBlockDocument(text)), documentShape(doc), `text:\n${text}`)
    }),
    settings,
  )
})

test('a description read back over itself keeps every top-level id', () => {
  fc.assert(
    fc.property(documentArb({ form: 'description' }), (doc) => {
      const again = descriptionTextToBlockDocument(descriptionText(doc), doc)
      assert.deepEqual(
        again.content.map((b) => b.id),
        doc.content.map((b) => b.id),
      )
    }),
    settings,
  )
})

test('a document opened in the editor and saved is the same document, ids and all', () => {
  fc.assert(
    fc.property(documentArb({ form: 'editor' }), (doc) => {
      const back = fromEditorDocument(toEditorDocument(doc, { links: true }))
      assert.deepEqual(documentShape(back, { ids: true }), documentShape(doc, { ids: true }))
    }),
    settings,
  )
})

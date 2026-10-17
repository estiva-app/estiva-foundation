/*
  COMM-2: what the shared comment box holds, as the message it writes, and
  back — for an edit and a draft. The box is @estiva-app/ui/editor's; these
  are the bytes every app's send puts on the wire.
*/
import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { encodeNpub } from '@estiva-app/protocol'
import {
  composerDocument,
  composerDraft,
  composerText,
  createDraftStore,
  messageReference,
  urgentTagsFor,
  withoutNewUrgency,
} from '../dist/index.js'

const BOB = 'b'.repeat(64)
const CAT = 'c'.repeat(64)
const MSG = 'd'.repeat(64)
const NPUB_BOB = `nostr:${encodeNpub(BOB)}`
const NPUB_CAT = `nostr:${encodeNpub(CAT)}`
const NEVENT = messageReference(MSG, 9)

const paragraph = (...content: unknown[]) => ({ type: 'doc', content: [{ type: 'paragraph', content }] }) as never
const text = (value: string) => ({ type: 'text', text: value })
const mention = (pubkey: string | null, label: string, urgent = false) => ({ type: urgent ? 'urgentMention' : 'mention', attrs: { id: pubkey ?? label, label, pubkey } })
const captioned = (uri: string, label: string, snippet: string) => ({ type: 'captionedReference', attrs: { id: uri, label, snippet, uri } })

/** Every inline node of a document's first paragraph, as `type` or `type:label`. */
const inline = (doc: { content: { content?: { type: string; text?: string; attrs?: Record<string, unknown> }[] }[] }) =>
  (doc.content[0].content ?? []).map((n) => (n.type === 'text' ? `text:${n.text}` : n.attrs?.label ? `${n.type}:${n.attrs.label}` : `${n.type}:${n.attrs?.uri}`))

const memory = () => {
  const kept = new Map<string, string>()
  return { getItem: (k: string) => kept.get(k) ?? null, setItem: (k: string, v: string) => void kept.set(k, v), removeItem: (k: string) => void kept.delete(k) }
}

describe('composerText: what a send writes from the box', () => {
  it('writes a person by key, a keyless one by name, and a message by its nevent', () => {
    const doc = paragraph(text('hi '), mention(BOB, 'Bob'), text(' '), mention(null, 'Ann', true), text(' see '), captioned(NEVENT, 'Bob', 'the numbers'))
    assert.deepEqual(composerText(doc), { text: `hi ${NPUB_BOB} !@Ann see ${NEVENT}` })
  })

  it('an urgent chip writes the ordinary npub, and its key comes back for the urgent tag', () => {
    const { text: body, urgent } = composerText(paragraph(mention(BOB, 'Bob', true), text(' and '), mention(CAT, 'Cat'), text(' '), mention(BOB, 'Bob', true)))
    assert.equal(body, `${NPUB_BOB} and ${NPUB_CAT} ${NPUB_BOB}`)
    assert.deepEqual(urgent, [BOB])
    assert.deepEqual(urgentTagsFor(body, urgent), [['urgent', BOB]])
  })

  it('keeps the formatting and trims the ends; a document with no blocks is no text', () => {
    const doc = { type: 'doc', content: [{ type: 'paragraph', content: [text('  '), { type: 'text', text: 'ship', marks: [{ type: 'bold' }] }, text(' it  ')] }] } as never
    assert.equal(composerText(doc).text, '**ship** it')
    assert.deepEqual(composerText({ type: 'doc', content: [] } as never), { text: '' })
  })
})

describe('composerDocument: an edit or a draft opens with chips again', () => {
  const labels = {
    personLabel: (pubkey: string) => (pubkey === BOB ? 'Bob' : undefined),
    referenceCaption: (uri: string) => (uri === NEVENT ? { label: 'Bob', snippet: 'the numbers' } : undefined),
  }

  it('a person and a message come back as the chips they were written from, urgent where it says', () => {
    const doc = composerDocument(`hi ${NPUB_BOB} see ${NEVENT}`, labels, [BOB])
    assert.deepEqual(inline(doc), ['text:hi ', 'urgentMention:Bob', 'text: see ', 'captionedReference:Bob'])
    assert.deepEqual(composerText(doc), { text: `hi ${NPUB_BOB} see ${NEVENT}`, urgent: [BOB] })
  })

  it('what the app cannot name stays a reference, and writes the same text back', () => {
    const doc = composerDocument(`ask ${NPUB_CAT}`, labels)
    assert.deepEqual(inline(doc), ['text:ask ', `reference:${NPUB_CAT}`])
    assert.equal(composerText(doc).text, `ask ${NPUB_CAT}`)
  })
})

describe('withoutNewUrgency: an edit makes nobody newly urgent', () => {
  it('keeps the !@ the message held and writes a new one as @', () => {
    assert.equal(withoutNewUrgency('!@Ann and !@Bob', 'ping !@Ann'), '!@Ann and @Bob')
  })
})

describe('composerDraft: the box’s draft, kept as text', () => {
  it('a draft with an urgent chip comes back urgent, and an empty one is gone', () => {
    const store = createDraftStore(memory())
    const draft = composerDraft(store, 'thread:x', { personLabel: () => 'Bob' })
    draft.write(paragraph(text('for '), mention(BOB, 'Bob', true)))
    assert.deepEqual(store.readDraft('thread:x'), { text: `for ${NPUB_BOB}`, urgent: [BOB] })
    assert.deepEqual(inline(draft.read() as never), ['text:for ', 'urgentMention:Bob'])
    draft.write(paragraph())
    assert.equal(draft.read(), undefined)
  })
})

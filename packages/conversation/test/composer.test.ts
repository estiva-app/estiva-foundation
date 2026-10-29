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
const ISSUE_URL = 'https://ship.estiva.app/issue/one'

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

  it('words a URL was pasted over are sent as a link on those words', () => {
    const linked = (value: string, href: string, marks: unknown[] = []) => ({ type: 'text', text: value, marks: [...marks, { type: 'link', attrs: { href } }] })
    assert.equal(composerText(paragraph(text('see '), linked('the plan', ISSUE_URL), text(' now'))).text, `see [the plan](${ISSUE_URL}) now`)
    assert.equal(composerText(paragraph(linked('the plan', ISSUE_URL, [{ type: 'bold' }]))).text, `**[the plan](${ISSUE_URL})**`)
  })

  it('a link whose words are its URL, or words a marker link cannot hold, keep their words only', () => {
    const linked = (value: string, href: string) => ({ type: 'text', text: value, marks: [{ type: 'link', attrs: { href } }] })
    assert.equal(composerText(paragraph(linked(ISSUE_URL, ISSUE_URL))).text, ISSUE_URL)
    assert.equal(composerText(paragraph(linked('a [b]', ISSUE_URL))).text, 'a [b]')
    const inCode = { type: 'text', text: 'plan', marks: [{ type: 'code' }, { type: 'link', attrs: { href: ISSUE_URL } }] }
    assert.equal(composerText(paragraph(inCode)).text, '`plan`')
  })

  // Katerina, 2026-10-30: "test" typed right after a chip was sent onto its address, which then named nothing.
  describe('a word typed right after a chip', () => {
    const chip = { type: 'reference', attrs: { uri: NEVENT, href: ISSUE_URL } }

    it('is written a space apart from a URL chip, which stays whole', () => {
      assert.equal(composerText(paragraph(chip, text('test'))).text, `${ISSUE_URL} test`)
    })

    it('and from a person or a message by its nostr: address', () => {
      assert.equal(composerText(paragraph(mention(BOB, 'Bob'), text('thanks'))).text, `${NPUB_BOB} thanks`)
      assert.equal(composerText(paragraph(captioned(NEVENT, 'Bob', 'the numbers'), text('again'))).text, `${NEVENT} again`)
    })

    it('two chips side by side are written apart', () => {
      assert.equal(composerText(paragraph(chip, chip)).text, `${ISSUE_URL} ${ISSUE_URL}`)
    })

    it('a space, or a sentence ending, after a chip is written as typed', () => {
      assert.equal(composerText(paragraph(chip, text(' test'))).text, `${ISSUE_URL} test`)
      assert.equal(composerText(paragraph(chip, text(', test'))).text, `${ISSUE_URL}, test`)
      assert.equal(composerText(paragraph(chip, text('.'))).text, `${ISSUE_URL}.`)
    })
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

  it('a link on words opens as the linked words and writes the same text back', () => {
    const written = `see [the plan](${ISSUE_URL}) and ${ISSUE_URL}/[x](${ISSUE_URL})`
    const doc = composerDocument(written, labels) as unknown as { content: { content: { text: string; marks?: { attrs?: { href?: string } }[] }[] }[] }
    const runs = doc.content[0].content.map((n) => (n.marks?.length ? `link:${n.text}>${n.marks[0].attrs?.href}` : `text:${n.text}`))
    assert.deepEqual(runs, ['text:see ', `link:the plan>${ISSUE_URL}`, `text: and ${ISSUE_URL}/[x](${ISSUE_URL})`])
    assert.equal(composerText(doc as never).text, written)
  })

  it('a nested list item opens nested under its item, and writes the same text back (PEE-57)', () => {
    const written = '- Agenda\n  - budget\n- Next steps'
    const doc = composerDocument(written, labels)
    assert.deepEqual(doc.content?.map((b) => b.type), ['bulletList'])
    const [agenda, next] = doc.content?.[0].content ?? []
    assert.deepEqual(agenda.content?.map((b) => b.type), ['paragraph', 'bulletList'])
    assert.equal(agenda.content?.[1].content?.[0].content?.[0].content?.[0].text, 'budget')
    assert.equal(next.content?.[0].content?.[0].text, 'Next steps')
    assert.equal(composerText(doc).text, written)
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

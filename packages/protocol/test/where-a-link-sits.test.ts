/**
 * SPEC §13.2, §13.6.2 — where a link sits decides how it draws in a message
 * (Widgets 2): a chip in a sentence, a row alone on its line, and one file's
 * card under the message by the writer's default. Conformance C21, C26, C27.
 *
 * A reader here does what Peek and Ship do: split each block into lines
 * (`linesOf`), ask what a line is only (`isOnlyReferenceLine`), and draw
 * nothing on a lone line whose value has a card under the message (`cardsIn`).
 */
import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import {
  addrToNaddr,
  buildEdit,
  cardsIn,
  defaultCardOf,
  embedTag,
  embedsOf,
  encodeNevent,
  encodeNpub,
  isFolderValue,
  isOnlyReferenceLine,
  linesOf,
  linksAsReferences,
  toRenderTree,
  urlRunsIn,
  valueOfReference,
  valuesIn,
  withCard,
  type Embed,
  type LinkResolver,
  type RenderBlock,
} from '../dist/index.js'

const PK = 'b38fd2687b17bbde2e8079577cba601936acfe1b731d2d2ba7cdef29a063db46'
const RELAY = 'c4d0b5b1a3f1e2d4c6b8a0f2e4d6c8b0a2f4e6d8c0b2a4f6e8d0c2b4a6f8e0d2'
const ISSUE = `30851:${PK}:f78c3b96-2a3b-4d92-910a-ac25aba672cd`
const PROJECT = `30850:${PK}:15e9b50a-825a-4537-8b4a-df46efb9c7e4`
const PAGE = `30842:${PK}:0b8e7a4c-5d61-4f0e-9a43-2f7c1d3e8b90`
const FOLDER = `39000:${RELAY}:05bebd5b-b699-4bd4-af50-f5377df0fd67`
const MESSAGE = 'd064ad5af7aa5810775d78ef18c8f55efd58e7434e8a93face9c4a860195573a'
const ref = (address: string) => `nostr:${addrToNaddr(address)}`
const messageRef = `nostr:${encodeNevent({ id: MESSAGE, relays: [] })}`
const personRef = `nostr:${encodeNpub(PK)}`
const ISSUE_URL = 'https://ship.estiva.app/issue/f78c3b96-2a3b-4d92-910a-ac25aba672cd'
const resolve: LinkResolver = (url) => (url === ISSUE_URL ? ISSUE : undefined)

const tree = (text: string) => toRenderTree(text, 'marker')

/** What each line of a message draws, as a reader following §13.6.2 would: `row <value>`, `url <url>`, `nothing`, or `sentence`. */
function draw(text: string, embeds: Embed[] = [], parts: { address: string; block: string }[] = []): string[] {
  const blocks = tree(text)
  const carded = new Set([...cardsIn(embeds, blocks, parts, resolve).filter((e) => e.layout !== 'none').map((e) => e.value), ...parts.map((p) => p.address)])
  const out: string[] = []
  const walk = (bs: readonly RenderBlock[]) => {
    for (const block of bs) {
      if (block.inline) {
        for (const line of linesOf(block)) {
          if (line.length === 0) continue
          const only = isOnlyReferenceLine(line, block)
          const value = only && (only.startsWith('nostr:') ? valueOfReference(only) : resolve(only))
          if (!only) out.push('sentence')
          else if (!value) out.push(only.startsWith('nostr:') ? 'row unreadable' : `url ${only}`)
          else if (isFolderValue(value)) out.push('sentence')
          else out.push(carded.has(value) ? 'nothing' : `row ${value}`)
        }
      }
      if (block.children) walk(block.children)
    }
  }
  walk(blocks)
  return out
}

describe('C21 — where a link sits (§13.2, §13.6.2)', () => {
  it('a body that is only a reference, an app URL or a bullet of either draws the row in place and no card', () => {
    assert.deepEqual(draw(ref(ISSUE)), [`row ${ISSUE}`])
    assert.deepEqual(draw(`  ${ISSUE_URL}  `), [`row ${ISSUE}`])
    assert.deepEqual(draw(`- ${ref(ISSUE)}\n1. ${ISSUE_URL}`), [`row ${ISSUE}`, `row ${ISSUE}`])
    assert.deepEqual(cardsIn([], tree(ref(ISSUE))), [], 'a reader never adds a card')
  })

  it('a reference in a sentence, a quote, a heading, a marker, beside a second reference or with trailing punctuation is a chip', () => {
    for (const text of [
      `see ${ref(ISSUE)}`,
      `${ISSUE_URL}.`,
      `**${ref(ISSUE)}**`,
      `${ref(ISSUE)} ${ref(PROJECT)}`,
      `\`${ISSUE_URL}\``,
      `[the issue](${ISSUE_URL})`,
    ]) {
      assert.deepEqual(draw(text), ['sentence'], text)
    }
    assert.equal(isOnlyReferenceLine(linesOf(tree(`> ${ref(ISSUE)}`)[0])[0], { type: 'blockquote' }), undefined)
    assert.equal(isOnlyReferenceLine(linesOf(tree(`## ${ref(ISSUE)}`)[0])[0], { type: 'heading' }), undefined)
  })

  it('each line of a paragraph is its own line', () => {
    assert.deepEqual(draw(`look at this\n${ref(ISSUE)}\nthanks`), ['sentence', `row ${ISSUE}`, 'sentence'])
  })

  it('a person or a Folder alone on its line stays a chip', () => {
    assert.equal(isOnlyReferenceLine(linesOf(tree(personRef)[0])[0], { type: 'paragraph' }), undefined)
    assert.deepEqual(draw(ref(FOLDER)), ['sentence'])
  })

  it('a lone URL that names nothing stays the URL; a lone nostr: reference to something unreadable draws the unreadable row', () => {
    assert.deepEqual(draw('https://example.com/x'), ['url https://example.com/x'])
    assert.deepEqual(draw('nostr:naddr1qqqqqq'), ['row unreadable'])
  })
})

describe('C26 — the card replaces the row (§13.6.2)', () => {
  it('a file with a card or a part under the message draws nothing on its line', () => {
    assert.deepEqual(draw(ref(ISSUE), [{ value: ISSUE, layout: 'detailed' }]), ['nothing'])
    assert.deepEqual(draw(ref(ISSUE), embedsOf({ tags: [['embed', ISSUE, 'huge']] })), ['nothing'], 'an unknown layout is a card')
    assert.deepEqual(draw(ref(PAGE), [], [{ address: PAGE, block: 'b1' }]), ['nothing'])
  })

  it('the chip in a sentence still draws beside the card; ✕ brings the row back', () => {
    const text = `${ref(ISSUE)}\nthe plan is in ${ref(ISSUE)}`
    assert.deepEqual(draw(text, [{ value: ISSUE, layout: 'detailed' }]), ['nothing', 'sentence'])
    assert.deepEqual(draw(ref(ISSUE), withCard([{ value: ISSUE, layout: 'detailed' }], ISSUE, 'none')), [`row ${ISSUE}`])
  })

  it('✕ on one of two old compact cards keeps the other', () => {
    const set: Embed[] = [{ value: ISSUE, layout: 'compact' }, { value: PROJECT, layout: 'compact' }]
    const edit = buildEdit(PK, 1_760_000_000_000, { channelUuid: 'f', targetEventId: MESSAGE, body: `${ref(ISSUE)} and ${ref(PROJECT)}`, embeds: withCard(set, ISSUE, 'none') })
    assert.deepEqual(edit.tags.filter((t) => t[0] === 'embed'), [embedTag(ISSUE, 'none'), embedTag(PROJECT, 'compact')])
    const cards = cardsIn(embedsOf(edit), tree(edit.content)).filter((e) => e.layout !== 'none')
    assert.deepEqual(cards, [{ value: PROJECT, layout: 'compact' }])
  })
})

describe('C27 — the default card (§13.6.2)', () => {
  const named = (text: string) => valuesIn(tree(text), resolve)

  it('one file gets the card, also beside a Folder, a person or a message', () => {
    assert.equal(defaultCardOf(named(ISSUE_URL)), ISSUE)
    assert.equal(defaultCardOf(named(`${ref(ISSUE)} in ${ref(FOLDER)}, ${personRef}, ${messageRef}`)), ISSUE)
  })

  it('two files, or a file and a block link, get none; the part takes no embed', () => {
    assert.equal(defaultCardOf(named(`${ref(ISSUE)} and ${ref(PROJECT)}`)), undefined)
    assert.equal(defaultCardOf(named(`${ref(ISSUE)} and ${ref(PAGE)}`), [{ address: PAGE, block: 'b1' }]), undefined)
    assert.equal(defaultCardOf(named(ref(PAGE)), [{ address: PAGE, block: 'b1' }]), undefined)
  })

  it('a message alone, or the file whose conversation it is, gets none', () => {
    assert.equal(defaultCardOf(named(messageRef)), undefined)
    assert.equal(defaultCardOf(named(ref(ISSUE)), [], { here: ISSUE }), undefined)
  })

  it('an edit adds it only for a file the previous body did not name, and carries the whole set', () => {
    const before = named('no link yet')
    const after = named(`now ${ref(ISSUE)}`)
    const value = defaultCardOf(after, [], { previous: before })
    assert.equal(value, ISSUE)
    const set: Embed[] = [{ value: MESSAGE, layout: 'none' }]
    const edit = buildEdit(PK, 1_760_000_000_000, { channelUuid: 'f', targetEventId: MESSAGE, body: `now ${ref(ISSUE)}`, embeds: withCard(set, value!, 'detailed') })
    assert.deepEqual(edit.tags.filter((t) => t[0] === 'embed'), [embedTag(MESSAGE, 'none'), embedTag(ISSUE, 'detailed')])

    // ✕ before sending wrote no tag: fixing a word leaves the card off.
    assert.equal(defaultCardOf(named(`the ${ref(ISSUE)}`), [], { previous: named(`teh ${ref(ISSUE)}`) }), undefined)
  })

  it('an edit that changes no card carries no embed', () => {
    const edit = buildEdit(PK, 1_760_000_000_000, { channelUuid: 'f', targetEventId: MESSAGE, body: 'fixed' })
    assert.deepEqual(edit.tags.map((t) => t[0]), ['h', 'e', 'ts'])
  })
})

describe('where a bare URL starts and ends (§13.2)', () => {
  it('trailing punctuation and brackets are the sentence’s; a URL stuck to a word is not a link', () => {
    assert.deepEqual(urlRunsIn(`(${ISSUE_URL}), and "${ISSUE_URL}"`).map((r) => r.url), [ISSUE_URL, ISSUE_URL])
    assert.deepEqual(urlRunsIn(`see${ISSUE_URL}`), [])
    assert.deepEqual(valuesIn(tree(`see${ISSUE_URL}`), resolve), [])
    const runs = linksAsReferences(tree(`see${ISSUE_URL}`), resolve)[0].inline!
    assert.equal(runs.some((r) => r.reference), false)
  })
})

/*
  COMM-8: what a comment box shows under itself while a comment is written,
  and the `embed` it sends — read from the draft by the rules a reader draws
  it by (record a-link-on-words-counts-toward-the-card).
*/
import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { boxLinksOf, boxReadOf, embedsToEdit, embedsToSend, namedBefore, withoutCard } from '../dist/index.js'

const PK = 'a'.repeat(64)
const ISSUE = `30851:${PK}:issue-one`
const OTHER_ISSUE = `30851:${PK}:issue-two`
const PAGE = `30023:${PK}:page-one`
const HERE = `30023:${PK}:page-here`
const FOLDER = `39000:${PK}:team`

const ISSUE_URL = 'https://ship.estiva.app/issue/one'
const OTHER_ISSUE_URL = 'https://ship.estiva.app/issue/two'
const FOLDER_URL = 'https://peek.estiva.app/folder/team'
const PAGE_BLOCK_URL = 'https://leaf.estiva.app/page/one#block-b1'
const HERE_BLOCK_URL = 'https://leaf.estiva.app/page/here#block-b9'
const HERE_URL = 'https://leaf.estiva.app/page/here'
const WEB_URL = 'https://example.com/news'

const RESOLVED: Record<string, string> = {
  [ISSUE_URL]: ISSUE,
  [OTHER_ISSUE_URL]: OTHER_ISSUE,
  [FOLDER_URL]: FOLDER,
  [HERE_URL]: HERE,
}
const BLOCKS: Record<string, { address: string; block: string }> = {
  [PAGE_BLOCK_URL]: { address: PAGE, block: 'b1' },
  [HERE_BLOCK_URL]: { address: HERE, block: 'b9' },
}
const context = { resolveLink: (url: string) => RESOLVED[url], blockOf: (url: string) => BLOCKS[url], here: HERE }

describe('boxLinksOf: the one file a draft names gets its card', () => {
  it('a bare link to one issue gives that issue the card', () => {
    assert.equal(boxLinksOf(`see ${ISSUE_URL}`, context).card, ISSUE)
  })

  it('a link on words counts by its target, as a bare link does', () => {
    assert.equal(boxLinksOf(`see [these words](${ISSUE_URL})`, context).card, ISSUE)
  })

  it('a second file, on words or bare, leaves no card', () => {
    assert.equal(boxLinksOf(`${ISSUE_URL} and [that](${OTHER_ISSUE_URL})`, context).card, undefined)
    assert.equal(boxLinksOf(`[this](${ISSUE_URL}) and ${OTHER_ISSUE_URL}`, context).card, undefined)
  })

  it('a plain web link and a Folder count for nothing', () => {
    assert.equal(boxLinksOf(`${ISSUE_URL} ${WEB_URL} ${FOLDER_URL}`, context).card, ISSUE)
  })

  it('the file the conversation is on gets no card and does not count against another', () => {
    assert.equal(boxLinksOf(HERE_URL, context).card, undefined)
    assert.equal(boxLinksOf(`${HERE_URL} ${ISSUE_URL}`, context).card, ISSUE)
  })

  it('a URL in a code span or in a link’s words names nothing', () => {
    assert.equal(boxLinksOf(`\`${ISSUE_URL}\``, context).card, undefined)
    assert.deepEqual(boxLinksOf(`[${OTHER_ISSUE_URL}](${ISSUE_URL})`, context).values, [ISSUE])
  })

  it('a link not answered yet names nothing, and is listed for the app to ask about', () => {
    const links = boxLinksOf('https://ship.estiva.app/issue/unknown', context)
    assert.equal(links.card, undefined)
    assert.deepEqual(links.urls, ['https://ship.estiva.app/issue/unknown'])
  })
})

describe('boxLinksOf: a block link shows its live part instead of a card', () => {
  it('a block of another page is a part, and with an issue there is no card, only the part', () => {
    const links = boxLinksOf(`${ISSUE_URL} ${PAGE_BLOCK_URL}`, context)
    assert.deepEqual(links.parts, [{ address: PAGE, block: 'b1' }])
    assert.equal(links.card, undefined)
  })

  it('a block of the page being commented on is its chip only: no part and no card', () => {
    const links = boxLinksOf(HERE_BLOCK_URL, context)
    assert.deepEqual(links.parts, [])
    assert.equal(links.card, undefined)
    assert.equal(boxLinksOf(`${HERE_BLOCK_URL} ${ISSUE_URL}`, context).card, ISSUE)
  })

  it('one part per file, the first link’s, at most six', () => {
    const many = Object.fromEntries(Array.from({ length: 8 }, (_, i) => [`https://leaf.estiva.app/p/${i}#b`, { address: `30023:${PK}:p${i}`, block: 'b' }]))
    const second = { 'https://leaf.estiva.app/p/0#c': { address: `30023:${PK}:p0`, block: 'c' } }
    const all: Record<string, { address: string; block: string }> = { ...many, ...second }
    const text = ['https://leaf.estiva.app/p/0#b', 'https://leaf.estiva.app/p/0#c', ...Object.keys(many).slice(1)].join(' ')
    const parts = boxLinksOf(text, { ...context, blockOf: (url) => all[url] }).parts
    assert.equal(parts.length, 6)
    assert.deepEqual(parts[0], { address: `30023:${PK}:p0`, block: 'b' })
  })
})

describe('boxReadOf: the box’s document, read as the send writes it', () => {
  const doc = (...content: unknown[]) => ({ type: 'doc', content: [{ type: 'paragraph', content }] }) as never

  it('words carrying a link mark count by its target', () => {
    const links = boxReadOf(doc({ type: 'text', text: 'these words', marks: [{ type: 'link', attrs: { href: ISSUE_URL } }] }), context)
    assert.equal(links.card, ISSUE)
  })

  it('a pasted link drawn as its chip is written as the URL and counts as the file', () => {
    const links = boxReadOf(doc({ type: 'text', text: 'see ' }, { type: 'reference', attrs: { uri: `nostr:x`, href: ISSUE_URL } }), context)
    assert.equal(links.card, ISSUE)
  })
})

describe('the embed a comment sends', () => {
  it('a new comment sends its card as detailed, and nothing after ✕', () => {
    const links = boxLinksOf(ISSUE_URL, context)
    assert.deepEqual(embedsToSend(links, new Set()), [{ value: ISSUE, layout: 'detailed' }])
    assert.deepEqual(embedsToSend(links, new Set([ISSUE])), [])
  })

  it('an edit gives a card only to a file it names first, keeping the folded set', () => {
    const previous = namedBefore(`${ISSUE_URL}`, context)
    assert.equal(boxLinksOf(`${ISSUE_URL} again`, { ...context, previous }).card, undefined)
    const added = boxLinksOf(`${OTHER_ISSUE_URL}`, { ...context, previous })
    assert.deepEqual(embedsToEdit(added, new Set(), [{ value: ISSUE, layout: 'none' }]), [
      { value: ISSUE, layout: 'none' },
      { value: OTHER_ISSUE, layout: 'detailed' },
    ])
    assert.equal(embedsToEdit(added, new Set([OTHER_ISSUE]), []), undefined)
  })

  it('a block link’s file was named before an edit, so it gets no card after', () => {
    const previous = namedBefore(PAGE_BLOCK_URL, context)
    assert.ok(previous.includes(PAGE))
  })

  it('✕ on a sent card sets it none and keeps the rest', () => {
    assert.deepEqual(withoutCard([{ value: ISSUE, layout: 'detailed' }, { value: OTHER_ISSUE, layout: 'detailed' }], ISSUE), [
      { value: ISSUE, layout: 'none' },
      { value: OTHER_ISSUE, layout: 'detailed' },
    ])
  })
})

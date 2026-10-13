/**
 * SPEC §13.6.2 — a message asks for a reference's card (OPT-16).
 *
 * `embedsOf` reads the tags of one event; `cardsIn` says which of them the body
 * still names, in body order, with a `part` winning over an `embed`. The
 * addresses are Ship's real shapes: an issue (`30851`, manifest `row`) and a
 * project (`30850`, manifest `card`).
 */
import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { EMBED_TAG, addrToNaddr, cardsIn, embedTag, embedsOf, encodeNevent, toRenderTree, urlNamesAddress } from '../dist/index.js'

const PK = 'b38fd2687b17bbde2e8079577cba601936acfe1b731d2d2ba7cdef29a063db46'
const ISSUE = `30851:${PK}:f78c3b96-2a3b-4d92-910a-ac25aba672cd`
const PROJECT = `30850:${PK}:15e9b50a-825a-4537-8b4a-df46efb9c7e4`
const MESSAGE = 'd064ad5af7aa5810775d78ef18c8f55efd58e7434e8a93face9c4a860195573a'
const issueRef = `nostr:${addrToNaddr(ISSUE)}`
const projectRef = `nostr:${addrToNaddr(PROJECT)}`
const messageRef = `nostr:${encodeNevent({ id: MESSAGE, relays: [] })}`

const body = (text: string) => toRenderTree(text, 'marker')

describe('reading embed tags', () => {
  it('writes the three-element tag', () => {
    assert.deepEqual(embedTag(ISSUE, 'compact'), [EMBED_TAG, ISSUE, 'compact'])
  })

  it('takes the first tag per value, in tag order', () => {
    const got = embedsOf({ tags: [['a', ISSUE], embedTag(PROJECT, 'detailed'), embedTag(ISSUE, 'compact'), embedTag(ISSUE, 'detailed')] })
    assert.deepEqual(got, [{ value: PROJECT, layout: 'detailed' }, { value: ISSUE, layout: 'compact' }])
  })

  it('draws an unknown layout as compact and keeps none', () => {
    assert.deepEqual(embedsOf({ tags: [['embed', ISSUE, 'huge'], ['embed', PROJECT, 'none'], ['embed', MESSAGE]] }), [
      { value: ISSUE, layout: 'compact' },
      { value: PROJECT, layout: 'none' },
      { value: MESSAGE, layout: 'compact' },
    ])
  })

  it('skips a value that is neither an address nor an event id, and lowercases an id', () => {
    assert.deepEqual(embedsOf({ tags: [['embed', 'https://example.com', 'compact'], ['embed', '', 'compact'], ['embed', MESSAGE.toUpperCase(), 'detailed']] }), [
      { value: MESSAGE, layout: 'detailed' },
    ])
  })
})

describe('which cards a message draws', () => {
  it('draws only values the body names, in body order', () => {
    const embeds = embedsOf({ tags: [embedTag(ISSUE, 'compact'), embedTag(PROJECT, 'detailed')] })
    assert.deepEqual(cardsIn(embeds, body(`see ${projectRef} and then ${issueRef}`)), [
      { value: PROJECT, layout: 'detailed' },
      { value: ISSUE, layout: 'compact' },
    ])
  })

  it('draws nothing for a value the folded body no longer names', () => {
    const embeds = embedsOf({ tags: [embedTag(ISSUE, 'compact')] })
    assert.deepEqual(cardsIn(embeds, body('the link was edited out')), [])
  })

  it('matches by body alone — no a or q needed, as on an edit', () => {
    assert.deepEqual(cardsIn([{ value: ISSUE, layout: 'detailed' }], body(`added later: ${issueRef}`)), [{ value: ISSUE, layout: 'detailed' }])
  })

  it('names an address by an app link whose path ends in its d', () => {
    const url = 'https://ship.estiva.app/issue/opt-16-probe-issue-f78c3b96-2a3b-4d92-910a-ac25aba672cd'
    assert.equal(urlNamesAddress(url, ISSUE), true)
    assert.deepEqual(cardsIn([{ value: ISSUE, layout: 'compact' }], body(`the plan: ${url}.`)), [{ value: ISSUE, layout: 'compact' }])
  })

  it('names a message by nevent', () => {
    assert.deepEqual(cardsIn([{ value: MESSAGE, layout: 'detailed' }], body(`as said in ${messageRef}`)), [{ value: MESSAGE, layout: 'detailed' }])
  })

  it('keeps none, so it can override the reader default', () => {
    assert.deepEqual(cardsIn([{ value: ISSUE, layout: 'none' }], body(issueRef)), [{ value: ISSUE, layout: 'none' }])
  })

  it('lets a part win over an embed for the same address', () => {
    const got = cardsIn([{ value: ISSUE, layout: 'compact' }], body(`see ${issueRef}`), [{ address: ISSUE, block: 'b1' }])
    assert.deepEqual(got, [])
  })

  it('does not count a reference inside a code span', () => {
    assert.deepEqual(cardsIn([{ value: ISSUE, layout: 'compact' }], body(`example: \`${issueRef}\``)), [])
  })
})

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
import { EMBED_TAG, addrToNaddr, cardsIn, embedTag, embedsOf, encodeNevent, linksAsReferences, toRenderTree } from '../dist/index.js'

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

  it('names an address by an app link only as the reader resolves it (§7.7), never by its trailing d', () => {
    const url = 'https://ship.estiva.app/issue/opt-16-probe-issue-f78c3b96-2a3b-4d92-910a-ac25aba672cd'
    const lookalike = 'https://evil.example/issue/x-f78c3b96-2a3b-4d92-910a-ac25aba672cd'
    const resolve = (u: string) => (u === url ? ISSUE : undefined)
    assert.deepEqual(cardsIn([{ value: ISSUE, layout: 'compact' }], body(`the plan: ${url}.`), [], resolve), [{ value: ISSUE, layout: 'compact' }])
    assert.deepEqual(cardsIn([{ value: ISSUE, layout: 'compact' }], body(`the plan: ${lookalike}.`), [], resolve), [])
    assert.deepEqual(cardsIn([{ value: ISSUE, layout: 'compact' }], body(`the plan: ${url}.`)), [], 'no resolver, no link')
  })

  it('strips a hostile run of trailing dots in linear time', () => {
    const text = `https://x.example/${'.'.repeat(200_000)}y ${'.'.repeat(200_000)}`
    const started = Date.now()
    cardsIn([{ value: ISSUE, layout: 'compact' }], body(text), [], () => undefined)
    assert.ok(Date.now() - started < 1000, `took ${Date.now() - started} ms`)
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

  it('finds a link inside a mark, and an address with an empty d', () => {
    const url = 'https://ship.estiva.app/issue/opt-16-probe-issue-f78c3b96-2a3b-4d92-910a-ac25aba672cd'
    const resolve = (u: string) => (u === url ? ISSUE : undefined)
    assert.deepEqual(cardsIn([{ value: ISSUE, layout: 'compact' }], body(`**the plan: ${url}**`), [], resolve), [{ value: ISSUE, layout: 'compact' }])
    assert.deepEqual(embedsOf({ tags: [['embed', `30023:${PK}:`, 'detailed']] }), [{ value: `30023:${PK}:`, layout: 'detailed' }])
  })

  it('does not count a reference inside a code span', () => {
    assert.deepEqual(cardsIn([{ value: ISSUE, layout: 'compact' }], body(`example: \`${issueRef}\``)), [])
  })
})

describe('linksAsReferences', () => {
  const url = 'https://ship.estiva.app/issue/opt-18-probe-issue-f78c3b96-2a3b-4d92-910a-ac25aba672cd'
  const messageUrl = 'https://peek.estiva.app/message/d064ad5a'
  const resolve = (u: string) => (u === url ? ISSUE : u === messageUrl ? MESSAGE : undefined)
  const runs = (text: string) => linksAsReferences(body(text), resolve)[0].inline!.map((r) => (r.reference ? { ref: r.reference, text: r.text } : r.text))

  it('turns a link alone on its line into the reference it names', () => {
    assert.deepEqual(runs(url), [{ ref: issueRef, text: url }])
  })

  it('turns a link in a sentence too, and leaves the sentence its punctuation', () => {
    assert.deepEqual(runs(`see ${url}, then ship`), ['see ', { ref: issueRef, text: url }, ', then ship'])
  })

  it('names a message by its nevent', () => {
    assert.deepEqual(runs(messageUrl), [{ ref: messageRef, text: messageUrl }])
  })

  it('leaves a link on words alone — target and words', () => {
    assert.deepEqual(runs(`the [plan](${url}) for now`), [`the [plan](${url}) for now`])
    assert.deepEqual(runs(`[${url}](https://elsewhere.example/x)`), [`[${url}](https://elsewhere.example/x)`])
  })

  it('leaves the target of a link on words whose words carry a mark', () => {
    const got = linksAsReferences(body(`[**the plan**](${url})`), resolve)
    assert.ok(got[0].inline!.every((r) => !r.reference))
  })

  it('leaves a link nothing claims, and one in code', () => {
    assert.deepEqual(runs('https://example.com/a'), ['https://example.com/a'])
    const code = linksAsReferences(body(`\`${url}\``), resolve)[0].inline!
    assert.ok(code.every((r) => !r.reference))
    const block = linksAsReferences(body('```\n' + url + '\n```'), resolve)
    assert.ok(JSON.stringify(block).indexOf('reference') === -1)
  })

  it('keeps the marks around a link', () => {
    const got = linksAsReferences(body(`**${url}**`), resolve)[0].inline!
    assert.deepEqual(got.map((r) => [r.reference ?? null, r.marks]), [[issueRef, ['bold']]])
  })

  it('leaves a link whose answer no naddr can hold (a d over 255 bytes) as a link, without throwing', () => {
    const long = `30851:${PK}:${'x'.repeat(300)}`
    const got = linksAsReferences(body(url), () => long)[0].inline!
    assert.deepEqual(got.map((r) => r.reference ?? null), [null])
  })

  it('stays linear on a hostile run of unclosed links (256 KB)', () => {
    const hostile = '[a](https://x'.repeat(19700)
    const t0 = performance.now()
    linksAsReferences(body(hostile), resolve)
    linksAsReferences(body('[a](https://x) https://y '.repeat(10000)), resolve)
    assert.ok(performance.now() - t0 < 500, `took ${Math.round(performance.now() - t0)} ms`)
  })

  it('returns a block with nothing to turn as the same object', () => {
    const tree = body('just words, and https://example.com/a')
    assert.equal(linksAsReferences(tree, resolve)[0], tree[0])
    assert.notEqual(linksAsReferences(body(url), resolve)[0], body(url)[0])
  })

  it('agrees with cardsIn about which card a link names', () => {
    const tree = linksAsReferences(body(url), resolve)
    assert.deepEqual(cardsIn([{ value: ISSUE, layout: 'compact' }], tree), [{ value: ISSUE, layout: 'compact' }])
  })
})

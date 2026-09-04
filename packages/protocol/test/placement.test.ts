/**
 * Where a reference belongs — RIC-10.
 *
 * A reference that is the whole of a paragraph is somebody attaching an object.
 * A reference inside a sentence is somebody naming one mid-thought, and cutting
 * it out of the prose loses the sentence.
 *
 * The rule lives in the package because **two apps disagreeing about it makes
 * the same body read differently in each** — SPEC §10's test, and the reason
 * `stripNaddrs` being applied by each app separately was never going to hold.
 */
import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import {
  addrToNaddr,
  encodeNpub,
  referencesIn,
  standaloneReference,
  toRenderTree,
} from '../dist/index.js'

const PK = 'b38fd2687b17bbde2e8079577cba601936acfe1b731d2d2ba7cdef29a063db46'
const NADDR = `nostr:${addrToNaddr(`30851:${PK}:an-issue`)}`
const NPUB = `nostr:${encodeNpub(PK)}`
const tree = (body: string) => toRenderTree(body, 'marker')

describe('standaloneReference', () => {
  it('finds a reference that is the whole paragraph', () => {
    assert.equal(standaloneReference(tree(NADDR)[0]), NADDR)
  })

  it('ignores whitespace around it', () => {
    assert.equal(standaloneReference(tree(`   ${NADDR}   `)[0]), NADDR)
  })

  it('says nothing for a reference inside a sentence', () => {
    // The case RIC-10 exists for: cutting this out loses the sentence.
    assert.equal(standaloneReference(tree(`tracked in ${NADDR} for now`)[0]), undefined)
  })

  it('says nothing for two references alone together', () => {
    // Two pointers on one line is a list of attachments, and this function
    // answers about one. The caller reads `referencesIn` for the rest.
    assert.equal(standaloneReference(tree(`${NADDR} ${NADDR}`)[0]), undefined)
  })

  it('says nothing for a paragraph with no reference at all', () => {
    assert.equal(standaloneReference(tree('just words')[0]), undefined)
  })

  it('says nothing for a heading or a list item', () => {
    // A pointer used as a heading is doing something other than attaching.
    assert.equal(standaloneReference(tree(`# ${NADDR}`)[0]), undefined)
    const list = tree(`- ${NADDR}`)[0]
    assert.equal(standaloneReference(list), undefined)
  })
})

describe('referencesIn', () => {
  it('reads them in the order they were written', () => {
    assert.deepEqual(referencesIn(tree(`ask ${NPUB} about ${NADDR}`)), [NPUB, NADDR])
  })

  it('finds one nested in a list', () => {
    assert.deepEqual(referencesIn(tree(`- see ${NADDR}`)), [NADDR])
  })

  it('does NOT count a pointer quoted as an example', () => {
    // §13.1 makes code literal. `findNaddrs` reads the string and cannot tell
    // the difference, which is why this reads the tree instead.
    assert.deepEqual(referencesIn(tree(`type \`${NADDR}\` exactly`)), [])
  })

  it('finds nothing in a body with none', () => {
    assert.deepEqual(referencesIn(tree('just words')), [])
  })
})

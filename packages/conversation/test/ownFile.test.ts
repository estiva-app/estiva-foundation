/**
 * The file a comment is on, and an edit of an old Ship comment (ONE-11; Miky,
 * 2026-11-09): Ship ended every issue comment with `\n\nnostr:naddr…` of the
 * issue, which no reader draws, so an edit made in any app opens without it.
 * How a reader draws that line is the one line rule's (shape.test.ts).
 */
import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { encodeNaddr } from '@estiva-app/protocol'
import { ownFileOf, withoutOwnFileLines } from '../dist/index.js'

const ALICE = 'a'.repeat(64)
const D = 'd68a8c78-5ec7-4652-b236-89ab57ac5b1e'
const ISSUE = `30851:${ALICE}:${D}`
const naddr = `nostr:${encodeNaddr({ kind: 30851, pubkey: ALICE, identifier: D, relays: [] })}`
const URL = `https://ship.example/issue/fix-it-${D}`

describe('the file a comment is on', () => {
  it('is its A and its O; a chat message is on nothing, whatever its a names', () => {
    assert.deepEqual(ownFileOf({ kind: 1111, tags: [['A', ISSUE], ['O', D], ['a', ISSUE]] }), [ISSUE, D])
    assert.deepEqual(ownFileOf({ kind: 9, tags: [['a', ISSUE]] }), [])
  })
})

describe('an edit of an old Ship comment', () => {
  it('opens without the line linking its own file, and keeps every other', () => {
    assert.equal(withoutOwnFileLines(`Looks right.\n\n${naddr}`, [ISSUE]), 'Looks right.')
    assert.equal(withoutOwnFileLines(`Looks right.\n\n${URL}`, [ISSUE]), `Looks right.\n\n${URL}`)
    assert.equal(withoutOwnFileLines(`Same as ${naddr} then.`, [ISSUE]), `Same as ${naddr} then.`)
    assert.equal(withoutOwnFileLines(`Looks right.\n\n${naddr}`, [`30851:${ALICE}:another-issue`]), `Looks right.\n\n${naddr}`)
  })

  it('keeps the link when it is all the comment says, and a link in a code block', () => {
    assert.equal(withoutOwnFileLines(naddr, [ISSUE]), naddr)
    const code = `Raw:\n\`\`\`\n${naddr}\n\`\`\``
    assert.equal(withoutOwnFileLines(code, [ISSUE]), code)
  })
})

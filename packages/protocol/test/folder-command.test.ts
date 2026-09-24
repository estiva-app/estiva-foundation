/**
 * The Folder command's refusals — FOL-4.
 *
 * The bytes are pinned in `wire-vectors.json`. What is here is what the builder
 * refuses before a round trip, because each of these reaches the relay as a
 * command it rejects or, worse, one it applies.
 */
import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { KIND, buildFolderCommand, type FolderOp } from '../dist/index.js'

const PUB = 'b'.repeat(64)
const FOLDER = '24f5c271-3ed4-47f7-92e4-e9d6cf7f42d1'

describe('buildFolderCommand', () => {
  it('is kind 1852 with no content', () => {
    const event = buildFolderCommand(PUB, 0, { folder: FOLDER, op: 'add' })
    assert.equal(event.kind, KIND.FOLDER_COMMAND)
    assert.equal(event.kind, 1852)
    assert.equal(event.content, '')
    assert.deepEqual(event.tags, [
      ['h', FOLDER],
      ['op', 'add'],
    ])
  })

  it('refuses an op the relay would refuse, rather than sending it', () => {
    assert.throws(() => buildFolderCommand(PUB, 0, { folder: FOLDER, op: 'rename' as FolderOp }), /unknown folder op/)
  })

  it('refuses a command that names no folder', () => {
    assert.throws(() => buildFolderCommand(PUB, 0, { folder: '', op: 'add' }), /names the folder/)
  })

  it('refuses an empty address, which would be dropped and make the command mean something else', () => {
    assert.throws(() => buildFolderCommand(PUB, 0, { folder: FOLDER, op: 'remove', addresses: [''] }), /must not be empty/)
  })

  it('refuses a name that canonicalises to nothing — it is not a rename', () => {
    assert.throws(() => buildFolderCommand(PUB, 0, { folder: FOLDER, op: 'add', name: ' # ' }), /name is required/)
  })

  it('omits the name when none is given, so the relay keeps the one it has', () => {
    const event = buildFolderCommand(PUB, 0, { folder: FOLDER, op: 'add', addresses: ['30840:x:y'] })
    assert.equal(event.tags.some(([t]) => t === 'name'), false)
  })

  it('refuses a malformed signer', () => {
    assert.throws(() => buildFolderCommand('B'.repeat(64), 0, { folder: FOLDER, op: 'add' }), /pubkey/)
  })
})

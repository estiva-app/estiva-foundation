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

  it('writes a move with the folder it leaves in from, after the op', () => {
    const SOURCE = '5c1f7a3e-0b4d-4f7e-9a51-3d2c8e6b7f10'
    const event = buildFolderCommand(PUB, 0, { folder: FOLDER, op: 'move', from: SOURCE, addresses: [`30840:${PUB}:t1`] })
    assert.deepEqual(event.tags, [
      ['h', FOLDER],
      ['op', 'move'],
      ['from', SOURCE],
      ['a', `30840:${PUB}:t1`],
    ])
  })

  it('refuses a move with no from, a from on any other op, and a move to the folder it leaves', () => {
    assert.throws(() => buildFolderCommand(PUB, 0, { folder: FOLDER, op: 'move' }), /only a move/)
    assert.throws(() => buildFolderCommand(PUB, 0, { folder: FOLDER, op: 'add', from: 'x' }), /only a move/)
    assert.throws(() => buildFolderCommand(PUB, 0, { folder: FOLDER, op: 'move', from: '' }), /another folder/)
    assert.throws(() => buildFolderCommand(PUB, 0, { folder: FOLDER, op: 'move', from: FOLDER }), /another folder/)
    assert.throws(() => buildFolderCommand(PUB, 0, { folder: FOLDER, op: 'move', from: FOLDER.toUpperCase() }), /another folder/)
    assert.throws(() => buildFolderCommand(PUB, 0, { folder: FOLDER, op: 'move', from: '5c1f7a3e-0b4d-4f7e-9a51-3d2c8e6b7f10' }), /names the files/)
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

  it('names a file given by its id with o, and one given by its address with a, in the order given (§3.3, ALO-4)', () => {
    const ID = '0f8a7c1e-5b2d-4e6f-9a3b-c4d5e6f7a8b9'
    const event = buildFolderCommand(PUB, 0, { folder: FOLDER, op: 'add', addresses: [ID, `30840:${PUB}:t1`] })
    assert.deepEqual(event.tags, [
      ['h', FOLDER],
      ['op', 'add'],
      ['o', ID],
      ['a', `30840:${PUB}:t1`],
    ])
  })

  it('refuses a malformed signer', () => {
    assert.throws(() => buildFolderCommand('B'.repeat(64), 0, { folder: FOLDER, op: 'add' }), /pubkey/)
  })
})

import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { changeTypeOf, changeTypeTags } from '../dist/index.js'

const AUTHOR = 'a'.repeat(64)
const D = 'd68a8c78-5ec7-4652-b236-89ab57ac5b1e'

describe('the type a change says for its file — SPEC §6.2', () => {
  it('a change to each base kind says that kind’s type by name, in one K tag', () => {
    assert.deepEqual(changeTypeTags(`30851:${AUTHOR}:${D}`), [['K', 'osnova.issue']])
    assert.deepEqual(changeTypeTags(`30850:${AUTHOR}:${D}`), [['K', 'osnova.project']])
    assert.deepEqual(changeTypeTags(`30842:${AUTHOR}:${D}`), [['K', 'osnova.document']])
    assert.deepEqual(changeTypeTags(`30840:${AUTHOR}:${D}`), [['K', 'osnova.topic']])
  })

  it('a change on a team’s own address, or on a kind that is no file’s, carries no K', () => {
    assert.deepEqual(changeTypeTags(`39000:${AUTHOR}:${D}`), [])
    assert.deepEqual(changeTypeTags(`31990:${AUTHOR}:some-app`), [])
  })

  it('a change to a named-type file says the type it is handed, and is not built without one', () => {
    assert.equal(changeTypeOf(`30852:${AUTHOR}:${D}`, 'acme.invoice'), 'acme.invoice')
    assert.throws(() => changeTypeOf(`30852:${AUTHOR}:${D}`), /says its type/)
    // A base type is only ever written on its own kind (§6.1), so it is never a 30852's.
    assert.throws(() => changeTypeOf(`30852:${AUTHOR}:${D}`, 'osnova.issue'), /says its type/)
  })

  it('a base kind handed another type’s name is not built: the relay would refuse it', () => {
    assert.throws(() => changeTypeOf(`30851:${AUTHOR}:${D}`, 'osnova.document'), /osnova\.issue, not/)
  })
})

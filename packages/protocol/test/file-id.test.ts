/*
  A file's id is a random (version 4) lowercase uuid (SPEC §6.1, LIN-2): the
  relay refuses any other `d` on a file, so a reader that took one as a file's
  id would name a file that cannot exist — and write `o`/`O` tags and read-state
  keys for it that no app reading the rule could match.
*/
import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { fileIdOf, isFileId, sameFile } from '../dist/index.js'

const KEY = 'b'.repeat(64)
const V4 = '3f6d2a1e-8c4b-4d7a-9e21-5b0c7f8a6d13'

describe("a file's id", () => {
  it('is a v4 lowercase uuid, as crypto.randomUUID() writes one', () => {
    assert.equal(isFileId(V4), true)
    assert.equal(fileIdOf(`30851:${KEY}:${V4}`), V4)
  })

  for (const [label, d] of Object.entries({
    'a version 1 uuid': '6ba7b810-9dad-11d1-80b4-00c04fd430c8',
    'a version 7 uuid': '01936b2e-8a3c-7c4d-9e5f-0a1b2c3d4e5f',
    'the nil uuid': '00000000-0000-0000-0000-000000000000',
    'a v4 uuid of the wrong variant': '3f6d2a1e-8c4b-4d7a-ce21-5b0c7f8a6d13',
    'a v4 uuid in capitals': V4.toUpperCase(),
    'a key a person knows': 'PROJ-1',
  })) {
    it(`is not ${label}: the address keeps naming the file by itself`, () => {
      assert.equal(isFileId(d), false)
      assert.equal(fileIdOf(`30851:${KEY}:${d}`), undefined)
      // Two authors' files with such a `d` stay two files, not one by id.
      assert.equal(sameFile(`30851:${KEY}:${d}`, `30851:${'c'.repeat(64)}:${d}`), false)
    })
  }

  it('names one file by its address and by its id', () => {
    assert.equal(sameFile(`30851:${KEY}:${V4}`, V4), true)
  })
})

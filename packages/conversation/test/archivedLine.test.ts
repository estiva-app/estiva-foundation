/*
  PEEKM-8: the line on an archived file is one sentence for every app and the
  agent. It names what to unarchive — the file itself, or the closest archived
  one above it by its kind — and, for an app with no Unarchive of its own,
  where (record a-file-is-archived-with-the-closest-archived-file-above-it).
*/
import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { archivedLine } from '../dist/index.js'

const ABOVE = '30023:aaaa:plan'

describe('archivedLine', () => {
  it('says nothing for a file that is not archived', () => {
    assert.equal(archivedLine(undefined, 'page'), undefined)
    assert.equal(archivedLine(undefined, 'page', { in: 'Peek' }), undefined)
  })

  it('tells a person to unarchive the file itself when it is archived itself', () => {
    assert.equal(archivedLine({}, 'page'), 'Archived. Unarchive it to comment.')
  })

  it('names the closest archived file above by its kind', () => {
    assert.equal(archivedLine({ with: ABOVE }, 'page'), 'Unarchive the page to comment.')
    assert.equal(archivedLine({ with: ABOVE }, 'project'), 'Unarchive the project to comment.')
    assert.equal(archivedLine({ with: ABOVE }, 'PDF'), 'Unarchive the PDF to comment.')
  })

  it('writes Folder as a proper noun', () => {
    assert.equal(archivedLine({ with: ABOVE }, 'folder'), 'Unarchive the Folder to comment.')
  })

  it('still says what to do when the app has no noun for what is above', () => {
    assert.equal(archivedLine({ with: ABOVE }), 'Unarchive the parent to comment.')
    assert.equal(archivedLine({ with: ABOVE }, '  '), 'Unarchive the parent to comment.')
  })

  it('says where, for an app with no Unarchive of its own', () => {
    assert.equal(archivedLine({}, 'document', { in: 'Peek' }), 'Archived. Unarchive it in Peek to comment.')
    assert.equal(archivedLine({ with: ABOVE }, 'project', { in: 'Estiva Ship' }), 'Unarchive the project in Estiva Ship to comment.')
    assert.equal(archivedLine({}, 'issue', { in: ' ' }), 'Archived. Unarchive it to comment.')
  })

  it('says what waits, for the line over a locked text', () => {
    assert.equal(archivedLine({}, 'issue', { in: 'Estiva Ship', to: 'edit' }), 'Archived. Unarchive it in Estiva Ship to edit.')
    assert.equal(archivedLine({ with: ABOVE }, 'document', { in: 'Peek', to: 'edit' }), 'Unarchive the document in Peek to edit.')
  })
})

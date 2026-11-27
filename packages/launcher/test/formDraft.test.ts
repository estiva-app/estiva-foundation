/**
 * KIN-9 — New document picked under an answer starts with the answer as its text (Miky, at its kickoff, 27 November).
 */
import { describe, expect, it } from 'vitest'
import { applyPrefill, seedDraft, withAnswer } from '../src/formDraft.js'
import type { LauncherAction } from '../src/launcherActions.js'

const newDocument: LauncherAction = {
  id: 'add-document',
  label: 'New document',
  submitLabel: 'New document',
  fields: [
    { key: 'title', label: 'Title', control: 'string', required: true },
    { key: 'description', label: 'Description', control: 'prose' },
  ],
}
const newProject: LauncherAction = { ...newDocument, id: 'add-project', fields: [newDocument.fields[0], { key: 'description', label: 'Description', control: 'text' }] }

const ANSWER = 'We decided three things [1]:\n\n- Launch on 3 December [2] [4].\n- Katerina owns the page [3].'

describe('a form picked under an answer (KIN-9)', () => {
  it("puts the answer in the new document's text, without the conversation's message numbers", () => {
    const draft = withAnswer(seedDraft(newDocument), newDocument, ANSWER)
    expect(draft.values.description).toBe('We decided three things:\n\n- Launch on 3 December.\n- Katerina owns the page.')
  })

  it('keeps the answer when the conversation then suggests a text, and still fills the title', () => {
    const draft = applyPrefill(withAnswer(seedDraft(newDocument), newDocument, ANSWER), { title: 'Launch decisions', description: 'Something else' })
    expect(draft.values).toEqual({ title: 'Launch decisions', description: 'We decided three things:\n\n- Launch on 3 December.\n- Katerina owns the page.' })
  })

  it('never replaces a text the person typed', () => {
    const typed = { ...seedDraft(newDocument), values: { description: 'My own notes' }, touched: ['description'] }
    expect(withAnswer(typed, newDocument, ANSWER).values.description).toBe('My own notes')
  })

  it("leaves a form whose app declares no document text as it was: a project's one-line description stays empty", () => {
    const draft = seedDraft(newProject)
    expect(withAnswer(draft, newProject, ANSWER)).toBe(draft)
  })
})

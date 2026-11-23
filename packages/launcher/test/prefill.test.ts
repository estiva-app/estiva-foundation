/**
 * PEE-5 / PEE-6 — the schema is the constraint, and the bound is stated.
 *
 * The assertions worth reading are the two exclusions from the schema. A model
 * that fills in a **parent** picks where an object lands, which PEE-1 says is
 * never picked silently; a model that fills in a **pubkey** invents a plausible
 * 64-hex key belonging to nobody, and the relay would accept it. Both are
 * cheaper to forbid here than to detect afterwards.
 */
import { describe, expect, it } from 'vitest'
import type { FormField } from '../src/launcherActions.js'
import {
  THREAD_CONTEXT_CHARS,
  draftInstruction,
  formSchema,
  prefillInstruction,
  threadContext,
  usablePrefill,
} from '../src/prefill.js'

const fields: FormField[] = [
  { key: 'title', label: 'Title', control: 'string', required: true },
  { key: 'description', label: 'Description', control: 'text' },
  { key: 'status', label: 'Status', control: 'enum', vocabulary: 'status' },
  { key: 'assignee', label: 'Assignee', control: 'pubkey' },
  { key: '__parent', label: 'Project', control: 'parent', required: true, parentNoun: 'project' },
]

const vocabularies = {
  status: [
    { value: 'todo', label: 'Todo' },
    { value: 'done', label: 'Done' },
  ],
}

describe('formSchema', () => {
  it('constrains an enum to the vocabulary the owning app declared', () => {
    const built = formSchema(fields, vocabularies)
    const properties = (built?.schema as { properties: Record<string, unknown> }).properties
    expect(properties.status).toEqual({ type: 'string', enum: ['todo', 'done'] })
  })

  it('never asks a model for the parent', () => {
    // Where a new object lands is a decision with consequences the model
    // cannot see, and PEE-1's rule is that the destination is shown before it
    // happens rather than guessed.
    const built = formSchema(fields, vocabularies)
    expect(built?.keys).not.toContain('__parent')
  })

  it('never asks a model for a pubkey', () => {
    // It would produce a well-formed key belonging to nobody, and the relay
    // takes whatever it is given.
    const built = formSchema(fields, vocabularies)
    expect(built?.keys).not.toContain('assignee')
  })

  it('asks for the text fields, which is the point', () => {
    expect(formSchema(fields, vocabularies)?.keys).toEqual(['title', 'description', 'status'])
  })

  it('marks every drawn field required, so the model answers about all of them', () => {
    const schema = formSchema(fields, vocabularies)?.schema as { required: string[]; additionalProperties: boolean }
    expect(schema.required).toEqual(['title', 'description', 'status'])
    // Constrained decoding with an open object would let it volunteer keys the
    // form has nowhere to put.
    expect(schema.additionalProperties).toBe(false)
  })

  it('drops an enum whose vocabulary did not resolve, rather than constraining to nothing', () => {
    const built = formSchema(fields, {})
    expect(built?.keys).toEqual(['title', 'description'])
  })

  it('returns null when there is nothing a model could write', () => {
    // An action that is only a parent and an assignee has no prose in it, and
    // running a model to fill in nothing is worse than not offering it.
    expect(formSchema([fields[3], fields[4]], vocabularies)).toBeNull()
  })
})

describe('threadContext', () => {
  it('keeps the newest messages and drops the oldest', () => {
    // The tail is where the thing being captured was decided.
    const messages = ['oldest', 'middle', 'newest']
    expect(threadContext(messages, 14)).toBe('middle\nnewest')
  })

  it('bounds by characters, because a message is not a unit of size', () => {
    const long = 'x'.repeat(THREAD_CONTEXT_CHARS + 100)
    expect(threadContext(['short', long])).toBe('short')
  })

  it('skips an oversized message rather than dropping the thread with it', () => {
    /*
      Found by the test above failing. Walking newest-first and STOPPING at the
      first message that would not fit meant one pasted stack trace as the
      latest message threw away the discussion around it — which is the part
      worth capturing.
    */
    const long = 'x'.repeat(THREAD_CONTEXT_CHARS + 100)
    expect(threadContext(['we should file this', long])).toBe('we should file this')
  })

  it('truncates rather than returning nothing when a single message is too big', () => {
    // Its opening is context. Its absence is none.
    const long = 'y'.repeat(THREAD_CONTEXT_CHARS + 100)
    expect(threadContext([long])).toBe('y'.repeat(THREAD_CONTEXT_CHARS))
  })

  it('collapses whitespace so a pasted block does not spend the budget on newlines', () => {
    expect(threadContext(['a\n\n\n   b'])).toBe('a b')
  })

  it('is empty for an empty thread, which is how the caller skips prefill', () => {
    expect(threadContext([])).toBe('')
    expect(threadContext(['', '   '])).toBe('')
  })
})

describe('prefillInstruction', () => {
  it('names the action the way the owning app named it', () => {
    // Inventing a better sentence here would be Peek deciding what another
    // app's action means.
    const instruction = prefillInstruction('Add issue', 'we should fix the build')
    expect(instruction).toContain('Add issue')
    expect(instruction).toContain('we should fix the build')
  })

  it('tells the model to leave a field empty rather than invent one', () => {
    expect(prefillInstruction('Add issue', 'x')).toMatch(/leave the field empty/i)
    expect(prefillInstruction('Add issue', null, 'file the billing bug')).toMatch(/leave the field empty/i)
  })

  it('puts the sentence the action was picked under before the conversation (a77dd5e3)', () => {
    const instruction = prefillInstruction('Create project', 'we talked about the budget', 'create a project for the website launch')
    expect(instruction).toContain('create a project for the website launch')
    expect(instruction).toContain('we talked about the budget')
    expect(instruction.indexOf('website launch')).toBeLessThan(instruction.indexOf('the budget'))
  })

  it('fills from the sentence alone where no conversation is open', () => {
    const instruction = prefillInstruction('Create project', null, 'create a project for the website launch')
    expect(instruction).toContain('create a project for the website launch')
    expect(instruction).not.toMatch(/conversation/i)
  })
})

describe('usablePrefill', () => {
  it('keeps the drawn fields', () => {
    expect(usablePrefill({ title: 'Build is broken' }, ['title'])).toEqual({ title: 'Build is broken' })
  })

  it('drops a blank answer rather than clearing a declared default', () => {
    // A key present with an empty string is the model saying it had nothing.
    expect(usablePrefill({ title: '   ' }, ['title'])).toEqual({})
  })

  it('drops a key the form never drew', () => {
    expect(usablePrefill({ title: 'a', invented: 'b' }, ['title'])).toEqual({ title: 'a' })
  })

  it('drops a non-string, whatever the constraint should have guaranteed', () => {
    expect(usablePrefill({ title: 42 } as unknown as Record<string, unknown>, ['title'])).toEqual({})
  })

  it('is empty for no answer at all', () => {
    expect(usablePrefill(null, ['title'])).toEqual({})
  })
})

/**
 * The budget, once it stopped being a guess (INT-1).
 *
 * Measured in Chrome via `__promptContext.sweep()` on 2026-09-02: 4k answers in
 * 1.8s, 8k in 2.3s, 16k in 4.1s, 32k in 9.1s, and 64k is refused outright. The
 * cost is **super-linear**, so the ceiling is not the interesting bound — the
 * shoulder of the curve is.
 */
describe('THREAD_CONTEXT_CHARS is set from the curve, not from what fits', () => {
  it('is well inside the region where an answer is cheap', () => {
    // 16k already costs 4.1s before a single word is generated, and a real
    // feature generates a paragraph on top of that.
    expect(THREAD_CONTEXT_CHARS).toBeLessThanOrEqual(16_000)
  })

  it('is far below the measured ceiling, which is between 32k and 64k', () => {
    // Not a safety margin for its own sake: the room is deliberately left for
    // INT-3, where a person has asked and knows they are waiting.
    expect(THREAD_CONTEXT_CHARS).toBeLessThan(32_000)
  })

  it('is bigger than the value that demonstrably discarded a real conversation', () => {
    /*
      A real 9-message thread of 5795 characters was cut to 2465 by the old
      4000 — 57% discarded — and the untruncated version answered faster than
      the truncated one. The bound cost conversation and bought nothing.
    */
    expect(THREAD_CONTEXT_CHARS).toBeGreaterThan(5_795)
  })

  it('carries a thread the size of the real one whole', () => {
    // 9 messages of ~650 characters — 5850 in total, matching the 5795-character
    // conversation the old bound cut to 2465.
    const thread = Array.from({ length: 9 }, (_, i) => `Message ${i} `.repeat(65))
    expect(thread.join('\n').length).toBeGreaterThan(5_795)

    const kept = threadContext(thread)
    // Nothing skipped: every message survives, which 4000 could not manage.
    for (let i = 0; i < 9; i++) expect(kept).toContain(`Message ${i}`)
    expect(threadContext(thread, 4_000).length).toBeLessThan(kept.length)
  })
})

describe('draftInstruction (INT-4)', () => {
  const conversation = 'Katerina: the interop bump broke the build\nJan: reverting for now'

  it('carries both the conversation and the request', () => {
    // Neither works alone: "make it shorter" means nothing without the thread,
    // and the thread does not say what the person wants written.
    const instruction = draftInstruction(conversation, 'offer to take a look tomorrow')

    expect(instruction).toContain(conversation)
    expect(instruction).toContain('offer to take a look tomorrow')
  })

  it('asks for the message text only', () => {
    /*
      A small model otherwise returns "Sure! Here's a draft:" plus an offer to
      revise, and every word of that would land in somebody's composer for them
      to delete. Same reason `prefillInstruction` forbids inventing a field.
    */
    const instruction = draftInstruction(conversation, 'agree')

    expect(instruction).toMatch(/message text only/i)
    expect(instruction).toMatch(/no preamble/i)
  })

  it('puts the request last, after the material', () => {
    // The brief is what the model should still be holding when it starts
    // writing; an 8000-character thread in between would bury it.
    const instruction = draftInstruction(conversation, 'offer to take a look tomorrow')

    expect(instruction.indexOf('offer to take a look tomorrow')).toBeGreaterThan(instruction.indexOf(conversation))
  })

  it('does not name the person or sign off for them', () => {
    /*
      INT-4 hands the draft over for editing; it does not publish in anybody's
      voice. A sign-off is the one part of a message a person cannot see is
      wrong at a glance, because it looks exactly like something they would
      write.
    */
    expect(draftInstruction(conversation, 'agree')).toMatch(/no sign-off/i)
  })
})

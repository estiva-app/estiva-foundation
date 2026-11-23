/**
 * INT-3 — retrieval is where the accuracy comes from, so it is where the tests
 * are.
 *
 * The model is not exercised here at all, and that is the point of the split:
 * the set of messages an answer could possibly have come from is decided by
 * deterministic code, before anything is generated. What a small model does
 * with that material varies; what it is allowed to cite does not.
 */
import { describe, expect, it } from 'vitest'
import type { LauncherMessage as ConversationMessage } from '../src/host.js'
import { answerInstruction, parseAnswer, selectMessages } from '../src/askThread.js'

let seq = 0
const m = (body: string, author = 'Katerina'): ConversationMessage => ({
  id: `r${seq++}`,
  author,
  timestamp: '9:41 AM',
  body,
})

const thread = [
  m('morning all', 'Amie'),
  m('the migration is blocked on the interop bump', 'Daniel'),
  m('lunch?', 'Juan'),
  m('we decided to postpone the migration until Thursday', 'Katerina'),
  m('sounds good', 'Amie'),
]

describe('selectMessages — which messages an answer may come from', () => {
  it('reads the whole thread when the whole thread fits', () => {
    /*
      Retrieval exists because of the ceiling, not for its own sake. A short
      thread costs less than the budget INT-1 set, and reading all of it is
      strictly better than reading part — the numbering and the citations work
      the same either way.
    */
    expect(selectMessages('migration', thread).chosen).toHaveLength(thread.length)
  })

  it('picks the messages that share terms with the question once it must choose', () => {
    const { chosen } = selectMessages('what did we decide about the migration', thread, 100)
    const bodies = chosen.map((c) => c.message.body)

    expect(bodies).toContain('we decided to postpone the migration until Thursday')
    expect(bodies).toContain('the migration is blocked on the interop bump')
    expect(bodies).not.toContain('lunch?')
  })

  it('scores on distinct terms, so repetition does not win', () => {
    /*
      A message saying "migration migration migration" answers nothing. Counting
      occurrences would rank it top and spend the budget on it.
    */
    const noise = m('migration migration migration migration migration')
    const answerish = m('the migration ships Thursday after the bump')
    const { chosen } = selectMessages('when does the migration ship', [noise, answerish], 60)

    expect(chosen).toHaveLength(1)
    expect(chosen[0].message.body).toBe('the migration ships Thursday after the bump')
  })

  it('matches a plural against its singular, but not on two letters', () => {
    const hit = m('the migrations are queued')
    const miss = m('mi casa es su casa')
    const { chosen } = selectMessages('migration', [hit, miss], 40)

    expect(chosen.map((c) => c.message.body)).toEqual(['the migrations are queued'])
  })

  it('ignores stopwords, or every message would match', () => {
    // "what did we decide" is four words and three of them appear everywhere.
    const { byRecency } = selectMessages('what did we', [m('completely unrelated text')])
    expect(byRecency).toBe(true)
  })

  it('numbers and orders the selection chronologically', () => {
    /*
      The model reads a conversation, not a ranked list — an answer about what
      happened depends on the order it happened in. Ranking decides *which*
      messages; it must not decide what order they are read in.
    */
    const { chosen } = selectMessages('migration', thread, 100)
    const indexes = chosen.map((c) => thread.indexOf(c.message))

    expect(chosen.map((c) => c.n)).toEqual(chosen.map((_, i) => i + 1))
    expect([...indexes]).toEqual([...indexes].sort((a, b) => a - b))
  })

  it('falls back to recency when nothing matches, and says so', () => {
    /*
      Not a failure — a person who typed a question and pressed Enter is owed an
      answer or a reason. But it is a different thing from retrieval, so it is
      reported rather than hidden behind an identical-looking answer.
    */
    const { chosen, byRecency } = selectMessages('unrelated zzqxvw', thread, 40)

    expect(byRecency).toBe(true)
    expect(chosen.map((c) => c.message.body)).toContain('sounds good')
  })

  it('respects the context budget INT-1 measured', () => {
    const long = Array.from({ length: 20 }, () => m('the migration is blocked '.repeat(20)))
    const { chosen } = selectMessages('migration', long, 1000)
    const spent = chosen.reduce((n, c) => n + c.message.body.length, 0)

    expect(spent).toBeLessThanOrEqual(1000)
    expect(chosen.length).toBeLessThan(long.length)
  })

  it('reports what did not fit rather than dropping it silently', () => {
    // `threadContext` drops what will not fit and says nothing, which reads as
    // "that is all there was". Retrieval must not repeat that.
    const long = Array.from({ length: 10 }, () => m('the migration is blocked '.repeat(20)))
    const { omitted, chosen } = selectMessages('migration', long, 1000)

    expect(omitted).toBe(10 - chosen.length)
    expect(omitted).toBeGreaterThan(0)
  })

  it('takes one message even when it alone exceeds the budget', () => {
    // An answer from a truncated set beats "the thread is too long to ask
    // about", which is not an outcome anybody wants from pressing Enter.
    const { chosen } = selectMessages('migration', [m('migration '.repeat(500))], 100)
    expect(chosen).toHaveLength(1)
  })

  it('handles an empty thread without inventing one', () => {
    expect(selectMessages('anything', [])).toEqual({ chosen: [], omitted: 0, byRecency: true })
  })
})

describe('answerInstruction', () => {
  it('numbers the messages and names their authors', () => {
    const { chosen } = selectMessages('migration', thread, 100)
    const instruction = answerInstruction('what about the migration', chosen)

    expect(instruction).toContain('[1] Daniel: the migration is blocked on the interop bump')
    expect(instruction).toContain('[2] Katerina: we decided to postpone the migration until Thursday')
  })

  it('asks for citations and permits an honest refusal', () => {
    /*
      A small model asked a question it has no material for answers it anyway.
      That is the failure citations exist to catch, and telling it to say so is
      cheaper than catching it afterwards.
    */
    const instruction = answerInstruction('q', selectMessages('migration', thread, 100).chosen)

    expect(instruction).toMatch(/cite the messages/i)
    expect(instruction).toMatch(/do not answer the question, say so/i)
  })

  it('carries the question after the material', () => {
    const instruction = answerInstruction('when does it ship', selectMessages('migration', thread, 100).chosen)
    expect(instruction.indexOf('when does it ship')).toBeGreaterThan(instruction.indexOf('[1]'))
  })
})

describe('parseAnswer — a citation cannot be invented', () => {
  it('collects the numbers cited, deduplicated, in order', () => {
    const { cited } = parseAnswer('Postponed [2]. Blocked on interop [1][2].', 3)
    expect(cited).toEqual([2, 1])
  })

  it('keeps valid markers in the text', () => {
    const { text } = parseAnswer('Postponed until Thursday [2].', 3)
    expect(text).toBe('Postponed until Thursday [2].')
  })

  it('removes a marker for a message that was never given', () => {
    /*
      The one place the model's output is not taken at face value, and the place
      where doing so would put a fabricated source in front of somebody. Given
      three messages it will still occasionally cite [7].
    */
    const { text, cited } = parseAnswer('Postponed until Thursday [7].', 3)

    expect(cited).toEqual([])
    expect(text).toBe('Postponed until Thursday.')
  })

  it('tidies the space a removed marker leaves behind', () => {
    const { text } = parseAnswer('It is blocked [9] on interop [1].', 2)
    expect(text).toBe('It is blocked on interop [1].')
  })

  it('treats zero as out of range, because citations are 1-based', () => {
    expect(parseAnswer('Answer [0].', 3).cited).toEqual([])
  })

  it('leaves an uncited answer alone', () => {
    // Not an error. The caller shows the whole retrieved set in that case —
    // those are the only messages the model saw.
    const { text, cited } = parseAnswer('They postponed it until Thursday.', 3)

    expect(cited).toEqual([])
    expect(text).toBe('They postponed it until Thursday.')
  })
})

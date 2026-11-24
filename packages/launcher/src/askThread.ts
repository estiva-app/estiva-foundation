import type { LauncherMessage as ConversationMessage, LauncherOpen } from './host.js'
import { THREAD_CONTEXT_CHARS } from './prefill.js'

/**
 * INT-3 — retrieval first, generation second.
 *
 * Two independent constraints point at the same architecture, which is usually
 * the sign it is right.
 *
 * **The context ceiling.** INT-1 measured it: 4k of thread costs 1.8s, 8k
 * 2.3s, 16k 4.1s, 32k 9.1s, and 64k is refused outright. The curve is
 * super-linear, so a topic does not fit. Selecting messages before summarising
 * is not a compromise; it is the only option.
 *
 * **Accuracy.** Edge's own flag text about the model it ships: *"It is NOT
 * suitable for use cases that require factual accuracy."* A question about a
 * work conversation is exactly that use case — somebody asks what was decided
 * about the migration and a small model confabulates plausibly, in the tool of
 * record. You do not fix that by trusting the model harder. You fix it by
 * making every claim checkable in one click: a wrong answer with three
 * citations is recoverable in seconds, and a wrong answer with none is a false
 * belief about your own workspace.
 *
 * So the retrieval here is deliberately **not a model**. It is lexical, it is
 * deterministic, and it is testable — which means the set of messages an answer
 * could possibly have come from is known before the model runs, and a citation
 * cannot be invented.
 */

/**
 * Words carrying no retrieval signal.
 *
 * Short and English, matching `OUTPUT_LANGUAGE`, and stated as a list rather
 * than a cleverness: "what did we decide about the migration" has to score on
 * *migration* and *decide*, not on *what*, *did* and *we*, which appear in
 * every message ever written.
 */
const STOPWORDS = new Set([
  'a', 'about', 'all', 'am', 'an', 'and', 'any', 'are', 'as', 'at', 'be', 'been', 'but', 'by', 'can', 'did',
  'do', 'does', 'for', 'from', 'get', 'had', 'has', 'have', 'he', 'her', 'him', 'his', 'how', 'i', 'if', 'in',
  'into', 'is', 'it', 'its', 'me', 'my', 'no', 'not', 'of', 'on', 'or', 'our', 'out', 'said', 'say', 'she',
  'should', 'so', 'some', 'than', 'that', 'the', 'their', 'them', 'then', 'there', 'these', 'they', 'this',
  'to', 'up', 'us', 'was', 'we', 'were', 'what', 'when', 'where', 'which', 'who', 'why', 'will', 'with',
  'would', 'you', 'your',
])

function terms(text: string): string[] {
  return text
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((t) => t.length > 1 && !STOPWORDS.has(t))
}

/** One selected message and the number it is cited by. */
export interface NumberedMessage {
  /** 1-based, and the number the model is told to cite. */
  n: number
  message: ConversationMessage
}

export interface ThreadSelection {
  /** The chosen messages, oldest first — a conversation, not a ranked list. */
  chosen: NumberedMessage[]
  /**
   * Messages the budget could not take.
   *
   * Reported rather than dropped in silence. `threadContext` drops what will
   * not fit and says nothing, which reads as "that is all there was" — the same
   * failure PEE-4 called out for unroutable search hits.
   */
  omitted: number
  /**
   * True when nothing in the question matched anything in the thread, so
   * recency chose instead.
   *
   * Worth saying out loud: an answer drawn from the last few messages because
   * the question matched none of them is a different thing from an answer drawn
   * from the messages that matched, and only one of them is retrieval.
   */
  byRecency: boolean
}

/**
 * Choose the messages a question should be answered from.
 *
 * Scored on **distinct** query terms present, so a message repeating one word
 * six times does not outrank one that answers the question. Ties break towards
 * the recent, because the thing just discussed is usually the thing asked
 * about — the same assumption `conversationRegistry` makes about references.
 */
export function selectMessages(
  question: string,
  messages: readonly ConversationMessage[],
  limit = THREAD_CONTEXT_CHARS,
): ThreadSelection {
  const wanted = new Set(terms(question))
  const scored = messages.map((message, i) => {
    const present = new Set(terms(message.body))
    let score = 0
    for (const term of wanted) {
      if (present.has(term)) score += 1
      /*
        A prefix counts for less: "migration" should find "migrations". **Both**
        sides must be four characters, not just the query's — a message
        containing "mi" is a prefix of "migration" and matching it would score
        every message in the thread. Caught by the test that asks for it.
      */
      else if (term.length >= 4 && [...present].some((p) => p.length >= 4 && (p.startsWith(term) || term.startsWith(p))))
        score += 0.5
    }
    return { i, message, score }
  })

  const byRecency = scored.every((s) => s.score === 0)
  /*
    Recency is the fallback, not a failure. A person who typed a question and
    pressed Enter is owed an answer or a reason — PEE-6's "say nothing rather
    than apologise" was written for unsolicited prefill and inverts here.
  */
  const ranked = byRecency
    ? [...scored].reverse()
    : [...scored].sort((a, b) => b.score - a.score || b.i - a.i)

  const taken: typeof scored = []
  let spent = 0
  for (const row of ranked) {
    const cost = row.message.body.length + 1
    if (taken.length > 0 && spent + cost > limit) continue
    taken.push(row)
    spent += cost
  }

  // Back into thread order: the model reads a conversation, and a citation
  // numbered 1 should be the earlier of two messages.
  taken.sort((a, b) => a.i - b.i)
  return {
    chosen: taken.map((row, k) => ({ n: k + 1, message: row.message })),
    omitted: messages.length - taken.length,
    byRecency,
  }
}

/**
 * The prompt.
 *
 * Numbered messages and an instruction to cite them. **The numbers are the
 * only citation vocabulary the model has** — it cannot name a message that was
 * not given to it, and `parseAnswer` discards a number outside the range, so
 * the worst a confabulated citation can do is not appear.
 *
 * It is told to say when the messages do not answer the question. A small model
 * asked a question it has no material for will otherwise answer it anyway, and
 * that is the failure mode citations exist to catch.
 */
export function answerInstruction(question: string, chosen: readonly NumberedMessage[], open?: Pick<LauncherOpen, 'kind' | 'title'>): string {
  if (open?.kind === 'page') {
    /*
      A page (KIN-5): its text, then the comments on it, resolved ones marked so a settled point is not read as open
      (Miky, KIN-5 kickoff: the answer reads the text and every comment). A part with no author is the page's own text.
    */
    // One line per part, each saying what it is: a comment's line breaks cannot start a part of its own (KIN-5 review).
    const line = (words: string) => words.replace(/\s*\n\s*/g, ' ')
    const material = chosen
      .map(({ n, message }) =>
        message.author
          ? `[${n}] Comment by ${line(message.author)}${message.resolved ? ' (resolved)' : ''}: ${line(message.body)}`
          : `[${n}] Page text: ${line(message.body)}`,
      )
      .join('\n')
    return [
      `Here are numbered parts of a team's page${open.title ? ` called "${open.title}"` : ''}: passages of its text, and comments on it.`,
      '',
      material,
      '',
      `Answer this question using only those parts: ${question}`,
      'After each statement, cite the parts it came from like [1] or [2][3].',
      'If the parts do not answer the question, say so instead of guessing.',
      'Reply with the answer only — no preamble and nothing about being an assistant.',
    ].join('\n')
  }
  const material = chosen
    .map(({ n, message }) => `[${n}] ${message.author}: ${message.body}`)
    .join('\n')
  return [
    'Here are numbered messages from a team conversation:',
    '',
    material,
    '',
    `Answer this question using only those messages: ${question}`,
    'After each statement, cite the messages it came from like [1] or [2][3].',
    'If the messages do not answer the question, say so instead of guessing.',
    'Reply with the answer only — no preamble and nothing about being an assistant.',
  ].join('\n')
}

export interface ParsedAnswer {
  /** The answer with unusable citation markers taken out. */
  text: string
  /** The numbers actually cited, in order of first appearance, deduplicated. */
  cited: number[]
}

/**
 * Split an answer from its citations, keeping only citations that exist.
 *
 * A small model will cite `[7]` when it was given four messages. Rendering that
 * as a source is impossible and rendering it as text is noise, so an
 * out-of-range marker is removed from the prose and never becomes a row. This
 * is the one place the model's output is not taken at face value, and it is the
 * place where taking it at face value would put a fabricated source in front of
 * somebody.
 */
export function parseAnswer(raw: string, count: number): ParsedAnswer {
  const cited: number[] = []
  const text = raw
    .replace(/\[(\d+)\]/g, (marker, digits: string) => {
      const n = Number(digits)
      if (n < 1 || n > count) return ''
      if (!cited.includes(n)) cited.push(n)
      return marker
    })
    // Markers removed mid-sentence leave doubled spaces and space-before-period.
    .replace(/[ \t]{2,}/g, ' ')
    .replace(/\s+([.,;:!?])/g, '$1')
    .trim()
  return { text, cited }
}

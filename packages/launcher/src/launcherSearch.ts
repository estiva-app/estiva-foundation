/**
 * Finding things from the launcher (PEE-4).
 *
 * > **Miky, 2026-08-19** — *"We could also add basic Topic search and People /
 * > Team search to make it little bit more useful."*
 *
 * One rule for the whole panel (SPEC §5.2): every typed word matches the start
 * of a word, in any order; `"…"` is those whole words next to each other, and
 * `-word` leaves out anything with a word starting that way. What Peek holds
 * on the device — people, apps, actions — is matched by `referenceMatch`, the
 * rule's reader half; files and messages are the relay's, asked from the
 * second letter typed. So "remov short" finds *Remove Short summary…* the same
 * way in every section, and nothing is found by the middle of a word: "aud"
 * no longer finds Claude.
 *
 * Until 2026-10-19 the relay matched whole words over Peek's socket, so a
 * message section had to say "needs a whole word" while the device's lists
 * matched any fragment. The relay now answers by word starts on every
 * connection, and the hint went with it.
 *
 * The message corpus is both kinds a conversation is written in — `kind:9`
 * in a topic and `kind:1111` on a file — since FOL-36; a hit's own tags say
 * which page it opens on (`MessageHit.file`).
 */
// why: https://github.com/estiva-app/estiva-docs/blob/main/decisions/search-matches-every-word-as-a-word-start.md
import { referenceMatch } from '@estiva-app/conversation'
import type { LauncherPerson } from './host.js'

/** Why a relay read brought nothing: no answer, a no, a no for now, or a place the person is not a member of. */
export type RelayFailureKind = 'unreachable' | 'refused' | 'rate_limited' | 'not_a_member'

/**
 * A window of text around the match, rather than the first N characters.
 *
 * Taken from `lib/peekSearch.ts`, which was a verbatim copy from the prototype,
 * claimed in its own header to *"power the launcher's 'In Peek' results"*, and
 * was imported by nothing. It searched the `TOPICS` / `TOPIC_CONVERSATIONS`
 * fixtures directly — so it could never see a message from production, which is
 * presumably why it fell out of use when the mock apps went (2026-08-31). This
 * function was the one part worth keeping; the file is deleted rather than left
 * beside a real implementation for somebody to find and trust.
 */
export function snippetAround(text: string, query: string, span = 76): string {
  const flat = text.replace(/\s+/g, ' ')
  const lower = flat.toLowerCase()
  // The first word asked for, where it starts a word as the relay matched it: "remov short" is
  // two words apart in the text, `-draft` is left out, and "mov" is not the middle of "remove".
  const found = (query.replace(/(^|\s)-\S*/g, ' ').match(/[\p{L}\p{N}]+/u)?.[0] ?? '').toLowerCase()
  const idx = found ? lower.search(new RegExp(`(?<![\\p{L}\\p{N}])${found}`, 'u')) : -1
  if (idx < 0) return flat.slice(0, span)
  const start = Math.max(0, idx - Math.floor((span - found.length) / 2))
  const end = Math.min(flat.length, start + span)
  return `${start > 0 ? '…' : ''}${flat.slice(start, end).trim()}${end < flat.length ? '…' : ''}`
}

/** Whether `text` matches what was typed, by the panel's one rule. */
export function launcherMatch(text: string, query: string): boolean {
  return referenceMatch(text, query) > 0
}

/**
 * Whether what was typed has stopped being a search: up to two words is a
 * search, from the third it is a prompt (Miky, on the prototype, 5 November
 * 2026). A quote or a leading minus is search syntax, so those words stay a
 * search however many there are.
 */
// why: https://github.com/estiva-app/estiva-docs/blob/main/decisions/search-matches-every-word-as-a-word-start.md
export function isPrompt(text: string): boolean {
  const words = text.trim().split(/\s+/).filter(Boolean)
  if (words.length < 3) return false
  return !words.some((word) => word.includes('"') || (word.startsWith('-') && word.length > 1))
}

/**
 * People by name **or role**, because "designer" is a thing somebody looks for
 * and a role is the only place it is written down.
 */
export function matchPeople<P extends LauncherPerson>(people: readonly P[], query: string, limit = 5): P[] {
  return people.filter((p) => launcherMatch(`${p.name} ${p.role ?? ''}`, query)).slice(0, limit)
}

/** How the message search ended, which decides what the section says. */
export type MessageSearchState =
  /** Nothing typed yet. */
  | { kind: 'idle' }
  /** In flight. */
  | { kind: 'searching' }
  /** The relay answered. `count` may be zero. */
  | { kind: 'done'; count: number }
  /** The relay did not answer, or answered no. */
  | { kind: 'failed'; failure: RelayFailureKind }
  /** No token, so there was nothing to ask with. */
  | { kind: 'signed-out' }

/**
 * The sentence the message section shows, or `null` when it has results to
 * show instead.
 *
 * PEE-4's done-when is explicit that **the empty state distinguishes "nothing
 * matched" from "nothing you can read"**, and those are the two lines that used
 * to be one. `RelayReadError` already classifies the difference (PEE-10), so
 * this only has to not throw it away.
 */
export function messageEmptyState(state: MessageSearchState): string | null {
  switch (state.kind) {
    case 'idle':
      return null
    case 'searching':
      return 'Searching messages…'
    case 'signed-out':
      return 'Sign in to search messages.'
    case 'failed':
      /*
        `not_a_member` is an answer, not an outage — the viewer is not in that
        channel, arrived at successfully. Saying "could not reach" there would
        report a healthy relay as broken.
      */
      return state.failure === 'not_a_member'
        ? 'No messages you can read match — some conversations are not yours to see.'
        : state.failure === 'refused'
          ? 'The relay refused the search, so this list is incomplete.'
          : state.failure === 'rate_limited'
            ? // Not an outage: the relay answered, and said to come back. A
              // search is typed, so it is retried by typing rather than on a
              // timer — the sentence has to invite that rather than report a
              // broken relay (FOL-40).
              'The relay is busy, so messages are not included. Try again in a moment.'
            : 'Could not reach the relay, so messages are not included.'
    case 'done':
      return state.count > 0 ? null : 'No messages matched.'
  }
}

/**
 * The sentence the Files section adds (SUM-7), or `null`. Only a search that
 * did not happen is said: "nothing matched" is the launcher's own empty line,
 * and signing in is already asked by the messages' line.
 */
export function fileEmptyState(state: MessageSearchState): string | null {
  if (state.kind !== 'failed' || state.failure === 'not_a_member') return null
  return state.failure === 'refused'
    ? 'The relay refused the file search, so files are not included.'
    : state.failure === 'rate_limited'
      ? 'The relay is busy, so files are not included. Try again in a moment.'
      : 'Could not reach the relay, so files are not included.'
}

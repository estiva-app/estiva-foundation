/**
 * A message's opening words, as a caption — what `[`'s row for a comment
 * shows under its author, the same in every app (PEEKM-6).
 *
 * One line of plain words: marks and line prefixes gone, a link on words as
 * its words, a fenced code block's fences dropped. A `nostr:` reference reads
 * as its chip would without resolving anything (SPEC §13.1: "the URI's own
 * label or its shortened form, never blank"):
 *
 * - a person as `@Name`, or `@` and the key's shortened form when nobody here
 *   can name them;
 * - a message as "Message", a file by its type word ("Issue", "Project",
 *   "Topic", "Document"), any other address as "File" — never by its title,
 *   so the same comment reads the same in an app that has the file loaded and
 *   one that does not (Miky, 27 October, PEEKM-6's kickoff).
 *
 * why: https://github.com/estiva-app/estiva-docs/blob/main/decisions/a-conversation-is-one-shared-thing-and-only-its-colours-are-the-apps.md
 */
import { decodeNpub, parseInlineMarks, referenceToPointer } from '@estiva-app/protocol'

/** A file's type word by its kind, as `[`'s Files rows name it. */
const TYPE_WORDS: Record<number, string> = { 30850: 'Project', 30851: 'Issue', 30840: 'Topic', 30842: 'Document', 39000: 'Folder' }

const FENCE = /^\s*(?:```|~~~)/
/** A line's block prefixes: quotes and headings, then one list or task marker. */
const LINE_PREFIX = /^\s*(?:(?:>|#{1,6})\s+)*(?:(?:[-*+]|\d+[.)])\s+(?:\[[ xX]\]\s+)?)?/
/**
 * A link on words, `[words](url)`: its words are what a reader sees. Swapped before the marks are read, so a `_` in a
 * URL is never one. The grammar is protocol's `parseInlineMarksAndLinks`, so what reads as a link here is what a reader
 * draws as one: a URL with an unclosed `(` (`…/Foo_(bar)`) is no link there, and stays as written here.
 */
const LINK_ON_WORDS = /(?<!!)\[([^[\]\n]+)\]\(((?:https?:\/\/|mailto:)[^\s)]+)\)/g
const linkWords = (whole: string, words: string, url: string) => (url.split('(').length > url.split(')').length ? whole : words)

/** The shortened form §13.1 asks for when a reference names nobody here. */
function shortened(uri: string): string {
  return `${uri.replace(/^nostr:/i, '').slice(0, 12)}…`
}

/** What a `nostr:` reference reads as in a caption, by its kind alone, or a person by name. */
export function referenceWord(uri: string, nameOf: (pubkey: string) => string | undefined): string {
  const bare = uri.replace(/^nostr:/i, '').toLowerCase()
  if (bare.startsWith('npub1')) {
    let name: string | undefined
    try {
      name = nameOf(decodeNpub(bare))
    } catch {
      name = undefined
    }
    return `@${name || shortened(uri)}`
  }
  if (bare.startsWith('naddr1')) {
    try {
      return TYPE_WORDS[referenceToPointer(bare).kind] ?? 'File'
    } catch {
      return 'File'
    }
  }
  if (bare.startsWith('nevent1') || bare.startsWith('note1')) return 'Message'
  return `@${shortened(uri)}`
}

/** A message body's opening words on one line, as a caption: see the module's note. */
export function openingWords(body: string, nameOf: (pubkey: string) => string | undefined): string {
  return body
    .split('\n')
    .filter((line) => !FENCE.test(line))
    .map((line) =>
      parseInlineMarks(line.replace(LINE_PREFIX, '').replace(LINK_ON_WORDS, linkWords))
        .map((span) => (span.reference ? referenceWord(span.reference, nameOf) : span.text))
        .join(''),
    )
    .join(' ')
    .replace(/\s+/g, ' ')
    .trim()
}

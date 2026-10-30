/**
 * A message's opening words, as a caption — what `[`'s row for a comment
 * shows under its author, and any preview of a message, the same in every app
 * (PEEKM-6).
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
 * A bare app URL that names a file or a message reads as that reference would
 * (§13.6.2, "A bare app link reads as a reference"), never as the raw URL
 * (Katerina, 30 October, widget review item 20). A URL nothing claims stays
 * as written (§13.1), and so does one in code.
 *
 * why: https://github.com/estiva-app/estiva-docs/blob/main/decisions/a-conversation-is-one-shared-thing-and-only-its-colours-are-the-apps.md
 */
import { decodeNpub, parseInlineMarks, referenceOfLink, referenceToPointer, urlRunsIn, type LinkResolver } from '@estiva-app/protocol'

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

/** A reference to a file or a message: the ones a caption names by a type word, not by anything its writer typed. */
const OBJECT_REFERENCE = /^nostr:(?:naddr1|nevent1|note1)/i

export interface OpeningWordsOptions {
  /**
   * What an app link names (§7.7), as answered so far — the resolver the app
   * gives its box (`BoxLinkContext.resolveLink`). A bare app URL it answers
   * reads as the reference it names ("Issue", "Message"); one it does not —
   * nothing claims it, or the answer has not come back yet — stays as
   * written. Without it, every URL stays as written.
   */
  resolveLink?: LinkResolver
}

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

/**
 * How a line is read: `caption`, as a preview shows it ({@link openingWords}); `words`, only what its writer
 * wrote ({@link messageWords}). `code` is a line of a fenced code block, where a URL is literal (§13.1).
 */
interface Reading {
  mode: 'caption' | 'words'
  nameOf: (pubkey: string) => string | undefined
  resolveLink?: LinkResolver
  code?: boolean
}

/** A character `text` does not hold, from the private use area. */
function unusedCharacter(text: string): string | undefined {
  for (let code = 0xe000; code <= 0xf8ff; code++) {
    const ch = String.fromCharCode(code)
    if (!text.includes(ch)) return ch
  }
  return undefined
}

/** A bare URL as the line reads it: the reference's word in a caption, as written in code or when nothing claims it. */
function urlWord(url: string, reading: Reading): string {
  if (reading.code) return url
  if (reading.mode === 'words') return ''
  const reference = reading.resolveLink ? referenceOfLink(url, reading.resolveLink) : undefined
  return reference ? referenceWord(reference, reading.nameOf) : url
}

/** Each bare URL in a run of plain text, as the line reads it; the rest as it is. */
function withUrlsRead(text: string, reading: Reading): string {
  let out = ''
  let at = 0
  for (const { url, from, to } of urlRunsIn(text)) {
    out += text.slice(at, from) + urlWord(url, reading)
    at = to
  }
  return out + text.slice(at)
}

/** A `nostr:` reference as the line reads it: its word, or nothing in a message's own words when it names a file or a message. */
function referenceAs(uri: string, reading: Reading): string {
  return reading.mode === 'words' && OBJECT_REFERENCE.test(uri) ? '' : referenceWord(uri, reading.nameOf)
}

/**
 * One line's words. A bare URL is found in the text the marks leave, as a reader finds it (`urlRunsIn`), and read by
 * {@link urlWord}. A URL written in a link's words names nothing (§13.6.2), so its `://` is broken by a character the
 * line does not hold until the line is read. Protocol's mark reader recurses once per mark, so a line of a few thousand
 * (anyone can post one) overflows the stack; that line then reads as its text with the marker characters dropped,
 * rather than taking down every `[` list that captions it (Peek: Feedback & Bugs 4acb43ac is the reader's own fix).
 */
function lineWords(line: string, reading: Reading): string {
  const mark = line.includes('://') ? unusedCharacter(line) : undefined
  const text = line.replace(LINK_ON_WORDS, (whole: string, words: string, url: string) => {
    const read = linkWords(whole, words, url)
    return read !== whole && mark ? read.replaceAll('://', `:${mark}//`) : read
  })
  const unmark = (words: string) => (mark ? words.replaceAll(mark, '') : words)
  try {
    return parseInlineMarks(text)
      .map((span) => (span.reference ? referenceAs(span.reference, reading) : unmark(span.code ? span.text : withUrlsRead(span.text, reading))))
      .join('')
  } catch {
    return unmark(withUrlsRead(text.replace(/[*_~`]+/g, ''), reading))
  }
}

/** A body's lines on one line, read as `reading` says, a code block's fences dropped. */
function bodyWords(body: string, reading: Omit<Reading, 'code'>): string {
  let inCode = false
  const lines: string[] = []
  for (const line of body.split('\n')) {
    if (FENCE.test(line)) {
      inCode = !inCode
      continue
    }
    lines.push(lineWords(line.replace(LINE_PREFIX, ''), { ...reading, code: inCode }))
  }
  return lines.join(' ').replace(/\s+/g, ' ').trim()
}

/** A message body's opening words on one line, as a caption: see the module's note. */
export function openingWords(body: string, nameOf: (pubkey: string) => string | undefined, options: OpeningWordsOptions = {}): string {
  return bodyWords(body, { mode: 'caption', nameOf, resolveLink: options.resolveLink })
}

/**
 * The words a message is found by in `[` (Katerina, 30 October, widget review
 * item 19): what its writer wrote, read as {@link openingWords} reads it, but
 * with no link's raw text — no bare URL, resolved or not — and no type word
 * for a file or a message it names, so typing a file's word finds the file,
 * not every message that links to it. A link on words keeps its words, a
 * person reads as `@Name`, and code is kept as written.
 */
export function messageWords(body: string, nameOf: (pubkey: string) => string | undefined): string {
  return bodyWords(body, { mode: 'words', nameOf })
}

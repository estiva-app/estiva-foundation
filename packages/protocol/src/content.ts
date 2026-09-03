/**
 * The message marker dialect — SPEC §13.1 and §13.2.
 *
 * ## Why content is in a package that "interprets nothing"
 *
 * `index.ts` draws the line at *interpretation*: the fold stays in the apps,
 * because how an app turns events into current truth is where apps are supposed
 * to differ. A body's formatting is on the other side of that line for the same
 * reason the event id is — **it is wire-visible, and two apps disagreeing about
 * it produces a divergence each copy is self-consistent about and nobody
 * notices.** That is not a hypothetical: measured on production 2026-09-02,
 * 261 of 548 published messages carry structure, Peek parses it, Ship renders
 * it literally, and neither is wrong about its own behaviour.
 *
 * Being honest about the usual test: the relay would *not* notice if two apps
 * disagreed here, so §10's question is a poor fit. What makes this belong is the
 * failure shape rather than the arbiter — see RFC 0.4 §14.3, which put the
 * inline layer here, and SPEC §13.1, which made it normative.
 *
 * **What is deliberately not here.** Mentions resolved against a directory,
 * bracket references to an app's own objects, and anything that needs to know
 * what a topic or a file is. Peek's `textParsing.ts` mixes those with the marks;
 * only the marks moved. A `nostr:` reference is a mark and its *token* is in
 * scope, but what a mention does is RIC-2's.
 */

import { NOSTR_URI_RE } from './nip19.js'

/** Marks a run of text can carry. `code` is exclusive — see {@link parseInlineMarks}. */
export type InlineMark = 'bold' | 'italic' | 'underline' | 'code'

/** A run of text and the marks on it. */
export interface InlineMarkSpan {
  text: string
  bold?: boolean
  italic?: boolean
  underline?: boolean
  code?: boolean
  /**
   * The `nostr:` URI this run points at — SPEC §13.1's `reference` mark.
   *
   * A value rather than a flag, because the whole point of a reference is
   * *what* it names. `text` stays the URI itself, which is what a reader that
   * cannot resolve it must show (§13.1: "the URI's own label or its shortened
   * form, never blank").
   */
  reference?: string
}

/** A block-level run, parsed from line prefixes. */
export type BodySegment =
  | { type: 'text'; lines: string[] }
  | { type: 'bullet'; items: string[] }
  | {
      type: 'numbered'
      items: string[]
      /**
       * The number the author actually wrote, when it is not 1.
       *
       * A body can hold two numbered runs separated by a paragraph, the second
       * written to continue the first — `2.` after an earlier `1.`. Discarding
       * it renumbers somebody's list, which is a change to what they wrote
       * rather than a rendering choice. Absent means 1.
       */
      start?: number
    }
  | { type: 'heading'; level: 1 | 2; text: string }
  | { type: 'quote'; lines: string[] }
  | { type: 'code'; language?: string; lines: string[] }

interface MarkToken {
  token: string
  keys: InlineMark[]
  /**
   * The content is taken literally and no mark may nest inside it, and the
   * adjacency fence below does not apply to the delimiter.
   */
  literal?: boolean
}

/**
 * Longest token first so `***` is not consumed as `**` plus a dangling `*`.
 *
 * Order only decides ties at one index — the scanner walks left to right, so the
 * leftmost opening delimiter wins regardless of what is listed first.
 */
const MARK_TOKENS: MarkToken[] = [
  { token: '***', keys: ['bold', 'italic'] },
  { token: '**', keys: ['bold'] },
  { token: '__', keys: ['underline'] },
  { token: '*', keys: ['italic'] },
  { token: '`', keys: ['code'], literal: true },
]

const isWordChar = (ch: string | undefined) => ch !== undefined && /[A-Za-z0-9]/.test(ch)

/**
 * SPEC §13.2 rule 2 — a marker adjacent to an alphanumeric is not a marker, so
 * `2*3*4` stays literal math.
 *
 * **It does not apply to a backtick.** Rule 2 resolves an ambiguity that only
 * asymmetric prose markers have: `*` is multiplication and a glob, `_` is in
 * identifiers. A backtick is not used as ordinary punctuation, so there is no
 * ambiguity to resolve — and applying the fence anyway leaves `` `main`s ``
 * literal, which is a code span followed by a plural or possessive. Measured
 * against production 2026-09-02: 8 such spans in 6 published messages, and zero
 * cases of the opening side needing the fence. CommonMark agrees.
 */
function findMarkClose(text: string, token: string, from: number, fenced: boolean): number {
  let idx = text.indexOf(token, from)
  while (idx !== -1) {
    if (!fenced || !isWordChar(text[idx + token.length])) return idx
    idx = text.indexOf(token, idx + 1)
  }
  return -1
}

function toMarkSpan(text: string, active: InlineMark[]): InlineMarkSpan {
  const span: InlineMarkSpan = { text }
  for (const key of active) span[key] = true
  return span
}

function scanMarks(text: string, active: InlineMark[]): InlineMarkSpan[] {
  for (let i = 0; i < text.length; i++) {
    for (const { token, keys, literal } of MARK_TOKENS) {
      if (keys.some((k) => active.includes(k))) continue
      if (!text.startsWith(token, i)) continue
      const fenced = !literal
      if (fenced && isWordChar(text[i - 1])) continue
      const close = findMarkClose(text, token, i + token.length, fenced)
      if (close === -1) continue
      const inner = text.slice(i + token.length, close)
      // SPEC §13.2 rule 1: whitespace at the inner edges means it is not a pair.
      if (!inner || /^\s/.test(inner) || /\s$/.test(inner)) continue
      const spans: InlineMarkSpan[] = []
      const before = text.slice(0, i)
      if (before) spans.push(toMarkSpan(before, active))
      if (literal) {
        /*
          SPEC §13.1: code MUST NOT combine with any other mark, and its content
          MUST NOT be parsed for further marks. So the span carries `code` alone
          even inside an enclosing bold — dropping the outer mark rather than
          emitting a combination the spec forbids.
        */
        spans.push({ text: inner, code: true })
      } else {
        spans.push(...scanMarks(inner, [...active, ...keys]))
      }
      spans.push(...scanMarks(text.slice(close + token.length), active))
      return spans
    }
  }
  return text ? [toMarkSpan(text, active)] : []
}

/**
 * Parse one plain-text run into styled spans.
 *
 * Split mentions and app-specific references out first — this function knows
 * about marks and nothing else.
 */
export function parseInlineMarks(text: string): InlineMarkSpan[] {
  return scanMarks(text, []).flatMap(splitReferences)
}

/**
 * Split a run on its `nostr:` URIs — SPEC §13.1's `reference` mark.
 *
 * A separate pass because a reference is not a delimiter pair: there is nothing
 * to open and close, only a token to recognise. Running it *after* the marker
 * scan means a reference inside bold stays bold, and a reference inside `code`
 * is never split at all — code content is literal (§13.1), and a URI somebody
 * quoted as an example is not a link to follow.
 */
function splitReferences(span: InlineMarkSpan): InlineMarkSpan[] {
  if (span.code || !span.text.includes('nostr:')) return [span]
  const out: InlineMarkSpan[] = []
  let last = 0
  for (const match of span.text.matchAll(NOSTR_URI_RE)) {
    const at = match.index ?? 0
    if (at > last) out.push({ ...span, text: span.text.slice(last, at) })
    const uri = `nostr:${match[1].toLowerCase()}`
    out.push({ ...span, text: match[0], reference: uri })
    last = at + match[0].length
  }
  if (last < span.text.length) out.push({ ...span, text: span.text.slice(last) })
  return out
}

/**
 * Wrap a run of text in the markers for the marks it carries.
 *
 * Edge whitespace is hoisted outside the markers, because `**word **` would not
 * parse back under rule 1 — so bolding "word " round-trips as `**word** `.
 *
 * `code` wins alone, for the same reason the parser never emits it combined.
 */
export function wrapInlineMarks(text: string, markNames: ReadonlySet<string>): string {
  // A reference needs no markers: the URI *is* its marker-text form, which is
  // why §13.1 can share one vocabulary across two encodings without the message
  // dialect growing a syntax for it.
  if (markNames.has('reference')) return text
  if (!text) return text
  const bold = markNames.has('bold')
  const italic = markNames.has('italic')
  const underline = markNames.has('underline')
  const code = markNames.has('code')
  if (!bold && !italic && !underline && !code) return text
  const m = text.match(/^(\s*)([\s\S]*?)(\s*)$/)!
  const [, lead, core, trail] = m
  if (!core) return text
  if (code) return `${lead}\`${core}\`${trail}`
  let out = core
  if (bold && italic) out = `***${out}***`
  else if (bold) out = `**${out}**`
  else if (italic) out = `*${out}*`
  if (underline) out = `__${out}__`
  return lead + out + trail
}

const HEADING_LINE_RE = /^#{1,2}\s/
/** `> ` with the space required — a bare `>` typed at a line start ("5 > 3")
 *  stays literal, the same conservatism as the inline markers. */
const QUOTE_LINE_RE = /^>\s/
const FENCE_RE = /^```/

/**
 * Where the fence opened at `from` closes, or -1 if it never does.
 *
 * An unclosed fence is not a fence: SPEC §13.2 requires an unmatched marker to
 * render literally, and swallowing the rest of the body because somebody typed
 * three backticks is the opposite of that.
 */
function fenceCloses(lines: string[], from: number): number {
  if (!FENCE_RE.test(lines[from])) return -1
  for (let j = from + 1; j < lines.length; j++) if (FENCE_RE.test(lines[j])) return j
  return -1
}

/**
 * Split a body into block segments.
 *
 * Blank lines split runs of plain text into separate `text` segments. `# ` and
 * `## ` become headings; three or more `#`s, and a `#123` reference with no
 * space, stay plain text.
 */
export function parseBodySegments(body: string): BodySegment[] {
  const lines = body.split('\n')
  const segments: BodySegment[] = []
  let i = 0
  while (i < lines.length) {
    const line = lines[i]
    const fenceEnd = fenceCloses(lines, i)
    if (fenceEnd !== -1) {
      const language = line.slice(3).trim()
      segments.push({
        type: 'code',
        ...(language ? { language } : {}),
        lines: lines.slice(i + 1, fenceEnd),
      })
      i = fenceEnd + 1
    } else if (HEADING_LINE_RE.test(line) && !line.startsWith('###')) {
      segments.push({
        type: 'heading',
        level: line.startsWith('##') ? 2 : 1,
        text: line.replace(HEADING_LINE_RE, ''),
      })
      i++
    } else if (/^[-•]\s/.test(line)) {
      const items: string[] = []
      while (i < lines.length && /^[-•]\s/.test(lines[i])) {
        items.push(lines[i].replace(/^[-•]\s/, ''))
        i++
      }
      segments.push({ type: 'bullet', items })
    } else if (/^\d+\.\s/.test(line)) {
      const items: string[] = []
      const first = Number.parseInt(line, 10)
      while (i < lines.length && /^\d+\.\s/.test(lines[i])) {
        items.push(lines[i].replace(/^\d+\.\s/, ''))
        i++
      }
      segments.push({ type: 'numbered', items, ...(first > 1 ? { start: first } : {}) })
    } else if (QUOTE_LINE_RE.test(line)) {
      const quoteLines: string[] = []
      while (i < lines.length && QUOTE_LINE_RE.test(lines[i])) {
        quoteLines.push(lines[i].replace(QUOTE_LINE_RE, ''))
        i++
      }
      segments.push({ type: 'quote', lines: quoteLines })
    } else {
      const textLines: string[] = []
      while (
        i < lines.length &&
        fenceCloses(lines, i) === -1 &&
        !/^[-•]\s/.test(lines[i]) &&
        !/^\d+\.\s/.test(lines[i]) &&
        !QUOTE_LINE_RE.test(lines[i]) &&
        !(HEADING_LINE_RE.test(lines[i]) && !lines[i].startsWith('###'))
      ) {
        textLines.push(lines[i])
        i++
      }
      let chunk: string[] = []
      for (const l of textLines) {
        if (l === '') {
          if (chunk.length > 0) { segments.push({ type: 'text', lines: chunk }); chunk = [] }
        } else {
          chunk.push(l)
        }
      }
      if (chunk.length > 0) segments.push({ type: 'text', lines: chunk })
    }
  }
  return segments
}

/**
 * Markers, heading prefixes and fences removed — for one-line previews that
 * render body text raw, outside any renderer.
 *
 * **Prefixes stack, and the order they are removed in is not cosmetic.** The
 * version this was extracted from removed the heading prefix first and the
 * quote prefix second, so `> # Heading` — a quoted heading, which the corpus is
 * full of because every project brief quotes one — came back as `# Heading` and
 * a preview showed a stray `#`. Stripping until the line stops changing removes
 * whatever order they were written in. Found by running this over 152 real
 * published bodies, not by reading the code.
 */
function stripLinePrefixes(line: string): string {
  let out = line
  for (;;) {
    const next = out.replace(/^>\s/, '').replace(/^#{1,2}\s/, '')
    if (next === out) return out
    out = next
  }
}

export function stripInlineFormatting(text: string): string {
  return text
    .split('\n')
    .filter((line) => !FENCE_RE.test(line))
    .map((line) => parseInlineMarks(stripLinePrefixes(line)).map((s) => s.text).join(''))
    .join('\n')
}

// ── The inline vocabulary's second serialisation — SPEC §13.1 ──
//
// The same marks, encoded as JSON nodes instead of markers, because a block
// document's inline content is an array of these (§13.3). RIC-4 shipped the
// marker side and deliberately stopped there: this half had no consumer until
// the block model existed, and designing an encoding against no caller is how
// you get one nobody can use.
//
// **The vocabulary is shared; the encoding is not.** That is the whole shape of
// SPEC §13 — a message and a paragraph mean the same thing by "bold", and agree
// about nothing else.

/** A mark on an inline run, in the JSON encoding. */
export type InlineMarkNode =
  | { type: InlineMark }
  /** §13.1's `reference`, which carries what it points at. */
  | { type: 'reference'; attrs: { uri: string } }

/** One run of text and its marks — §13.3's `{"type":"text","text":…,"marks":[…]}`. */
export interface InlineTextNode {
  type: 'text'
  text: string
  marks?: InlineMarkNode[]
}

/** Deterministic order, so the same marks always serialise to the same JSON.
 *  Two encoders disagreeing about array order would produce documents that
 *  differ byte-for-byte while meaning the same thing, and every equality check
 *  downstream — a diff, a dedupe, a cache key — would be wrong about it. */
const MARK_ORDER: InlineMark[] = ['bold', 'italic', 'underline', 'code']

/** Marker text → inline JSON nodes. */
export function markersToInlineNodes(text: string): InlineTextNode[] {
  return parseInlineMarks(text).map((span) => {
    const marks: InlineMarkNode[] = MARK_ORDER.filter((m) => span[m]).map((type) => ({ type }))
    if (span.reference) marks.push({ type: 'reference', attrs: { uri: span.reference } })
    return marks.length ? { type: 'text' as const, text: span.text, marks } : { type: 'text' as const, text: span.text }
  })
}

/**
 * Inline JSON nodes → marker text.
 *
 * The inverse of {@link markersToInlineNodes} for every mark the dialect can
 * spell, which is all four of them. Whitespace at a run's edges is hoisted
 * outside the markers by `wrapInlineMarks`, because §13.2 rule 1 would not
 * parse it back otherwise — so this round-trips the *marks on each character*
 * rather than the span boundaries. See the corpus tests.
 */
export function inlineNodesToMarkers(nodes: readonly InlineTextNode[]): string {
  return nodes
    .map((node) => wrapInlineMarks(node.text, new Set((node.marks ?? []).map((m) => m.type))))
    .join('')
}

/** The plain text of a run of inline nodes, marks discarded. */
export function inlineNodesToText(nodes: readonly InlineTextNode[]): string {
  return nodes.map((n) => n.text).join('')
}

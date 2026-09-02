/**
 * One tree, whichever content model the body is in — SPEC §13.5.
 *
 * §13.5 asks for a renderer *"safe by construction"*, and the safety is not in
 * a component: it is in never handing an app a string it has to interpret.
 * What this module produces is a fully resolved tree — marks decided, blocks
 * decided, nothing left to parse and nothing to interpolate — so the app's only
 * remaining job is to create elements and set text. An app that maps this tree
 * cannot accidentally render markup, because there is no markup in it.
 *
 * ## Why a tree rather than a shared component
 *
 * Not because the apps use different frameworks — Ship and Peek are both React
 * and already share `@estiva-app/ui`, so a component was possible. Because
 * **how rich text looks is the consumer's**, which is the same rule RFC 0.4
 * §13.1 states for projections — *the owner defines the projection, the
 * consumer decides how it looks* — and SPEC §10's line about apps sharing the
 * wire and never the interpretation. A shared component would make Ship and
 * Peek look alike by construction, which is not a property anybody asked for.
 *
 * So: one parse, one resolution, two designs.
 *
 * ## The three formats, including the one nobody has written yet
 *
 * `toRenderTree` takes the format from `contentFormatOf` in
 * `@estiva-app/interop` — the tag, never the body (§13.4). `'unknown'` is the
 * interesting one: a format declared after this code was written becomes a
 * single unmarked paragraph of the raw value, which §13.5 says is conformant.
 * Handling it here rather than in each consumer is what stops one app deciding
 * to guess.
 */
import {
  type BodySegment,
  type InlineMark,
  type InlineTextNode,
  parseBodySegments,
  parseInlineMarks,
} from './content.js'
import { type Block, type BlockDocument, parseBlockDocument, inlineTextOf } from './blocks.js'
import type { SignedEvent } from './events.js'

/** A run of text and the marks on it. Nothing here needs escaping; it is text. */
export interface RenderInline {
  text: string
  marks: InlineMark[]
}

/**
 * A resolved block.
 *
 * **A `\n` inside `inline` text is a line break**, in both content models — it
 * is how a marker-text paragraph carries its lines, and it keeps a consumer
 * from needing two rules. Splitting on it is the consumer's whole obligation.
 */
export interface RenderBlock {
  type:
    | 'paragraph' | 'heading' | 'bulletList' | 'orderedList' | 'listItem'
    | 'blockquote' | 'codeBlock' | 'table' | 'horizontalRule'
    | 'attachment' | 'widget' | 'unknown'
  /** The block's address, from a block document. Marker text has no addressable
   *  sub-unit (§13.1), so it is absent — which is the difference that matters. */
  id?: string
  level?: 1 | 2 | 3
  language?: string
  /** An ordered list's first number, when the author did not start at 1. */
  start?: number
  attrs?: Record<string, unknown>
  /** What the document actually called it, when `type` is `'unknown'`. */
  typeName?: string
  inline?: RenderInline[]
  children?: RenderBlock[]
}

/**
 * What content model a body is written in — SPEC §13.4.
 *
 * Three values, not two, and not the raw tag string. A consumer makes a
 * three-way decision and **must not guess the third**:
 *
 * - `marker` — the §13.2 dialect. The default, permanently. 731 published
 *   bodies carry no tag and none of them can be given one, so this is not a
 *   migration window that closes.
 * - `blocks` — a §13.3 JSON block document.
 * - `unknown` — a format declared after this runtime was written. Render the
 *   body as plain text; §13.5 says declining to format is conformant, and
 *   parsing it as either known model is what §13 forbids outright.
 *
 * Resolved in one place rather than per consumer for the reason `CLOSED_WIDGETS`
 * is: two copies of `tag === undefined ? marker : tag === 'estiva-blocks-1' ?
 * blocks : text` disagree the first time a third format exists, and the
 * disagreement shows up as one app rendering JSON at a person.
 */
export type ContentFormat = 'marker' | 'blocks' | 'unknown'

/**
 * @deprecated The name this shipped under in 0.8.0. It is `ContentFormat`.
 * Kept as an alias so 0.8.0's consumers keep compiling.
 */
export type RenderFormat = ContentFormat

/** The tag SPEC §13.4 defines. Absence is a declaration, not an omission. */
export const CONTENT_FORMAT_TAG = 'content-format'

/** The one format §13.3 names today. */
export const BLOCK_DOCUMENT_FORMAT = 'estiva-blocks-1'

/**
 * The content model an event's body is in.
 *
 * **Decided by the tag alone.** §13.4 is explicit that a reader MUST NOT decide
 * by inspecting the body: a legacy description that happens to begin with `{`
 * is marker text, because it carries no tag.
 *
 * **Why this lives here and not in `@estiva-app/interop`, where it was born.**
 * It arrived with the projection layer because that is what needed it first,
 * and reading a tag off an event looked like a question about a slot. It is
 * not — it is a question about an event, which is this package's subject. Two
 * folds now need it and neither is a projection consumer: Ship's and the
 * agent's, which are the same fold in two repositories held to one recorded
 * state. Making either of them depend on the projection layer to read a tag
 * would be the wrong direction, and a second copy of the rule is what this
 * package exists to prevent. `interop` re-exports these, so nothing it
 * published has moved.
 */
export function contentFormatOf(event: SignedEvent): ContentFormat {
  const declared = event.tags.find((t) => t[0] === CONTENT_FORMAT_TAG)?.[1]
  if (declared === undefined || declared === '') return 'marker'
  return declared === BLOCK_DOCUMENT_FORMAT ? 'blocks' : 'unknown'
}

const KNOWN: ReadonlySet<string> = new Set([
  'paragraph', 'heading', 'bulletList', 'orderedList', 'listItem',
  'blockquote', 'codeBlock', 'table', 'horizontalRule', 'attachment', 'widget',
])

const marksOf = (span: { bold?: boolean; italic?: boolean; underline?: boolean; code?: boolean }): InlineMark[] => {
  const out: InlineMark[] = []
  if (span.bold) out.push('bold')
  if (span.italic) out.push('italic')
  if (span.underline) out.push('underline')
  if (span.code) out.push('code')
  return out
}

const inlineFromMarkers = (text: string): RenderInline[] =>
  parseInlineMarks(text).map((s) => ({ text: s.text, marks: marksOf(s) }))

/** One inline run per line, joined by the `\n` the interface documents. */
const inlineFromLines = (lines: string[]): RenderInline[] => inlineFromMarkers(lines.join('\n'))

function blockFromSegment(seg: BodySegment): RenderBlock {
  switch (seg.type) {
    case 'heading':
      return { type: 'heading', level: seg.level, inline: inlineFromMarkers(seg.text) }
    case 'bullet':
      return {
        type: 'bulletList',
        children: seg.items.map((item) => ({ type: 'listItem' as const, inline: inlineFromMarkers(item) })),
      }
    case 'numbered':
      return {
        type: 'orderedList',
        ...(seg.start ? { start: seg.start } : {}),
        children: seg.items.map((item) => ({ type: 'listItem' as const, inline: inlineFromMarkers(item) })),
      }
    case 'quote':
      return { type: 'blockquote', inline: inlineFromLines(seg.lines) }
    case 'code':
      // A fence is literal by definition — its content is never mark-parsed.
      return {
        type: 'codeBlock',
        ...(seg.language ? { language: seg.language } : {}),
        inline: [{ text: seg.lines.join('\n'), marks: [] }],
      }
    case 'text':
      return { type: 'paragraph', inline: inlineFromLines(seg.lines) }
  }
}

const isInlineRun = (content: unknown): content is InlineTextNode[] =>
  Array.isArray(content) && content.every((n) => typeof n === 'object' && n !== null && (n as { type?: unknown }).type === 'text')

function blockFromDocument(block: Block): RenderBlock {
  const known = KNOWN.has(block.type)
  const out: RenderBlock = {
    type: (known ? block.type : 'unknown') as RenderBlock['type'],
    id: block.id,
    ...(known ? {} : { typeName: block.type }),
    ...(block.attrs ? { attrs: block.attrs } : {}),
  }
  const level = block.attrs?.level
  if (block.type === 'heading' && (level === 1 || level === 2 || level === 3)) out.level = level
  const language = block.attrs?.language
  if (block.type === 'codeBlock' && typeof language === 'string') out.language = language
  const start = block.attrs?.start
  if (block.type === 'orderedList' && typeof start === 'number' && start > 1) out.start = start

  if (Array.isArray(block.content)) {
    if (isInlineRun(block.content)) {
      out.inline = block.content.map((node) => ({
        text: node.text,
        marks: (node.marks ?? []).map((m) => m.type),
      }))
    } else {
      out.children = (block.content as Block[]).map(blockFromDocument)
    }
  }
  /*
    §13.3: a reader MUST render an unknown block's inline text and MUST NOT drop
    it. A later version could nest content in a shape this code cannot walk, so
    the fallback reads the text by shape rather than trusting the walk above to
    have found it.
  */
  if (!known && !out.inline && !out.children) {
    const text = inlineTextOf(block)
    if (text) out.inline = [{ text, marks: [] }]
  }
  return out
}

/**
 * The body, resolved.
 *
 * `format` comes from the event's `content-format` tag — `contentFormatOf` in
 * `@estiva-app/interop`. Do not infer it from `value`: §13.4 forbids it, and a
 * legacy description that happens to begin with `{` is the case that proves
 * why.
 *
 * A body in an unparseable state never throws here. A `'blocks'` value that is
 * not a document degrades to one unmarked paragraph — the same outcome as
 * `'unknown'` — because a reader that throws renders nothing at all, and a
 * description that is present is better shown as its own text than as an empty
 * field.
 */
export function toRenderTree(value: string, format: RenderFormat): RenderBlock[] {
  if (format === 'unknown') return plainParagraph(value)
  if (format === 'blocks') {
    let doc: BlockDocument
    try {
      doc = parseBlockDocument(value)
    } catch {
      return plainParagraph(value)
    }
    return doc.content.map(blockFromDocument)
  }
  return parseBodySegments(value).map(blockFromSegment)
}

function plainParagraph(value: string): RenderBlock[] {
  return value === '' ? [] : [{ type: 'paragraph', inline: [{ text: value, marks: [] }] }]
}

/** Every character a reader would see, for previews and search. */
export function renderTreeText(blocks: readonly RenderBlock[]): string {
  return blocks
    .map((b) => {
      const own = (b.inline ?? []).map((i) => i.text).join('')
      const kids = b.children ? renderTreeText(b.children) : ''
      return [own, kids].filter((s) => s !== '').join('\n')
    })
    .filter((s) => s !== '')
    .join('\n')
}

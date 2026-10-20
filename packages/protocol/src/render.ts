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
  targetMark,
} from './content.js'
import { type Block, type BlockDocument, type CalloutTone, parseBlockDocument, inlineTextOf, listItemDepths, listItemChecked, calloutTone } from './blocks.js'
import type { SignedEvent } from './events.js'
import { type LinkResolver, referenceOfLink } from './embeds.js'

/** A run of text and the marks on it. Nothing here needs escaping; it is text. */
export interface RenderInline {
  text: string
  marks: InlineMark[]
  /**
   * The `nostr:` URI this run points at — SPEC §13.1's `reference` mark.
   *
   * A value rather than a mark name, because a consumer needs *what* it points
   * at to draw anything useful. `text` remains the URI, so an app that resolves
   * nothing still shows the token rather than a blank.
   */
  reference?: string
  /**
   * The card its writer chose for this reference in a block document (§13.3,
   * "A reference's card"), as `cardLayout` reads it: absent for none. Only
   * `detailed` draws one, and only alone on its line (`documentLineDrawOf`). A
   * message's cards are its `embed` tags instead (§13.6.2), so a marker body
   * never has one.
   */
  embed?: 'compact' | 'detailed'
  /**
   * The URL a block document's `link` mark points this run at (§13.3). On a run
   * whose text is the URL, `linksAsReferences` turns it into the reference the
   * URL names, `embed` and all; a link on words keeps it.
   */
  href?: string
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
  /**
   * How far a list item is indented, when it is (§13.3, MAN-13): its
   * `attrs.indent` as `listItemDepths` reads it, so it is never more than one
   * below the item before. A list's items stay its flat `children`; drawing
   * them nested, and numbering each level from 1, is the reader's.
   */
  indent?: number
  /**
   * A checklist item's tick (§13.3, RIC-19): `true` or `false` on a checklist
   * item, absent on a plain one — `attrs.checked` as `listItemChecked` reads it.
   */
  checked?: boolean
  /**
   * A callout's tone (§13.3, RIC-19), absent on a plain quote — `attrs.tone` as
   * `calloutTone` reads it, so an unknown tone is already `note` here.
   */
  tone?: CalloutTone
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

const INLINE_MARKS: ReadonlySet<string> = new Set<InlineMark>(['bold', 'italic', 'underline', 'code'])

const marksOf = (span: { bold?: boolean; italic?: boolean; underline?: boolean; code?: boolean }): InlineMark[] => {
  const out: InlineMark[] = []
  if (span.bold) out.push('bold')
  if (span.italic) out.push('italic')
  if (span.underline) out.push('underline')
  if (span.code) out.push('code')
  return out
}

const inlineFromMarkers = (text: string): RenderInline[] =>
  parseInlineMarks(text).map((s) => ({
    text: s.text,
    marks: marksOf(s),
    ...(s.reference ? { reference: s.reference } : {}),
  }))

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
  const checked = block.type === 'listItem' ? listItemChecked(block) : undefined
  if (checked !== undefined) out.checked = checked
  const tone = block.type === 'blockquote' ? calloutTone(block) : undefined
  if (tone) out.tone = tone

  if (Array.isArray(block.content)) {
    if (isInlineRun(block.content)) {
      out.inline = block.content.map((node) => {
        const marks = node.marks ?? []
        const reference = targetMark(marks, 'reference')
        const link = reference ? undefined : targetMark(marks, 'link')
        const embed = cardLayout((reference ?? link)?.embed)
        return {
          text: node.text,
          // Only the four the vocabulary has: a mark this reader does not know is not one to draw (§13.3).
          marks: marks.map((m) => m.type).filter((type): type is InlineMark => INLINE_MARKS.has(type)),
          ...(reference ? { reference: reference.uri } : {}),
          ...(link ? { href: link.href } : {}),
          ...(embed ? { embed } : {}),
        }
      })
    } else {
      const children = block.content as Block[]
      out.children = children.map(blockFromDocument)
      if (block.type === 'bulletList' || block.type === 'orderedList') {
        // Flat on the wire and flat here, so a reader that draws only `inline`
        // still shows every item; `indent` is the depth it may nest them by.
        const depths = listItemDepths(children)
        out.children.forEach((child, i) => {
          if (child.type === 'listItem' && depths[i] > 0) child.indent = depths[i]
        })
      }
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

// ── Where a reference belongs — SPEC §13.1, RIC-10 ─────────────────────────

/**
 * The URI, when this block is nothing but one reference.
 *
 * **Two apps must agree about this or the same body reads differently in each**,
 * which is the test SPEC §10 applies and the reason the rule is here rather
 * than in either app. A reference that is the whole of a paragraph is somebody
 * attaching an object; a reference inside a sentence is somebody naming one
 * mid-thought, and cutting it out of the prose loses the sentence.
 *
 * That distinction used to be unavailable: `stripNaddrs` removed every pointer
 * from every body before rendering, because a description had no structure to
 * put a widget into. §13.3 gave it one.
 *
 * Whitespace around the reference does not change the answer — a pointer alone
 * on its line is alone on its line whether or not somebody left a space after
 * it.
 *
 * @deprecated A whole paragraph is not the unit: since 0.38.0 a message's line
 * that is only a reference draws its row (§13.2, §13.6.2), which
 * `isOnlyReferenceLine` decides per line, list items and app URLs included. A
 * block document draws by the same line rule (§13.3): `documentLineDrawOf`.
 */
export function standaloneReference(block: RenderBlock): string | undefined {
  if (block.type !== 'paragraph' || block.children?.length) return undefined
  const runs = (block.inline ?? []).filter((run) => run.text.trim() !== '')
  if (runs.length !== 1) return undefined
  const only = runs[0]
  return only.reference && only.text.trim() === only.reference ? only.reference : undefined
}

// ── A reference's card in a block document — SPEC §13.3 ─────────────────────

/**
 * `attrs.embed` on a reference mark, read: `compact`, `detailed`, or absent for
 * no card. A string this reader does not know is `compact` — the writer asked
 * for a card, and the smallest is the safe reading, as for a message's `embed`
 * tag (§13.6.2). `none`, a non-string and absence are all no card.
 *
 * In a block document only `detailed` draws a card, in its lone link's row's
 * place; everything else draws the row (§13.3, `documentLineDrawOf`).
 */
export function cardLayout(raw: unknown): 'compact' | 'detailed' | undefined {
  // An empty string names no layout: no card, as an editor saves it.
  if (typeof raw !== 'string' || raw === '' || raw === 'none') return undefined
  return raw === 'detailed' ? 'detailed' : 'compact'
}

/** One card a block document asks for: the reference it hangs from, and how much to show. */
export interface BlockCard {
  /** The `nostr:` URI, as the reference mark carries it. */
  reference: string
  layout: 'compact' | 'detailed'
}

/**
 * The cards to draw after this block, in the order their references appear
 * (§13.3, "A reference's card"). Only the block's own runs: a list's cards hang
 * from each item, so a reader asks each item.
 *
 * Each occurrence is its own card, so the same object twice may draw twice. A
 * reference split across runs (part of it bold) is one occurrence, and takes
 * its card from its first run.
 *
 * A link carries its card the same way. Read the block through
 * `linksAsReferences` first and a URL is its reference already; a link on
 * other words draws its card only when `resolveLink` says what its `href`
 * names (§7.7), and without one names nothing.
 *
 * Inside a card's body or a part a reader asks nothing: there every reference
 * is its chip (§13.3), or two objects that card each other nest forever.
 *
 * @deprecated Since 0.41.0 a document's card is drawn in its lone link's row's
 * place, never after the block, and only for `detailed` (§13.3, C22): a link
 * in a sentence draws its chip, and a link on words draws its words. Draw each
 * line by {@link documentLineDrawOf}. Kept until Ship's and Peek's readers move.
 */
export function blockCards(block: RenderBlock, resolveLink?: LinkResolver): BlockCard[] {
  const out: BlockCard[] = []
  let previous: string | undefined
  for (const run of block.inline ?? []) {
    const target = run.reference ?? (run.href !== undefined ? `href:${run.href}` : undefined)
    if (target && target === previous) continue
    previous = target
    if (!run.embed) continue
    const reference = run.reference ?? (run.href !== undefined && resolveLink ? referenceOfLink(run.href, resolveLink) : undefined)
    if (reference) out.push({ reference, layout: run.embed })
  }
  return out
}

/**
 * Every `nostr:` reference in a resolved tree, in the order they are written.
 *
 * The tree rather than the raw text, so a URI inside a code span is not counted
 * — §13.1 makes code literal, and a pointer somebody quoted as an example is
 * not one they are attaching. `findNaddrs` reads the string and cannot tell.
 */
export function referencesIn(blocks: readonly RenderBlock[]): string[] {
  const out: string[] = []
  const walk = (bs: readonly RenderBlock[]) => {
    for (const block of bs) {
      for (const run of block.inline ?? []) if (run.reference) out.push(run.reference)
      if (block.children) walk(block.children)
    }
  }
  walk(blocks)
  return out
}

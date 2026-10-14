/**
 * Marker text and block documents, converted between — the bridge across §13's
 * two serialisations.
 *
 * SPEC §13 keeps the two content models apart on purpose, and nothing here
 * softens that: a message is still marker text and a rich text field is still a
 * block document. What this module does is let an app whose *editor* produces
 * marker text publish a **block document** anyway, which is the only way a
 * description acquires addressable blocks before somebody builds a block editor.
 *
 * ## The id carry-forward is the whole point
 *
 * A description is replaced wholesale on every save. If each save re-parses the
 * text into fresh blocks, every block gets a new id, and **every comment
 * anchored to one detaches** — silently, because a detached comment renders
 * exactly like a comment that was never anchored. So
 * {@link markerTextToBlockDocument} takes the previous document and carries ids
 * across, by a rule written down here rather than left to be inferred:
 *
 * 1. **Same type and identical text** — reuse that block's id, wherever it
 *    moved to. This survives a reorder, and an edit to a *different* block.
 * 2. **Same type at the same index**, among what is left — reuse that id. This
 *    survives editing a block's own text in place.
 * 3. Anything still unmatched gets a fresh id.
 *
 * **What that rule does not survive, stated rather than discovered:** a block
 * moved *and* edited in one save matches neither pass and gets a new id, so an
 * anchor to it breaks. That is a real limit of reconstructing structure from
 * text. It is acceptable because the anchor has to fail visibly anyway — a
 * block can always be deleted outright, so a reader that cannot show a broken
 * anchor is broken regardless of this rule.
 */
import {
  type BodySegment,
  type InlineTextNode,
  markersToInlineNodes,
  inlineNodesToMarkers,
  parseBodySegments,
} from './content.js'
import { type Block, type BlockDocument, newBlockId, listItemDepths, listItemChecked, MAX_LIST_DEPTH } from './blocks.js'

const isInlineRun = (content: unknown): content is InlineTextNode[] =>
  Array.isArray(content) &&
  content.length > 0 &&
  typeof content[0] === 'object' &&
  content[0] !== null &&
  (content[0] as { type?: unknown }).type === 'text'

/** A block's text, for matching. Cheap and stable: it is what the author sees. */
function textOf(block: Block): string {
  if (!Array.isArray(block.content)) return ''
  if (isInlineRun(block.content)) return block.content.map((n) => n.text).join('')
  return (block.content as Block[]).map(textOf).join('\n')
}

/*
  `\u0000` as an escape, never the byte. A separator has to be something a
  block type cannot contain, and NUL is the right choice — but writing it
  literally makes this file *binary* to the tools that read source: `grep`
  skips it and says nothing, which is how this very line hid a control
  character until a search for `previous` came back empty. Ship's `fold.ts`
  carries the same warning for the same reason.
*/
const keyOf = (block: Block) => `${block.type}\u0000${textOf(block)}`

/**
 * How a description's text spells what §13.2 has no marker for (RIC-19):
 * a checklist item as `- [ ] ` / `- [x] `, GFM's task list, and a callout as a
 * quote whose first line is `[!NOTE]`, GitHub's alert. **Descriptions only**
 * (Miky, 2026-10-13): a message stays §13.2's dialect, where `[x]` is text.
 *
 * Two more, so every list and quote reads back as it printed (d98a5636): an
 * indented item (`attrs.indent`) is spelled two spaces a level and read
 * relative to the item above; and a plain item or quote whose text would read
 * as one of the above is escaped with one more `\` in front, which reading
 * takes off again — `- \[ ] brackets` is a plain item whose text is `[ ] brackets`.
 */
export interface DescriptionTextOptions {
  description?: boolean
}

const TASK = /^\[( |x|X)\] /
const ALERT = /^\[!([A-Za-z]+)\]$/
/** Text that reads as a checklist box or a callout line — after any backslashes, which the escape adds one of. */
const ESCAPED_TASK = /^\\*\[( |x|X)\] /
const ESCAPED_ALERT = /^\\*\[![A-Za-z]+\]$/

/** One `\` more in front of text that would otherwise read as `pattern`, after `lead` whitespace. */
function escaped(text: string, pattern: RegExp): string {
  const lead = text.length - text.trimStart().length
  return pattern.test(text.slice(lead).trimEnd()) ? `${text.slice(0, lead)}\\${text.slice(lead)}` : text
}

/** The inverse of {@link escaped}: one `\` fewer. */
function unescaped(text: string, pattern: RegExp): string {
  const lead = text.length - text.trimStart().length
  return text[lead] === '\\' && pattern.test(text.slice(lead).trimEnd()) ? text.slice(0, lead) + text.slice(lead + 1) : text
}

function itemFromText(item: string, description: boolean, depth = 0): Block {
  const indent = depth > 0 ? { indent: Math.min(depth, MAX_LIST_DEPTH) } : undefined
  const task = description ? TASK.exec(item) : null
  if (!task) {
    const text = description ? unescaped(item, ESCAPED_TASK) : item
    return { type: 'listItem', id: '', ...(indent ? { attrs: indent } : {}), content: markersToInlineNodes(text) }
  }
  return {
    type: 'listItem',
    id: '',
    attrs: { ...indent, checked: task[1] !== ' ' },
    content: markersToInlineNodes(item.slice(task[0].length)),
  }
}

function quoteFromLines(lines: string[], description: boolean): Block {
  const alert = description && lines.length > 0 ? ALERT.exec(lines[0].trim()) : null
  if (!alert) {
    const text = description && lines.length > 0 ? [unescaped(lines[0], ESCAPED_ALERT), ...lines.slice(1)] : lines
    return { type: 'blockquote', id: '', content: markersToInlineNodes(text.join('\n')) }
  }
  /*
    The kind is kept as written, lowercased: a tone this version does not know
    is still a callout, and the next save must not turn it into a `note`.
  */
  return { type: 'blockquote', id: '', attrs: { tone: alert[1].toLowerCase() }, content: markersToInlineNodes(lines.slice(1).join('\n')) }
}

function blockFromSegment(seg: BodySegment, description: boolean): Block {
  switch (seg.type) {
    case 'heading':
      return { type: 'heading', id: '', attrs: { level: seg.level }, content: markersToInlineNodes(seg.text) }
    case 'bullet':
      return {
        type: 'bulletList',
        id: '',
        content: seg.items.map((item, i) => itemFromText(item, description, seg.depths?.[i])),
      }
    case 'numbered':
      return {
        type: 'orderedList',
        id: '',
        ...(seg.start ? { attrs: { start: seg.start } } : {}),
        content: seg.items.map((item, i) => itemFromText(item, description, seg.depths?.[i])),
      }
    case 'quote':
      return quoteFromLines(seg.lines, description)
    case 'code':
      return {
        type: 'codeBlock',
        id: '',
        ...(seg.language ? { attrs: { language: seg.language } } : {}),
        // A fence is literal — its content is never mark-parsed.
        content: [{ type: 'text' as const, text: seg.lines.join('\n') }],
      }
    case 'text':
      return { type: 'paragraph', id: '', content: markersToInlineNodes(seg.lines.join('\n')) }
  }
}

/**
 * Marker text as a block document, keeping `previous`'s ids wherever a block
 * still corresponds. The matching rule is in this module's header.
 */
export function markerTextToBlockDocument(text: string, previous?: BlockDocument, options: DescriptionTextOptions = {}): BlockDocument {
  const description = options.description === true
  const fresh = parseBodySegments(text, { indentedItems: description }).map((seg) => blockFromSegment(seg, description))
  const old = previous?.content ?? []
  const takenIds = new Set<string>()
  const usedOld = new Set<number>()

  // Pass 1 — same type and identical text, wherever it moved to.
  const byKey = new Map<string, number[]>()
  old.forEach((block, i) => {
    if (!block.id) return
    const list = byKey.get(keyOf(block)) ?? []
    list.push(i)
    byKey.set(keyOf(block), list)
  })
  const ids: (string | undefined)[] = fresh.map((block) => {
    const candidates = byKey.get(keyOf(block))
    while (candidates && candidates.length) {
      const i = candidates.shift() as number
      if (usedOld.has(i)) continue
      usedOld.add(i)
      takenIds.add(old[i].id)
      return old[i].id
    }
    return undefined
  })

  // Pass 2 — same type at the same index, among what is left.
  fresh.forEach((block, i) => {
    if (ids[i] !== undefined) return
    const candidate = old[i]
    if (!candidate || usedOld.has(i) || candidate.type !== block.type || !candidate.id) return
    if (takenIds.has(candidate.id)) return
    usedOld.add(i)
    takenIds.add(candidate.id)
    ids[i] = candidate.id
  })

  // Pass 3 — a fresh id for everything still unmatched, children included.
  const mint = () => {
    let id = newBlockId()
    while (takenIds.has(id)) id = newBlockId()
    takenIds.add(id)
    return id
  }
  const fill = (block: Block, id?: string): Block => {
    const children = Array.isArray(block.content) && !isInlineRun(block.content)
      ? (block.content as Block[]).map((child) => fill(child))
      : undefined
    return {
      ...block,
      id: id ?? (block.id || mint()),
      ...(children ? { content: children } : {}),
    }
  }

  return { type: 'doc', content: fresh.map((block, i) => fill(block, ids[i] || undefined)) }
}

const itemText = (item: Block): string =>
  isInlineRun(item.content) ? inlineNodesToMarkers(item.content) : ''

/**
 * A block document back as marker text, for an editor that edits text.
 *
 * The inverse of {@link markerTextToBlockDocument} for everything the marker
 * dialect can spell, which is everything that function can produce. A document
 * written by a *block* editor may hold a table or a nested list, and §13.2 has
 * no marker for either — those degrade to their text rather than vanishing,
 * which is the rule §13.3 already gives a reader for an unknown block.
 *
 * With `{ description: true }` a checklist item and a callout are spelled too
 * ({@link DescriptionTextOptions}); without it they read as a plain item and a
 * plain quote, as §13.2 has them.
 */
export function blockDocumentToMarkerText(doc: BlockDocument, options: DescriptionTextOptions = {}): string {
  const description = options.description === true
  const lines: string[] = []
  for (const block of doc.content) {
    const inline = isInlineRun(block.content) ? inlineNodesToMarkers(block.content) : ''
    switch (block.type) {
      case 'heading': {
        const level = block.attrs?.level === 2 ? 2 : 1
        lines.push(`${'#'.repeat(level)} ${inline}`)
        break
      }
      case 'bulletList':
      case 'orderedList': {
        /*
          An indented item (MAN-13) is spelled two spaces a level, as Markdown
          does. A description's text reads it back at its depth (d98a5636); a
          message's §13.2 has no nesting, so there it reads back level — still
          every item.
        */
        const items = (block.content as Block[]) ?? []
        const depths = listItemDepths(items)
        const start = typeof block.attrs?.start === 'number' ? block.attrs.start : 1
        // The next number at each depth; a shallower item restarts the ones below it.
        const next: number[] = []
        items.forEach((item, i) => {
          const depth = depths[i]
          next.length = depth + 1
          next[depth] ??= depth === 0 ? start : 1
          const marker = block.type === 'bulletList' ? '-' : `${next[depth]++}.`
          const checked = description ? listItemChecked(item) : undefined
          const task = checked === undefined ? '' : checked ? '[x] ' : '[ ] '
          const text = description && checked === undefined ? escaped(itemText(item), ESCAPED_TASK) : itemText(item)
          lines.push(`${'  '.repeat(depth)}${marker} ${task}${text}`)
        })
        break
      }
      case 'blockquote': {
        // The tone as written, not as `calloutTone` reads it: the next save reads back what this spelled.
        const tone = description && typeof block.attrs?.tone === 'string' && /^[A-Za-z]+$/.test(block.attrs.tone) ? block.attrs.tone : ''
        if (tone) lines.push(`> [!${tone.toUpperCase()}]`)
        const quoted = inline.split('\n')
        if (description && !tone) quoted[0] = escaped(quoted[0], ESCAPED_ALERT)
        for (const line of quoted) lines.push(`> ${line}`)
        break
      }
      case 'codeBlock': {
        const language = typeof block.attrs?.language === 'string' ? block.attrs.language : ''
        lines.push('```' + language, inline, '```')
        break
      }
      case 'horizontalRule':
        lines.push('---')
        break
      default:
        // A table, an attachment, a widget, or a type from a later version.
        lines.push(inline || textOf(block))
    }
    lines.push('')
  }
  return lines.join('\n').replace(/\n+$/, '')
}

/**
 * A description's text, read whole — SPEC §13.3 "A description as text".
 *
 * {@link markerTextToBlockDocument} with `{ description: true }` reads every
 * block that text spells except one: a table, which §13.2's markers have no
 * syntax for. This reads that too — a GFM pipe table (a header row, a `| --- |`
 * row, then rows, `\|` for a pipe in a cell) becomes a `table` block shaped as
 * an editor saves one. It is the one reader for text that becomes a
 * description: the agent's `edit-issue`, and a markdown paste into an editor
 * that saves a block document (LEAF-10). Moved here from the agent CLI
 * (RIC-20, estiva-agent#75) so the two cannot read the same text differently.
 *
 * A message's text is not read this way: §13.2 has no table, so a pasted table
 * stays text in a message (Miky, 2026-10-15, LEAF-10).
 */
import { type Block, type BlockDocument, inlineTextOf, newBlockId } from './blocks.js'
import { blockDocumentToMarkerText, markerTextToBlockDocument } from './bridge-content.js'
import { fenceCloses } from './content.js'

const DESCRIPTION = { description: true }

const doc = (content: Block[]): BlockDocument => ({ type: 'doc', content })

/** Child blocks, as opposed to an inline run or nothing. */
const childBlocks = (block: Block): Block[] | undefined =>
  Array.isArray(block.content) && block.content.length > 0 && block.content.every((node) => typeof (node as Block).id === 'string')
    ? (block.content as Block[])
    : undefined

/**
 * Text as a description's block document: marker text read with
 * `{ description: true }`, with each GFM pipe table read as a `table` block.
 * A table is a block boundary, so it stands in the marker text as a
 * placeholder paragraph of its own. `previous` lends the other blocks their
 * ids by index among the blocks that are not tables, so a table added or
 * removed above a paragraph does not cost that paragraph its id. A table
 * takes the ids of a table in `previous` that prints the same; failing that,
 * of the table at its position, but only when the text has as many tables as
 * `previous` — else a deleted table's ids would pass to the next one.
 */
export function descriptionTextToBlockDocument(text: string, previous?: BlockDocument): BlockDocument {
  const before = previous?.content ?? []
  const mark = placeholderFor(text)
  const tables: string[][][] = []
  const lines = text.split('\n')
  const out: string[] = []
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]
    const fenceEnd = fenceCloses(lines, i)
    if (fenceEnd !== -1) {
      out.push(...lines.slice(i, fenceEnd + 1))
      i = fenceEnd
      continue
    }
    const header = PIPE.test(line) ? rowCells(line) : undefined
    if (!header || i + 1 >= lines.length || !isSeparator(lines[i + 1], header.length)) {
      out.push(line)
      continue
    }
    const rows = [header]
    for (i += 2; i < lines.length && lines[i].trim() && PIPE.test(lines[i]); i++) rows.push(rowCells(lines[i]))
    i--
    out.push('', `${mark}${tables.length}${mark}`, '')
    tables.push(rows)
  }
  const aligned = before.filter((block) => block.type !== 'table')
  if (!tables.length) return markerTextToBlockDocument(text, doc(aligned), DESCRIPTION)

  // Which blocks are tables' places is known before ids are lent: the blocks
  // the text spells do not depend on `previous`.
  const marked = out.join('\n')
  const places = new Map(tables.map((_, n) => [`${mark}${n}${mark}`, n]))
  const placeOf = (block: Block) => (block.type === 'paragraph' ? places.get(inlineTextOf(block)) : undefined)
  markerTextToBlockDocument(marked, undefined, DESCRIPTION).content.forEach((block, i) => {
    if (placeOf(block) !== undefined) aligned.splice(i, 0, { type: 'paragraph', id: '' })
  })

  const oldTables = before.filter((block) => block.type === 'table')
  const used = new Set<Block>()
  const lend = (rows: string[][], n: number): Block | undefined => {
    const printed = tableToDescriptionText(tableBlock(rows, undefined))
    const same = oldTables.find((old) => !used.has(old) && printed !== undefined && tableToDescriptionText(old) === printed)
    const positional = oldTables.length === tables.length && !used.has(oldTables[n]) ? oldTables[n] : undefined
    const old = same ?? positional
    if (old) used.add(old)
    return old
  }
  return doc(
    markerTextToBlockDocument(marked, doc(aligned), DESCRIPTION).content.map((block) => {
      const n = placeOf(block)
      return n === undefined ? block : tableBlock(tables[n], lend(tables[n], n))
    }),
  )
}

/**
 * A mark the text does not hold, so nothing a person writes — or pastes — is
 * mistaken for a table's place: a private-use character, or, in text that
 * holds every one of them, one followed by a counter.
 */
function placeholderFor(text: string): string {
  for (let code = 0xe000; code <= 0xf8ff; code++) {
    const mark = String.fromCharCode(code)
    if (!text.includes(mark)) return mark
  }
  let n = 0
  while (text.includes(`${n}x`)) n++
  return `${n}x`
}

/** An unescaped pipe: a line that can be a table's header or row. */
const PIPE = /(?<!\\)\|/

/** A row's cells, outer pipes optional, `\|` read as a literal pipe. */
function rowCells(line: string): string[] {
  const inner = line.trim().replace(/^\|/, '').replace(/(?<!\\)\|$/, '')
  return inner.split(/(?<!\\)\|/).map((cell) => cell.trim().replace(/\\\|/g, '|'))
}

/** GFM's delimiter row: one `---` (optionally `:`-aligned) per header cell. */
function isSeparator(line: string, width: number): boolean {
  if (!PIPE.test(line)) return false
  const cells = rowCells(line)
  return cells.length === width && cells.every((cell) => /^:?-+:?$/.test(cell))
}

/** A table as wide as its widest row, so no cell's text is lost. */
function tableBlock(rows: string[][], old: Block | undefined): Block {
  const width = Math.max(...rows.map((cells) => cells.length))
  const oldRows = old ? (childBlocks(old) ?? []) : []
  return {
    type: 'table',
    id: old?.id ?? newBlockId(),
    content: rows.map((cells, r) => {
      const oldCells = oldRows[r] ? (childBlocks(oldRows[r]) ?? []) : []
      const type = r === 0 ? 'tableHeader' : 'tableCell'
      return {
        type: 'tableRow',
        id: oldRows[r]?.id ?? newBlockId(),
        content: Array.from({ length: width }, (_, c) => tableCell(type, cells[c] ?? '', oldCells[c]?.type === type ? oldCells[c] : undefined)),
      }
    }),
  }
}

/** A cell as an editor saves one: one paragraph, the text's inline marks kept. */
function tableCell(type: string, text: string, old: Block | undefined): Block {
  const [parsed, ...more] = text ? markerTextToBlockDocument(text).content : []
  const paragraph: Block =
    parsed?.type === 'paragraph' && !more.length ? parsed : text ? { type: 'paragraph', id: '', content: [{ type: 'text', text }] } : { type: 'paragraph', id: '' }
  const oldParagraph = old ? childBlocks(old)?.[0] : undefined
  return {
    type,
    id: old?.id ?? newBlockId(),
    attrs: old?.attrs ?? { colspan: 1, rowspan: 1 },
    content: [{ ...paragraph, id: oldParagraph?.type === 'paragraph' ? oldParagraph.id : newBlockId() }],
  }
}

/**
 * A table as GFM text, for a table text can carry: a header row first, and
 * each cell one paragraph on one line. `undefined` for any other table, which
 * §13.3 gives no spelling.
 */
export function tableToDescriptionText(block: Block): string | undefined {
  const rows = (childBlocks(block) ?? []).map((row) => childBlocks(row) ?? [])
  if (!rows.length || !rows[0].length) return undefined
  const lines: string[] = []
  for (const [r, cells] of rows.entries()) {
    if (cells.some((cell) => cell.type !== (r === 0 ? 'tableHeader' : 'tableCell'))) return undefined
    const texts = cells.map((cell) => {
      const children = childBlocks(cell) ?? []
      if (children.length > 1 || (children[0] && children[0].type !== 'paragraph')) return undefined
      const line = children[0] && Array.isArray(children[0].content) ? cellParagraphText(children[0]) : ''
      return line.includes('\n') ? undefined : line.replace(/\|/g, '\\|')
    })
    if (texts.some((t) => t === undefined)) return undefined
    lines.push(`| ${texts.join(' | ')} |`)
    if (r === 0) lines.push(`| ${cells.map(() => '---').join(' | ')} |`)
  }
  return lines.join('\n')
}

/**
 * A cell's paragraph as marker text, with the whitespace that ends its run
 * dropped first: an editor saves some runs as `"text\n"`, which nobody sees
 * but which would make the cell two lines.
 */
const cellParagraphText = (paragraph: Block) => blockDocumentToMarkerText(doc([trimRun(paragraph)]), DESCRIPTION)

function trimRun(block: Block): Block {
  const run = [...(block.content as { type: string; text?: string }[])]
  while (run.length) {
    const last = run[run.length - 1]
    if (last.type !== 'text' || typeof last.text !== 'string') break
    const trimmedText = last.text.trimEnd()
    if (trimmedText) {
      run[run.length - 1] = { ...last, text: trimmedText }
      break
    }
    run.pop()
  }
  return { ...block, content: run as Block['content'] }
}

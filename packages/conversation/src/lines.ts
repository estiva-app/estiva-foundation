/**
 * Where a message's lines draw — the one line rule (SPEC §13.2, §13.6.2, C21),
 * shared since ONE-2. It replaces Peek's and Ship's `messageLines.ts`, Leaf's
 * `commentLines.ts` and Peek's `urlNames`, three copies that had drifted.
 *
 * A sentence keeps its chips; a line that is only a link to a file or a
 * message is that file's row; and one whose file has a card or a part under
 * the message draws nothing, since the card stands for it (C26). A person or a
 * Folder alone on its line stays a chip, and a quote's or a heading's line is a
 * sentence (protocol `lineDrawOf`).
 *
 * why: https://github.com/estiva-app/estiva-docs/blob/main/decisions/a-link-on-words-counts-toward-the-card.md
 */
import { KIND_COMMENT } from './kinds.js'
import {
  lineDrawOf,
  linesOf,
  referenceOfLink,
  sameFile,
  valueOfReference,
  type Embed,
  type LinkResolver,
  type PartPointer,
  type RenderBlock,
  type RenderInline,
} from '@estiva-app/protocol'

/**
 * A line of a message that is only a link to a file or a message, drawn as
 * that file's row in place. `reference` is the `nostr:` reference the line
 * names; `unreadable` is one that names no address or event id, drawn as the
 * not-available row.
 */
export interface RowLine {
  reference: string
  /** The file's value (an address or an id), when the line names one. */
  value?: string
  unreadable?: true
  /** The URL the line was written as, when it names that same file: the row opens it as written (LTX-6). */
  url?: string
}

/** A paragraph's line that is a row, lifted out as a block of its own, so the row is not drawn inside a `<p>`. */
export const ROW_BLOCK = 'linkRow'

/** The answer of {@link placeLines}. */
export interface PlacedLines {
  blocks: RenderBlock[]
  /** The row a block of type {@link ROW_BLOCK} draws. */
  rowOf: (block: { type: string; attrs?: Record<string, unknown> }) => RowLine | undefined
  /** The row a list item's only run draws, by that run: a bullet that is only a link keeps its bullet. */
  rowRuns: ReadonlyMap<object, RowLine>
}

/** What a line's drawing reads beyond the line. */
export interface LineContext {
  /** The message's cards (`foldEmbeds`, `cardsIn`): a line whose file has one draws nothing. */
  cards?: readonly Embed[]
  /** The `part`s drawn under the message: a line whose file has one draws nothing. */
  parts?: readonly PartPointer[]
  /** What an app link names (§7.7), as answered so far. */
  resolveLink?: LinkResolver
  /**
   * Values whose lines stay sentences, their chip only: the file the message
   * is shown on draws no row of itself there (Miky, WID-3).
   */
  stayChip?: (value: string) => boolean
  /**
   * The file a comment is on, by each value it names it with (its NIP-22 `A`
   * address, its `O` id): a line that is only a link to it, a `nostr:`
   * reference or an app URL, draws nothing, as a file whose card is under the
   * message does. The comment already says which file it is on. A message
   * that would then draw no words at all draws them as before. Ship ended
   * every issue comment with such a line until ONE-11 (Miky, 2026-11-09).
   * why: https://github.com/estiva-app/estiva-docs/blob/main/decisions/a-comment-draws-no-line-for-the-file-it-is-on.md
   */
  ownFile?: readonly string[]
}

/**
 * The values naming the file a comment is on, for `LineContext.ownFile`: its
 * NIP-22 `A` address and its `O` id (SPEC §6.4). None for chat (`kind:9`),
 * whose `a` names what it mentions, not where it is.
 */
export function ownFileOf(event: { kind: number; tags: readonly (readonly string[])[] }): string[] {
  if (event.kind !== KIND_COMMENT) return []
  return event.tags.filter((t) => (t[0] === 'A' || t[0] === 'O') && !!t[1]).map((t) => t[1])
}

/**
 * A comment's words for its edit box, less each line that is only a `nostr:`
 * reference to the file it is on: the line Ship appended to every issue
 * comment until ONE-11, which no reader draws, so an edit made in any app
 * drops it, as an edit made in Ship always has. A URL or a sentence naming
 * the file stays, being words somebody typed.
 */
export function withoutOwnFileLines(body: string, ownFile: readonly string[]): string {
  if (!ownFile.length) return body
  const isOwn = (line: string) => {
    const text = line.trim()
    if (!/^nostr:[a-z0-9]+$/i.test(text)) return false
    const value = valueOfReference(text)
    return !!value && ownFile.some((own) => sameFile(value, own))
  }
  const lines = body.split('\n')
  // A line inside a fenced code block is code, drawn as written, never a link.
  let inCode = false
  const kept = lines.filter((line) => {
    if (/^\s*```/.test(line)) inCode = !inCode
    return inCode || !isOwn(line)
  })
  if (kept.length === lines.length) return body
  const words = kept.join('\n').replace(/\n{3,}/g, '\n\n').trim()
  // Nothing else written: the link is the message, and a reader draws it, so the edit keeps it too.
  return words || body
}

/**
 * The URL a run wrote for its reference, when the URL names that same file:
 * what its chip or row opens (LTX-6). A marker or a block comment can set any
 * URL's text on a reference to another file, so the text must itself read as
 * it; without `resolveLink` nothing can be checked and there is none.
 */
export function writtenUrlOf(run: Pick<RenderInline, 'text' | 'reference'>, resolveLink: LinkResolver | undefined): string | undefined {
  if (!run.reference || !resolveLink || !/^https?:\/\//i.test(run.text)) return undefined
  return referenceOfLink(run.text, resolveLink) === run.reference ? run.text : undefined
}

/**
 * Whether a pasted app link names this address: its path ends in the
 * address's `d` (§7.2 puts the identity last, `…/<slug>-<d>`), and that `d` is
 * long enough to be one. A `d` comes from somebody's tag, so a short one would
 * otherwise match half the links in a body.
 */
export function urlNames(url: string, address: string): boolean {
  const d = address.split(':')[2] ?? ''
  if (d.length < 8) return false
  const path = url.split(/[?#]/)[0].replace(/\/+$/, '')
  return path.endsWith(`-${d}`) || path.endsWith(`/${d}`)
}

const BREAK: RenderInline = { text: '\n', marks: [] }

function rowLineOf(line: readonly RenderInline[], block: Pick<RenderBlock, 'type'>, context: LineContext): RowLine | 'nothing' | undefined {
  const drawn = lineDrawOf(line, block, context)
  // A link alone on its line to the file the comment is on: nothing (`LineContext.ownFile`).
  if ((drawn.draw === 'row' || drawn.draw === 'nothing') && context.ownFile?.some((own) => sameFile(drawn.value, own))) return 'nothing'
  if ((drawn.draw === 'row' || drawn.draw === 'nothing') && context.stayChip?.(drawn.value)) return undefined
  if (drawn.draw === 'nothing') return 'nothing'
  if (drawn.draw === 'unreadable') return { reference: drawn.reference, unreadable: true }
  // A URL whose file is not read yet stays the link it was; once read, `linksAsReferences` made it a reference.
  if (drawn.draw !== 'row' || drawn.url) return undefined
  const run = line.find((r) => r.reference)
  if (!run?.reference) return undefined
  const url = writtenUrlOf(run, context.resolveLink)
  return { reference: run.reference, value: drawn.value, ...(url ? { url } : {}) }
}

/**
 * Where each of a message's lines draws. `blocks` is its tree after
 * `linksAsReferences`, so a lone app URL this reader can read is already its
 * reference, and one it cannot stays the URL as written.
 */
export function placeLines(blocks: readonly RenderBlock[], context: LineContext = {}): PlacedLines {
  const rows = new Map<object, RowLine>()
  const rowRuns = new Map<RenderInline, RowLine>()
  const out: RenderBlock[] = []
  for (const block of blocks) {
    if (block.type === 'paragraph') {
      const lines = linesOf(block)
      const drawn = lines.map((line) => rowLineOf(line, block, context))
      if (drawn.every((d) => d === undefined)) {
        out.push(block)
        continue
      }
      let sentence: RenderInline[][] = []
      let first = true
      const flush = () => {
        if (!sentence.length) return
        const inline = sentence.flatMap((line, i) => (i > 0 ? [BREAK, ...line] : line))
        out.push({ ...block, inline, ...(first ? {} : { id: undefined }) })
        first = false
        sentence = []
      }
      lines.forEach((line, i) => {
        const d = drawn[i]
        if (d === undefined) {
          sentence.push(line)
          return
        }
        flush()
        if (d === 'nothing') return
        // Not a protocol block: a drawer hands a type it has no design for to its own renderer.
        const row = { type: ROW_BLOCK, attrs: {} } as unknown as RenderBlock
        rows.set(row, d)
        out.push(row)
      })
      flush()
      continue
    }
    if (block.type === 'bulletList' || block.type === 'orderedList') {
      const items = (block.children ?? []).flatMap((item) => {
        const lines = linesOf(item)
        if (lines.length !== 1) return [item]
        const d = rowLineOf(lines[0], item, context)
        if (d === undefined) return [item]
        if (d === 'nothing') return []
        // A fresh run, so the map names this line and no other drawing of the same body.
        const run = { ...lines[0].find((r) => r.reference || r.text.trim())! }
        rowRuns.set(run, d)
        return [{ ...item, inline: [run] }]
      })
      if (items.length) out.push({ ...block, children: items })
      continue
    }
    out.push(block)
  }
  // Nothing left, not even a card or a part under it: the message keeps its link, as the chip or row it would be without the rule.
  const underIt = (context.cards ?? []).some((card) => card.layout !== 'none') || !!context.parts?.length
  if (!out.length && blocks.length && context.ownFile?.length && !underIt) {
    const own = context.ownFile
    // Its chip, in every app, whether or not the app keeps the page it is on as a chip (WID-3's `stayChip`).
    return placeLines(blocks, { ...context, ownFile: undefined, stayChip: (value) => own.some((o) => sameFile(value, o)) || !!context.stayChip?.(value) })
  }
  return { blocks: out, rowOf: (block) => rows.get(block), rowRuns }
}

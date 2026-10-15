/**
 * A comment on a selection — SPEC §13.3 "A run of blocks" and §13.6 (LEAF-7).
 *
 * A comment's anchor is a run of blocks, listed in its `block` tag the way a
 * `part` lists one, narrowed by the words where the selection starts and ends
 * in a `quote` tag:
 *
 *   ["block", <first id>, …, <last id>]
 *   ["quote", <start words>, <end words> | "", <prefix> | "", <suffix> | ""]
 *
 * - A selection inside one block quotes exactly its words.
 * - Across blocks, the start words lie in the first listed block and the end
 *   words in the last, each inside one block's text, so no rule for joining
 *   blocks is needed.
 * - A selection of whole blocks carries no `quote`: it is about the blocks and
 *   grows with the run.
 * - Prefix and suffix are written only when the words repeat in their block.
 *
 * Resolving one has five outcomes, and the new one is `reworded`: the run is
 * there and the words are not. It is not `detached` — the blocks still are —
 * and it is not `resolved`, because nothing may be highlighted on a guess.
 *
 * why: https://github.com/estiva-app/estiva-docs/blob/main/decisions/a-comment-remembers-where-its-selection-starts-and-ends.md
 */
import { type Block, type BlockDocument, inlineTextOf, parseBlockDocument } from './blocks.js'
import { BLOCK_ANCHOR_TAG } from './anchors.js'
import type { ContentFormat } from './render.js'

/** The tag carrying a comment's words (§13.6). */
export const QUOTE_TAG = 'quote'

/** The most ids a run lists: a longer selection keeps its first and last 32 (§13.3). */
export const MAX_RUN_IDS = 64

/** Up to this many characters, a selection's words are quoted whole. */
export const QUOTE_WHOLE_MAX = 1000

/** Otherwise, about this many characters at each end, cut at a word boundary. */
export const QUOTE_END_LENGTH = 150

/** How much of the text around repeated words is kept to tell them apart. */
export const QUOTE_CONTEXT_LENGTH = 32

/** The ids a run may name: safe in a URL fragment and a selector (§13.3, §13.6.1). */
const BLOCK_ID = /^[A-Za-z0-9_-]{1,64}$/

/** The first 32 and the last 32 of a list longer than {@link MAX_RUN_IDS}. */
function capRun(ids: readonly string[]): string[] {
  if (ids.length <= MAX_RUN_IDS) return [...ids]
  const half = MAX_RUN_IDS / 2
  return [...ids.slice(0, half), ...ids.slice(ids.length - half)]
}

/** A run's ids as §13.3 reads them: an invalid first id voids it; later ones are skipped; duplicates dropped. */
export function readRunIds(ids: readonly string[]): string[] | undefined {
  const [first] = ids
  if (first === undefined || !BLOCK_ID.test(first)) return undefined
  const out: string[] = []
  for (const id of ids) if (BLOCK_ID.test(id) && !out.includes(id)) out.push(id)
  return capRun(out)
}

/** The `block` tag for a run, ids in document order. One id is today's one-block tag, unchanged. */
export function blockRunTag(ids: readonly string[]): string[] {
  return [BLOCK_ANCHOR_TAG, ...capRun(ids)]
}

/**
 * The run a comment anchors to, or `undefined` when it anchors to none.
 *
 * Only a `kind:1111` anchors (§13.6). Every id from index 1 is the run; a
 * reader that knows only one block reads index 1 and gets its first block.
 */
export function blockRunOf(event: { kind?: number; tags: string[][] }): string[] | undefined {
  if (event.kind !== undefined && event.kind !== 1111) return undefined
  const tag = event.tags.find((t) => t[0] === BLOCK_ANCHOR_TAG)
  return tag ? readRunIds(tag.slice(1)) : undefined
}

/** Where each block sits: its parent's children (the document's own list at the top) and its index there. */
function placesIn(doc: BlockDocument): Map<string, { siblings: Block[]; index: number }> {
  const out = new Map<string, { siblings: Block[]; index: number }>()
  const walk = (blocks: Block[]) => {
    blocks.forEach((block, index) => {
      if (typeof block.id === 'string' && block.id !== '' && !out.has(block.id)) out.set(block.id, { siblings: blocks, index })
      if (Array.isArray(block.content) && block.content.some((c) => (c as { type?: string }).type !== 'text')) walk(block.content as Block[])
    })
  }
  walk(doc.content)
  return out
}

/**
 * The blocks a run names in the document as it is now — §13.3's span — or
 * `undefined` when none of its ids is present.
 *
 * The parent most of the present ids sit under (on a tie, the one of the
 * earliest listed), and every child of it from the earliest to the latest of
 * those ids, in current order. So a block inserted in the middle joins the run,
 * a deleted end shortens it, and an id that drifted to another parent is left
 * out rather than dragging the run across levels.
 */
export function resolveBlockRun(doc: BlockDocument, ids: readonly string[]): Block[] | undefined {
  const places = placesIn(doc)
  const groups: { siblings: Block[]; indexes: number[] }[] = []
  for (const id of ids) {
    const place = places.get(id)
    if (!place) continue
    const group = groups.find((g) => g.siblings === place.siblings)
    if (group) group.indexes.push(place.index)
    else groups.push({ siblings: place.siblings, indexes: [place.index] })
  }
  if (groups.length === 0) return undefined
  const best = groups.reduce((a, b) => (b.indexes.length > a.indexes.length ? b : a))
  return best.siblings.slice(Math.min(...best.indexes), Math.max(...best.indexes) + 1)
}

/** A comment's words: where the selection starts and, across blocks or when long, where it ends. */
export interface Quote {
  /** The selected words in the first block, or all of them when they fit. */
  start: string
  /** The selected words in the last block, when the selection crosses blocks or is long. */
  end?: string
  /** The text just before `start`, only when `start` repeats in its block. */
  prefix?: string
  /** The text just after the words, only when they repeat in their block. */
  suffix?: string
}

/** The `quote` tag, with empty placeholders only where a later value needs its index. */
export function quoteTag(quote: Quote): string[] {
  const tag = [QUOTE_TAG, quote.start, quote.end ?? '', quote.prefix ?? '', quote.suffix ?? '']
  while (tag.length > 2 && tag[tag.length - 1] === '') tag.pop()
  return tag
}

/** A comment's `quote` tag, read. An empty start voids it; empty later values mean absent. */
export function quoteOf(event: { tags: string[][] }): Quote | undefined {
  const tag = event.tags.find((t) => t[0] === QUOTE_TAG)
  const [, start, end, prefix, suffix] = tag ?? []
  if (!start) return undefined
  return {
    start,
    ...(end ? { end } : {}),
    ...(prefix ? { prefix } : {}),
    ...(suffix ? { suffix } : {}),
  }
}

/** A place in a block's text: an offset into its wire text ({@link inlineTextOf}). */
export interface TextPoint {
  block: string
  offset: number
}

/** The text a quote is matched in: §13.3's runs, a mention as its `nostr:` text, NFC. */
function textOf(block: Block): string {
  return inlineTextOf(block).normalize('NFC')
}

/** How many times `words` occurs in `text`. */
function occurrences(text: string, words: string): number {
  let count = 0
  for (let at = text.indexOf(words); at !== -1; at = text.indexOf(words, at + 1)) count++
  return count
}

/** At most `length` characters from the front of `text`, cut back to a word boundary when one is near. */
function headOf(text: string, length: number): string {
  if (text.length <= length) return text
  const cut = text.lastIndexOf(' ', length)
  return text.slice(0, cut > length / 2 ? cut : length)
}

/** At most `length` characters from the back of `text`, cut forward to a word boundary when one is near. */
function tailOf(text: string, length: number): string {
  if (text.length <= length) return text
  const from = text.length - length
  const cut = text.indexOf(' ', from)
  return text.slice(cut !== -1 && cut < from + length / 2 ? cut + 1 : from)
}

/**
 * The anchor tags for a selection: the `block` run, and a `quote` unless the
 * selection covers its first and last blocks whole.
 *
 * `run` is the selected blocks' ids in document order; `start` and `end` are
 * where the selection begins in the first and ends in the last. Omit both for
 * a selection of whole blocks. Nothing is trimmed: the words are exactly the
 * block's text between the two points.
 */
export function selectionAnchorTags(
  doc: BlockDocument,
  run: readonly string[],
  selection?: { start: TextPoint; end: TextPoint },
): string[][] {
  const tags = [blockRunTag(run)]
  if (!selection) return tags
  const places = placesIn(doc)
  const blockOf = (id: string) => {
    const place = places.get(id)
    if (!place) throw new Error(`block ${id} is not in the document`)
    return textOf(place.siblings[place.index])
  }
  const { start, end } = selection
  const firstText = blockOf(start.block)
  const lastText = start.block === end.block ? firstText : blockOf(end.block)
  if (start.offset === 0 && end.offset >= lastText.length) return tags

  const quote: Quote = { start: '' }
  if (start.block === end.block && end.offset - start.offset <= QUOTE_WHOLE_MAX) {
    quote.start = firstText.slice(start.offset, end.offset)
  } else {
    const startWords = start.block === end.block ? firstText.slice(start.offset, end.offset) : firstText.slice(start.offset)
    const endWords = start.block === end.block ? startWords : lastText.slice(0, end.offset)
    quote.start = headOf(startWords, QUOTE_END_LENGTH)
    quote.end = tailOf(endWords, QUOTE_END_LENGTH)
  }
  if (quote.start === '') return tags
  if (occurrences(firstText, quote.start) > 1) quote.prefix = firstText.slice(Math.max(0, start.offset - QUOTE_CONTEXT_LENGTH), start.offset)
  if (occurrences(lastText, quote.end ?? quote.start) > 1) quote.suffix = lastText.slice(end.offset, end.offset + QUOTE_CONTEXT_LENGTH)
  if (quote.prefix === '') delete quote.prefix
  if (quote.suffix === '') delete quote.suffix
  tags.push(quoteTag(quote))
  return tags
}

/**
 * What a comment's anchor resolved to (§13.6). Five states, none a degree of
 * another:
 *
 * - `unanchored` — no `block` tag: a comment about the whole object. A `quote`
 *   without a `block` is ignored.
 * - `resolved` — the run is there and so are its words, or it quotes none.
 *   `words` says where to highlight; absent, the comment is about the blocks.
 * - `reworded` — the run is there and its words are not, in order. Show the
 *   comment beside `blocks` with no highlight and `quote` as what the commenter
 *   quoted, never as what the page says; never as `detached`.
 * - `unaddressable` — the body is not a block document.
 * - `detached` — none of the run's blocks is left.
 */
export type CommentAnchor =
  | { state: 'unanchored' }
  | { state: 'resolved'; ids: string[]; blocks: Block[]; words?: { start: TextPoint; end: TextPoint } }
  | { state: 'reworded'; ids: string[]; blocks: Block[]; quote: Quote }
  | { state: 'unaddressable'; ids: string[] }
  | { state: 'detached'; ids: string[] }

/** Where `words` sits in `text` at or after `from`: the occurrence whose context matches, else the first. */
function find(text: string, words: string, from: number, context: (at: number) => boolean): number {
  let first = -1
  for (let at = text.indexOf(words, from); at !== -1; at = text.indexOf(words, at + 1)) {
    if (first === -1) first = at
    if (context(at)) return at
  }
  return first
}

/**
 * Which of §13.6's five states a comment's anchor is in, against the body as it
 * is now — the object's folded `description` (§6.10), never its root alone.
 *
 * `format` comes from the event carrying the body, as for
 * {@link resolveBlockAnchor}. Matching is exact: a reader may suggest where
 * reworded words might be, but never as `resolved`.
 */
export function resolveCommentAnchor(
  event: { kind?: number; tags: string[][] },
  value: string,
  format: ContentFormat,
): CommentAnchor {
  const ids = blockRunOf(event)
  if (!ids) return { state: 'unanchored' }
  if (format !== 'blocks') return { state: 'unaddressable', ids }
  let doc: BlockDocument
  try {
    doc = parseBlockDocument(value)
  } catch {
    return { state: 'unaddressable', ids }
  }
  const blocks = resolveBlockRun(doc, ids)
  if (!blocks) return { state: 'detached', ids }
  const quote = quoteOf(event)
  if (!quote) return { state: 'resolved', ids, blocks }

  const reworded = { state: 'reworded' as const, ids, blocks, quote }
  const first = blocks.findIndex((b) => b.id === ids[0])
  const last = blocks.findIndex((b) => b.id === ids[ids.length - 1])
  if (first === -1 || last === -1 || last < first) return reworded
  const firstText = textOf(blocks[first])
  const lastText = textOf(blocks[last])
  const start = quote.start.normalize('NFC')
  const end = quote.end?.normalize('NFC')

  if (end === undefined) {
    const at = find(firstText, start, 0, (i) =>
      (!quote.prefix || firstText.slice(0, i).endsWith(quote.prefix)) &&
      (!quote.suffix || firstText.slice(i + start.length).startsWith(quote.suffix)))
    if (at === -1) return reworded
    return { state: 'resolved', ids, blocks, words: { start: { block: ids[0], offset: at }, end: { block: ids[0], offset: at + start.length } } }
  }

  const startAt = find(firstText, start, 0, (i) => !quote.prefix || firstText.slice(0, i).endsWith(quote.prefix))
  if (startAt === -1) return reworded
  const from = first === last ? startAt + start.length : 0
  const endAt = find(lastText, end, from, (i) => !quote.suffix || lastText.slice(i + end.length).startsWith(quote.suffix))
  if (endAt === -1) return reworded
  return {
    state: 'resolved',
    ids,
    blocks,
    words: { start: { block: ids[0], offset: startAt }, end: { block: ids[ids.length - 1], offset: endAt + end.length } },
  }
}

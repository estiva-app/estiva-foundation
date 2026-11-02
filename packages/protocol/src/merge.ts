/**
 * Merging two changes to one text — SPEC §13.3, conformance C41 and C42.
 *
 * When the relay refuses a text save with `conflict:` (§6.2), its app merges
 * three texts: the **base**, the text its save named as `prev`; **theirs**, the
 * text now current; and **mine**, the refused one. Every app merges by this
 * rule, so two crossing saves give the same text whichever app was refused.
 *
 * Words are never lost: a block both sides changed differently, or one side
 * deleted while the other edited, **asks**, and while anything asks nothing of
 * mine is saved. Everything else merges quietly.
 *
 * why: https://github.com/estiva-app/estiva-docs/blob/main/decisions/merging-two-changes-to-one-text-never-loses-words.md
 */
import {
  type Block,
  type BlockDocument,
  documentText,
  parseBlockDocument,
  serializeBlockDocument,
} from './blocks.js'
import type { InlineTextNode } from './content.js'

/** The content format a block document is tagged with (§13.4). */
const BLOCKS_FORMAT = 'estiva-blocks-1'

/** One of the three texts, with the `content-format` its event carried. */
export interface MergeText {
  value: string
  /** `'estiva-blocks-1'` for a block document; anything else, or none, is one block. */
  format?: string
}

/**
 * A block the merge cannot settle without its person.
 *
 * - `changed-by-both`: both sides changed its own content, differently.
 * - `edited-and-deleted`: one side deleted it, or the block it sits under,
 *   and the other changed, added or moved it there.
 *
 * `block` is the block's id, or `null` when the text is not a block document
 * and so is one block. `theirs` and `mine` are each side's version as plain
 * text, absent on the side that deleted it; `theirsBlock` and `mineBlock` are
 * the blocks themselves, for a change plain text does not show (a heading's
 * level).
 */
export interface MergeAsk {
  block: string | null
  why: 'changed-by-both' | 'edited-and-deleted'
  base?: string
  theirs?: string
  mine?: string
  baseBlock?: Block
  theirsBlock?: Block
  mineBlock?: Block
}

export type TextMerge = { merged: MergeText; asks?: undefined } | { merged?: undefined; asks: MergeAsk[] }

export type BlockMerge = { merged: BlockDocument; asks?: undefined } | { merged?: undefined; asks: MergeAsk[] }

const isInlineRun = (content: unknown): content is InlineTextNode[] =>
  Array.isArray(content) && content.every((n) => typeof n === 'object' && n !== null && (n as { type?: unknown }).type === 'text')

/** A node whose content holds blocks: every one of them has an id. */
const childBlocksOf = (block: Block): Block[] | undefined =>
  Array.isArray(block.content) && block.content.length > 0 && !isInlineRun(block.content) &&
  block.content.every((child) => typeof (child as Block).id === 'string' && (child as Block).id !== '')
    ? (block.content as Block[])
    : undefined

interface Placed {
  block: Block
  /** The id of the block it sits under, or `null` at the top. */
  parent: string | null
  /** Its own content, as JSON: type, attrs and every node in it that is not itself a block. */
  own: string
}

interface Indexed {
  byId: Map<string, Placed>
  /** Each parent's children in order; `null` is the document. */
  children: Map<string | null, string[]>
  /** Every id in document order. */
  order: string[]
}

function ownContentOf(block: Block): string {
  const { id: _id, content, ...rest } = block
  const own: Record<string, unknown> = { ...rest }
  // A block's children are blocks of their own: where they sit is a move,
  // what they say is theirs. Everything else in it is this block's words.
  // An empty content is no words: an emptied list has not been rewritten.
  if (content !== undefined && !childBlocksOf(block) && !(Array.isArray(content) && content.length === 0)) own.content = content
  return stableJson(own)
}

/** JSON with object keys sorted, so an editor's key order is not a change. */
function stableJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(',')}]`
  if (value && typeof value === 'object') {
    const entries = Object.entries(value as Record<string, unknown>)
      .filter(([, v]) => v !== undefined)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${stableJson(v)}`).join(',')}}`
  }
  return JSON.stringify(value)
}

function indexOf(doc: BlockDocument): Indexed {
  const byId = new Map<string, Placed>()
  const children = new Map<string | null, string[]>([[null, []]])
  const order: string[] = []
  const walk = (blocks: Block[], parent: string | null) => {
    for (const block of blocks) {
      byId.set(block.id, { block, parent, own: ownContentOf(block) })
      children.get(parent)!.push(block.id)
      order.push(block.id)
      children.set(block.id, [])
      const kids = childBlocksOf(block)
      if (kids) walk(kids, block.id)
    }
  }
  walk(doc.content, null)
  return { byId, children, order }
}

/**
 * The blocks one side moved, against the base.
 *
 * A block is moved when its parent changed, or when, among the blocks under
 * that parent that both the base and this side hold, it is outside the longest
 * run still in the base's order — on a tie, the run whose first difference
 * comes earlier in the base. So a neighbour added or deleted moves nothing, and
 * moving one block moves only that one.
 */
function movedOn(base: Indexed, side: Indexed): Set<string> {
  const moved = new Set<string>()
  for (const [id, placed] of side.byId) {
    const was = base.byId.get(id)
    if (was && was.parent !== placed.parent) moved.add(id)
  }
  for (const [parent, ids] of side.children) {
    const baseIds = base.children.get(parent)
    if (!baseIds) continue
    const basePos = new Map(baseIds.map((id, i) => [id, i]))
    // Under this parent on both sides, in this side's order, as base positions.
    const shared = ids.filter((id) => basePos.has(id))
    const seq = shared.map((id) => basePos.get(id)!)
    for (const i of outsideLongestRun(seq)) moved.add(shared[i])
  }
  return moved
}

/**
 * The indexes of `seq` outside its longest increasing run, choosing among
 * equally long runs the one smallest in the base's order at its first
 * difference.
 */
function outsideLongestRun(seq: number[]): number[] {
  const n = seq.length
  // longest[i]: the longest increasing run starting at i.
  const longest = new Array<number>(n).fill(1)
  for (let i = n - 1; i >= 0; i--) {
    for (let j = i + 1; j < n; j++) {
      if (seq[j] > seq[i] && longest[j] + 1 > longest[i]) longest[i] = longest[j] + 1
    }
  }
  const best = Math.max(0, ...longest)
  const kept = new Set<number>()
  let from = 0
  let floor = -1
  for (let need = best; need > 0; need--) {
    let pick = -1
    for (let j = from; j < n; j++) {
      if (seq[j] > floor && longest[j] >= need && (pick === -1 || seq[j] < seq[pick])) pick = j
    }
    kept.add(pick)
    floor = seq[pick]
    from = pick + 1
  }
  return seq.map((_, i) => i).filter((i) => !kept.has(i))
}

/** A block as plain text, its own words only (not the blocks inside it). */
function ownText(block: Block | undefined): string | undefined {
  if (!block) return undefined
  const kids = childBlocksOf(block)
  const alone: Block = kids ? { ...block, content: undefined } : block
  return documentText({ type: 'doc', content: [alone] })
}

/** A block with no blocks inside it, its own content kept: the merge places its children. */
function shellOf(block: Block): Block {
  return childBlocksOf(block) ? { ...block, content: [] } : { ...block }
}

/**
 * Merge two block documents that both started from `base` — §13.3's rule.
 *
 * Returns the merged document, keeping every block id the merge kept, or the
 * blocks that ask. When anything asks, there is no merged document: nothing of
 * mine is saved.
 */
export function mergeBlockDocuments(base: BlockDocument, theirs: BlockDocument, mine: BlockDocument): BlockMerge {
  const B = indexOf(base)
  const T = indexOf(theirs)
  const M = indexOf(mine)
  const movedT = movedOn(B, T)
  const movedM = movedOn(B, M)
  const asks: MergeAsk[] = []
  const ask = (id: string, why: MergeAsk['why']) => {
    const b = B.byId.get(id)?.block
    const t = T.byId.get(id)?.block
    const m = M.byId.get(id)?.block
    asks.push({
      block: id,
      why,
      ...(b ? { base: ownText(b), baseBlock: b } : {}),
      ...(t ? { theirs: ownText(t), theirsBlock: t } : {}),
      ...(m ? { mine: ownText(m), mineBlock: m } : {}),
    })
  }

  // What each kept block says, and the blocks the merge deletes.
  const content = new Map<string, Block>()
  const deleted = new Set<string>()
  // In the base's order, so blocks that ask come in the order the text had.
  const ids = new Set([...B.order, ...T.order, ...M.order])
  for (const id of ids) {
    const b = B.byId.get(id)
    const t = T.byId.get(id)
    const m = M.byId.get(id)
    if (!b) {
      // Added. Both adding one id is one block, kept once when they agree.
      if (t && m && t.own !== m.own) ask(id, 'changed-by-both')
      else content.set(id, shellOf((t ?? m)!.block))
      continue
    }
    const changedT = !!t && t.own !== b.own
    const changedM = !!m && m.own !== b.own
    if (!t || !m) {
      // Deleted on one side or both. Against an edit it asks; against a move
      // or nothing, it is deleted: a move changes no words.
      if ((!t && changedM) || (!m && changedT)) ask(id, 'edited-and-deleted')
      else deleted.add(id)
      continue
    }
    if (changedT && changedM && t.own !== m.own) {
      ask(id, 'changed-by-both')
      continue
    }
    content.set(id, shellOf(changedM && !changedT ? m.block : t.block))
  }

  // The order is theirs, less what the merge deletes.
  const kids = new Map<string | null, string[]>()
  const parentOf = new Map<string, string | null>()
  for (const [parent, list] of T.children) {
    if (parent !== null && !content.has(parent)) continue
    kids.set(parent, list.filter((id) => content.has(id)))
    for (const id of kids.get(parent)!) parentOf.set(id, parent)
  }
  for (const id of content.keys()) if (!kids.has(id)) kids.set(id, [])

  // A block theirs kept under a parent the merge deletes: theirs added, moved
  // or changed it there against mine's delete.
  for (const [parent, list] of T.children) {
    if (parent === null || content.has(parent) || !deleted.has(parent)) continue
    for (const id of list) if (content.has(id) && touchedBy(id, B, T, movedT)) ask(id, 'edited-and-deleted')
  }

  const addedByTheirs = (id: string) => T.byId.has(id) && !B.byId.has(id) && !M.byId.has(id)

  // Then each block mine moved or added, in mine's order, is taken out and
  // placed after the nearest block before it in mine that the merge keeps
  // (and after any blocks theirs added right behind that one), or first under
  // its parent, after theirs' additions there.
  for (const id of M.order) {
    if (!content.has(id)) continue
    const addedByMine = !B.byId.has(id) && !T.byId.has(id)
    const mineMoved = movedM.has(id) && !movedT.has(id)
    if (!addedByMine && !mineMoved) continue
    const parent = M.byId.get(id)!.parent
    if (parent !== null && !content.has(parent)) {
      ask(id, 'edited-and-deleted')
      continue
    }
    // Mine puts it under a block theirs has meanwhile put inside it: both
    // moved, so theirs stands rather than a loop that holds neither.
    let above: string | null | undefined = parent
    while (above != null && above !== id) above = parentOf.get(above)
    if (above === id) continue
    if (parentOf.has(id)) {
      const from = kids.get(parentOf.get(id)!)!
      from.splice(from.indexOf(id), 1)
    }
    const under = kids.get(parent)!
    const siblings = M.children.get(parent)!
    let at = 0
    for (let i = siblings.indexOf(id) - 1; i >= 0; i--) {
      const before = under.indexOf(siblings[i])
      if (before !== -1) {
        at = before + 1
        break
      }
    }
    while (at < under.length && addedByTheirs(under[at])) at++
    under.splice(at, 0, id)
    parentOf.set(id, parent)
  }

  if (asks.length) return { asks: dedupe(asks) }

  const placed = new Set<string>()
  const build = (parent: string | null): Block[] =>
    kids.get(parent)!.map((id) => {
      placed.add(id)
      const block = content.get(id)!
      const inner = build(id)
      return inner.length || wasParent(id, B, T, M) ? { ...block, content: inner } : block
    })
  const merged: BlockDocument = { ...theirs, content: build(null) }
  // Never lose words: a block the merge kept but could not place asks.
  for (const id of content.keys()) if (!placed.has(id)) ask(id, 'changed-by-both')
  if (asks.length) return { asks: dedupe(asks) }
  return { merged }
}

/** Whether a block's own content held blocks on any side: an emptied list stays a list. */
function wasParent(id: string, ...sides: Indexed[]): boolean {
  return sides.some((side) => {
    const block = side.byId.get(id)?.block
    return !!block && !!childBlocksOf(block)
  })
}

function touchedBy(id: string, base: Indexed, side: Indexed, moved: Set<string>): boolean {
  const b = base.byId.get(id)
  const s = side.byId.get(id)
  return !b || moved.has(id) || (!!s && s.own !== b.own)
}

function dedupe(asks: MergeAsk[]): MergeAsk[] {
  const seen = new Set<string | null>()
  return asks.filter((a) => (seen.has(a.block) ? false : (seen.add(a.block), true)))
}

function asDocument(text: MergeText): BlockDocument | undefined {
  if (text.format !== BLOCKS_FORMAT) return undefined
  try {
    return parseBlockDocument(text.value)
  } catch {
    return undefined
  }
}

/**
 * Merge three texts by §13.3's rule.
 *
 * When all three are block documents, block by block; otherwise the text is
 * one block, so a change by both sides asks unless the two are equal. Mine
 * unchanged from the base gives theirs, and theirs unchanged gives mine.
 */
export function mergeTexts(base: MergeText, theirs: MergeText, mine: MergeText): TextMerge {
  const same = (a: MergeText, b: MergeText) => a.value === b.value && (a.format ?? '') === (b.format ?? '')
  if (same(mine, base) || same(mine, theirs)) return { merged: theirs }
  if (same(theirs, base)) return { merged: mine }
  const docs = [base, theirs, mine].map(asDocument)
  if (docs.every((d) => d !== undefined)) {
    const [b, t, m] = docs as BlockDocument[]
    const result = mergeBlockDocuments(b, t, m)
    if (result.asks) return result
    return { merged: { value: serializeBlockDocument(result.merged), format: BLOCKS_FORMAT } }
  }
  const plain = (text: MergeText) => {
    const doc = asDocument(text)
    return doc ? documentText(doc) : text.value
  }
  return { asks: [{ block: null, why: 'changed-by-both', base: plain(base), theirs: plain(theirs), mine: plain(mine) }] }
}

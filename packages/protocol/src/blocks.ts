/**
 * The rich text field — SPEC §13.3.
 *
 * A message is marker text (`content.ts`); a rich text field is this: a tree of
 * blocks, each with an id, serialised as JSON. **The id is the entire reason
 * this model is JSON rather than text.** A comment anchors to `<object address>
 * + <block id>`, which is what RFC 0.4 §6 was waiting for, and an implementation
 * that mints ids at render time has built a tree that is not addressable — the
 * anchor has nothing to bind to and nobody finds out until it silently drifts.
 *
 * ## What is deliberately not here
 *
 * **The `content-format` tag.** A document does not know its own tag — the tag
 * is on the event that carries it, and SPEC §13.4's read rule is
 * `contentFormatOf` in `render.ts`. (It lived in `@estiva-app/interop` until
 * two folds outside the projection layer needed it; see that function's note.)
 *
 * **Rendering.** §13.5's safe renderer is RIC-6's, where Ship is the consumer
 * that needs it. What this module owes a renderer is {@link inlineTextOf}, so
 * an unknown block type can be drawn as its own text rather than dropped.
 */
import { bytesToHex, randomBytes } from '@noble/hashes/utils'
import { type InlineTextNode, inlineNodesToText } from './content.js'

/**
 * The block types §13.3 names.
 *
 * **Open, not closed.** An unknown type is not an error at any point in this
 * module — §13.3 requires a reader to render its inline text and forbids
 * dropping it silently, which is the same fallback discipline §7.5 applies to
 * widgets and for the same reason: consumers upgrade at different times, and a
 * block that vanishes is indistinguishable from one you may not read.
 */
export const KNOWN_BLOCK_TYPES = [
  'paragraph',
  'heading',
  'bulletList',
  'orderedList',
  'listItem',
  'blockquote',
  'codeBlock',
  'table',
  'horizontalRule',
  'attachment',
  'widget',
] as const

export type KnownBlockType = (typeof KNOWN_BLOCK_TYPES)[number]

export interface Block {
  /** A {@link KnownBlockType}, or anything a later version publishes. */
  type: string
  /** Unique within the document, and stable across edits that do not replace it. */
  id: string
  attrs?: Record<string, unknown>
  /** Inline runs, or child blocks. A leaf like `horizontalRule` has neither. */
  content?: InlineTextNode[] | Block[]
}

export interface BlockDocument {
  type: 'doc'
  content: Block[]
}

/** Thrown by {@link parseBlockDocument}; `problems` is {@link validateBlockDocument}'s list. */
export class BlockDocumentError extends Error {
  readonly problems: string[]
  constructor(problems: string[]) {
    super(`not a block document: ${problems.join('; ')}`)
    this.name = 'BlockDocumentError'
    this.problems = problems
  }
}

const isObject = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v)

const isInlineRun = (content: unknown): content is InlineTextNode[] =>
  Array.isArray(content) && content.every((n) => isObject(n) && n.type === 'text')

/**
 * Every way a value fails to be a block document, rather than the first.
 *
 * A validator that stops at the first problem makes fixing a document a
 * sequence of round trips, and this one is read by authors of *other* apps.
 */
export function validateBlockDocument(value: unknown): string[] {
  const problems: string[] = []
  if (!isObject(value)) return ['root is not an object']
  if (value.type !== 'doc') problems.push(`root type is ${JSON.stringify(value.type)}, expected "doc"`)
  if (!Array.isArray(value.content)) {
    problems.push('root has no content array')
    return problems
  }

  const seen = new Set<string>()
  const walk = (blocks: unknown[], path: string) => {
    blocks.forEach((block, i) => {
      const at = `${path}[${i}]`
      if (!isObject(block)) {
        problems.push(`${at} is not an object`)
        return
      }
      if (typeof block.type !== 'string' || block.type === '') {
        problems.push(`${at} has no type`)
      }
      // §13.3: every block, not only the ones an app happens to know.
      if (typeof block.id !== 'string' || block.id === '') {
        problems.push(`${at} has no id`)
      } else if (seen.has(block.id)) {
        problems.push(`${at} repeats the id ${JSON.stringify(block.id)}`)
      } else {
        seen.add(block.id)
      }
      if (block.type === 'heading') {
        const level = isObject(block.attrs) ? block.attrs.level : undefined
        if (typeof level !== 'number' || !Number.isInteger(level) || level < 1 || level > 3) {
          problems.push(`${at} is a heading with level ${JSON.stringify(level)}, expected 1–3`)
        }
      }
      if (block.content === undefined) return
      if (!Array.isArray(block.content)) {
        problems.push(`${at} has a content that is not an array`)
        return
      }
      if (isInlineRun(block.content)) {
        block.content.forEach((node, j) => {
          const nodeAt = `${at}.content[${j}]`
          if (typeof (node as { text?: unknown }).text !== 'string') {
            problems.push(`${nodeAt} has no text`)
          }
          const marks = (node as { marks?: unknown }).marks
          if (marks === undefined) return
          if (!Array.isArray(marks)) {
            problems.push(`${nodeAt} has marks that are not an array`)
            return
          }
          for (const mark of marks) {
            if (!isObject(mark) || typeof mark.type !== 'string') {
              problems.push(`${nodeAt} has a mark with no type`)
            }
          }
        })
        return
      }
      walk(block.content, `${at}.content`)
    })
  }
  walk(value.content, 'content')
  return problems
}

/**
 * A block document from JSON text, or from an already-parsed value.
 *
 * **Throws rather than returning a partial document.** A caller that cannot
 * tell "this is not a block document" from "this is an empty one" would render
 * a blank field for a body that is really there — and §13.4 is explicit that a
 * body's model is decided by its event's tag, so arriving here with something
 * that is not a document means the tag was wrong, which is worth an error and
 * not a shrug.
 */
export function parseBlockDocument(input: string | unknown): BlockDocument {
  let value: unknown = input
  if (typeof input === 'string') {
    try {
      value = JSON.parse(input)
    } catch (e) {
      throw new BlockDocumentError([`content is not JSON: ${(e as Error).message}`])
    }
  }
  const problems = validateBlockDocument(value)
  if (problems.length) throw new BlockDocumentError(problems)
  return value as BlockDocument
}

/** JSON text for the wire. §12.3's 256 KiB ingest cap applies to this string. */
export function serializeBlockDocument(doc: BlockDocument): string {
  return JSON.stringify(doc)
}

/**
 * A fresh block id.
 *
 * Short on purpose: ids repeat in every anchor and every serialisation, the
 * document has a 256 KiB ceiling, and uniqueness is only required *within one
 * document* (§13.3) rather than globally. 12 hex characters is far more than
 * that needs, and {@link assignMissingBlockIds} checks for a collision anyway
 * rather than trusting the arithmetic.
 */
export function newBlockId(): string {
  // `@noble/hashes`' randomBytes, the same source `nip98.ts` draws its nonce
  // from — one CSPRNG seam for the package rather than a direct `globalThis`
  // reach that types differently under DOM and node libs.
  return bytesToHex(randomBytes(6))
}

/**
 * Ids for blocks that have none, **leaving every existing id alone**.
 *
 * This is the id-stability rule (§13.3) as a function. An editor rebuilds a
 * document on every keystroke; if that rebuild re-mints ids, every anchored
 * comment detaches on the next edit and the anchoring feature is silently
 * worthless. Assigning only what is missing makes the safe path the easy one.
 *
 * Returns a new document; the input is not mutated.
 */
export function assignMissingBlockIds(doc: BlockDocument): BlockDocument {
  const taken = new Set(blockIds(doc))
  const fresh = () => {
    let id = newBlockId()
    while (taken.has(id)) id = newBlockId()
    taken.add(id)
    return id
  }
  const walk = (blocks: Block[]): Block[] =>
    blocks.map((block) => {
      const id = typeof block.id === 'string' && block.id !== '' ? block.id : fresh()
      const content =
        Array.isArray(block.content) && !isInlineRun(block.content)
          ? walk(block.content as Block[])
          : block.content
      return { ...block, id, ...(content === undefined ? {} : { content }) } as Block
    })
  return { ...doc, content: walk(doc.content) }
}

/** Every block id in document order, nested blocks included. */
export function blockIds(doc: BlockDocument): string[] {
  const out: string[] = []
  const walk = (blocks: Block[]) => {
    for (const block of blocks) {
      if (typeof block.id === 'string' && block.id !== '') out.push(block.id)
      if (Array.isArray(block.content) && !isInlineRun(block.content)) walk(block.content as Block[])
    }
  }
  walk(doc.content)
  return out
}

/** The block an anchor points at, or `undefined` if it is gone. */
export function findBlock(doc: BlockDocument, id: string): Block | undefined {
  const walk = (blocks: Block[]): Block | undefined => {
    for (const block of blocks) {
      if (block.id === id) return block
      if (Array.isArray(block.content) && !isInlineRun(block.content)) {
        const hit = walk(block.content as Block[])
        if (hit) return hit
      }
    }
    return undefined
  }
  return walk(doc.content)
}

/**
 * A block's text, including its children's.
 *
 * This is what §13.3 requires a reader to draw for a block type it does not
 * know — *"render that block's inline text rather than dropping it"*. It works
 * on an unknown type for the same reason it works on a known one: it reads the
 * shape, never the name.
 */
export function inlineTextOf(block: Block): string {
  if (!Array.isArray(block.content)) return ''
  if (isInlineRun(block.content)) return inlineNodesToText(block.content)
  return (block.content as Block[]).map(inlineTextOf).join('\n')
}

/** The whole document as plain text — previews, search, and the last-resort render. */
export function documentText(doc: BlockDocument): string {
  return doc.content.map(inlineTextOf).filter((t) => t !== '').join('\n')
}

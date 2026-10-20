/**
 * A mention in a file's text — SPEC §11.8 *A mention in a file's text*.
 *
 * A file's text (its root's content, or a prose field's value, §7.3) is not a
 * message: a save of it carries no `p` for the people it names (§13.1). What
 * adds a person is the membership change the writer signs when its save names
 * them and the version it edited from did not, the same Add a Members button
 * writes. A typo fix names nobody new, so it writes nothing, and a person who
 * left stays out. Being added shows no unread by itself.
 *
 * The writer compares the two versions it holds, the one it loaded and the one
 * it saves; nothing is kept between edits. Leaf, Ship, Peek's panel and the
 * agent's description writes all use {@link mentionAddsFor}.
 *
 * why: https://github.com/estiva-app/estiva-docs/blob/main/decisions/a-mention-in-a-files-text-adds-the-person-with-no-unread.md
 */
import {
  BLOCK_DOCUMENT_FORMAT,
  markersToInlineNodes,
  parseBlockDocument,
  type Block,
  type BlockDocument,
  type InlineTextNode,
  type UnsignedEvent,
} from '@estiva-app/protocol'
import { buildMembershipChange } from './membership.js'
import { MAX_MENTIONED_PEOPLE, peopleNamedInBody } from './strength.js'

/**
 * One version of a file's text: what goes in the event's content (or a
 * change's `value`), and its `content-format` tag. A block document may be
 * passed parsed. With no `format`, a string is §13.2 marker text.
 */
export interface FileText {
  content: string | BlockDocument
  format?: string
}

const isInlineRun = (content: unknown): content is InlineTextNode[] =>
  Array.isArray(content) && content.every((n) => typeof n === 'object' && n !== null && (n as { type?: unknown }).type === 'text')

/** A `reference` mark's `uri`, when the mark is well formed; somebody else's JSON may hold `"attrs": null`. */
function referenceUri(node: InlineTextNode): string | undefined {
  const attrs = (node.marks?.find((m) => m.type === 'reference') as { attrs?: unknown } | undefined)?.attrs
  const uri = attrs && typeof attrs === 'object' ? (attrs as { uri?: unknown }).uri : undefined
  return typeof uri === 'string' && uri !== '' ? uri : undefined
}

function namedInBlocks(blocks: readonly Block[], out: Set<string>): void {
  for (const block of blocks) {
    // A code block's text is code, not prose (§13.1): a key in it names nobody.
    if (block.type === 'codeBlock' || !Array.isArray(block.content)) continue
    if (!isInlineRun(block.content)) {
      namedInBlocks(block.content as Block[], out)
      continue
    }
    namedInRuns(block.content, out)
  }
}

/** Only a `reference` mark names a person (§13.1); a bare key in a run's text is text, as a reader draws it. */
function namedInRuns(nodes: readonly InlineTextNode[], out: Set<string>): void {
  for (const node of nodes) {
    if (node.marks?.some((m) => m.type === 'code')) continue
    const uri = referenceUri(node)
    if (uri) for (const person of peopleNamedInBody(uri)) out.add(person)
  }
}

/**
 * The people a version of a file's text names by `nostr:npub…`: a `reference`
 * mark in a block document (§13.3), or the URI itself in marker text (§13.2).
 * A bare key in a document's plain run, a run marked `code`, and a code block
 * name nobody.
 */
export function peopleNamedInText(text: FileText): Set<string> {
  const out = new Set<string>()
  let doc: BlockDocument | undefined
  if (typeof text.content !== 'string') doc = text.content
  else if (text.format === BLOCK_DOCUMENT_FORMAT) {
    try {
      doc = parseBlockDocument(text.content)
    } catch {
      // A tag that lies about its content: read the string as marker text, as a message is read.
    }
  }
  if (doc) namedInBlocks(doc.content, out)
  // Marker text through §13.2's own parse, so a key inside `code` stays code.
  else if (typeof text.content === 'string') namedInRuns(markersToInlineNodes(text.content), out)
  return out
}

/**
 * The people `saved` names and `editedFrom` did not, in the order `saved`
 * names them. `editedFrom` is `null` for a creation, which is edited from
 * nothing.
 */
export function newlyNamedPeople(saved: FileText, editedFrom: FileText | null): string[] {
  const before = editedFrom ? peopleNamedInText(editedFrom) : new Set<string>()
  return [...peopleNamedInText(saved)].filter((person) => !before.has(person))
}

/**
 * The membership changes a save of a file's text writes beside itself
 * (§11.8): one Add (`member:<P>` = `true`) for each person `saved` names and
 * `editedFrom` did not, signed by `writer`, at most
 * {@link MAX_MENTIONED_PEOPLE}. None for the writer, whose own Add would be a
 * Join, and none when nobody is named anew — a typo fix writes nothing.
 *
 * The save itself carries no `p` for these people (§13.1). Publish each Add
 * with the save; an Add the relay refuses is the person not being told, and is
 * surfaced like any failed write (C9).
 */
export function mentionAddsFor(
  writer: string,
  createdAtMs: number,
  args: { file: string; folder: string; saved: FileText; editedFrom: FileText | null },
): UnsignedEvent[] {
  return newlyNamedPeople(args.saved, args.editedFrom)
    .filter((person) => person !== writer)
    .slice(0, MAX_MENTIONED_PEOPLE)
    .map((person) => buildMembershipChange(writer, createdAtMs, { file: args.file, folder: args.folder, person, member: true }))
}

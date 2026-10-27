/**
 * What the shared comment box holds, as the message it writes, and back
 * (COMM-2).
 *
 * The box is `@estiva-app/ui/editor`'s `CommentBox`, and it hands its app the
 * editor's document: a person as a `mention` or `urgentMention` chip, a
 * message or a file as a `captionedReference` chip. That package depends on no
 * protocol package, so the translation is here, once, for every app — Ship
 * wrote it itself until now (`chipsAsReferences`, `withoutNewUrgency`,
 * `urgentChipsFrom`), and Peek and Leaf each would have again.
 *
 * - {@link composerText}: the document → the marker text a send writes, and the
 *   people it names urgently (what {@link urgentTagsFor} takes).
 * - {@link composerDocument}: marker text → the document an edit or a draft
 *   opens with, the people and references as chips again.
 * - {@link withoutNewUrgency}: an edit's text, making nobody newly urgent.
 * - {@link composerDraft}: a {@link DraftStore} as the box reads and writes it.
 *
 * why: https://github.com/estiva-app/estiva-docs/blob/main/decisions/every-app-writes-and-reacts-with-one-shared-box.md
 */
import {
  blockDocumentToMarkerText,
  decodeNpub,
  documentForEditing,
  fromEditorDocument,
  linksOnWordsOf,
  toEditorDocument,
  type EditorDocument,
  type EditorNode,
} from '@estiva-app/protocol'
import { mentionText } from './compose.js'
import type { DraftStore } from './drafts.js'

/** What a composer's document writes: the trimmed marker text, and whom it names urgently. */
export interface ComposerText {
  text: string
  /** The keys its urgent chips name, once each; absent when none do. What `urgentTagsFor` takes. */
  urgent?: string[]
}

const HEX_KEY = /^[0-9a-f]{64}$/

const keyOf = (node: EditorNode): string | null => {
  const pubkey = node.attrs?.pubkey
  return typeof pubkey === 'string' && HEX_KEY.test(pubkey) ? pubkey : null
}

/**
 * A link on words as the marker format writes it, `[words](url)`, and back.
 * Read by protocol's `linksOnWordsOf`, the rule `valuesIn` and ui's `RichText`
 * read by, so a URL starting earlier swallows a bracket inside it here as it
 * does there. Words hold no bracket and no line break (COMM-8; Peek's rule).
 */
const LINK_TARGET = /^(?:https?:\/\/|mailto:)[^\s)]+$/
const LINK_WORDS = /^[^[\]\n]+$/

const linkMarkOf = (node: EditorNode) => node.marks?.find((m) => m.type === 'link')

/**
 * Words the box holds as a link (a URL pasted over them) written as
 * `[words](url)`. The block bridge draws and writes no link on words, so
 * without this the words would be sent and the link dropped. A link whose
 * words are its URL is the URL itself; words that cannot be a marker link (a
 * bracket, code) keep their words and lose the link, as the bridge did.
 */
function linkOnWordsAsMarker(node: EditorNode): EditorNode {
  const link = linkMarkOf(node)
  const href = link?.attrs?.href
  if (!link || node.text === undefined) return node
  const marks = (node.marks ?? []).filter((m) => m !== link)
  const kept = marks.length ? { marks } : {}
  const written = typeof href === 'string' && node.text !== href && LINK_TARGET.test(href) && LINK_WORDS.test(node.text) && !marks.some((m) => m.type === 'code')
  return { type: 'text', text: written ? `[${node.text}](${href})` : node.text, ...kept }
}

/** Marker text's `[words](url)` in a text node, as the words with a `link` mark the box draws; anything else as it was. */
function linksOnWordsAsMarks(node: EditorNode): EditorNode[] {
  const text = node.text ?? ''
  if (!text.includes('](') || node.marks?.some((m) => m.type === 'code' || m.type === 'link')) return [node]
  const out: EditorNode[] = []
  let at = 0
  for (const link of linksOnWordsOf(text)) {
    if (link.from > at) out.push({ ...node, text: text.slice(at, link.from) })
    out.push({ ...node, text: link.words, marks: [...(node.marks ?? []), { type: 'link', attrs: { href: link.url } }] })
    at = link.to
  }
  if (out.length === 0) return [node]
  if (at < text.length) out.push({ ...node, text: text.slice(at) })
  return out
}

/**
 * The chips as the block bridge can write them. `fromEditorDocument` knows a
 * `reference` and drops any inline node it does not, so a picked person would
 * vanish from the message: a chip becomes the `reference` its `nostr:` text
 * names (§13.1), or `@Name` / `!@Name` for somebody with no key.
 */
function chipsAsReferences(node: EditorNode): EditorNode {
  if (node.type === 'text') return linkOnWordsAsMarker(node)
  if (node.type === 'mention' || node.type === 'urgentMention') {
    const pubkey = keyOf(node)
    const written = mentionText({ pubkey, label: String(node.attrs?.label ?? '') }, node.type === 'urgentMention')
    return pubkey ? { type: 'reference', attrs: { uri: written } } : { type: 'text', text: written }
  }
  if (node.type === 'captionedReference') {
    const uri = typeof node.attrs?.uri === 'string' ? node.attrs.uri : ''
    return uri ? { type: 'reference', attrs: { uri } } : { type: 'text', text: String(node.attrs?.label ?? '') }
  }
  return node.content ? { ...node, content: node.content.map(chipsAsReferences) } : node
}

/**
 * The message a composer's document writes: its marker text, trimmed, and the
 * keys its urgent chips name. A document with no blocks (an edit of a message
 * that is only files starts as one) is no text.
 *
 * The send then earns its tags from these, as before: `mentionTagsFor`,
 * `urgentTagsFor(text, urgent)`, `quoteTagsFor`, `referenceTagsFor`.
 */
export function composerText(doc: EditorDocument | EditorNode): ComposerText {
  const urgent = new Set<string>()
  const walk = (node: EditorNode) => {
    if (node.type === 'urgentMention') {
      const pubkey = keyOf(node)
      if (pubkey) urgent.add(pubkey)
    }
    node.content?.forEach(walk)
  }
  walk(doc)
  const text = doc.content?.length ? blockDocumentToMarkerText(fromEditorDocument(chipsAsReferences(doc) as EditorDocument)).trim() : ''
  return urgent.size > 0 ? { text, urgent: [...urgent] } : { text }
}

/** What a composer needs to draw marker text as chips again. Each answers `undefined` for what it does not know. */
export interface ComposerLabels {
  /** A person's name, by key: their `nostr:npub…` becomes a chip again. */
  personLabel?: (pubkey: string) => string | undefined
  /** A message's or a file's chip, by its `nostr:` URI, as `[` captioned it. */
  referenceCaption?: (uri: string) => { label: string; snippet: string } | undefined
}

/** A reference that carries nothing a chip would drop: no marks, no card, no URL. */
const plainReference = (node: EditorNode): string | null => {
  if (node.type !== 'reference') return null
  const { uri, marks, embed, extra, href } = node.attrs ?? {}
  if (typeof uri !== 'string' || !uri) return null
  if ((Array.isArray(marks) && marks.length > 0) || embed || extra || href) return null
  return uri
}

/**
 * The document a composer opens with for marker text — an edit's or a draft's.
 *
 * A person written as `nostr:npub…` becomes a `mention` chip again, or an
 * `urgentMention` one when `urgent` names them (§13.1 keeps the urgency in a
 * tag, so marker text alone cannot say it); a message or a file becomes its
 * `captionedReference` chip. Whatever `labels` does not know stays the
 * `reference` it was, and so does one with marks or a card, which a chip
 * would lose. A link on words, `[words](url)`, opens as the words with a
 * `link` mark, as the box drew it while it was written.
 */
export function composerDocument(text: string, labels: ComposerLabels = {}, urgent?: readonly string[]): EditorDocument {
  const keys = new Set(urgent ?? [])
  const walk = (node: EditorNode): EditorNode => {
    const uri = plainReference(node)
    if (uri && /^nostr:npub1/i.test(uri)) {
      let pubkey: string | null = null
      try {
        pubkey = decodeNpub(uri.slice('nostr:'.length).toLowerCase())
      } catch {
        pubkey = null
      }
      const label = pubkey ? labels.personLabel?.(pubkey) : undefined
      if (pubkey && label !== undefined) return { type: keys.has(pubkey) ? 'urgentMention' : 'mention', attrs: { id: pubkey, label, pubkey } }
      return node
    }
    if (uri) {
      const caption = labels.referenceCaption?.(uri)
      if (caption) return { type: 'captionedReference', attrs: { id: uri, label: caption.label, snippet: caption.snippet, uri } }
      return node
    }
    return node.content ? { ...node, content: node.content.flatMap((child) => (child.type === 'text' ? linksOnWordsAsMarks(child) : [walk(child)])) } : node
  }
  return walk(toEditorDocument(documentForEditing(text, 'marker')) as EditorNode) as EditorDocument
}

/**
 * An edit's text with any `!@Name` the message did not already hold written as
 * an ordinary `@Name` — CON-24. An edit carries no tags, so it makes nobody
 * urgent (Miky, kickoff, 2026-10-07); a hand-typed `!@Name` is the old urgent
 * text, which Peek still draws urgent while it pages nobody.
 */
export function withoutNewUrgency(text: string, original: string): string {
  return text.replace(/!@([^\s!@]+)/g, (whole, name: string) => (original.includes(whole) ? whole : `@${name}`))
}

/** One composer's draft, in the composer's own terms. */
export interface ComposerDraft {
  /** The document to open with, or `undefined` when there is no draft. */
  read(): EditorDocument | undefined
  /** Keep what is written; an empty document clears the draft. */
  write(doc: EditorDocument): void
  clear(): void
}

/**
 * A draft kept in `store` under `key` (one of `draftKeys`), read and written as
 * the composer's document: the marker text and the urgent picks (CON-31), and
 * the chips back through {@link composerDocument}.
 */
export function composerDraft(store: DraftStore, key: string, labels: ComposerLabels = {}): ComposerDraft {
  return {
    read() {
      const draft = store.readDraft(key)
      return draft && draft.text.trim() ? composerDocument(draft.text, labels, draft.urgent) : undefined
    },
    write(doc) {
      const { text, urgent } = composerText(doc)
      store.write(key, text, urgent)
    },
    clear() {
      store.clear(key)
    },
  }
}

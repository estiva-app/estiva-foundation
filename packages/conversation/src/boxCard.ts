/**
 * What a comment box shows under itself, as it will be sent (SPEC §13.6.1,
 * §13.6.2), for every app's box (COMM-8). Peek wrote this rule itself
 * (`lib/boxCard.ts`) and Ship its copy (`lib/messageCard.ts`); it is here once
 * so Leaf, and Ship on the shared box, read a draft as Peek does.
 *
 * - **One file's card.** When what is written names exactly one file, its
 *   default card, `["embed", V, "detailed"]`, by protocol's `defaultCardOf`:
 *   a Folder, a person, a message and the file the conversation is on do not
 *   count, a link on words counts by its target, and a plain web link counts
 *   for nothing. ✕ takes it off (the box's to keep).
 * - **The live part of each block link**, as the `part` the message will
 *   carry, one per file. A part counts as its file and draws instead of a card,
 *   so linking an issue and a block of a page shows the block and no card. A
 *   link to a block of the conversation's own file is its chip only and
 *   writes no `part` (Miky, 2026-10-19).
 *
 * Read from the marker text the box would send, by the rules a reader draws it
 * by, so what shows under the box is what shows under the message.
 *
 * why: https://github.com/estiva-app/estiva-docs/blob/main/decisions/a-link-on-words-counts-toward-the-card.md
 */
import {
  defaultCardOf,
  toRenderTree,
  valuesIn,
  withCard,
  type EditorDocument,
  type EditorNode,
  type Embed,
  type LinkResolver,
  type PartPointer,
} from '@estiva-app/protocol'
import { composerText } from './composer.js'

/** At most this many blocks show live under one message (SPEC §13.6.1). */
export const MAX_PARTS = 6

export interface BoxLinks {
  /** Every address and event id the text names. */
  values: string[]
  /** The block links' parts, one per file, the first link's; none of the conversation's own file. */
  parts: PartPointer[]
  /** The file that gets the default card, before any ✕. */
  card?: string
  /**
   * Every URL the text names, bare or as a link's target, once each: what the
   * app asks its resolver about, so an answer that comes back later reads again.
   */
  urls: string[]
}

export interface BoxLinkContext {
  /** What an app link names for a card (§7.7), as answered so far. */
  resolveLink: LinkResolver
  /** The file and block a link to one block names, as answered so far. */
  blockOf: (url: string) => PartPointer | undefined
  /** The file whose conversation this is: it gets no card here, and its blocks no part. */
  here?: string
  /** An edit's: the values the message named before it, which get no default again. */
  previous?: readonly string[]
}

/**
 * What an app link in the box draws as: the file or message it names, or, for
 * a link to one block, its file (§13.6.1), so a pasted block link reads as its
 * file's chip, the block live under the box.
 */
export function linkTargetOf(url: string, context: Pick<BoxLinkContext, 'resolveLink' | 'blockOf'>): string | undefined {
  return context.resolveLink(url) ?? context.blockOf(url)?.address
}

/** What a marker text names, and the one file it gives the default card. */
export function boxLinksOf(text: string, context: BoxLinkContext): BoxLinks {
  // valuesIn asks the resolver about exactly the URLs a reader counts (not one
  // in a code span, nor one in a link's words), so recording its questions
  // gives the URLs without a second URL finder.
  const urls: string[] = []
  const values = valuesIn(text ? toRenderTree(text, 'marker') : [], (url) => {
    if (!urls.includes(url)) urls.push(url)
    return context.resolveLink(url)
  })
  const parts = new Map<string, PartPointer>()
  for (const url of urls) {
    const part = context.blockOf(url)
    if (part && part.address !== context.here && !parts.has(part.address)) parts.set(part.address, part)
  }
  const kept = [...parts.values()].slice(0, MAX_PARTS)
  const card = defaultCardOf(values, kept, { here: context.here, previous: context.previous })
  return { values, parts: kept, card, urls }
}

/** {@link boxLinksOf} of a composer's document (`CommentBox`'s JSON), read as {@link composerText} writes it. */
export function boxReadOf(doc: EditorDocument | EditorNode, context: BoxLinkContext): BoxLinks {
  return boxLinksOf(composerText(doc).text, context)
}

/**
 * What a message named before an edit, for `defaultCardOf`'s `previous`: its
 * values, and the file of each block link, which was named too.
 */
export function namedBefore(text: string, context: Pick<BoxLinkContext, 'resolveLink' | 'blockOf'>): string[] {
  const { values, urls } = boxLinksOf(text, context)
  const files = urls.map((url) => context.blockOf(url)?.address).filter((v): v is string => !!v)
  return [...new Set([...values, ...files])]
}

/** The `embed` set a new message sends: the default card, unless ✕ took it off. `none` is never written. */
export function embedsToSend(links: Pick<BoxLinks, 'card'>, removed: ReadonlySet<string>): Embed[] {
  return links.card && !removed.has(links.card) ? [{ value: links.card, layout: 'detailed' }] : []
}

/**
 * The `embed` set an edit sends, or undefined to leave the message's as it
 * was. Only an edit that names a file first adds its default (`links` read
 * with `previous`), and then it carries the whole folded set with it, since a
 * set replaces (§13.6.2). A card removed with ✕, before sending or after,
 * stays removed.
 */
export function embedsToEdit(links: Pick<BoxLinks, 'card'>, removed: ReadonlySet<string>, folded: readonly Embed[] | undefined): Embed[] | undefined {
  return links.card && !removed.has(links.card) ? withCard(folded ?? [], links.card, 'detailed') : undefined
}

/** ✕ on a sent message's card: the folded set, with that card `none` and every other kept. */
export function withoutCard(folded: readonly Embed[] | undefined, value: string): Embed[] {
  return withCard(folded ?? [], value, 'none')
}

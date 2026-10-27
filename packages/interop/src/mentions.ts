/**
 * Where a file is mentioned — its "Mentioned in", once for every app (SPEC
 * §6.4, §6.8, PEEKM-7). Peek's file panel and Ship's Activity each read it
 * their own way: Peek dropped a row an edit took a `nostr:` reference out of,
 * Ship kept every first version, and neither saw a link an edit added.
 *
 * A file lists a message while the message's **latest words** link it. The
 * candidates are every message, comment and edit pointing at the file by `a`
 * (an edit carries the `a` its new words earn); an edit stands for the message
 * it edits; and each is confirmed against the folded body, by a `nostr:`
 * reference or an app link that names the file. A message the reader cannot
 * read lists nothing, whatever its edits point at. The file's own conversation
 * is not a mention of it.
 *
 * why: https://github.com/estiva-app/estiva-docs/blob/main/decisions/an-edit-says-what-the-message-links-now.md
 * why: https://github.com/estiva-app/estiva-docs/blob/main/decisions/activity-lists-only-mentions-from-elsewhere.md
 */
import { anchorsOf, editsByTarget, editTargetOf, isCommentOn, KIND_COMMENT, KIND_EDIT, KIND_MESSAGE } from '@estiva-app/conversation'
import { toRenderTree, valuesIn, type LinkResolver, type SignedEvent } from '@estiva-app/protocol'
import { linksIn, within, MAX_LINKS_ASKED, type LinkReader } from './links.js'
import type { QueryFn } from './projection.js'

/** One message that mentions the file, as its latest words say. */
export interface MentionedIn {
  /** The message as sent: a `kind:1111` comment or a `kind:9` message. Where it was said, its thread, its author. */
  event: SignedEvent
  /** Its latest words: the latest edit's, or its own. */
  body: string
  /** The latest edit, when there is one: its files and cards replace the message's (§6.8). */
  edit?: SignedEvent
}

/** Enough for a list that is scanned, not read; the oldest pointers are what a cap drops. */
export const MENTIONED_IN_LIMIT = 200

/**
 * How many links one Mentioned-in read asks about in all, newest messages
 * first. Each asked link is a relay query, and {@link MENTIONED_IN_LIMIT}
 * candidates at {@link MAX_LINKS_ASKED} each would be 4,800 of them for one
 * panel (PEEKM-7's review). A link left over stays unanswered, so a message
 * pointing at the file keeps its row; a later read asks the next ones.
 */
export const MAX_MENTIONED_IN_LINKS_ASKED = 64

/**
 * The links of a message's words that can name the file: the first
 * {@link MAX_LINKS_ASKED}, the ones a sender asks about before it tags. A link
 * past them earned no `a`, so it is never asked about and keeps no row: a body
 * of hundreds of links costs a reader no more than a sender.
 */
const linksNaming = (tree: ReturnType<typeof toRenderTree>) => linksIn(tree).slice(0, MAX_LINKS_ASKED)

/** The one filter for the candidates: every message, comment and edit pointing at the file. */
export function mentionedInFilter(address: string, limit = MENTIONED_IN_LIMIT): Record<string, unknown> {
  return { kinds: [KIND_COMMENT, KIND_MESSAGE, KIND_EDIT], '#a': [address], limit }
}

const isMessage = (event: SignedEvent) => event.kind === KIND_COMMENT || event.kind === KIND_MESSAGE

/**
 * The messages among `events` that list under the file, newest first.
 *
 * `events` holds the candidates ({@link mentionedInFilter}), the messages their
 * edits edit, and every edit of each message; `resolveLink` what the app links
 * in their words name. `commentKinds` is the file's owner's comment kinds
 * (`isCommentOn`): a message on the file itself is not a mention of it.
 * `unanswered` says which links could not be asked about: a message whose
 * latest version points at the file and holds one keeps its row until the
 * link can be read, rather than lose it to a failed read.
 */
export function mentionedInOf(
  events: readonly SignedEvent[],
  address: string,
  resolveLink?: LinkResolver,
  commentKinds?: readonly number[],
  unanswered: (url: string) => boolean = () => false,
): MentionedIn[] {
  const messages = new Map<string, SignedEvent>()
  for (const event of events) if (isMessage(event)) messages.set(event.id.toLowerCase(), event)
  const edits = editsByTarget(events)
  const pointed = new Set<string>()
  for (const event of events) {
    if (!event.tags.some((t) => t[0] === 'a' && t[1] === address)) continue
    const id = event.kind === KIND_EDIT ? editTargetOf(event) : isMessage(event) ? event.id.toLowerCase() : undefined
    if (id) pointed.add(id)
  }
  const file = valueOf(address)
  const out: MentionedIn[] = []
  for (const id of pointed) {
    const event = messages.get(id)
    if (!event) continue
    if (anchorsOf(event).includes(address) || isCommentOn(event, address, commentKinds)) continue
    // An edit by anyone but the author is not the message's (the relay refuses one; a reader does not trust that).
    const edit = edits.get(id)?.filter((e) => e.pubkey === event.pubkey).at(-1)
    const body = edit?.content ?? event.content
    const tree = toRenderTree(body, 'marker')
    const pointsNow = (edit ?? event).tags.some((t) => t[0] === 'a' && t[1] === address)
    const first = linksNaming(tree)
    const named = new Set(first)
    const resolve: LinkResolver | undefined = resolveLink && ((url) => (named.has(url) ? resolveLink(url) : undefined))
    if (!valuesIn(tree, resolve).includes(file) && !(pointsNow && first.some(unanswered))) continue
    out.push(edit ? { event, body, edit } : { event, body })
  }
  return out.sort((a, b) => b.event.created_at - a.event.created_at)
}

/**
 * {@link mentionedInOf} as the viewer: the candidates, then the messages their
 * edits edit and every edit of each message, then what the links in their
 * latest words name, asked through `links` and waited for at most `waitMs`.
 * Throws when a read is refused, so an unreadable relay and a file nobody
 * mentions are not the same empty list.
 */
export async function readMentionedIn(
  query: QueryFn,
  address: string,
  options: { links?: LinkReader; limit?: number; waitMs?: number; commentKinds?: readonly number[] } = {},
): Promise<MentionedIn[]> {
  const candidates = await query([mentionedInFilter(address, options.limit)])
  const held = new Set(candidates.filter(isMessage).map((e) => e.id.toLowerCase()))
  const missing = [...new Set(candidates.filter((e) => e.kind === KIND_EDIT).map(editTargetOf))].filter((id): id is string => !!id && !held.has(id))
  const targets = missing.length ? await query([{ ids: missing, kinds: [KIND_COMMENT, KIND_MESSAGE] }]) : []
  const ids = [...held, ...targets.map((e) => e.id.toLowerCase())]
  const edits = ids.length ? await query([{ kinds: [KIND_EDIT], '#e': ids, limit: 1000 }]) : []
  const events = [...candidates, ...targets, ...edits]
  const links = options.links
  if (!links) return mentionedInOf(events, address, undefined, options.commentKinds, () => true)
  // The links that can name the file in each candidate's latest words: read as if each named it, so each candidate holding one is kept to ask.
  // At most MAX_MENTIONED_IN_LINKS_ASKED, newest messages first; one left over stays unanswered, so a message pointing at the file keeps its row.
  const urls = [...new Set(mentionedInOf(events, address, () => address, options.commentKinds).flatMap((m) => linksNaming(toRenderTree(m.body, 'marker'))))]
  const waiting = urls.filter((url) => !links.answered(url)).slice(0, MAX_MENTIONED_IN_LINKS_ASKED)
  if (waiting.length) await within(links.ask(waiting), options.waitMs ?? 5000)
  return mentionedInOf(events, address, links.known, options.commentKinds, (url) => !links.answered(url))
}

/** The address as `valuesIn` spells it. */
function valueOf(address: string): string {
  const [kind, pubkey = '', ...d] = address.split(':')
  return `${kind}:${pubkey.toLowerCase()}:${d.join(':')}`
}

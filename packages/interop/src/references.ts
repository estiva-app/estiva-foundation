/**
 * The files `[` offers, as @estiva-app/conversation ranks them (PEE-21).
 *
 * conversation's `rankReferences` orders candidates and knows nothing of a
 * relay; this is the half that turns what a relay holds into candidates — a
 * resolved object into a row, and typed text into the search tier — so Peek
 * and Ship draw the same rows from the same reads.
 *
 * A row is the type word, the current title and, when it has one, the file's
 * summary (SPEC §6.12, SUM-7); an issue is captioned with its
 * project's title, and nothing names a Folder (Miky, 2026-10-03). Only what the
 * reader resolved is offered: an object the relay did not hand back to them is
 * never a row, so nothing unreadable is offered. An archived file is offered
 * at the lowest priority, and so is an issue in an archived project.
 */
import {
  FILE_TIER,
  fileReference,
  KIND_CHANGE,
  referenceMatch,
  refMatch,
  type ReferenceCandidate,
  type ReferenceType,
} from '@estiva-app/conversation'
import {
  isClosedStatus,
  KIND_BARE_FILE,
  projectListedFiles,
  resolveForeignRoots,
  type ForeignObject,
  type ProjectionCache,
  type QueryFn,
} from './projection.js'
import { fileIdFormOf, type SearchMatch, type SignedEvent } from '@estiva-app/protocol'

const KIND_PROJECT = 30850
const KIND_ISSUE = 30851
const KIND_DOCUMENT = 30842

/**
 * The kinds `[` offers as files, and the type word each draws as. A Leaf page
 * is offered in every app, beside topics, projects and issues (Miky, SUM-7
 * kickoff, 2026-10-16).
 */
export const REFERENCE_FILE_TYPES: Readonly<Record<number, ReferenceType>> = {
  [KIND_PROJECT]: 'project',
  [KIND_ISSUE]: 'issue',
  [KIND_BARE_FILE]: 'topic',
  [KIND_DOCUMENT]: 'document',
}

/** A file's summary as a row's second line: plain text, never a body declared into the slot. */
const summaryOf = (object: ForeignObject): string | undefined => {
  const slot = object.slots.subtitle
  return slot && !slot.format ? slot.value.replace(/\s+/g, ' ').trim() || undefined : undefined
}

const typeOf = (kind: number): ReferenceType | undefined => REFERENCE_FILE_TYPES[kind]

type Addressed = ForeignObject & { address: string }

/** An object `[` may offer: a file kind it knows, resolved, not deleted (SPEC §6.5), with a title. */
const offerable = (object: ForeignObject | null | undefined): object is Addressed =>
  !!object &&
  !!object.address &&
  !object.unreachable &&
  !object.deleted &&
  typeOf(object.kind) !== undefined &&
  !!object.slots.title?.value.trim()

/**
 * An issue's current ref (`CON-33`, SPEC §6.1) — the manifest slot that folds
 * the `ref` field — so typing it finds the issue. Only an issue has one.
 */
const refOf = (object: ForeignObject): string | undefined =>
  object.kind === KIND_ISSUE ? object.meta.find((slot) => slot.field === 'ref')?.value.trim() || undefined : undefined

export interface FileCandidatesOptions {
  cache?: ProjectionCache
  /** When each address was last written or read, in seconds — newer first within a tier. */
  at?: ReadonlyMap<string, number>
  /** The types the relay keeps in order (`RelayFileReads.inOrder`): a project of one is picked as its link. */
  inOrder?: readonly string[]
  /** The host Ship serves projects from: a picked project's link is `<it>/project/<d>`. Ship's own unless said, so every app picks the same link. */
  projectOrigin?: string
  /** The relay offers the list read: an issue's project, read for its caption, is read by its current fields (`resolveForeignRoots`). */
  listRead?: boolean
}

/** Where Ship serves projects (§13.1, decided 2026-11-03): one link for a project, whichever app picked it. */
export const SHIP_ORIGIN = 'https://ship.estiva.app'

/**
 * How a picked file goes in the text (§13.1): a project whose type the relay
 * keeps in order as Ship's path link with its id and no title, which every
 * app's host answers; anything else as `nostr:naddr…`.
 *
 * why: https://github.com/estiva-app/estiva-docs/blob/main/decisions/a-file-is-named-by-its-id-in-a-capital-and-small-tag.md
 */
export function pickedFileUri(
  address: string,
  { inOrder = [], projectOrigin = SHIP_ORIGIN }: Pick<FileCandidatesOptions, 'inOrder' | 'projectOrigin'> = {},
): string {
  const byId = fileIdFormOf(inOrder, address)
  return byId?.type === 'osnova.project' ? `${projectOrigin.replace(/\/+$/, '')}/project/${byId.id}` : fileReference(address)
}

/**
 * Rows for resolved files, all in one tier.
 *
 * An issue's caption is its project's title, and an issue in an archived
 * project is archived with it: the project is taken from `objects` when it is
 * among them, and otherwise read in one more batch for every missing project
 * at once (roots and changes only). A project that cannot be read leaves the
 * caption empty rather than dropping the issue. Objects that are not
 * offerable — unreachable, untitled, or of a kind `[` does not offer — are
 * left out.
 */
export async function fileCandidates(
  objects: readonly (ForeignObject | null | undefined)[],
  tier: number,
  query: QueryFn,
  { cache, at, inOrder, projectOrigin, listRead }: FileCandidatesOptions = {},
): Promise<ReferenceCandidate[]> {
  const files = objects.filter(offerable)
  const parents = new Map<string, ForeignObject>()
  for (const o of objects) if (o?.address && !o.unreachable) parents.set(o.address, o)
  const missing = [
    ...new Set(files.flatMap((o) => (o.kind === KIND_ISSUE && o.parentRef && !parents.has(o.parentRef) ? [o.parentRef] : []))),
  ]
  if (missing.length) {
    const read = await resolveForeignRoots(missing, query, cache, { listRead }).catch(() => [])
    for (const parent of read) if (parent.address) parents.set(parent.address, parent)
  }
  return files.map((o) => {
    const parent = o.kind === KIND_ISSUE && o.parentRef ? parents.get(o.parentRef) : undefined
    const ref = refOf(o)
    const summary = summaryOf(o)
    return {
      id: o.address,
      uri: pickedFileUri(o.address, { inOrder, projectOrigin }),
      type: typeOf(o.kind)!,
      kind: o.kind,
      title: o.slots.title!.value,
      // An issue reads "CON-33 · Conversation standard": the ref first, so a hit by ref shows it (Miky, 2026-10-05).
      caption: [ref, parent?.slots.title?.value].filter(Boolean).join(' · '),
      ...(summary ? { summary } : {}),
      tier,
      ...(ref ? { search: ref } : {}),
      ...(isClosedStatus(o.slots.status) ? { closed: true } : {}),
      ...(o.archived || parent?.archived ? { archived: true } : {}),
      ...(at?.has(o.address) ? { at: at.get(o.address) } : {}),
    }
  })
}

/** A `/query` that keeps what a `search` found besides its events (protocol's `Relay.queryWithMatches`). */
export type SearchQueryFn = (filters: Record<string, unknown>[]) => Promise<{ events: SignedEvent[]; matches: readonly SearchMatch[] }>

export interface SearchFileReferencesOptions extends Omit<FileCandidatesOptions, 'at'> {
  /** How many roots, and separately how many renames, the relay is asked for. Default 32. */
  limit?: number
  /**
   * The kinds the relay finds by the words of their current fields (NIP-11
   * `file_search`, `RelayFileReads.search`), and the read that asks it. Those
   * kinds are found by their summary, key and text too, through the list read;
   * every other kind by its title as before.
   */
  byFields?: {
    kinds: readonly number[]
    query: SearchQueryFn
    /** The relay's `file_search.max_page_size`, which refuses a larger page. Default 20, production's. */
    limit?: number
  }
}

const tagOf = (event: { tags: string[][] }, name: string) => event.tags.find((t) => t[0] === name)?.[1]

/**
 * The file a `kind:1851` hit names, when it is one the relay indexes for `[`
 * (SPEC §5.2): a title change on any file, a ref change only on an issue.
 */
const searchedChange = (field: string | undefined, address: string | undefined) =>
  field === 'title' || (field === 'ref' && address?.startsWith(`${KIND_ISSUE}:`)) ? address : undefined

/**
 * The files whose **current** title — or, for an issue, current ref (CON-33)
 * — holds `text`, as the search tier.
 *
 * The relay indexes a root's `title` and `ref` and a change's `value` for those
 * fields (SPEC §5.2); none is the current one on its own — a root keeps the
 * name it was created with, and a rename found by an old word may since have
 * been renamed again. So a hit is only an address: each is read back as its
 * root and changes, folded through its app's manifest, and kept only when what
 * it is called now matches what was typed.
 *
 * Roots and renames are asked for separately, so a burst of renames cannot
 * crowd every root out of the answer. Every typed word matches the start of a
 * word (SPEC §5.2), so a word matches before it is finished; `search_mode` is
 * still sent for a relay from before that rule. A relay that indexes none of these
 * kinds answers nothing, and so does this. A failed read rejects, for
 * `referenceSearch` to answer no hits for a while.
 *
 * With `byFields`, its kinds are found by the words of their current fields
 * instead, ahead of the title hits (`searchByFields`).
 */
export async function searchFileReferences(
  text: string,
  query: QueryFn,
  { limit = 32, byFields, ...options }: SearchFileReferencesOptions = {},
): Promise<ReferenceCandidate[]> {
  const wanted = text.trim()
  if (!wanted) return []
  const fieldKinds = new Set(byFields?.kinds.filter((kind) => typeOf(kind)) ?? [])
  const [byTitle, found] = await Promise.all([
    searchByTitle(wanted, query, limit, fieldKinds, options),
    byFields && fieldKinds.size ? searchByFields(wanted, byFields.query, [...fieldKinds], byFields.limit ?? 20, query, options) : [],
  ])
  return [...found, ...byTitle]
}

/** The files of every kind but `skip` whose current title or ref holds `wanted`. */
async function searchByTitle(
  wanted: string,
  query: QueryFn,
  limit: number,
  skip: ReadonlySet<number>,
  options: Omit<FileCandidatesOptions, 'at'>,
): Promise<ReferenceCandidate[]> {
  const kinds = Object.keys(REFERENCE_FILE_TYPES).map(Number).filter((kind) => !skip.has(kind))
  if (!kinds.length) return []
  const asked = { search: wanted, search_mode: 'prefix', limit }
  const hits = await query([
    { kinds, ...asked },
    { kinds: [KIND_CHANGE], ...asked },
  ])
  const at = new Map<string, number>()
  for (const hit of hits) {
    const address =
      hit.kind === KIND_CHANGE
        ? searchedChange(tagOf(hit, 'field'), tagOf(hit, 'a'))
        : typeOf(hit.kind) && `${hit.kind}:${hit.pubkey}:${tagOf(hit, 'd') ?? ''}`
    const kind = Number(address?.split(':')[0])
    if (!address || !typeOf(kind) || skip.has(kind)) continue
    at.set(address, Math.max(at.get(address) ?? 0, hit.created_at))
  }
  if (at.size === 0) return []
  const objects = await resolveForeignRoots([...at.keys()], query, options.cache)
  const matching = objects.filter((o) => (o.slots.title && referenceMatch(o.slots.title.value, wanted) > 0) || refMatch(refOf(o), wanted) > 0)
  return fileCandidates(matching, FILE_TIER.search, query, { ...options, at })
}

/**
 * The files of `kinds` whose current title, summary, key or text holds
 * `wanted`, by the relay's list read with `search` (§6.13): each hit is its
 * first record and its fields' current changes, so nothing is folded from its
 * history and nothing older than its current values matches. A hit found only
 * in its text shows the words around the match as its second line.
 *
 * why: https://github.com/estiva-app/estiva-docs/blob/main/decisions/search-finds-a-file-by-the-words-of-its-current-fields.md
 */
async function searchByFields(
  wanted: string,
  search: SearchQueryFn,
  kinds: readonly number[],
  limit: number,
  query: QueryFn,
  options: Omit<FileCandidatesOptions, 'at'>,
): Promise<ReferenceCandidate[]> {
  const { events, matches } = await search([{ kinds, search: wanted, limit, fields: 'newest' }])
  const why = new Map(matches.map((m) => [m.a, m.match]))
  const at = new Map<string, number>()
  const objects = (await projectListedFiles(events, query, options.cache)).filter((o) => o.address && why.has(o.address))
  for (const event of events) {
    const address = event.kind === KIND_CHANGE ? tagOf(event, 'a') : `${event.kind}:${event.pubkey}:${tagOf(event, 'd') ?? ''}`
    if (address && why.has(address)) at.set(address, Math.max(at.get(address) ?? 0, event.created_at))
  }
  const rank = new Map(matches.map((m, i) => [m.a, i]))
  objects.sort((a, b) => rank.get(a.address!)! - rank.get(b.address!)!)
  const rows = await fileCandidates(objects, FILE_TIER.search, query, { ...options, at })
  return rows.map((row) => {
    const match = why.get(row.id)!
    const around = match.fields[0] === 'text' ? match.around?.replace(/\s+/g, ' ').trim() : undefined
    // "…" marks words from inside the text, not the file's own summary; the relay does not say where they start.
    return { ...row, matched: match.fields, ...(around ? { summary: `…${around}` } : {}) }
  })
}

/**
 * The files `[` offers, as @estiva-app/conversation ranks them (PEE-21).
 *
 * conversation's `rankReferences` orders candidates and knows nothing of a
 * relay; this is the half that turns what a relay holds into candidates — a
 * resolved object into a row, and typed text into the search tier — so Peek
 * and Ship draw the same rows from the same reads.
 *
 * A row is the type word and the current title; an issue is captioned with its
 * project's title, and nothing names a Folder (Miky, 2026-10-03). Only what the
 * reader resolved is offered: an object the relay did not hand back to them is
 * never a row, so nothing unreadable is offered.
 */
import { FILE_TIER, fileReference, referenceMatch, type ReferenceCandidate, type ReferenceType } from '@estiva-app/conversation'
import {
  isClosedStatus,
  KIND_BARE_FILE,
  resolveForeignObjects,
  type ForeignObject,
  type PeopleFn,
  type ProjectionCache,
  type QueryFn,
} from './projection.js'

const KIND_PROJECT = 30850
const KIND_ISSUE = 30851
/** A file's change event (SPEC §6.3): a rename is one whose `field` is `title`. */
const KIND_FILE_CHANGE = 1851

/** The kinds `[` offers as files, and the type word each draws as. */
export const REFERENCE_FILE_TYPES: Readonly<Record<number, ReferenceType>> = {
  [KIND_PROJECT]: 'project',
  [KIND_ISSUE]: 'issue',
  [KIND_BARE_FILE]: 'topic',
}

const typeOf = (kind: number): ReferenceType | undefined => REFERENCE_FILE_TYPES[kind]

/** An object `[` may offer: a file kind it knows, resolved, with a title, not archived. */
const offerable = (object: ForeignObject | null | undefined): object is ForeignObject & { address: string } =>
  !!object &&
  !!object.address &&
  !object.unreachable &&
  !object.archived &&
  typeOf(object.kind) !== undefined &&
  !!object.slots.title?.value.trim()

export interface FileCandidatesOptions {
  lookupPeople?: PeopleFn
  cache?: ProjectionCache
  /** When each address was last written or read, in seconds — newer first within a tier. */
  at?: ReadonlyMap<string, number>
}

/**
 * Rows for resolved files, all in one tier.
 *
 * An issue's caption is its project's title: taken from `objects` when the
 * project is among them, and otherwise read in one more batch for every
 * missing project at once. A project that cannot be read leaves the caption
 * empty rather than dropping the issue. Objects that are not offerable —
 * unreachable, archived, untitled, or of a kind `[` does not offer — are left
 * out.
 */
export async function fileCandidates(
  objects: readonly (ForeignObject | null | undefined)[],
  tier: number,
  query: QueryFn,
  { lookupPeople, cache, at }: FileCandidatesOptions = {},
): Promise<ReferenceCandidate[]> {
  const files = objects.filter(offerable)
  const titles = new Map(files.map((o) => [o.address, o.slots.title!.value]))
  const missing = [
    ...new Set(
      files.flatMap((o) => (o.kind === KIND_ISSUE && o.parentRef && !titles.has(o.parentRef) ? [o.parentRef] : [])),
    ),
  ]
  if (missing.length) {
    const parents = await resolveForeignObjects(missing, query, lookupPeople, cache).catch(() => ({}))
    for (const [address, parent] of Object.entries(parents)) {
      if (parent && !parent.unreachable && parent.slots.title?.value) titles.set(address, parent.slots.title.value)
    }
  }
  return files.map((o) => ({
    id: o.address,
    uri: fileReference(o.address),
    type: typeOf(o.kind)!,
    kind: o.kind,
    title: o.slots.title!.value,
    caption: (o.kind === KIND_ISSUE && o.parentRef && titles.get(o.parentRef)) || '',
    tier,
    ...(isClosedStatus(o.slots.status) ? { closed: true } : {}),
    ...(at?.has(o.address) ? { at: at.get(o.address) } : {}),
  }))
}

export interface SearchFileReferencesOptions extends Omit<FileCandidatesOptions, 'at'> {
  /** How many hits the relay is asked for. Default 32 — one batch to resolve. */
  limit?: number
}

const tagOf = (event: { tags: string[][] }, name: string) => event.tags.find((t) => t[0] === name)?.[1]

/**
 * The files whose **current** title holds `text`, as the search tier.
 *
 * The relay indexes a root's `title` and a rename's `value` (relay ticket
 * 6fea004e); neither is the current title on its own — a root keeps the name
 * it was created with, and a rename found by an old word may since have been
 * renamed again. So a hit is only an address: each is resolved through its
 * app's manifest, which folds every rename, and kept only when what it is
 * called now matches what was typed.
 *
 * A relay that indexes none of these kinds answers nothing, and so does this.
 * A failed read rejects, for `referenceSearch` to remember as no hits.
 */
export async function searchFileReferences(
  text: string,
  query: QueryFn,
  { limit = 32, ...options }: SearchFileReferencesOptions = {},
): Promise<ReferenceCandidate[]> {
  const wanted = text.trim()
  if (!wanted) return []
  const hits = await query([
    { kinds: [...Object.keys(REFERENCE_FILE_TYPES).map(Number), KIND_FILE_CHANGE], search: wanted, limit },
  ])
  const at = new Map<string, number>()
  for (const hit of hits) {
    const address =
      hit.kind === KIND_FILE_CHANGE
        ? tagOf(hit, 'field') === 'title'
          ? tagOf(hit, 'a')
          : undefined
        : typeOf(hit.kind) && `${hit.kind}:${hit.pubkey}:${tagOf(hit, 'd') ?? ''}`
    if (!address || !typeOf(Number(address.split(':')[0]))) continue
    at.set(address, Math.max(at.get(address) ?? 0, hit.created_at))
  }
  if (at.size === 0) return []
  const objects = await resolveForeignObjects([...at.keys()], query, options.lookupPeople, options.cache)
  const matching = Object.values(objects).filter((o) => o?.slots.title && referenceMatch(o.slots.title.value, wanted) > 0)
  return fileCandidates(matching, FILE_TIER.search, query, { ...options, at })
}

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
 * never a row, so nothing unreadable is offered. An archived file is offered
 * at the lowest priority, and so is an issue in an archived project.
 */
import {
  FILE_TIER,
  fileReference,
  KIND_CHANGE,
  referenceMatch,
  type ReferenceCandidate,
  type ReferenceType,
} from '@estiva-app/conversation'
import {
  isClosedStatus,
  KIND_BARE_FILE,
  resolveForeignRoots,
  type ForeignObject,
  type ProjectionCache,
  type QueryFn,
} from './projection.js'

const KIND_PROJECT = 30850
const KIND_ISSUE = 30851

/** The kinds `[` offers as files, and the type word each draws as. */
export const REFERENCE_FILE_TYPES: Readonly<Record<number, ReferenceType>> = {
  [KIND_PROJECT]: 'project',
  [KIND_ISSUE]: 'issue',
  [KIND_BARE_FILE]: 'topic',
}

const typeOf = (kind: number): ReferenceType | undefined => REFERENCE_FILE_TYPES[kind]

type Addressed = ForeignObject & { address: string }

/** An object `[` may offer: a file kind it knows, resolved, with a title. */
const offerable = (object: ForeignObject | null | undefined): object is Addressed =>
  !!object &&
  !!object.address &&
  !object.unreachable &&
  typeOf(object.kind) !== undefined &&
  !!object.slots.title?.value.trim()

export interface FileCandidatesOptions {
  cache?: ProjectionCache
  /** When each address was last written or read, in seconds — newer first within a tier. */
  at?: ReadonlyMap<string, number>
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
  { cache, at }: FileCandidatesOptions = {},
): Promise<ReferenceCandidate[]> {
  const files = objects.filter(offerable)
  const parents = new Map<string, ForeignObject>()
  for (const o of objects) if (o?.address && !o.unreachable) parents.set(o.address, o)
  const missing = [
    ...new Set(files.flatMap((o) => (o.kind === KIND_ISSUE && o.parentRef && !parents.has(o.parentRef) ? [o.parentRef] : []))),
  ]
  if (missing.length) {
    const read = await resolveForeignRoots(missing, query, cache).catch(() => [])
    for (const parent of read) if (parent.address) parents.set(parent.address, parent)
  }
  return files.map((o) => {
    const parent = o.kind === KIND_ISSUE && o.parentRef ? parents.get(o.parentRef) : undefined
    return {
      id: o.address,
      uri: fileReference(o.address),
      type: typeOf(o.kind)!,
      kind: o.kind,
      title: o.slots.title!.value,
      caption: parent?.slots.title?.value ?? '',
      tier,
      ...(isClosedStatus(o.slots.status) ? { closed: true } : {}),
      ...(o.archived || parent?.archived ? { archived: true } : {}),
      ...(at?.has(o.address) ? { at: at.get(o.address) } : {}),
    }
  })
}

export interface SearchFileReferencesOptions extends Omit<FileCandidatesOptions, 'at'> {
  /** How many roots, and separately how many renames, the relay is asked for. Default 32. */
  limit?: number
}

const tagOf = (event: { tags: string[][] }, name: string) => event.tags.find((t) => t[0] === name)?.[1]

/**
 * The files whose **current** title holds `text`, as the search tier.
 *
 * The relay indexes a root's `title` and a rename's `value` (relay ticket
 * 6fea004e); neither is the current title on its own — a root keeps the name
 * it was created with, and a rename found by an old word may since have been
 * renamed again. So a hit is only an address: each is read back as its root
 * and changes, folded through its app's manifest, and kept only when what it
 * is called now matches what was typed.
 *
 * Roots and renames are asked for separately, so a burst of renames cannot
 * crowd every root out of the answer, and with buzz's prefix mode, so the word
 * being typed matches before it is finished. A relay that indexes none of these
 * kinds answers nothing, and so does this. A failed read rejects, for
 * `referenceSearch` to answer no hits for a while.
 */
export async function searchFileReferences(
  text: string,
  query: QueryFn,
  { limit = 32, ...options }: SearchFileReferencesOptions = {},
): Promise<ReferenceCandidate[]> {
  const wanted = text.trim()
  if (!wanted) return []
  const asked = { search: wanted, search_mode: 'prefix', limit }
  const hits = await query([
    { kinds: Object.keys(REFERENCE_FILE_TYPES).map(Number), ...asked },
    { kinds: [KIND_CHANGE], ...asked },
  ])
  const at = new Map<string, number>()
  for (const hit of hits) {
    const address =
      hit.kind === KIND_CHANGE
        ? tagOf(hit, 'field') === 'title'
          ? tagOf(hit, 'a')
          : undefined
        : typeOf(hit.kind) && `${hit.kind}:${hit.pubkey}:${tagOf(hit, 'd') ?? ''}`
    if (!address || !typeOf(Number(address.split(':')[0]))) continue
    at.set(address, Math.max(at.get(address) ?? 0, hit.created_at))
  }
  if (at.size === 0) return []
  const objects = await resolveForeignRoots([...at.keys()], query, options.cache)
  const matching = objects.filter((o) => o.slots.title && referenceMatch(o.slots.title.value, wanted) > 0)
  return fileCandidates(matching, FILE_TIER.search, query, { ...options, at })
}

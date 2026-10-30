/**
 * A topic's list of files — SPEC §6.14 "A file's list of other files"; record
 * why: https://github.com/estiva-app/estiva-docs/blob/main/decisions/a-topic-keeps-its-own-list-of-files.md
 *
 * A topic lists files from any Folder, one entry per file, by the file's id.
 * An entry is a `kind:1851` change on the topic: `a` and `O` name the topic,
 * `field` is `lists:<d>`, `value` is `true` or `false`, `h` is the topic's
 * Folder, then `ts`, then `["o", <d>]` naming the listed file. The newest
 * entry per topic and file counts (§6.3).
 *
 * `O` is the file the change is about and `o` another file it points at
 * (why: https://github.com/estiva-app/estiva-docs/blob/main/decisions/a-change-is-about-its-file-as-a-comment-is.md),
 * so `#o` asks which topics list a file and `#O` asks what changed on a topic,
 * and a file's own changes never include a topic's entry about it.
 *
 * Here rather than in each app because Peek, Ship and Leaf all add, remove
 * and read entries, and a reader rule kept in one of them only is a list that
 * reads differently in the next.
 *
 * ## What a listing is not
 *
 * It grants nothing: who reads the listed file is its own Folder's rule. It is
 * not a mention, not a parent and not a Folder's listing, so Mentioned in, the
 * archive chain and a Folder move all ignore it. It carries no `p`, so it adds
 * nobody to the file (§11.8).
 */
import { type SignedEvent, type UnsignedEvent } from '@estiva-app/protocol'
import { byOrder } from '@estiva-app/conversation'
import { folderOf, type QueryFn } from './projection.js'

const KIND_CHANGE = 1851
/** The topic (bare file) kind: the only lists this stage reads (Miky, 2026-10-30). */
const KIND_TOPIC = 30840
const KIND_FOLDER = 39000
/** Listed ids resolved per request: 2 × this stays under a relay's usual `limit` cap. */
const RESOLVE_BATCH = 100
/**
 * The file kinds a listed id is looked for under by default: topic, document,
 * project, issue. Never a bare `#d`, since a Folder's `kind:39000` shares its
 * uuid (§11.1). An app that knows more kinds from manifests passes them.
 */
export const LISTED_FILE_KINDS: readonly number[] = [30840, 30842, 30850, 30851]

const ADDRESS = /^(\d+):([0-9a-f]{64}):(.+)$/
const FIELD_PREFIX = 'lists:'

/** The field an entry for `file` sets: `lists:<d>`. */
export function listsField(file: string): string {
  return `${FIELD_PREFIX}${file}`
}

/** The file a list carries entries on, as a write needs it. */
export interface ListHolder {
  /** Its address, `<kind>:<pubkey>:<d>`. */
  address: string
  /** Its Folder, read from its root (`folderOf`), never the Folder it was opened from (§6.2). */
  folder: string
}

function entry(
  pubkey: string,
  createdAtMs: number,
  args: { list: ListHolder; file: string; listed: boolean; note?: string },
): UnsignedEvent {
  const holder = ADDRESS.exec(args.list.address)
  if (!holder) throw new Error(`not a file address: ${JSON.stringify(args.list.address)}`)
  if (!args.list.folder) throw new Error('a list entry names the Folder of the file that keeps the list')
  if (!args.file || /\s/.test(args.file)) throw new Error(`not a file id: ${JSON.stringify(args.file)}`)
  // A reader ignores a file on its own list (§6.14): refuse it here rather than publish an entry that shows nothing.
  if (args.file === holder[3]) throw new Error('a file is not on its own list')
  if (!Number.isSafeInteger(createdAtMs) || createdAtMs < 0) throw new Error(`not epoch milliseconds: ${createdAtMs}`)
  return {
    pubkey,
    created_at: Math.floor(createdAtMs / 1000),
    kind: KIND_CHANGE,
    tags: [
      ['a', args.list.address],
      ['O', holder[3]],
      ['field', listsField(args.file)],
      ['value', args.listed ? 'true' : 'false'],
      ['h', args.list.folder],
      ['ts', String(createdAtMs)],
      ['o', args.file],
    ],
    // Empty unless the person wrote a note: each app says "added" and "removed" in its own words (§6.14).
    content: args.note ?? '',
  }
}

/**
 * Put a file on a topic's list: `[kind:1851 lists:<d> = true]`, signed by
 * whoever adds it. `file` is the listed file's id (its `d`), from any Folder.
 */
export function planListInTopic(
  pubkey: string,
  createdAtMs: number,
  args: { topic: ListHolder; file: string; note?: string },
): UnsignedEvent[] {
  return [entry(pubkey, createdAtMs, { list: args.topic, file: args.file, listed: true, note: args.note })]
}

/** Take a file off a topic's list: `[kind:1851 lists:<d> = false]`. {@link planListInTopic} in reverse. */
export function planRemoveFromTopic(
  pubkey: string,
  createdAtMs: number,
  args: { topic: ListHolder; file: string; note?: string },
): UnsignedEvent[] {
  return [entry(pubkey, createdAtMs, { list: args.topic, file: args.file, listed: false, note: args.note })]
}

/** Which topics list a file: every entry naming its id in `o`. Fold with {@link listEntries}. */
export function topicsOfFileFilter(file: string): Record<string, unknown> {
  return { kinds: [KIND_CHANGE], '#o': [file] }
}

/** A topic's changes, its list entries among them: `#O` on its id. Fold with {@link listEntries}. */
export function topicListFilter(topic: string): Record<string, unknown> {
  const holder = ADDRESS.exec(topic)
  return { kinds: [KIND_CHANGE], '#O': [holder ? holder[3] : topic] }
}

/** The newest entry for one list and one file. */
export interface ListEntry {
  /** The address of the file keeping the list (a topic). */
  list: string
  /** The listed file's id. */
  file: string
  /** The entry's Folder: its first `h` with a value. */
  folder: string
  /** `true` when the newest entry lists the file. */
  listed: boolean
  event: SignedEvent
}

const tagOf = (event: Pick<SignedEvent, 'tags'>, name: string): string | undefined =>
  event.tags.find((t) => t[0] === name && t[1])?.[1]

/** The file an entry lists: the `<d>` of its `lists:<d>` field, or `null` for any other change. */
const listedIn = (event: Pick<SignedEvent, 'tags'>): string | null => {
  const field = tagOf(event, 'field')
  return field?.startsWith(FIELD_PREFIX) ? field.slice(FIELD_PREFIX.length) || null : null
}

/**
 * The newest entry per list and file, from any mix of changes: the reader
 * rules of §6.14. A change counts as an entry only when its field is
 * `lists:<d>`, one of its `o` tags is that same `<d>` (an `o` the field does
 * not name is some other relation, a move's new parent for one), its `a`
 * names a file whose `d` is its `O`, `<d>` is not that file itself, and it
 * names a Folder. Anything else is skipped, not folded, so a malformed entry
 * never hides a good one. A `value` other than exactly `true` does not list
 * the file.
 *
 * The Folder check against the list's root (§6.2) is the caller's, since only
 * the caller holds the root: {@link topicsOfFile} and {@link topicList} do it.
 */
export function listEntries(events: readonly SignedEvent[]): ListEntry[] {
  const newest = new Map<string, { event: SignedEvent; file: string }>()
  for (const event of events) {
    if (event.kind !== KIND_CHANGE) continue
    const file = listedIn(event)
    if (!file || !event.tags.some((t) => t[0] === 'o' && t[1] === file)) continue
    const list = tagOf(event, 'a')
    const holder = list ? ADDRESS.exec(list) : null
    if (!holder || tagOf(event, 'O') !== holder[3] || file === holder[3] || !tagOf(event, 'h')) continue
    const key = `${list}\n${file}`
    const seen = newest.get(key)
    if (!seen || byOrder(seen.event, event) < 0) newest.set(key, { event, file })
  }
  return [...newest.values()].map(({ event, file }) => ({
    list: tagOf(event, 'a')!,
    file,
    folder: tagOf(event, 'h')!,
    listed: event.tags.find((t) => t[0] === 'value')?.[1] === 'true',
    event,
  }))
}

/** The roots of the given list addresses that the reader can read, by address. */
async function rootsOf(query: QueryFn, addresses: readonly string[]): Promise<Map<string, SignedEvent>> {
  const byKindAuthor = new Map<string, { kind: number; pubkey: string; ds: string[] }>()
  for (const address of addresses) {
    const [, kind, pubkey, d] = ADDRESS.exec(address) ?? []
    if (!d) continue
    const key = `${kind}:${pubkey}`
    const group = byKindAuthor.get(key) ?? { kind: Number(kind), pubkey, ds: [] }
    group.ds.push(d)
    byKindAuthor.set(key, group)
  }
  if (byKindAuthor.size === 0) return new Map()
  const filters = [...byKindAuthor.values()].map(({ kind, pubkey, ds }) => ({ kinds: [kind], authors: [pubkey], '#d': ds, limit: ds.length }))
  const roots = new Map<string, SignedEvent>()
  for (const root of await query(filters)) {
    const address = `${root.kind}:${root.pubkey}:${tagOf(root, 'd') ?? ''}`
    const held = roots.get(address)
    // Two versions of one record: NIP-01's later created_at, then the lower id (§6.3).
    if (!held || root.created_at > held.created_at || (root.created_at === held.created_at && root.id < held.id)) roots.set(address, root)
  }
  return roots
}

/** A topic that lists a file. */
export interface FileTopic {
  /** The topic's address. */
  address: string
  /** The topic's root, as the reader read it. */
  root: SignedEvent
  entry: ListEntry
}

/**
 * Which topics list a file — `{kinds:[1851], "#o":[<d>]}`, folded per topic.
 *
 * Keeps an entry only when its newest value lists the file, it is on a topic
 * (only topics' lists are read, Miky 2026-10-30), the topic's root is one the
 * reader can read (a deleted or unreadable topic drops out), and the entry is
 * filed in the topic's own Folder (§6.2). Two reads: the entries, then the
 * topics' roots.
 */
export async function topicsOfFile(query: QueryFn, file: string): Promise<FileTopic[]> {
  const entries = listEntries(await query([topicsOfFileFilter(file)])).filter(
    (entry) => entry.listed && entry.file === file && entry.list.startsWith(`${KIND_TOPIC}:`),
  )
  if (entries.length === 0) return []
  const roots = await rootsOf(query, entries.map((entry) => entry.list))
  const topics: FileTopic[] = []
  for (const entry of entries) {
    const root = roots.get(entry.list)
    if (root && folderOf(root) === entry.folder) topics.push({ address: entry.list, root, entry })
  }
  return topics
}

/** A file on a topic's list. */
export interface ListedFile {
  /** The listed file's id. */
  file: string
  /** Its address when exactly one file the reader can read holds the id, else `null`: not drawn, not counted. */
  address: string | null
  entry: ListEntry
}

/**
 * A topic's list: its entries whose newest value lists the file, filed in the
 * topic's Folder (§6.2), in no promised order (sort as the design says;
 * `entry.event` carries the time), each id resolved over
 * `fileKinds` by `#d`. An id held by none the reader can read, or by two,
 * resolves to `null`: a consumer draws and counts only the resolved ones
 * (§3.2, the count is the disclosure).
 */
export async function topicList(
  query: QueryFn,
  topic: ListHolder,
  options: { fileKinds?: readonly number[] } = {},
): Promise<ListedFile[]> {
  const entries = listEntries(await query([topicListFilter(topic.address)]))
    .filter((entry) => entry.listed && entry.list === topic.address && entry.folder === topic.folder)
    .sort((a, b) => byOrder(a.event, b.event))
  if (entries.length === 0) return []
  const ids = [...new Set(entries.map((entry) => entry.file))]
  // Never a Folder's `39000`, which shares its uuid (§11.1): an id only a Folder holds resolves to nothing.
  const kinds = (options.fileKinds ?? LISTED_FILE_KINDS).filter((kind) => kind !== KIND_FOLDER)
  // Room for a second holder of every id, so two holders are seen as two; in
  // batches, so a relay's cap on `limit` cannot cut a long list short.
  const batches: string[][] = []
  for (let i = 0; i < ids.length; i += RESOLVE_BATCH) batches.push(ids.slice(i, i + RESOLVE_BATCH))
  const found = (await Promise.all(batches.map((batch) => query([{ kinds, '#d': batch, limit: batch.length * 2 }])))).flat()
  const holders = new Map<string, Set<string>>()
  for (const event of found) {
    const d = tagOf(event, 'd')
    if (!d || !kinds.includes(event.kind)) continue
    const set = holders.get(d) ?? new Set<string>()
    set.add(`${event.kind}:${event.pubkey}`)
    holders.set(d, set)
  }
  return entries.map((entry) => {
    const set = holders.get(entry.file)
    return { file: entry.file, address: set?.size === 1 ? `${[...set][0]}:${entry.file}` : null, entry }
  })
}

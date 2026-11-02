/**
 * A file as its fields, each kept in order by the relay — SPEC §6.2, §6.13.
 *
 * Two halves, both for any type the relay keeps:
 *
 * - **Reading** a list or one file with the relay's list read
 *   (`"fields": "newest"`), which answers each file's first record and, for
 *   each field, only its current change: a list never carries the text, and
 *   opening one file (`"text": true` beside `#d`) carries its current text and
 *   none of its history. Each change's id is that field's next `prev`.
 * - **Writing** a change that names the one it follows, and answering the
 *   relay's `conflict:` as §6.2 says: a field set again keeps the later, and a
 *   text merges by §13.3's rule, or stops and asks when a block was changed by
 *   both or edited against a delete. It never writes over someone's newer
 *   words.
 *
 * Only for a relay whose NIP-11 advertises `file_list` (`relayFileReadsOf` in
 * `@estiva-app/protocol`), and `"text"` only where it says `text`: a relay
 * without them answers these reads as if they were plain ones.
 *
 * why: https://github.com/estiva-app/estiva-docs/blob/main/decisions/a-file-is-its-fields-each-kept-in-order-by-the-relay.md
 * why: https://github.com/estiva-app/estiva-docs/blob/main/decisions/opening-a-file-reads-its-current-text-not-its-history.md
 * why: https://github.com/estiva-app/estiva-docs/blob/main/decisions/merging-two-changes-to-one-text-never-loses-words.md
 */
import {
  CONTENT_FORMAT_TAG,
  mergeTexts,
  type MergeAsk,
  type MergeText,
  type SignedEvent,
  type UnsignedEvent,
} from '@estiva-app/protocol'
import { folderOf, type QueryFn } from './projection.js'

/** The change event every Estiva app writes (SPEC §6.2). */
const KIND_CHANGE = 1851

/** The field that holds a file's text (§6.10): the one field that merges rather than re-sets. */
export const TEXT_FIELD = 'description'

/** One field's current value, and the change that set it. */
export interface CurrentField {
  value: string
  /** The value's `content-format`, for the text; absent for marker text. */
  format?: string
  /** The change's id: the field's next `prev`. */
  id: string
  /** Who set it. */
  pubkey: string
  /** When, in ms: `ts` where it agrees with `created_at` to the second (§6.2), else `created_at`. */
  at: number
  event: SignedEvent
}

/** A file read by its fields. */
export interface FileFields {
  root: SignedEvent
  /** `<kind>:<pubkey>:<d>`. */
  address: string
  /** Each field's current change. The text is here only when the file was opened with it. */
  fields: Record<string, CurrentField>
  /** The root and each current change, as signed — what a fold of every change would read the same. */
  events: SignedEvent[]
}

const tagValue = (event: { tags: string[][] }, name: string) => event.tags.find((t) => t[0] === name)?.[1]

/** When a change happened, in ms, by §6.3's order. */
export function changedAt(event: SignedEvent): number {
  const ts = Number(tagValue(event, 'ts'))
  return Number.isFinite(ts) && Math.floor(ts / 1000) === event.created_at ? ts : event.created_at * 1000
}

/** Newer first by §6.3: time, then `created_at`, then id. */
function newer(a: SignedEvent, b: SignedEvent): boolean {
  const at = changedAt(a) - changedAt(b)
  if (at !== 0) return at > 0
  if (a.created_at !== b.created_at) return a.created_at > b.created_at
  return a.id > b.id
}

/**
 * The fields one change sets, with their values: one `field`/`value`, or one
 * per `set` (§6.2). A change setting the text carries its `content-format`.
 */
export function fieldsSetBy(event: { tags: string[][] }): { field: string; value: string; format?: string }[] {
  const format = tagValue(event, CONTENT_FORMAT_TAG)
  const withFormat = (field: string, value: string) =>
    field === TEXT_FIELD && format ? { field, value, format } : { field, value }
  const sets = event.tags.filter((t) => t[0] === 'set' && typeof t[1] === 'string')
  if (sets.length) return sets.map((t) => withFormat(t[1], t[2] ?? ''))
  const field = tagValue(event, 'field')
  return field === undefined ? [] : [withFormat(field, tagValue(event, 'value') ?? '')]
}

const addressOfRoot = (root: SignedEvent) => `${root.kind}:${root.pubkey}:${tagValue(root, 'd') ?? ''}`

/**
 * Each file the events hold, by its first record and the current change of each
 * of its fields.
 *
 * A change counts only where §6.2 says a reader folds it: its `a` names the
 * file, its `O` (if any) is the file's id, and its `h` is the file's home. The
 * text counts only when `withText`: a list never takes the text from a change
 * that set several fields, since a later text-only change may have replaced it
 * (§6.13).
 */
export function filesOf(events: readonly SignedEvent[], options: { withText?: boolean } = {}): FileFields[] {
  const roots = new Map<string, SignedEvent>()
  for (const event of events) {
    if (event.kind === KIND_CHANGE || tagValue(event, 'd') === undefined) continue
    const address = addressOfRoot(event)
    const held = roots.get(address)
    if (!held || event.created_at > held.created_at) roots.set(address, event)
  }
  const files = new Map<string, FileFields>()
  for (const [address, root] of roots) files.set(address, { root, address, fields: {}, events: [root] })

  for (const event of events) {
    if (event.kind !== KIND_CHANGE) continue
    const file = files.get(tagValue(event, 'a') ?? '')
    if (!file) continue
    const O = tagValue(event, 'O')
    if (O !== undefined && O !== tagValue(file.root, 'd')) continue
    if (tagValue(event, 'h') !== (folderOf(file.root) ?? undefined)) continue
    for (const set of fieldsSetBy(event)) {
      if (set.field === TEXT_FIELD && !options.withText) continue
      const held = file.fields[set.field]
      if (held && !newer(event, held.event)) continue
      file.fields[set.field] = { ...set, id: event.id, pubkey: event.pubkey, at: changedAt(event), event }
    }
  }
  // The root and each change some field still points at, once.
  for (const file of files.values()) {
    const current = new Map(Object.values(file.fields).map((f) => [f.id, f.event]))
    file.events = [file.root, ...current.values()]
  }
  return [...files.values()]
}

/**
 * A list of files by the relay's list read: each first record the filter picks,
 * with its fields' current changes and never its text (§6.13).
 *
 * `filter` picks first records, as §6.13 says: `#h` for a Folder's issues,
 * `kinds` alone for the workspace's projects, `#d` for named ones, `search`
 * for typing. Only for a relay advertising `file_list`.
 */
export async function listFiles(query: QueryFn, filter: Record<string, unknown>): Promise<FileFields[]> {
  if ('text' in filter) throw new Error('A list never carries text; open one file to read it.')
  const events = await query([{ ...filter, fields: 'newest' }])
  return filesOf(events)
}

/**
 * One file, opened: its first record, its fields' current changes and, where
 * the relay says `file_list.text`, its current text — one text however long
 * its history (§6.13, C40). Undefined when the relay holds no such file the
 * reader may read.
 *
 * Without `text` the answer has no text field at all, which is not "the text
 * was never changed": a caller that needs it reads it the old way.
 */
export async function openFile(
  query: QueryFn,
  file: { kind: number; pubkey: string; d: string },
  options: { text: boolean },
): Promise<FileFields | undefined> {
  // By `#d` alone, the shape §6.13 names; the author is checked below.
  const filter: Record<string, unknown> = { fields: 'newest', kinds: [file.kind], '#d': [file.d] }
  if (options.text) filter.text = true
  const events = await query([filter])
  const address = `${file.kind}:${file.pubkey}:${file.d}`
  return filesOf(events, { withText: options.text }).find((f) => f.address === address)
}

/**
 * The text a change or first record holds: a change's `description`, or a
 * first record's seed — a project's `description` tag, then its `content`
 * (§6.2, §7.2).
 */
export function textOf(event: SignedEvent): MergeText | undefined {
  if (event.kind === KIND_CHANGE) {
    const set = fieldsSetBy(event).find((f) => f.field === TEXT_FIELD)
    return set ? { value: set.value, ...(set.format ? { format: set.format } : {}) } : undefined
  }
  const format = tagValue(event, CONTENT_FORMAT_TAG)
  const value = tagValue(event, TEXT_FIELD) ?? event.content
  return { value, ...(format ? { format } : {}) }
}

/** What a `conflict:` refusal says (§6.2), as the relay words it. */
export type Conflict =
  | { kind: 'stale'; field: string; current?: string }
  | { kind: 'sorts-before'; field: string }
  | { kind: 'other' }

export function conflictOf(reason: string): Conflict | undefined {
  if (!reason.startsWith('conflict:')) return undefined
  const sorts = /^conflict: (\S+) does not sort after its prev\b/.exec(reason)
  if (sorts) return { kind: 'sorts-before', field: sorts[1] }
  const follows = /^conflict: (\S+) follows ([0-9a-f]{64})\s*$/.exec(reason)
  if (follows) return { kind: 'stale', field: follows[1], current: follows[2] }
  // A signer who cannot read the file's home is told only the field.
  const bare = /^conflict: (\S+)\s*$/.exec(reason)
  if (bare) return { kind: 'stale', field: bare[1] }
  return { kind: 'other' }
}

/** What {@link writeChange} is handed. */
export interface WriteChangeArgs {
  field: string
  /** The value to set; for the text, mine. */
  value: string
  /** The text's `content-format`, when it is one. */
  format?: string
  /**
   * The change this one follows, as the writer read it: the field's current
   * change, or the first record's id for its first change. For the text it is
   * also the base a merge starts from — the version the person, or the agent,
   * last read.
   */
  prev: string
  /**
   * The unsigned change for this value, `prev` and time — `buildActionEvent`
   * bound to the field's action, so the manifest decides its shape and every
   * attempt carries the same tags.
   */
  build: (input: { value: string; format?: string; prev: string; createdAtMs: number }) => UnsignedEvent | string
  sign: (event: UnsignedEvent) => Promise<SignedEvent>
  publish: (event: SignedEvent) => Promise<{ ok: boolean; reason?: string; eventId?: string }>
  /** Reads events by id, and the field's current change when a refusal names none. */
  query: QueryFn
  /** The field's current change, read again: {@link openFile}'s, for this field. */
  current: (field: string) => Promise<SignedEvent | undefined>
  /** The clock, in ms. */
  now?: () => number
  /** How many sends before giving up; 4 unless said. */
  tries?: number
}

export type WriteChangeResult =
  | {
      ok: true
      /** The id the relay accepted: the field's next `prev`. */
      id: string
      event: SignedEvent
      /** Set when the text was merged onto someone's newer change, which it names. */
      mergedOnto?: SignedEvent
    }
  | {
      ok: true
      /** Nothing was sent: mine, merged onto theirs, says nothing theirs does not. */
      unchanged: true
      id: string
      mergedOnto: SignedEvent
    }
  | {
      ok: false
      /** Why nothing was saved, in the relay's words or the builder's. */
      refused: string
    }
  | {
      ok: false
      /** The text asks: these blocks were changed by both, or edited against a delete. Nothing was saved. */
      asks: MergeAsk[]
      /** The change now current, whose words must be kept. */
      theirs: SignedEvent
    }

const byId = async (query: QueryFn, id: string) => (await query([{ ids: [id] }])).find((e) => e.id === id)

/**
 * Write one field's change, naming the one it follows, and answer a
 * `conflict:` as §6.2 says.
 *
 * - **Stale `prev`, a field other than the text**: read the current change
 *   (by the id the relay named, or {@link WriteChangeArgs.current} when it
 *   named none) and set the value again after it. Two setting one field is not
 *   a conflict to show: the later stands.
 * - **Stale `prev`, the text**: merge mine onto the current text by §13.3,
 *   with the text `prev` named as the base, and send the merge after it. When
 *   a block asks, nothing is sent and the answer carries the blocks and
 *   theirs. Refused again, it merges again with what it last sent as mine and
 *   what it merged onto as the base.
 * - **Does not sort after its `prev`**: the clock is behind; stamp it 1 ms
 *   after `prev`, `ts` and `created_at` agreeing.
 * - **Anything else** (`invalid:` and the rest) is never sent again.
 *
 * A few tries, then it stops with the relay's last answer.
 */
export async function writeChange(args: WriteChangeArgs): Promise<WriteChangeResult> {
  const now = args.now ?? Date.now
  const tries = args.tries ?? 4
  const isText = args.field === TEXT_FIELD
  let prev = args.prev
  let after = 0
  let mine: MergeText = { value: args.value, ...(args.format ? { format: args.format } : {}) }
  let base: MergeText | undefined
  let mergedOnto: SignedEvent | undefined
  let last = ''

  for (let attempt = 0; attempt < tries; attempt++) {
    const built = args.build({ value: mine.value, format: mine.format, prev, createdAtMs: Math.max(now(), after) })
    if (typeof built === 'string') return { ok: false, refused: built }
    const signed = await args.sign(built)
    const answer = await args.publish(signed)
    if (answer.ok) return { ok: true, id: answer.eventId ?? signed.id, event: signed, ...(mergedOnto ? { mergedOnto } : {}) }
    last = answer.reason ?? 'refused with no reason'
    const conflict = conflictOf(last)
    if (!conflict || conflict.kind === 'other' || conflict.field !== args.field) return { ok: false, refused: last }

    if (conflict.kind === 'sorts-before') {
      const followed = await byId(args.query, prev)
      if (!followed) return { ok: false, refused: last }
      after = changedAt(followed) + 1
      continue
    }

    const head = conflict.current ? await byId(args.query, conflict.current) : await args.current(args.field)
    if (!head) return { ok: false, refused: last }
    after = changedAt(head) + 1
    if (!isText) {
      prev = head.id
      continue
    }

    if (!base) {
      const followed = await byId(args.query, prev)
      base = followed && textOf(followed)
      if (!base) return { ok: false, refused: `${last} (the text it followed, ${prev}, could not be read to merge onto)` }
    }
    const theirs = textOf(head)
    if (!theirs) return { ok: false, refused: last }
    const merge = mergeTexts(base, theirs, mine)
    if (merge.asks) return { ok: false, asks: merge.asks, theirs: head }
    mergedOnto = head
    if (merge.merged.value === theirs.value && (merge.merged.format ?? '') === (theirs.format ?? '')) {
      return { ok: true, unchanged: true, id: head.id, mergedOnto: head }
    }
    base = theirs
    mine = merge.merged
    prev = head.id
  }
  return { ok: false, refused: `still refused after ${tries} tries: ${last}` }
}

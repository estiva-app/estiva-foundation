/**
 * A topic's files in the order and look someone gave them (SPEC §6.14).
 *
 * The topic keeps, per listed file, two fields beside the entry that lists it:
 * `order:<d>`, a sort key that places the file between its neighbours, and
 * `look:<d>`, `row` or `card`. Each is a `kind:1851` on the topic with §6.14's
 * tags and skip rules, `["o", <d>]` included, so two people arranging at once
 * both keep their change.
 *
 * - Files with a place come first, by key compared byte-wise, equal keys by
 *   the lower id; files with none follow, oldest listed first (§6.3).
 * - A place older than the file's newest `lists:<d>` = `true` is ignored: a
 *   file taken off and put back comes back unplaced, unless the put-back
 *   places it again ({@link planPutBackInTopic}).
 * - A missing or unknown look draws the manifest's widget: the look is a hint.
 * - Every `order:` change names the change it follows (`prev`), so a tab that
 *   read the topic before someone else moved the file is refused, and plans
 *   the move again on what is there now ({@link writeArrangement}).
 *
 * why: https://github.com/estiva-app/estiva-docs/blob/main/decisions/each-file-on-a-topic-keeps-its-own-place-and-look.md
 */
import type { SignedEvent, UnsignedEvent } from '@estiva-app/protocol'
import { byOrder } from '@estiva-app/conversation'
import { changedAt, combineChanges, conflictOf, fieldsSetBy } from './fields.js'

const KIND_CHANGE = 1851
const ADDRESS = /^(\d+):([0-9a-f]{64}):(.+)$/

export type FileLook = 'row' | 'card'

const ORDER = 'order:'
const LOOK = 'look:'
/** The field a file's place on a topic is kept in: `order:<d>`. */
export const orderField = (file: string): string => `${ORDER}${file}`
/** The field a file's look on a topic is kept in: `look:<d>`. */
export const lookField = (file: string): string => `${LOOK}${file}`

/** Digits in byte order: `0`–`9`, `A`–`Z`, `a`–`z`. */
const DIGITS = '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz'
const KEY = /^[0-9A-Za-z]*[1-9A-Za-z]$/
/** The longest key a reader takes (§6.14); a planner whose key would pass it places every file afresh. */
export const MAX_PLACE_KEY = 64

/** A place §6.14 reads: 1 to 64 of `0-9A-Za-z`, not ending in `0`. Anything else is no place. */
export const isPlaceKey = (key: string | undefined): key is string =>
  typeof key === 'string' && key.length <= MAX_PLACE_KEY && KEY.test(key)

/** `n` keys, evenly spread and as short as `n` allows, in order: every file placed afresh. */
function evenKeys(n: number): string[] {
  let width = 1
  while (DIGITS.length ** width < (n + 1) * 2) width++
  const span = DIGITS.length ** width
  return Array.from({ length: n }, (_, i) => {
    let value = Math.floor(((i + 1) * span) / (n + 1))
    let key = ''
    for (let w = 0; w < width; w++) {
      key = DIGITS[value % DIGITS.length] + key
      value = Math.floor(value / DIGITS.length)
    }
    // Never ending in `0`: a trailing `1` still sorts after this key and before the next.
    return key.endsWith('0') ? `${key}1` : key
  })
}

/** Byte-wise, as §6.14 compares keys (never `localeCompare`). */
const compareKeys = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0)

/**
 * A key that sorts strictly between `before` and `after`, either left out for
 * an open end. Each must be a valid key and `before` sort before `after`.
 * Pure, so two people dropping files between the same neighbours get the same
 * key; the file's id breaks that tie.
 */
export function keyBetween(before?: string, after?: string): string {
  if (before !== undefined && !isPlaceKey(before)) throw new Error(`not a place key: ${JSON.stringify(before)}`)
  if (after !== undefined && !isPlaceKey(after)) throw new Error(`not a place key: ${JSON.stringify(after)}`)
  if (before !== undefined && after !== undefined && compareKeys(before, after) >= 0) {
    throw new Error(`${JSON.stringify(before)} does not sort before ${JSON.stringify(after)}`)
  }
  return midpoint(before ?? '', after)
}

/** Between `a` (possibly empty) and `b` (absent: no upper end), neither ending in `0`. */
function midpoint(a: string, b: string | undefined): string {
  if (b !== undefined) {
    // A shared start stays; the rest is placed between what follows it.
    let n = 0
    while ((a[n] ?? '0') === b[n]) n++
    if (n > 0) return b.slice(0, n) + midpoint(a.slice(n), b.slice(n))
  }
  const low = a ? DIGITS.indexOf(a[0]) : 0
  const high = b !== undefined ? DIGITS.indexOf(b[0]) : DIGITS.length
  if (high - low > 1) return DIGITS[Math.round((low + high) / 2)]
  // Adjacent digits: a longer `b` has room under its first digit; otherwise go one digit deeper after `a`'s.
  if (b !== undefined && b.length > 1) return b.slice(0, 1)
  return DIGITS[low] + midpoint(a.slice(1), undefined)
}

/** What a reader knows of one listed file's place and look, beside its list entry. */
export interface FileArrangement {
  /** Its place, when it has one that counts: a valid key no older than its newest listing. */
  order?: string
  /** Its look, when set to one a reader knows; otherwise draw the manifest's widget. */
  look?: FileLook
  /**
   * What the next change of each field follows: the field's newest change
   * on the relay, one a reader skips included (the relay chains them all),
   * or the topic's first record when the field never changed.
   */
  prev: { order: string; look: string }
  /** The latest time (ms) among those, so a change is stamped after it. */
  prevAt: number
}

/** A file in the order it is drawn, as the planners are handed it. */
export interface ArrangedFile extends FileArrangement {
  /** The listed file's id. */
  file: string
}

interface Heads {
  /** Newest good change per field, by field name. */
  good: Map<string, SignedEvent>
  /** Newest change per field, any, by field name: the next `prev`. */
  any: Map<string, SignedEvent>
}

const tagOf = (event: Pick<SignedEvent, 'tags'>, name: string): string | undefined =>
  event.tags.find((t) => t[0] === name && t[1])?.[1]

const isArrangeField = (field: string) => field.startsWith(ORDER) || field.startsWith(LOOK)
/** The listed file a per-file field of a list names — `lists:`, `order:` or `look:` — or `null` for any other field. */
export const fileOfListField = (field: string): string | null =>
  /^(lists|order|look):./.test(field) ? field.slice(field.indexOf(':') + 1) : null
const fileOfField = (field: string) => fileOfListField(field) ?? ''

/**
 * Whether a change setting `field` on `list` is one a reader folds (§6.14's
 * skip rules, for `lists:`, `order:` and `look:` alike): one of its `o` tags
 * is the field's `<d>`, its `a` is the list, its `O` the list's id, the `<d>`
 * is not the list itself, and its `h` is the list's team.
 */
export function readsAs(event: SignedEvent, field: string, list: string, team: string | null | undefined): boolean {
  const holder = ADDRESS.exec(list)
  const file = fileOfField(field)
  return (
    !!holder &&
    !!file &&
    event.tags.some((t) => t[0] === 'o' && t[1] === file) &&
    tagOf(event, 'a') === list &&
    tagOf(event, 'O') === holder[3] &&
    file !== holder[3] &&
    !!team &&
    tagOf(event, 'h') === team
  )
}

/** The `order:` and `look:` changes per list, newest good and newest of any. */
export function arrangementHeads(
  events: readonly SignedEvent[],
  teamOfList: (list: string) => string | null | undefined,
): Map<string, Heads> {
  const out = new Map<string, Heads>()
  for (const event of events) {
    if (event.kind !== KIND_CHANGE) continue
    const list = tagOf(event, 'a')
    if (!list) continue
    for (const { field } of fieldsSetBy(event)) {
      if (!isArrangeField(field)) continue
      const heads = out.get(list) ?? { good: new Map(), any: new Map() }
      out.set(list, heads)
      const held = heads.any.get(field)
      if (!held || byOrder(held, event) < 0) heads.any.set(field, event)
      if (!readsAs(event, field, list, teamOfList(list))) continue
      const good = heads.good.get(field)
      if (!good || byOrder(good, event) < 0) heads.good.set(field, event)
    }
  }
  return out
}

const valueIn = (event: SignedEvent, field: string) => fieldsSetBy(event).find((f) => f.field === field)?.value

/**
 * One file's arrangement on a list, from {@link arrangementHeads}: `listed`
 * is the file's newest `lists:<d>` = `true` entry, `root` the list's first
 * record (the first `prev`).
 */
export function arrangementOf(heads: Heads | undefined, file: string, listed: SignedEvent, root: SignedEvent): FileArrangement {
  const placed = heads?.good.get(orderField(file))
  const key = placed && byOrder(placed, listed) >= 0 ? valueIn(placed, orderField(file)) : undefined
  const looked = heads?.good.get(lookField(file))
  const look = looked ? valueIn(looked, lookField(file)) : undefined
  const orderHead = heads?.any.get(orderField(file))
  const lookHead = heads?.any.get(lookField(file))
  return {
    ...(isPlaceKey(key) ? { order: key } : {}),
    ...(look === 'row' || look === 'card' ? { look } : {}),
    prev: { order: orderHead?.id ?? root.id, look: lookHead?.id ?? root.id },
    prevAt: Math.max(changedAt(root), orderHead ? changedAt(orderHead) : 0, lookHead ? changedAt(lookHead) : 0),
  }
}

/**
 * §6.14's order, stable: placed files by key (equal keys by the lower id),
 * then the rest in the order given, which is oldest listed first.
 */
export function sortArranged<T extends { file: string; order?: string }>(files: readonly T[]): T[] {
  const placed = files.filter((f) => f.order !== undefined)
  const rest = files.filter((f) => f.order === undefined)
  placed.sort((a, b) => compareKeys(a.order!, b.order!) || compareKeys(a.file, b.file))
  return [...placed, ...rest]
}

/** The topic the change goes on: its address and its team, read from its root (§6.2). */
export interface ArrangeHolder {
  address: string
  folder: string
}

/** One field's change on the topic: §6.2's one-field tag order, then `o`. */
function fieldChange(pubkey: string, createdAtMs: number, topic: ArrangeHolder, field: string, value: string, prev: string): UnsignedEvent {
  const holder = ADDRESS.exec(topic.address)
  if (!holder) throw new Error(`not a file address: ${JSON.stringify(topic.address)}`)
  if (!topic.folder) throw new Error("a change names the team of the file it is on")
  const file = fileOfField(field)
  if (file === holder[3]) throw new Error('a file is not on its own list')
  return {
    pubkey,
    created_at: Math.floor(createdAtMs / 1000),
    kind: KIND_CHANGE,
    tags: [
      ['a', topic.address],
      ['O', holder[3]],
      ['field', field],
      ['value', value],
      ['h', topic.folder],
      ['ts', String(createdAtMs)],
      ['prev', prev],
      ['o', file],
    ],
    content: '',
  }
}

/** Stamped after every change it follows, so a clock that is behind is not refused. */
const stamp = (createdAtMs: number, files: readonly FileArrangement[]) => Math.max(createdAtMs, ...files.map((f) => f.prevAt + 1))

/**
 * Move `file` to just after `after` (`null`: first) in `files`, which is the
 * topic's files in the order drawn. One change: the moved file's place, and
 * where it lands among files with no place, the places of those above it too,
 * since unplaced files follow placed ones; files tied on one key with the one
 * it lands before are placed again after it. Several places go in one change,
 * taken whole or refused whole. `null` when the file is already there.
 */
export function planMoveInTopic(
  pubkey: string,
  createdAtMs: number,
  args: { topic: ArrangeHolder; files: readonly ArrangedFile[]; file: string; after: string | null },
): UnsignedEvent | null {
  // In the topic's own order, whatever order the app draws them in (Ship groups by kind).
  const files = sortArranged(args.files)
  const moved = files.find((f) => f.file === args.file)
  if (!moved) throw new Error(`${args.file} is not on the topic's list`)
  const rest = files.filter((f) => f.file !== args.file)
  const to = args.after === null ? 0 : rest.findIndex((f) => f.file === args.after) + 1
  if (args.after !== null && to === 0) throw new Error(`${args.after} is not on the topic's list`)
  // Already there: nothing to write.
  if (files.indexOf(moved) === to) return null
  const before = rest.slice(0, to)
  const after = rest.slice(to)
  const writes: { file: ArrangedFile; key: string }[] = []
  const unplaced = before.findIndex((f) => f.order === undefined)
  let low = (unplaced < 0 ? before.at(-1) : before[unplaced - 1])?.order
  const place = (file: ArrangedFile, high?: string) => {
    const key = keyBetween(low, high)
    writes.push({ file, key })
    low = key
  }
  if (unplaced >= 0) {
    // Everything after an unplaced file is unplaced too: nothing bounds the keys above.
    for (const f of before.slice(unplaced)) place(f)
    place(moved)
  } else if (after[0]?.order !== undefined && after[0].order === low) {
    // It lands between two files sharing one key: place it, and the tied ones after it, below the next key.
    let j = 0
    while (after[j]?.order === low) j++
    const high = after[j]?.order
    place(moved, high)
    for (const f of after.slice(0, j)) place(f, high)
  } else {
    place(moved, after[0]?.order)
  }
  if (writes.some((w) => w.key.length > MAX_PLACE_KEY)) {
    // Keys grew too long (many moves to one spot): place every placed file, and the moved one, afresh.
    const placed = [...before, moved, ...after].filter((f) => f === moved || f.order !== undefined || before.includes(f))
    const keys = evenKeys(placed.length)
    writes.splice(0, writes.length, ...placed.map((file, i) => ({ file, key: keys[i] })))
  }
  const at = stamp(createdAtMs, writes.map((w) => w.file))
  const changes = writes.map((w) => fieldChange(pubkey, at, args.topic, orderField(w.file.file), w.key, w.file.prev.order))
  if (changes.length === 1) return changes[0]
  const combined = combineChanges(changes)
  if (typeof combined === 'string') throw new Error(combined)
  return combined
}

/** Show `file` as a row or a card: one `look:<d>` change. */
export function planLookInTopic(
  pubkey: string,
  createdAtMs: number,
  args: { topic: ArrangeHolder; file: ArrangedFile; look: FileLook },
): UnsignedEvent {
  return fieldChange(pubkey, stamp(createdAtMs, [args.file]), args.topic, lookField(args.file.file), args.look, args.file.prev.look)
}

/**
 * Undo of Remove: put `file` back on the list, then back in the place it had
 * — just after `after` (`null`: first). Its look stays: a listing never
 * resets it. Publish `relist`, then send `move` with {@link writeArrangement}
 * over the list read again, so a refusal plans the move again rather than
 * leaving the file back but last. The move is stamped after the listing, so
 * its place is not older than it.
 */
export function planPutBackInTopic(
  pubkey: string,
  createdAtMs: number,
  args: { topic: ArrangeHolder; file: ArrangedFile; after: string | null },
): { relist: UnsignedEvent; move: (files: readonly ArrangedFile[], createdAtMs: number) => UnsignedEvent | null } {
  const listedAt = stamp(createdAtMs, [args.file])
  const holder = ADDRESS.exec(args.topic.address)
  if (!holder) throw new Error(`not a file address: ${JSON.stringify(args.topic.address)}`)
  const relist: UnsignedEvent = {
    pubkey,
    created_at: Math.floor(listedAt / 1000),
    kind: KIND_CHANGE,
    tags: [
      ['a', args.topic.address],
      ['O', holder[3]],
      ['field', `lists:${args.file.file}`],
      ['value', 'true'],
      ['h', args.topic.folder],
      ['ts', String(listedAt)],
      ['o', args.file.file],
    ],
    content: '',
  }
  const move = (files: readonly ArrangedFile[], ms: number) => {
    // Back on the list it has no place yet; a list read before the listing landed does not hold it.
    const held = files.find((f) => f.file === args.file.file)
    const back: ArrangedFile = { ...(held ?? args.file), order: undefined, prevAt: Math.max((held ?? args.file).prevAt, listedAt) }
    const rest = files.filter((f) => f.file !== back.file)
    return planMoveInTopic(pubkey, Math.max(ms, listedAt + 1), { topic: args.topic, files: [...rest, back], file: back.file, after: args.after })
  }
  return { relist, move }
}

/** What {@link writeArrangement} is handed. */
export interface WriteArrangementArgs {
  /** The topic's files as drawn now, from {@link topicList}; read again after a refusal. */
  files: readonly ArrangedFile[]
  read: () => Promise<readonly ArrangedFile[]>
  /** The change for these files, or `null` when there is nothing left to do. */
  plan: (files: readonly ArrangedFile[], createdAtMs: number) => UnsignedEvent | null
  sign: (event: UnsignedEvent) => Promise<SignedEvent>
  publish: (event: SignedEvent) => Promise<{ ok: boolean; reason?: string }>
  now?: () => number
  tries?: number
}

/**
 * Send an arrangement change, and answer a `conflict:` by reading the topic
 * again and planning the change again on what is there now — never by sending
 * the same places again. A place the planner added for a file nobody had
 * placed would otherwise write over a move someone made since; a look or a
 * single move planned again is §6.2's "set it again after the current one".
 */
export async function writeArrangement(args: WriteArrangementArgs): Promise<{ ok: true; event?: SignedEvent } | { ok: false; refused: string }> {
  const now = args.now ?? Date.now
  const tries = args.tries ?? 3
  let files = args.files
  let last = ''
  for (let attempt = 0; attempt < tries; attempt++) {
    const change = args.plan(files, now())
    if (!change) return { ok: true }
    const signed = await args.sign(change)
    const answer = await args.publish(signed)
    if (answer.ok) return { ok: true, event: signed }
    last = answer.reason ?? 'refused with no reason'
    const conflict = conflictOf(last)
    if (!conflict || conflict.kind === 'other') return { ok: false, refused: last }
    files = await args.read()
  }
  return { ok: false, refused: `still refused after ${tries} tries: ${last}` }
}

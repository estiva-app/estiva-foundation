/**
 * `@estiva-app/protocol/testing` — made-up histories of files, for tests that
 * try thousands of inputs (fast-check). Test code only: it needs `fast-check`,
 * which this package lists as an optional peer, never as a dependency.
 *
 * A history is what a reader can be handed for a few files: their first
 * records (sometimes two versions of one), the changes people made to them
 * (`kind:1851`, one field or several, with or without a trusted `ts`, some in
 * the same second, some by people outside the file's team) and comments on
 * them. A first record may be created with a summary, a description (in a tag
 * or as its content), a key and a lead (a project) or a ref (an issue). A
 * change may set any of those too; a summary may hold line breaks and runs of
 * spaces; a status is one of its type's own list, one nobody defined, or the
 * other type's word, and may carry its stage (§6.2).
 *
 * Most shapes are ones on the relay today (estiva-ship
 * `conformance/fold-fixture.json`, 20 Nov 2026). A few are ones SPEC allows
 * and no app has written yet, and a reader must still agree on: a status
 * nobody defined, a stage word that is no stage, a `ts` from another second.
 * Every repo's tests share one idea of what a history can be.
 *
 * One maker, many repos: Ship, Peek and Leaf import it rather than copy it.
 */
import fc from 'fast-check'
import type { SignedEvent } from './events.js'
import type { Block, BlockDocument } from './blocks.js'

export const KIND_PROJECT = 30850
export const KIND_ISSUE = 30851
export const KIND_DOCUMENT = 30842
export const KIND_CHANGE = 1851
export const KIND_COMMENT = 1111

/** What {@link historyArb} makes. */
export interface History {
  /** Every event, in the order they were made up — never the order to read them in. */
  events: SignedEvent[]
  /** Each file's address, `<kind>:<pubkey>:<d>`. */
  files: string[]
  /** The people who wrote something. */
  people: string[]
  /** The teams (Folders) the files are filed in. */
  teams: string[]
}

export interface HistoryOptions {
  /** How many people write (default 3). */
  people?: number
  /** At most this many changes (default 24). */
  maxChanges?: number
  /** At most this many comments (default 4). */
  maxComments?: number
  /** Give some files an id with a colon in it (default false: today's apps mint UUIDs). */
  idsWithColons?: boolean
}

/** The second every history starts at; changes land within a few seconds of it, so ties are common. */
export const HISTORY_EPOCH = 1_763_000_000

const HEX = '0123456789abcdef'.split('')
/** A 64-character lowercase hex string: an event id or a pubkey. */
export const hex64Arb = (): fc.Arbitrary<string> => fc.string({ unit: fc.constantFrom(...HEX), minLength: 64, maxLength: 64 })

/** Each tracked type's own list (Ship's manifest, §7.4): a project's words are not an issue's. */
const ISSUE_STATUSES = ['todo', 'in_progress', 'done', 'cancelled']
const PROJECT_STATUSES = ['planned', 'in_progress', 'completed', 'cancelled']
/** Statuses nobody defined: in no list, and so shown by their id (§6.2). One holds a space and capitals. */
const UNDEFINED_STATUSES = ['blocked', 'In Review']
/**
 * What a status change may say its status means (§6.2's `["stage", "status", …]`):
 * the four stages, whichever the list gives the status, and a word that is no
 * stage, which a reader ignores.
 */
const STAGES = ['open', 'started', 'done', 'dropped', 'paused'] as const
/** Summaries as people paste them: line breaks, runs of spaces, a tab, space at either end, nothing but space. */
const SUMMARIES = ['', 'Summary', 'First line\nsecond line', '  Spaces   in a row  ', 'A tab\tand a\r\nWindows break', ' \n ']
const TEXTS = ['', 'A description', 'First paragraph\n\nSecond paragraph', '  ']
/** The same in the block format (§13.3): an empty document, and one paragraph. Their change or record says so in `content-format`. */
const BLOCK_TEXTS = [
  JSON.stringify({ type: 'doc', content: [] }),
  JSON.stringify({ type: 'doc', content: [{ type: 'paragraph', id: 'b1', content: [{ type: 'text', text: 'A description' }] }] }),
]
/** A description by the number that picked it: marker text for the first four, a block document after. */
const textFor = (n: number): string => (n % 8 < TEXTS.length ? TEXTS[n % 8] : BLOCK_TEXTS[n % BLOCK_TEXTS.length])
const inBlocks = (text: string): boolean => BLOCK_TEXTS.includes(text)
const KEYS = ['MOV', 'PEE', '']
const REFS = ['MOV-1', 'PEE-8', '']
const BLOCKS_FORMAT = 'estiva-blocks-1'
const TITLES = ['Payments', 'Billing', 'Renamed', 'Untitled', 'Launch plan', '']

type FileKind = typeof KIND_PROJECT | typeof KIND_ISSUE | typeof KIND_DOCUMENT

interface RootPlan {
  kind: FileKind
  author: number
  team: number
  /**
   * How the first record names its team: `h` (most), Ship's global
   * `buzz-channel` (SPEC §7.3), or not at all — all three are on the relay
   * (estiva-ship's fixture: 1 of 184 records each for the last two).
   */
  placement: 'h' | 'buzz-channel' | 'none'
  /** A project titled by upstream's `name` rather than `title` (REW-11); also on the relay. */
  nameTag: boolean
  colon: boolean
  title: string
  /**
   * What the first record is created with beside its title, as Ship's and
   * Peek's creation write it (§6.1, §7.2): each a number picking the value, or
   * `null` for no tag. `text` is a `description` tag, or the `content`;
   * `label` is a project's `key` or an issue's `ref`; `lead` is a project's.
   */
  seed: { summary: number | null; text: number | null; textIn: 'tag' | 'content'; label: number | null; lead: number | null }
  /** A second version of the first record: its offset in seconds (0 = the same second) and its title. */
  second: { after: number; title: string } | null
}

interface ChangePlan {
  file: number
  author: number
  /** Seconds after {@link HISTORY_EPOCH}. */
  at: number
  /** `null` for no `ts`; a millisecond within the second; or `'untrusted'`, a `ts` from another second. */
  ts: number | 'untrusted' | null
  sets: { field: (typeof FIELDS)[number]; value: number }[]
  /** The stage a status change carries (§6.2), or `null` for none: most changes on the relay predate it. */
  stage: (typeof STAGES)[number] | null
  /** Carry the file's id in `O` (as writers since §6.2 do), or the id of another file, or none. */
  O: 'own' | 'other' | 'none'
  /** Filed in the file's own team, or in another one (which a reader must not fold). */
  inOwnTeam: boolean
}

const FIELDS = ['title', 'status', 'summary', 'assignee', 'archived', 'deleted', 'project', 'member', 'description', 'key', 'lead', 'ref'] as const

/**
 * A made-up history of a few projects, issues and documents and the changes
 * made to them. Shrinks toward fewer files, fewer changes and earlier seconds.
 */
export function historyArb(options: HistoryOptions = {}): fc.Arbitrary<History> {
  const peopleCount = options.people ?? 3
  const rootArb = (kind: FileKind): fc.Arbitrary<RootPlan> =>
    fc.record({
      kind: fc.constant(kind),
      author: fc.nat(peopleCount - 1),
      team: fc.nat(1),
      // `buzz-channel` is a project's placement only (SPEC §7.3).
      placement: fc.oneof(
        { weight: 8, arbitrary: fc.constant<RootPlan['placement']>('h') },
        { weight: 1, arbitrary: fc.constant<RootPlan['placement']>(kind === KIND_PROJECT ? 'buzz-channel' : 'h') },
        { weight: 1, arbitrary: fc.constant<RootPlan['placement']>('none') },
      ),
      nameTag: kind === KIND_PROJECT ? fc.boolean() : fc.constant(false),
      colon:options.idsWithColons ? fc.boolean() : fc.constant(false),
      title: fc.constantFrom(...TITLES),
      seed: fc.record({
        summary: fc.option(fc.nat(SUMMARIES.length - 1), { freq: 3 }),
        text: fc.option(fc.nat(7), { freq: 3 }),
        textIn: fc.constantFrom<'tag' | 'content'>('tag', 'content'),
        label: fc.option(fc.nat(KEYS.length - 1), { freq: 3 }),
        lead: fc.option(fc.nat(peopleCount - 1), { freq: 3 }),
      }),
      second: fc.option(fc.record({ after: fc.nat(2), title: fc.constantFrom(...TITLES) }), { freq: 4 }),
    })
  const changeArb: fc.Arbitrary<ChangePlan> = fc.record({
    file: fc.nat(7),
    author: fc.nat(peopleCount - 1),
    at: fc.nat(4),
    ts: fc.oneof(fc.constant(null), fc.constantFrom(0, 500, 999), fc.constant('untrusted' as const)),
    // A status three times as often as any other field: it has the most to say (its list, its stage).
    sets: fc.array(fc.record({ field: fc.constantFrom(...FIELDS, 'status' as const, 'status' as const), value: fc.nat(7) }), { minLength: 1, maxLength: 2 }),
    stage: fc.option(fc.constantFrom(...STAGES), { freq: 2 }),
    O: fc.constantFrom('own', 'own', 'none', 'other'),
    inOwnTeam: fc.oneof({ weight: 9, arbitrary: fc.constant(true) }, { weight: 1, arbitrary: fc.constant(false) }),
  })
  const plan = fc.record({
    people: fc.uniqueArray(hex64Arb(), { minLength: peopleCount, maxLength: peopleCount }),
    teams: fc.uniqueArray(fc.uuid({ version: 4 }), { minLength: 2, maxLength: 2 }),
    projects: fc.array(rootArb(KIND_PROJECT), { minLength: 1, maxLength: 2 }),
    issues: fc.array(rootArb(KIND_ISSUE), { maxLength: 3 }),
    documents: fc.array(rootArb(KIND_DOCUMENT), { maxLength: 2 }),
    fileIds: fc.uniqueArray(fc.uuid({ version: 4 }), { minLength: 8, maxLength: 8 }),
    changes: fc.array(changeArb, { maxLength: options.maxChanges ?? 24 }),
    comments: fc.array(fc.record({ file: fc.nat(7), author: fc.nat(peopleCount - 1), at: fc.nat(4) }), { maxLength: options.maxComments ?? 4 }),
  })
  return plan.chain((p) => {
    const count = p.projects.length + p.issues.length + p.documents.length + p.changes.length + p.comments.length
    // Twice what is needed: a second version of a root takes one each.
    return fc.uniqueArray(hex64Arb(), { minLength: count * 2, maxLength: count * 2 }).map((ids) => build(p, ids))
  })
}

interface Plan {
  people: string[]
  teams: string[]
  projects: RootPlan[]
  issues: RootPlan[]
  documents: RootPlan[]
  fileIds: string[]
  changes: ChangePlan[]
  comments: { file: number; author: number; at: number }[]
}

function build(p: Plan, ids: string[]): History {
  let next = 0
  const id = () => ids[next++]
  const events: SignedEvent[] = []
  const files: { address: string; d: string; kind: FileKind; team: string; author: string }[] = []
  const roots = [...p.projects, ...p.issues, ...p.documents]
  roots.forEach((root, i) => {
    const d = root.colon ? `x:${p.fileIds[i]}` : p.fileIds[i]
    const pubkey = p.people[root.author]
    const team = p.teams[root.team]
    const address = `${root.kind}:${pubkey}:${d}`
    // An issue is filed under the first project; a project and a document stand alone.
    const parent = root.kind === KIND_ISSUE ? files[0]?.address : undefined
    const placed = root.placement === 'none' ? [] : [[root.placement, team]]
    // What it was created with. A second version carries the same: an app republishing its record keeps them.
    const { seed } = root
    const text = seed.text === null ? undefined : textFor(seed.text)
    const seeded: string[][] = []
    // Older first records hold their text (§6.1): a project's in a `description` tag, an issue's in
    // its content, or in the tag when another app's launcher filed it (Ship reads both, tag first,
    // as `textOf` does); a document's in its content only. A file made since 18 Nov 2026 has none,
    // and its text is its first change: a history with no seeded text and a description change.
    const textInTag = root.kind !== KIND_DOCUMENT && seed.textIn === 'tag'
    if (text !== undefined && textInTag) seeded.push(['description', text])
    // A record created with a block document says so, as Ship's creation does (§13.3).
    if (text !== undefined && inBlocks(text)) seeded.push(['content-format', BLOCKS_FORMAT])
    if (seed.summary !== null) seeded.push(['summary', SUMMARIES[seed.summary]])
    if (root.kind === KIND_PROJECT) {
      if (seed.lead !== null) seeded.push(['lead', p.people[seed.lead]], ['p', p.people[seed.lead]])
      if (seed.label !== null) seeded.push(['key', KEYS[seed.label]])
    } else if (root.kind === KIND_ISSUE && seed.label !== null) {
      seeded.push(['ref', REFS[seed.label]])
    }
    const content = text !== undefined && !textInTag ? text : ''
    const tags = (title: string) => [['d', d], [root.nameTag ? 'name' : 'title', title], ...placed, ...(parent ? [['a', parent]] : []), ...seeded]
    events.push({ id: id(), pubkey, created_at: HISTORY_EPOCH, kind: root.kind, tags: tags(root.title), content, sig: '' })
    if (root.second) {
      events.push({ id: id(), pubkey, created_at: HISTORY_EPOCH + root.second.after, kind: root.kind, tags: tags(root.second.title), content, sig: '' })
    }
    files.push({ address, d, kind: root.kind, team, author: pubkey })
  })
  const projects = files.filter((f) => f.kind === KIND_PROJECT)

  for (const change of p.changes) {
    const file = files[change.file % files.length]
    const pubkey = p.people[change.author]
    const created_at = HISTORY_EPOCH + change.at
    const set = change.sets
      .map(({ field, value }) => setting(field, value, file, p.people, projects))
      .filter((s): s is [string, string] => s !== undefined)
    // One field a change sets at most once; a several-field change never names a member (§11.8).
    const unique = [...new Map(set.map((s) => [s[0], s])).values()]
    const fields = unique.length > 1 ? unique.filter(([f]) => !f.startsWith('member:')) : unique
    if (!fields.length) continue
    const tags: string[][] = [['a', file.address]]
    if (change.O === 'own') tags.push(['O', file.d])
    // At most seven files, so the eighth id is never one of theirs.
    else if (change.O === 'other') tags.push(['O', p.fileIds[7]])
    tags.push(['h', change.inOwnTeam ? file.team : p.teams.find((t) => t !== file.team)!])
    if (fields.length === 1) tags.push(['field', fields[0][0]], ['value', fields[0][1]])
    else for (const [f, v] of fields) tags.push(['set', f, v])
    // A change names the person it is about in `p`, as membership's filters find it (§11.8).
    for (const [f, v] of fields) {
      if ((f === 'assignee' || f === 'lead') && v) tags.push(['p', v])
      else if (f.startsWith('member:')) tags.push(['p', f.slice('member:'.length)])
    }
    if (change.ts === 'untrusted') tags.push(['ts', String((created_at + 7) * 1000)])
    else if (change.ts !== null) tags.push(['ts', String(created_at * 1000 + change.ts)])
    // A description in the block format says so on its change (§13.3).
    if (fields.some(([f, v]) => f === 'description' && inBlocks(v))) tags.push(['content-format', BLOCKS_FORMAT])
    // A status change says what its status means, last (§6.2, C32).
    if (change.stage !== null && fields.some(([f]) => f === 'status')) tags.push(['stage', 'status', change.stage])
    events.push({ id: id(), pubkey, created_at, kind: KIND_CHANGE, tags, content: '', sig: '' })
  }

  for (const comment of p.comments) {
    const file = files[comment.file % files.length]
    events.push({
      id: id(),
      pubkey: p.people[comment.author],
      created_at: HISTORY_EPOCH + comment.at,
      kind: KIND_COMMENT,
      tags: [['A', file.address], ['K', String(file.kind)], ['a', file.address], ['k', String(file.kind)], ['h', file.team]],
      content: 'A comment',
      sig: '',
    })
  }
  return { events, files: files.map((f) => f.address), people: p.people, teams: p.teams }
}

/** One field a change sets and its value, or none where the field does not fit the file. */
function setting(
  field: (typeof FIELDS)[number],
  n: number,
  file: { kind: FileKind; address: string },
  people: string[],
  projects: { address: string }[],
): [string, string] | undefined {
  switch (field) {
    case 'title':
      return ['title', TITLES[n % TITLES.length]]
    case 'status': {
      if (file.kind === KIND_DOCUMENT) return undefined
      const own = file.kind === KIND_PROJECT ? PROJECT_STATUSES : ISSUE_STATUSES
      const other = file.kind === KIND_PROJECT ? ISSUE_STATUSES : PROJECT_STATUSES
      // Its own list most of the time; then one nobody defined, and the other type's first word.
      return ['status', n < 4 ? own[n] : n < 6 ? UNDEFINED_STATUSES[n - 4] : n === 6 ? other[0] : own[1]]
    }
    case 'summary':
      return ['summary', SUMMARIES[n % SUMMARIES.length]]
    case 'description':
      return ['description', textFor(n)]
    case 'key':
      return file.kind !== KIND_PROJECT ? undefined : ['key', KEYS[n % KEYS.length]]
    case 'lead':
      return file.kind !== KIND_PROJECT ? undefined : ['lead', n % 4 === 3 ? '' : people[n % people.length]]
    case 'ref':
      return file.kind !== KIND_ISSUE ? undefined : ['ref', REFS[n % REFS.length]]
    case 'assignee':
      return file.kind !== KIND_ISSUE ? undefined : ['assignee', n % 4 === 3 ? '' : people[n % people.length]]
    case 'archived':
      return ['archived', n % 2 ? 'true' : '']
    case 'deleted':
      return ['deleted', n % 2 ? 'true' : '']
    case 'project': {
      // A move: an issue's parent becomes another project.
      if (file.kind !== KIND_ISSUE || !projects.length) return undefined
      return ['project', projects[n % projects.length].address]
    }
    case 'member':
      return [`member:${people[n % people.length]}`, n % 2 ? 'true' : 'false']
  }
}

/**
 * The same events as a reader might be handed them: in any order, some of them
 * twice (each repeat a copy, as a second relay answer would be).
 */
export function deliveryArb<T>(events: readonly T[]): fc.Arbitrary<T[]> {
  const n = events.length
  return fc
    .tuple(fc.shuffledSubarray([...events], { minLength: n, maxLength: n }), fc.subarray([...events]))
    .chain(([all, twice]) => {
      const pool = [...all, ...twice.map((e) => JSON.parse(JSON.stringify(e)) as T)]
      return fc.shuffledSubarray(pool, { minLength: pool.length, maxLength: pool.length })
    })
}

/** The starting number a pull request runs with: the same inputs on every run. */
export const FIXED_SEED = 20_261_120

/**
 * The run's settings, from the environment: `FC_SEED` replays a run (CI sets a
 * fresh one on each merge to `main` and prints it), `FC_RUNS` sets how many
 * inputs each rule tries. Without them a run is the pull request's: the fixed
 * seed and `defaultRuns`.
 */
export function runSettings(defaultRuns: number, env: Record<string, string | undefined> = processEnv()): { seed: number; numRuns: number } {
  const seed = env.FC_SEED ? Number(env.FC_SEED) : FIXED_SEED
  const runs = env.FC_RUNS ? Number(env.FC_RUNS) : defaultRuns
  if (!Number.isSafeInteger(seed)) throw new Error(`FC_SEED is not a whole number: ${env.FC_SEED}`)
  if (!Number.isSafeInteger(runs) || runs < 1) throw new Error(`FC_RUNS is not a positive whole number: ${env.FC_RUNS}`)
  return { seed, numRuns: runs }
}

/*
  ---------------------------------------------------------------------------
  Made-up documents (TES-3): what a person writes in a message, a description
  or a page, for the rule "a document comes back as it went in".
  ---------------------------------------------------------------------------
*/

/**
 * What a document is written in, which decides what it can hold:
 * - `message`: a message's text, SPEC §13.2 — headings, lists (indented too),
 *   quotes, code, rules, bold, italic, underline, code and mentions;
 * - `description`: a description's text, §13.3 "A description as text" — all of
 *   that, plus checklists, callouts, links on words and tables;
 * - `editor`: anything an editor saves — all of that, plus a third heading
 *   level, pictures and files, and blocks from a later version.
 */
export type DocumentForm = 'message' | 'description' | 'editor'

export interface DocumentOptions {
  /** Default `editor`. */
  form?: DocumentForm
  /** At most this many top-level blocks (default 8). */
  maxBlocks?: number
}

/** Words people write, the awkward ones among them: accents, emoji, quotes, a colon, a dash, a percent. */
const WORDS = [
  'plan', 'Ada', 'ship', 'launch', 'Friday', 'notes', 'v1.2', '2026', 'déjà', 'naïve', 'Zürich', '🚀', 'it’s', "it's",
  'a-b', 'x:y', 'e.g.', '100%', 'Q&A', '"quoted"', '(aside)', '…', 'ok?', 'yes!', 'café', 'Łódź', '日本',
]
/**
 * What looks like a marker and is meant as text, and text still carries: a box
 * or a callout line (escaped, §13.3), a pipe in a cell, a backslash, brackets.
 */
const AWKWARD = ['[ ]', '[x]', '[!NOTE]', '\\', 'a\\', '|', '<b>', '[a](b)', '---', '~~']
/**
 * What looks like a marker and text cannot carry as text, so only an editor's
 * document holds it here (`test/document-trips.md`): a marker character meant
 * as a character (it pairs with the next one, or with a real mark's), and a
 * line that starts with a block's prefix.
 */
const EDITOR_ONLY = ['*', '**', '***', '_', '__', '`', 'x*', '\\*', '*not*', '**not**', '__not__', '`not`', '#', '##', '-', '1.', '>']
const LETTERS = 'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789'.split('')
const wordArb = (form: DocumentForm, awkward: boolean) =>
  fc.oneof(
    { weight: 4, arbitrary: fc.constantFrom(...WORDS) },
    { weight: 1, arbitrary: fc.string({ unit: fc.constantFrom(...LETTERS), minLength: 1, maxLength: 8 }) },
    ...(awkward ? [{ weight: 1, arbitrary: fc.constantFrom(...AWKWARD, ...(form === 'editor' ? EDITOR_ONLY : [])) }] : []),
  )
/**
 * A few words. Marker-like words only where text can carry them: in an
 * editor's document anywhere, in text only outside a mark or a link (a bold
 * `*` is `***` in text, which reads as an empty bold — listed in
 * `test/document-trips.md`).
 */
const wordsArb = (form: DocumentForm, max = 5, awkward = true) => fc.array(wordArb(form, awkward), { minLength: 1, maxLength: max }).map((ws) => ws.join(' '))

type Mark = { type: string; attrs?: Record<string, unknown> }
type Run = { type: 'text'; text: string; marks?: Mark[] }

const BECH32 = 'qpzry9x8gf2tvdw0s3jn54khce6mua7l'
/** A mention as text holds it: `nostr:npub1…`, carrying the `reference` mark its reader gives it. */
const mentionArb: fc.Arbitrary<Run> = fc
  .string({ unit: fc.constantFrom(...BECH32.split('')), minLength: 58, maxLength: 58 })
  .map((data) => {
    const uri = `nostr:npub1${data}`
    return { type: 'text' as const, text: uri, marks: [{ type: 'reference', attrs: { uri } }] }
  })

const styleArb: fc.Arbitrary<Mark[]> = fc.oneof(
  { weight: 3, arbitrary: fc.constant<Mark[]>([]) },
  {
    weight: 3,
    arbitrary: fc
      .record({ bold: fc.boolean(), italic: fc.boolean(), underline: fc.boolean() })
      .map((m): Mark[] => (['bold', 'italic', 'underline'] as const).filter((k) => m[k]).map((type) => ({ type }))),
  },
  { weight: 1, arbitrary: fc.constant<Mark[]>([{ type: 'code' }]) },
)

const linkArb: fc.Arbitrary<Mark> = fc
  .tuple(fc.constantFrom('https://example.com', 'https://peek.estiva.app/o', 'http://a.b', 'mailto:ada'), fc.array(fc.constantFrom('x', 'plan', '2026', 'a-b', 'q?id=1'), { maxLength: 3 }))
  .map(([base, path]) => ({ type: 'link', attrs: { href: path.length ? `${base}/${path.join('/')}` : base } }))

/** A run of words with marks on some of them, a word apart, as a person formats words. */
function inlineArb(form: DocumentForm, lines = 1): fc.Arbitrary<Run[]> {
  const piece: fc.Arbitrary<Run[]> = fc.oneof(
    { weight: 6, arbitrary: styleArb.chain((marks) => wordsArb(form, 5, form === 'editor' || !marks.length).map((text) => [run(text, marks)])) },
    { weight: 1, arbitrary: mentionArb.map((m) => [m]) },
    ...(form === 'message'
      ? []
      : [{ weight: 1, arbitrary: fc.tuple(wordsArb(form, 3, form === 'editor'), linkArb, styleArb.filter((s) => !s.some((m) => m.type === 'code'))).map(([text, link, marks]) => [run(text, [...marks, link])]) }]),
  )
  const line = fc.array(piece, { minLength: 1, maxLength: 4 }).map((pieces) => pieces.flatMap((p, i) => (i ? [run(' '), ...p] : p)))
  return fc.array(line, { minLength: 1, maxLength: lines }).map((ls) => mergeRuns(ls.flatMap((l, i) => (i ? [run('\n'), ...l] : l))))
}

const run = (text: string, marks: Mark[] = []): Run => (marks.length ? { type: 'text', text, marks } : { type: 'text', text })

/** Neighbouring runs with the same marks as one run, and no empty run: the one way to write a run of text. */
function mergeRuns(runs: readonly Run[]): Run[] {
  const out: Run[] = []
  for (const r of runs) {
    if (!r.text) continue
    const last = out[out.length - 1]
    if (last && JSON.stringify(last.marks ?? []) === JSON.stringify(r.marks ?? [])) out[out.length - 1] = { ...last, text: last.text + r.text }
    else out.push(r)
  }
  return out
}

type Draft = { type: string; attrs?: Record<string, unknown>; content?: Run[] | Draft[] }

const TONES = ['note', 'tip', 'important', 'warning', 'caution']
const SHA = 'ab'.repeat(32)

function listArb(form: DocumentForm): fc.Arbitrary<Draft> {
  const item = fc.record({ text: inlineArb(form), indent: fc.nat(2), checked: form === 'message' ? fc.constant(undefined) : fc.option(fc.boolean(), { freq: 2 }) })
  return fc
    .tuple(fc.constantFrom('bulletList', 'orderedList'), fc.array(item, { minLength: 1, maxLength: 5 }), fc.option(fc.integer({ min: 2, max: 20 }), { freq: 3 }))
    .map(([type, items, start]) => {
      let depth = 0
      const content = items.map((it, i) => {
        // An item is at most one deeper than the item above it, as an editor indents.
        depth = i === 0 ? 0 : Math.min(it.indent, depth + 1)
        const attrs = { ...(depth ? { indent: depth } : {}), ...(it.checked == null ? {} : { checked: it.checked }) }
        return { type: 'listItem', ...(Object.keys(attrs).length ? { attrs } : {}), content: it.text }
      })
      return { type, ...(type === 'orderedList' && start != null ? { attrs: { start } } : {}), content }
    })
}

function tableArb(form: DocumentForm): fc.Arbitrary<Draft> {
  return fc.integer({ min: 1, max: 3 }).chain((width) =>
    fc.array(fc.array(fc.oneof({ weight: 5, arbitrary: inlineArb(form) }, { weight: 1, arbitrary: fc.constant<Run[]>([]) }), { minLength: width, maxLength: width }), { minLength: 2, maxLength: 4 }).map((rows) => ({
      type: 'table',
      content: rows.map((cells, r) => ({
        type: 'tableRow',
        content: cells.map((text) => ({
          type: r === 0 ? 'tableHeader' : 'tableCell',
          attrs: { colspan: 1, rowspan: 1 },
          // An editor saves an empty cell as a paragraph with no text.
          content: [text.length ? { type: 'paragraph', content: text } : { type: 'paragraph' }],
        })),
      })),
    })),
  )
}

function blockArb(form: DocumentForm): fc.Arbitrary<Draft> {
  const choices: { weight: number; arbitrary: fc.Arbitrary<Draft> }[] = [
    { weight: 5, arbitrary: inlineArb(form, 2).map((content) => ({ type: 'paragraph', content })) },
    {
      weight: 2,
      arbitrary: fc.tuple(fc.integer({ min: 1, max: form === 'editor' ? 3 : 2 }), inlineArb(form)).map(([level, content]) => ({ type: 'heading', attrs: { level }, content })),
    },
    { weight: 4, arbitrary: listArb(form) },
    {
      weight: 2,
      arbitrary: fc
        .tuple(inlineArb(form, 3), form === 'message' ? fc.constant(null) : fc.option(fc.constantFrom(...TONES), { freq: 2 }))
        .map(([content, tone]) => ({ type: 'blockquote', ...(tone ? { attrs: { tone } } : {}), content })),
    },
    {
      weight: 1,
      arbitrary: fc
        .tuple(fc.option(fc.constantFrom('ts', 'json', 'sh'), { freq: 2 }), fc.array(wordsArb(form), { minLength: 1, maxLength: 3 }))
        .map(([language, lines]) => ({ type: 'codeBlock', ...(language ? { attrs: { language } } : {}), content: [run(lines.join('\n'))] })),
    },
  ]
  if (form !== 'message') choices.push({ weight: 1, arbitrary: tableArb(form) })
  // A divider has no spelling in text (`test/document-trips.md`).
  if (form === 'editor') choices.push({ weight: 1, arbitrary: fc.constant({ type: 'horizontalRule' }) })
  if (form === 'editor') {
    choices.push(
      {
        weight: 1,
        arbitrary: fc
          .record({ alt: fc.option(wordsArb(form, 3), { nil: undefined }), filename: fc.option(fc.constantFrom('shot.png', 'plan.pdf'), { nil: undefined }), size: fc.nat(1_000_000) })
          .map(({ alt, filename, size }) => ({
            type: 'attachment',
            attrs: { url: `/media/${SHA}.png`, m: 'image/png', x: SHA, size, ...(alt ? { alt } : {}), ...(filename ? { filename } : {}) },
          })),
      },
      // An empty line, as Enter twice saves it; text has no spelling for one.
      { weight: 1, arbitrary: fc.constant({ type: 'paragraph' }) },
      // A block from a later version, which every reader carries whole (§13.3).
      { weight: 1, arbitrary: inlineArb(form).map((content) => ({ type: 'widget', attrs: { app: 'later', n: 1 }, content })) },
    )
  }
  return fc.oneof(...choices)
}

/**
 * A made-up document of the given form, every block with its own id. The
 * shapes are what the editor saves and what the text forms read
 * (`bridge-content.ts`, `description-text.ts`, `editor.ts`), and each is
 * written the one way a reader writes it, so "the same document" can be
 * compared exactly — see {@link documentShape}.
 */
export function documentArb(options: DocumentOptions = {}): fc.Arbitrary<BlockDocument> {
  const form = options.form ?? 'editor'
  return fc.array(blockArb(form), { minLength: 1, maxLength: options.maxBlocks ?? 8 }).map((drafts) => {
    let n = 0
    const withIds = (d: Draft): Block => {
      const id = (++n).toString(16).padStart(12, '0')
      const children = d.content?.length && d.content[0].type !== 'text' ? (d.content as Draft[]).map(withIds) : undefined
      return { ...d, id, ...(children ? { content: children } : {}) } as Block
    }
    return { type: 'doc', content: drafts.map(withIds) }
  })
}

/**
 * A document as a person reads it, for comparing two: its runs written the one
 * way ({@link mergeRuns}), and a line break carrying no marks (an editor's
 * break sits inside the bold run before it, text's does not, and nobody can see
 * which). Without its block ids unless `ids` — a trip through text carries no
 * ids, so they are compared only where a trip keeps them.
 */
export function documentShape(doc: BlockDocument, options: { ids?: boolean } = {}): unknown {
  const shape = (block: Block): unknown => {
    const { id, content, ...rest } = block
    const out = options.ids ? { id, ...rest } : rest
    if (!Array.isArray(content)) return out
    const runs = content.length > 0 && (content as { type: string }[]).every((n) => n.type === 'text')
    if (!runs) return { ...out, content: (content as Block[]).map(shape) }
    // Marks as a set: an editor lists them in its schema's order, protocol in its own, and both draw the same.
    const sorted = (r: Run): Run => (r.marks ? { ...r, marks: [...r.marks].sort((a, b) => (JSON.stringify(a) < JSON.stringify(b) ? -1 : 1)) } : r)
    const split = (content as Run[]).flatMap((r) => r.text.split(/(\n)/).map((text) => (text === '\n' ? run(text) : sorted({ ...r, text }))))
    return { ...out, content: mergeRuns(split) }
  }
  return doc.content.map(shape)
}

function processEnv(): Record<string, string | undefined> {
  return (globalThis as { process?: { env?: Record<string, string | undefined> } }).process?.env ?? {}
}

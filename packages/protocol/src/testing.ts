/**
 * `@estiva-app/protocol/testing` — made-up histories of files, for tests that
 * try thousands of inputs (fast-check). Test code only: it needs `fast-check`,
 * which this package lists as an optional peer, never as a dependency.
 *
 * A history is what a reader can be handed for a few files: their first
 * records (sometimes two versions of one), the changes people made to them
 * (`kind:1851`, one field or several, with or without a trusted `ts`, some in
 * the same second, some by people outside the file's team) and comments on
 * them. The shapes are the ones on the relay today (estiva-ship
 * `conformance/fold-fixture.json`, 20 Nov 2026), so every repo's tests share
 * one idea of what a history can be.
 *
 * One maker, many repos: Ship, Peek and Leaf import it rather than copy it.
 */
import fc from 'fast-check'
import type { SignedEvent } from './events.js'

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

const STATUSES = ['todo', 'in_progress', 'done', 'cancelled']
const TITLES = ['Payments', 'Billing', 'Renamed', 'Untitled', 'Launch plan', '']

type FileKind = typeof KIND_PROJECT | typeof KIND_ISSUE | typeof KIND_DOCUMENT

interface RootPlan {
  kind: FileKind
  author: number
  team: number
  colon: boolean
  title: string
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
  /** Carry the file's id in `O` (as writers since §6.2 do), or the id of another file, or none. */
  O: 'own' | 'other' | 'none'
  /** Filed in the file's own team, or in another one (which a reader must not fold). */
  inOwnTeam: boolean
}

const FIELDS = ['title', 'status', 'summary', 'assignee', 'archived', 'deleted', 'project', 'member'] as const

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
      colon: options.idsWithColons ? fc.boolean() : fc.constant(false),
      title: fc.constantFrom(...TITLES),
      second: fc.option(fc.record({ after: fc.nat(2), title: fc.constantFrom(...TITLES) }), { freq: 4 }),
    })
  const changeArb: fc.Arbitrary<ChangePlan> = fc.record({
    file: fc.nat(7),
    author: fc.nat(peopleCount - 1),
    at: fc.nat(4),
    ts: fc.oneof(fc.constant(null), fc.constantFrom(0, 500, 999), fc.constant('untrusted' as const)),
    sets: fc.array(fc.record({ field: fc.constantFrom(...FIELDS), value: fc.nat(7) }), { minLength: 1, maxLength: 2 }),
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
    const tags = (title: string) => [['d', d], ['title', title], ['h', team], ...(parent ? [['a', parent]] : [])]
    events.push({ id: id(), pubkey, created_at: HISTORY_EPOCH, kind: root.kind, tags: tags(root.title), content: '', sig: '' })
    if (root.second) {
      events.push({ id: id(), pubkey, created_at: HISTORY_EPOCH + root.second.after, kind: root.kind, tags: tags(root.second.title), content: '', sig: '' })
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
      if (f === 'assignee' && v) tags.push(['p', v])
      else if (f.startsWith('member:')) tags.push(['p', f.slice('member:'.length)])
    }
    if (change.ts === 'untrusted') tags.push(['ts', String((created_at + 7) * 1000)])
    else if (change.ts !== null) tags.push(['ts', String(created_at * 1000 + change.ts)])
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
    case 'status':
      return file.kind === KIND_DOCUMENT ? undefined : ['status', STATUSES[n % STATUSES.length]]
    case 'summary':
      return ['summary', n % 3 === 0 ? '' : `Summary ${n}`]
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

function processEnv(): Record<string, string | undefined> {
  return (globalThis as { process?: { env?: Record<string, string | undefined> } }).process?.env ?? {}
}

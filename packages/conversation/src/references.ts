/**
 * What `[` offers, and in what order — CON-26's ranking (Miky, 2026-10-02),
 * in one place for every app (PEE-21).
 *
 * Two capped sections, Messages above Files:
 *
 * - **Messages:** this thread or file first, then the parent file's.
 * - **Files:** this Folder first, then files you read recently (your §11 read
 *   markers), then everything else, which you reach only by typing (relay
 *   search).
 *
 * With nothing typed the tiers set the order. Once you type, a better title
 * match beats a higher tier; an open issue goes before a done or cancelled
 * one on an equal match (Miky, 2026-10-03); the app's own kinds only break the
 * ties that are left.
 *
 * The menu that draws the result is an editor's (`@estiva-app/ui/editor`'s
 * `ReferenceTrigger`); this is the half a client that does not use React can
 * take too. Where the candidates come from — a Folder's files, the read
 * markers, a relay search — is the app's: each app holds them differently.
 */
import { addrToNaddr } from '@estiva-app/protocol'

/** What a reference names, as the row's type word says it (label objects by type, not app). */
export type ReferenceType = 'message' | 'issue' | 'project' | 'topic'

/** Something `[` can offer. */
export interface ReferenceCandidate {
  /** The event id of a message, the `kind:pubkey:d` address of a file. Unique across the list. */
  id: string
  /** `nostr:…`, exactly as the body will carry it: {@link fileReference} or `messageReference`. */
  uri: string
  type: ReferenceType
  kind: number
  /** A file's current title; a message's author. */
  title: string
  /** An issue's project title, a message's opening words; `''` when there is none. */
  caption: string
  /** A message's text, matched beside `title`. Files match on `title` only. */
  search?: string
  /** 0 is closest: {@link MESSAGE_TIER} or {@link FILE_TIER}. */
  tier: number
  /** A done or cancelled issue: offered, after an open one on an equal match. */
  closed?: boolean
  /**
   * An archived file, or an issue in an archived project: offered at the lowest
   * priority — after every row that is not, on an equal match (Miky, 2026-10-03).
   */
  archived?: boolean
  /** When it was written or last read, in seconds — newer first within a tier. */
  at?: number
}

/** Where a message sits relative to the box you are writing in. */
export const MESSAGE_TIER = { here: 0, parent: 1 } as const

/** Where a file sits relative to you. `search` only ever comes from typing. */
export const FILE_TIER = { folder: 0, recent: 1, search: 2 } as const

/** How many rows each section shows (Miky, 2026-10-03): the box stays at the old list's height. */
export const REFERENCE_CAPS = { messages: 4, files: 6 } as const

export interface RankedReferences {
  messages: ReferenceCandidate[]
  files: ReferenceCandidate[]
}

export interface RankReferencesInput {
  messages: readonly ReferenceCandidate[]
  files: readonly ReferenceCandidate[]
  /** What was typed after `[`. */
  query: string
  /** The kinds the app itself writes — the last tie-breaker. */
  ownKinds?: readonly number[]
  caps?: { messages: number; files: number }
}

const normalize = (text: string) => text.toLowerCase().replace(/\s+/g, ' ').trim()

const isWordStart = (text: string, at: number) => at === 0 || !/[\p{L}\p{N}]/u.test(text[at - 1]!)

/**
 * How well `text` holds `query`: 4 the whole of it, 3 its start, 2 the start of
 * a word, 1 anywhere — or every word of the query at a word's start. 0 is no
 * match. Case and runs of spaces are ignored.
 */
export function referenceMatch(text: string, query: string): number {
  const t = normalize(text)
  const q = normalize(query)
  if (!q) return 0
  if (t === q) return 4
  if (t.startsWith(q)) return 3
  let at = t.indexOf(q)
  if (at < 0) {
    const words = q.split(' ')
    if (words.length < 2) return 0
    const starts = (w: string) => {
      for (let i = t.indexOf(w); i >= 0; i = t.indexOf(w, i + 1)) if (isWordStart(t, i)) return true
      return false
    }
    return words.every(starts) ? 1 : 0
  }
  for (; at >= 0; at = t.indexOf(q, at + 1)) if (isWordStart(t, at)) return 2
  return 1
}

/** Keeps each id once, at its closest tier. */
function closest(candidates: readonly ReferenceCandidate[]): ReferenceCandidate[] {
  const best = new Map<string, ReferenceCandidate>()
  for (const c of candidates) {
    const known = best.get(c.id)
    if (!known || c.tier < known.tier) best.set(c.id, c)
  }
  return [...best.values()]
}

const newer = (a: ReferenceCandidate, b: ReferenceCandidate) => (b.at ?? 0) - (a.at ?? 0)

/**
 * The two sections `[` draws, each ranked and capped.
 *
 * Nothing in the `search` tier is offered with nothing typed, nor anything that
 * does not match what was typed. Ties end on recency, then the title, so the
 * list holds still between keystrokes.
 */
export function rankReferences({ messages, files, query, ownKinds = [], caps = REFERENCE_CAPS }: RankReferencesInput): RankedReferences {
  const typed = normalize(query) !== ''
  const own = new Set(ownKinds)
  const ownFirst = (a: ReferenceCandidate, b: ReferenceCandidate) => Number(!own.has(a.kind)) - Number(!own.has(b.kind))
  const byTitle = (a: ReferenceCandidate, b: ReferenceCandidate) => a.title.localeCompare(b.title)

  const messageScore = (m: ReferenceCandidate) => Math.max(referenceMatch(m.title, query), referenceMatch(m.search ?? m.caption, query))
  const shownMessages = closest(messages)
    .map((m) => ({ m, score: typed ? messageScore(m) : 0 }))
    .filter(({ score }) => !typed || score > 0)
    .sort((a, b) => b.score - a.score || a.m.tier - b.m.tier || newer(a.m, b.m) || a.m.id.localeCompare(b.m.id))
    .slice(0, caps.messages)
    .map(({ m }) => m)

  const shownFiles = closest(files)
    .filter((f) => typed || f.tier !== FILE_TIER.search)
    .map((f) => ({ f, score: typed ? referenceMatch(f.title, query) : 0 }))
    .filter(({ score }) => !typed || score > 0)
    .sort(
      (a, b) =>
        b.score - a.score ||
        Number(!!a.f.archived) - Number(!!b.f.archived) ||
        (typed ? Number(!!a.f.closed) - Number(!!b.f.closed) || a.f.tier - b.f.tier : a.f.tier - b.f.tier || Number(!!a.f.closed) - Number(!!b.f.closed)) ||
        ownFirst(a.f, b.f) ||
        newer(a.f, b.f) ||
        byTitle(a.f, b.f),
    )
    .slice(0, caps.files)
    .map(({ f }) => f)

  return { messages: shownMessages, files: shownFiles }
}

/**
 * A file as the body references it: `nostr:naddr…` with no relay hint, the
 * same bytes a pasted link resolves to — so it earns its `["a", <address>]`
 * through `referenceTagsFor` and draws as the same widget (SPEC §13.1). The
 * title is never in the body: a file from a private Folder named in a wider
 * one leaks nothing but its pointer.
 *
 * `address` is `kind:pubkey:d`; anything else throws.
 */
export function fileReference(address: string): string {
  return `nostr:${addrToNaddr(address)}`
}

/** What a {@link referenceSearch} asks the relay for: the files whose title holds `query`. */
export type ReferenceSearchFn = (query: string) => Promise<readonly ReferenceCandidate[]>

// The package targets no runtime's lib, and a pause is all it needs of one.
const timers = globalThis as unknown as { setTimeout(run: () => void, ms: number): unknown; clearTimeout(id: unknown): void }

export interface ReferenceSearch {
  /**
   * The search tier for `query`: what the relay last answered for it, or —
   * while it is asked — for the longest query before it that it answered.
   * Asks it, after a pause, when it has not been asked.
   */
  hits(query: string): readonly ReferenceCandidate[]
  /** Called when an answer lands; returns the unsubscribe. */
  subscribe(listener: () => void): () => void
  /**
   * Drops what is pending and what was answered. Call it when the signed-in
   * person changes: answers are kept by the text asked, not by who asked, and
   * the last person's hits name files the next one may not be able to read.
   */
  reset(): void
}

export interface ReferenceSearchOptions {
  search: ReferenceSearchFn
  /** The pause after a keystroke before asking. Default 200ms. */
  delayMs?: number
  /** How long a failed query answers no hits before it may be asked again. Default 5s. */
  retryMs?: number
  /** Shorter queries ask nothing. Default 2. */
  minLength?: number
}

/**
 * The third Files tier, as the list asks for it on every keystroke: answers
 * now from what it holds, and asks the relay behind it.
 *
 * The rows already on screen never wait for the relay: a slow or failing
 * search leaves them as they are, with no spinner and no error row
 * (PEE-21). A failure answers no hits for `retryMs`, so a rate limit is not
 * hammered on every render, and is then forgotten, so one blip does not hide
 * that query for the rest of the session. Answers are filtered again by
 * {@link rankReferences}, so a shorter query's hits shown meanwhile never
 * offer a row the typed text does not match.
 *
 * Only the pause is cancelled by the next keystroke: a query already asked
 * keeps its answer, which is still true of that query.
 */
export function referenceSearch({ search, delayMs = 200, retryMs = 5000, minLength = 2 }: ReferenceSearchOptions): ReferenceSearch {
  const answered = new Map<string, readonly ReferenceCandidate[]>()
  const asking = new Set<string>()
  const listeners = new Set<() => void>()
  let paused: { query: string; timer: unknown } | null = null

  const cancel = () => {
    if (paused) timers.clearTimeout(paused.timer)
    paused = null
  }

  const ask = (query: string) => {
    cancel()
    const timer = timers.setTimeout(() => {
      paused = null
      asking.add(query)
      search(query)
        .then(
          (found) => found,
          () => {
            const failed: readonly ReferenceCandidate[] = []
            timers.setTimeout(() => {
              if (answered.get(query) === failed) answered.delete(query)
            }, retryMs)
            return failed
          },
        )
        .then((found) => {
          if (!asking.delete(query)) return
          answered.set(query, found.length ? found.map((f) => ({ ...f, tier: FILE_TIER.search })) : found)
          // A session's worth of queries; the oldest goes first.
          if (answered.size > 64) answered.delete(answered.keys().next().value!)
          for (const listener of listeners) listener()
        })
    }, delayMs)
    paused = { query, timer }
  }

  return {
    hits(raw) {
      const query = normalize(raw)
      if (query.length < minLength) {
        cancel()
        return []
      }
      const known = answered.get(query)
      if (known) return known
      if (paused?.query !== query && !asking.has(query)) ask(query)
      for (let n = query.length - 1; n >= minLength; n--) {
        const shorter = answered.get(query.slice(0, n).trim())
        if (shorter) return shorter
      }
      return []
    },
    subscribe(listener) {
      listeners.add(listener)
      return () => listeners.delete(listener)
    },
    reset() {
      cancel()
      asking.clear()
      answered.clear()
    },
  }
}

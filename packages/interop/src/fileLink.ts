/**
 * A file's link, written once for every app (LIN-2): `/<word>/<slug>-<d>`, or
 * `/o/<naddr>` when the file's type has no word, or nothing at all for a `d`
 * no file can have.
 *
 * Peek, Ship, Leaf and the agent each wrote this with their own code until
 * now, and on 20 Nov thousands of made-up ids drew three different answers
 * from them. The reading half has lived here since TES-4 (`matchObjectUrl`);
 * this is the writing half, and every link it writes reads back through that
 * reader as the same file on every app's host.
 *
 * **The word is the kind's owner's** (SPEC §7.7 rule 1), and the owner is the
 * one SPEC already picks for the kind's noun and its "Open in" link, so an
 * outside company reading SPEC alone writes the same link:
 *
 *   - a claimed kind: the newest manifest whose `k` claims it and which
 *     projects it (§6.11, {@link resolveManifest}'s fallback);
 *   - the bare file, `30840`, which no manifest may claim: the newest manifest
 *     declaring the `conversation` aspect with an `naddr` `web` template
 *     (§7.8, the bare file's opener).
 *
 * The author's `kind:31989` recommendation is not read here, as it is for the
 * noun: a word is the kind's on every host, not the author's. Another
 * manifest's word for the same kind is ignored (rule 1 says a second app uses
 * the owner's). A word the owner does not declare, or a link that would not
 * read back as the file on every declared host — another manifest declaring
 * the owner's word for a different kind turns it plain (§7.7) — gives the
 * file's `/o/<naddr>` instead, which every app answers (rule 3).
 *
 * A `30852` has no word: a `urls` tag names a kind, and one kind holds every
 * named type, so a word declared for it would name them all. Its link is
 * `/o/<naddr>` until a type can declare its own.
 *
 * why: https://github.com/estiva-app/estiva-docs/blob/main/decisions/a-files-path-is-the-same-on-every-apps-host.md
 * why: https://github.com/estiva-app/estiva-docs/blob/main/decisions/a-files-id-is-a-random-uuid-the-same-rule-as-a-teams-id.md
 */
import { addrToNaddr, FILE_KINDS, isFileId, type SignedEvent } from '@estiva-app/protocol'
import { matchObjectUrl, objectRef, urlPatternsOf, type UrlPattern } from './objectUrl.js'
import { parseManifest, webTemplate } from './projection.js'

/** A published `kind:31990`, as an app holds it. Only these fields are read. */
export type LinkManifest = Pick<SignedEvent, 'pubkey' | 'created_at' | 'tags' | 'content'> & { id?: string; kind?: number }

/** The words {@link filePathOf} writes, by kind: what {@link fileLinkWordsOf} reads off the manifests. */
export interface FileLinkWords {
  readonly byKind: Readonly<Record<number, string>>
}

const KIND_HANDLER_INFORMATION = 31990
const KIND_BARE_FILE = 30840
const KIND_NAMED_FILE = 30852

/** A type word (§7.7 rule 1): lowercase letters, digits and hyphens, starting with a letter. */
const WORD = /^[a-z][a-z0-9-]*$/
/** Root paths no file's word may take (§7.7 rule 3): the `naddr` form and an app's own pages. */
const RESERVED_WORDS: readonly string[] = ['o', 'app']
/** `<kind>:<pubkey>:<d>`, the pubkey as it is on the wire. */
const ADDRESS = /^(\d+):([0-9a-f]{64}):([^]*)$/
/** A path shape for a file: `/<word>/<slug>-<d>` or `/<word>/<d>`, an optional non-route fragment, no query. */
const FILE_SHAPE = /^[a-z][a-z0-9+.-]*:\/\/[^/?#]+\/([^/?#]+)\/(?:<slug>-)?<d>(?:#(?!\/)[^]*)?$/i

/**
 * The word each file kind's link is written with, from every manifest the app
 * holds (the same `kind:31990` read the link reader takes its shapes from).
 * Pure and synchronous: read once when the manifests arrive, then build links
 * in render.
 */
export function fileLinkWordsOf(manifests: readonly LinkManifest[]): FileLinkWords {
  const published = manifests
    .filter((m) => m.kind === undefined || m.kind === KIND_HANDLER_INFORMATION)
    // Newest first; on the same second the lower id, as NIP-01 breaks a tie.
    .sort((a, b) => b.created_at - a.created_at || (a.id ?? '').localeCompare(b.id ?? ''))
  const patterns: UrlPattern[] = published.flatMap((m) => urlPatternsOf(m))
  const origins = [...new Set(patterns.map((p) => originOf(p.pattern)).filter((o): o is string => o !== null))]

  const byKind: Record<number, string> = {}
  for (const kind of FILE_KINDS) {
    if (kind === KIND_NAMED_FILE) continue
    const owner = published.find((m) => (kind === KIND_BARE_FILE ? opensConversations(m) : claims(m, kind)))
    const word = owner && ownersWord(owner, kind)
    if (word && readsBackEverywhere(word, kind, patterns, origins)) byKind[kind] = word
  }
  return { byKind }
}

/**
 * The path a file opens at on any app's host: `/<word>/<slug>-<d>` when its
 * kind has a word, `/o/<naddr>` when it has none, and `null` when the address
 * is not a file's — a kind that is not a file kind, or a `d` that is not a
 * random (version 4) lowercase uuid, which the relay refuses on every file
 * (SPEC §6.1), so no such file exists to link to.
 *
 * The slug is made from `title` and is decoration: without it the path is the
 * bare `/<word>/<d>`, which opens the same file.
 */
export function filePathOf(address: string, words: FileLinkWords, title?: string): string | null {
  const match = ADDRESS.exec(address)
  if (!match) return null
  const kind = Number(match[1])
  const d = match[3]
  if (!FILE_KINDS.includes(kind) || !isFileId(d)) return null
  const word = words.byKind[kind]
  return word ? `/${word}/${objectRef(d, title)}` : `/o/${addrToNaddr(address)}`
}

/** {@link filePathOf} on `origin` (`https://ship.estiva.app`): the link Copy link hands out. */
export function fileUrlOf(address: string, words: FileLinkWords, origin: string, title?: string): string | null {
  const path = filePathOf(address, words, title)
  return path === null ? null : `${origin.replace(/\/+$/, '')}${path}`
}

/** Whether a manifest claims `kind` by its `k` and projects it, as {@link resolveManifest} asks. */
function claims(manifest: LinkManifest, kind: number): boolean {
  if (!manifest.tags.some((t) => t[0] === 'k' && t[1] === String(kind))) return false
  return parseManifest(manifest)?.projections?.[String(kind)] !== undefined
}

/** Whether a manifest is the bare file's opener: the `conversation` aspect, with somewhere to open a file. */
function opensConversations(manifest: LinkManifest): boolean {
  return parseManifest(manifest)?.aspect === 'conversation' && webTemplate(manifest, 'naddr') !== undefined
}

/** The first word the owner declares a file path shape for `kind` with, on its own origin. */
function ownersWord(owner: LinkManifest, kind: number): string | undefined {
  for (const { pattern, kind: declared } of urlPatternsOf(owner)) {
    if (declared !== kind) continue
    const word = FILE_SHAPE.exec(pattern)?.[1]
    if (word && WORD.test(word) && !RESERVED_WORDS.includes(word)) return word
  }
  return undefined
}

/**
 * Whether `/<word>/<d>` reads back as this file on every declared host: as a
 * file of `kind`, or with the kinds left open, and never of another kind. The reader ignores the slug and the `d`'s value
 * (any uuid reads the same), so one made-up file stands for all of them.
 */
function readsBackEverywhere(word: string, kind: number, patterns: UrlPattern[], origins: string[]): boolean {
  const d = '00000000-0000-4000-8000-000000000000'
  return origins.every((origin) => {
    const match = matchObjectUrl(`${origin}/${word}/${d}`, patterns)
    if (match === null || match.by !== 'd' || match.identifier !== d || match.within) return false
    // A shape that names no kind (on its own origin) leaves the kinds open: the
    // reader then looks the id up under every declared kind and still finds
    // this file, so a stranger's kindless shape does not cost it its word.
    return match.kind === kind || (match.kind === undefined && match.kinds === undefined)
  })
}

/** `scheme://host[:port]`, lowercased, or null. */
function originOf(url: string): string | null {
  const match = /^(https?):\/\/([^/?#]+)/i.exec(url)
  return match ? `${match[1].toLowerCase()}://${match[2].toLowerCase()}` : null
}

/**
 * What an app link names, once for every app — SPEC §7.7, §13.1, §13.6.2
 * (PEEKM-7). The chip a pasted link becomes, the card under a comment, the
 * block a link to one block shows, the `a` and `q` tags a send or an edit
 * carries, and where a card written as a URL opens: Peek, Ship, Leaf and the
 * agent each kept a copy of this, and they drifted (Leaf retried, Ship tagged
 * a URL in code, only Leaf's opener was https only).
 *
 * A URL names an object when a published manifest's `urls` pattern claims its
 * host and `<type>`, and then **one author** holds that `d`: the `#d` query
 * asks for two, and a `d` two authors hold names nothing, so somebody
 * publishing the same `(kind, d)` cannot put their object's card or its
 * mention under a link to another's. Only an addressable kind is asked: a
 * manifest anyone can publish could otherwise point a path at a kind where a
 * `d` is no identity. A link to one block (`#block-<id>`) names its file, and
 * the block is its part (§13.6.1). A URL that names an event names its id.
 *
 * Asked once per link for the reader's life: a link names the same object for
 * as long as its owner's manifest does. A read that failed is forgotten, so the
 * next ask tries again, and is said as a change after 5, 10 and 20 seconds so
 * whoever still draws from it asks.
 *
 * why: https://github.com/estiva-app/estiva-docs/blob/main/decisions/a-files-path-is-the-same-on-every-apps-host.md
 * why: https://github.com/estiva-app/estiva-docs/blob/main/decisions/an-edit-says-what-the-message-links-now.md
 */
import { MAX_PARTS } from '@estiva-app/conversation'
import { partTag, valuesIn, type LinkResolver, type PartPointer, type RenderBlock } from '@estiva-app/protocol'
import { matchObjectUrl, urlPatternsOf, type UrlPattern } from './objectUrl.js'
import type { QueryFn } from './projection.js'

/** What one link names: an address or a message's event id, and the block when it links to one. */
export interface LinkAnswer {
  value: string | null
  block?: PartPointer
}

/** The comment a body is written in: its file and the message it replies to, which its tags never repeat as a mention. */
export interface OwnPlace {
  /** The file the comment is on, `kind:pubkey:d`: its `A`, never also an `a` for a link to it. */
  file?: string
  /** The event id it replies to: its `e`, never also a `q`. */
  parent?: string
}

export interface LinkReaderOptions {
  /** A read as the viewer. Throws when the relay could not be asked. */
  query: QueryFn
  /**
   * The published manifests, `kind:31990` (§7.2). Omitted: one read of every
   * manifest through `query`, kept for the reader's life and forgotten when it
   * fails. An app that already holds them passes its own.
   */
  manifests?: () => Promise<readonly { tags: string[][] }[]>
  /** How many times a failed read is said as a change, after 5, 10, 20… seconds. Default 3; 0 says none. */
  retries?: number
}

export interface LinkReader {
  /** What one link names; rejects when the relay could not be asked (and the next ask tries again). */
  answerOf(url: string): Promise<LinkAnswer>
  /**
   * Ask what each of these links names; settles when every answer is in, and
   * rejects when a read failed (it left no answer), so a `LinkChips` forgets
   * those links and asks again.
   */
  ask(urls: readonly string[]): Promise<void>
  /** What a link names, from what has come back: undefined until it has, and for nothing. A `LinkResolver`. */
  known: LinkResolver
  /** The file and block a link to one block names, from what has come back. */
  knownBlock(url: string): PartPointer | undefined
  /** Whether a link's answer has come back, naming something or nothing. */
  answered(url: string): boolean
  /** Called each time an answer comes back, or a failed one may be asked again. Returns the unsubscribe. */
  changed(listener: () => void): () => void
  /** How many times {@link changed} has fired: a snapshot for `useSyncExternalStore`. */
  version(): number
  /**
   * The `a`, `q` and `part` tags a body earns ({@link linkTagsOf}), asking
   * first what its links name and waiting at most `waitMs` (default 5 s): a
   * link not answered by then earns nothing, and the body keeps it.
   */
  tagsFor(blocks: readonly RenderBlock[], own: OwnPlace, options?: { waitMs?: number; edit?: boolean }): Promise<string[][]>
  /** {@link writtenOpenerOf} against the hosts the manifests read so far declare. */
  opener(url: string | undefined, opens: string | undefined, origin: string): string | undefined
  /** Every host an app declares its paths on, as the manifests read so far said. */
  declaredOrigins(): ReadonlySet<string>
}

// The runtime's, in every app and in node; this package compiles without the DOM or node types.
declare const URL: { new (raw: string, base?: string): { origin: string } }
declare const setTimeout: (run: () => void, ms: number) => unknown
declare const clearTimeout: (timer: unknown) => void

/** Wait for `work`, but no longer than `ms`; never rejects. */
export async function within(work: Promise<unknown>, ms: number): Promise<void> {
  let timer: unknown
  await Promise.race([
    work.then(
      () => {},
      () => {},
    ),
    new Promise<void>((resolve) => {
      timer = setTimeout(resolve, ms)
    }),
  ])
  clearTimeout(timer)
}

/** How many links one body asks about, the first ones — as `LinkChips`' `limit`: each answer can cost a relay query. */
export const MAX_LINKS_ASKED = 24

const EVENT_ID = /^[0-9a-f]{64}$/i
const RETRY_MS = 5000

/** NIP-89's handler information, where an app publishes its manifest and `urls` (§7.2). */
const KIND_APP_HANDLER = 31990

/** One link reader for an app: its relay reads, and the manifests it holds. */
export function linkReader(options: LinkReaderOptions): LinkReader {
  const { query, retries = 3 } = options
  const origins = new Set<string>()
  let shapes: Promise<UrlPattern[]> | null = null
  const shapesOf = (): Promise<UrlPattern[]> => {
    if (shapes) return shapes
    const read = (options.manifests ?? (() => query([{ kinds: [KIND_APP_HANDLER], limit: 500 }])))().then((manifests) => {
      const found = manifests.flatMap((manifest) => urlPatternsOf(manifest))
      for (const shape of found) {
        try {
          origins.add(new URL(shape.pattern).origin)
        } catch {
          // A shape that is not a URL declares no host.
        }
      }
      return found
    })
    shapes = read
    // A failed read must not poison the reader, nor an empty one (a relay still
    // starting, a read before sign-in): the next link asks again.
    read.then(
      (found) => {
        if (found.length === 0 && shapes === read) shapes = null
      },
      () => {
        if (shapes === read) shapes = null
      },
    )
    return read
  }

  const answer = async (url: string): Promise<LinkAnswer> => {
    const shapes = await shapesOf()
    // No manifest read yet is no answer: kept as one, the link would name nothing for the reader's life.
    if (shapes.length === 0) throw new Error('No app manifest has been read yet.')
    const hit = matchObjectUrl(url, shapes)
    if (!hit) return { value: null }
    if (hit.by === 'id') return { value: EVENT_ID.test(hit.identifier) ? hit.identifier.toLowerCase() : null }
    // A path on another app's host can read as several kinds (§7.7, LTX-6): ask under each addressable one.
    const kinds = (hit.kinds ?? (hit.kind === undefined ? undefined : [hit.kind]))?.filter((kind) => kind >= 30000 && kind < 40000)
    if (kinds?.length === 0) return { value: null }
    // A shape that names no kind asks every one; only an addressable answer counts.
    const found = (await query([{ '#d': [hit.identifier], limit: 2, ...(kinds ? { kinds } : {}) }])).filter((event) => event.kind >= 30000 && event.kind < 40000)
    const authors = new Set(found.map((event) => `${event.kind}:${event.pubkey.toLowerCase()}`))
    if (authors.size !== 1) return { value: null }
    const address = `${[...authors][0]}:${hit.identifier}`
    return hit.block === undefined ? { value: address } : { value: address, block: { address, block: hit.block } }
  }

  const asked = new Map<string, Promise<LinkAnswer>>()
  const known = new Map<string, LinkAnswer>()
  const failures = new Map<string, number>()
  const listeners = new Set<() => void>()
  let answered = 0
  const changed = () => {
    answered += 1
    for (const listener of listeners) listener()
  }

  const answerOf = (url: string): Promise<LinkAnswer> => {
    let pending = asked.get(url)
    if (!pending) {
      pending = answer(url).then(
        (found) => {
          known.set(url, found)
          changed()
          return found
        },
        (error: unknown) => {
          asked.delete(url)
          const failed = failures.get(url) ?? 0
          failures.set(url, failed + 1)
          if (failed < retries) setTimeout(changed, RETRY_MS * 2 ** failed)
          throw error
        },
      )
      asked.set(url, pending)
    }
    return pending
  }

  const knownValue: LinkResolver = (url) => known.get(url)?.value ?? undefined
  const knownBlock = (url: string) => known.get(url)?.block

  return {
    answerOf,
    async ask(urls) {
      const waiting = [...new Set(urls)].filter((url) => !known.has(url))
      await Promise.allSettled(waiting.map(answerOf))
      if (waiting.some((url) => !known.has(url))) throw new Error('A link could not be asked about; asked again later.')
    },
    known: knownValue,
    knownBlock,
    answered: (url) => known.has(url),
    changed(listener) {
      listeners.add(listener)
      return () => {
        listeners.delete(listener)
      }
    },
    version: () => answered,
    async tagsFor(blocks, own, { waitMs = 5000, edit = false } = {}) {
      const urls = linksIn(blocks).slice(0, MAX_LINKS_ASKED)
      const waiting = urls.filter((url) => !known.has(url))
      if (waiting.length > 0) await within(Promise.allSettled(waiting.map(answerOf)), waitMs)
      const first = new Set(urls)
      const resolve: LinkResolver = (url) => (first.has(url) ? knownValue(url) : undefined)
      return linkTagsOf(blocks, own, resolve, edit ? undefined : (url) => (first.has(url) ? knownBlock(url) : undefined))
    },
    opener: (url, opens, origin) => writtenOpenerOf(url, opens, origin, origins),
    declaredOrigins: () => origins,
  }
}

/**
 * Every link a body names something by, in the order it names them: the URLs
 * {@link valuesIn} asks a `LinkResolver` about — bare, or a link on words'
 * target, and none in code. What a sender asks about before it tags.
 */
export function linksIn(blocks: readonly RenderBlock[]): string[] {
  const urls: string[] = []
  valuesIn(blocks, (url) => {
    urls.push(url)
    return undefined
  })
  return [...new Set(urls)]
}

/**
 * The tags a message's body earns for what it names (§13.1, §13.6.1): an `a`
 * per address and a `q` per message, by a `nostr:` reference or an app link
 * `resolve` answers, in the order the body first names them; then one `part`
 * per file a link to one of its blocks names, the first link's, when
 * `blockOf` is given. The comment's own file earns neither an `a` nor a part
 * (it is the `A`), and the message it replies to no `q` (it is the `e`).
 *
 * A send and an edit carry the same `a` and `q` set: an edit says what the
 * message links now. An edit carries no `part` (pass no `blockOf`), and a
 * person is never here: `p` and `urgent` stay as the send wrote them.
 *
 * why: https://github.com/estiva-app/estiva-docs/blob/main/decisions/an-edit-says-what-the-message-links-now.md
 */
export function linkTagsOf(
  blocks: readonly RenderBlock[],
  own: OwnPlace,
  resolve: LinkResolver,
  blockOf?: (url: string) => PartPointer | undefined,
): string[][] {
  const file = own.file && sameValue(own.file)
  const parent = own.parent?.toLowerCase()
  const tags: string[][] = []
  for (const value of valuesIn(blocks, resolve)) {
    if (EVENT_ID.test(value)) {
      if (value !== parent) tags.push(['q', value])
    } else if (value !== file) tags.push(['a', value])
  }
  if (blockOf) {
    const parts = new Map<string, string>()
    for (const url of linksIn(blocks)) {
      const part = blockOf(url)
      if (part && sameValue(part.address) !== file && !parts.has(part.address)) parts.set(part.address, part.block)
    }
    // As many as a box shows under it (conversation's `boxLinksOf`): a part the box did not draw is not sent.
    for (const [address, block] of [...parts].slice(0, MAX_PARTS)) tags.push(partTag(address, block))
  }
  return tags
}

/** An address as `valuesIn` spells it: the kind and pubkey as hex, the `d` as written. */
function sameValue(address: string): string {
  const [kind, pubkey = '', ...d] = address.split(':')
  return `${kind}:${pubkey.toLowerCase()}:${d.join(':')}`
}

/**
 * Where a card or chip written as a URL opens: the address as written, in the
 * app it names (§7.7, LTX-6), so `leaf.estiva.app/issue/…` opens Leaf, not
 * Ship. Undefined for anything but https, and for a host that is neither this
 * app's (`origin`), the one its file opens on (`opens`), nor one an app
 * declares: a card that draws one file never opens a site no app serves from
 * (WBM-11 security review). The same rule in every app.
 *
 * why: https://github.com/estiva-app/estiva-docs/blob/main/decisions/a-files-path-is-the-same-on-every-apps-host.md
 */
export function writtenOpenerOf(url: string | undefined, opens: string | undefined, origin: string, declared: ReadonlySet<string>): string | undefined {
  if (!url || !/^https:\/\//i.test(url)) return undefined
  try {
    const at = new URL(url).origin
    const opensAt = opens ? new URL(opens, origin).origin : undefined
    return at === origin || at === opensAt || declared.has(at) ? url : undefined
  } catch {
    return undefined
  }
}

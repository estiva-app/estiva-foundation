/**
 * Object URLs — RFC 0.5 §7, accepted 2026-09-03.
 *
 *     https://<app>.estiva.app/<type>s                        a directory of that kind
 *     https://<app>.estiva.app/<type>/<slug>-<d>              one object
 *     https://<app>.estiva.app/<type>/<slug>-<id>             one event, which has no `d`
 *     https://<app>.estiva.app/<type>/<slug>-<d>?thread=<id>  one event, inside an object
 *
 * **Here rather than in each app** because it is wire-visible: §7.1's whole
 * argument is that the URL one app puts in the address bar has to be resolvable
 * by another, which is SPEC §10's test for something the protocol owns. Two
 * implementations would disagree about what a slug may contain, and the
 * disagreement would show up as a link that resolves in the app that wrote it
 * and nowhere else.
 *
 * Peek's `src/lib/objectUrl.ts` is where `slugify`, `objectRef` and
 * `identifierFromRef` were written (PEE-14) and they are moved rather than
 * rewritten — an extraction that changes behaviour while every test still
 * passes is the thing to guard against, so Peek's own cases come with them.
 *
 * Two properties from §7.2 do all the work:
 *
 *   - **The uuid is the whole identity and is never truncated.** A consumer
 *     resolves `{"#d": ["<uuid>"]}` — one query, no index, and no service that
 *     can go down and take every published link with it.
 *   - **The slug is decorative.** Renaming the object changes it and the link
 *     still resolves, because a reader ignores everything between the `<type>`
 *     segment and the final uuid.
 *
 * That second sentence is the amended one. §7.2 used to say a consumer MUST
 * ignore *everything* before the final uuid, which contradicted the paragraph
 * above it and, read literally, resolves `evil.example.com/issue/<uuid>` as a
 * Ship issue. The host and the `<type>` segment are exactly what select the app
 * and the kind; only the slug is decoration. `matchObjectUrl` implements the
 * corrected rule.
 */

/**
 * A v4 uuid at the very end of a ref.
 *
 * Anchored at the end rather than searched for, because §7.2's rule is
 * positional: the identity is the tail, and everything before it is a human
 * label that may itself contain hyphens, digits and hex.
 */
const TRAILING_UUID_RE = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

/**
 * A 64-character event id at the very end of a ref.
 *
 * The second identity shape, for an object that has no `d` — a `kind:9`
 * message is the case in hand, and §7.6 recorded it as outside the grammar
 * until this. Anchored at the end for the same positional reason as the uuid.
 */
const TRAILING_EVENT_ID_RE = /(?:^|[^0-9a-f])([0-9a-f]{64})$/i

/**
 * Slugs are cut here. Long enough to stay recognisable in a chat client's link
 * preview, short enough that the uuid is not pushed off the end of a rendered
 * URL — which is the only thing in the ref that carries meaning.
 */
const SLUG_MAX_LENGTH = 60

/**
 * A title reduced to URL-safe words. Decorative by contract: nothing resolves
 * through it, so it is free to be lossy — accents folded, punctuation dropped,
 * runs collapsed.
 */
export function slugify(title: string): string {
  return title
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, SLUG_MAX_LENGTH)
    .replace(/-+$/g, '')
}

/** `<slug>-<identifier>`, or the bare identifier when the title slugs to nothing. */
export function objectRef(identifier: string, title?: string): string {
  const slug = title ? slugify(title) : ''
  return slug ? `${slug}-${identifier}` : identifier
}

/**
 * The identity out of a ref, or `null` if it carries none.
 *
 * Lowercased on the way out: the relay's `d` values are lowercase uuids, and a
 * link that has been through a system which upper-cased it should still resolve
 * rather than silently miss.
 */
export function identifierFromRef(ref: string): string | null {
  const match = TRAILING_UUID_RE.exec(ref)
  return match ? match[0].toLowerCase() : null
}

/**
 * The event id out of a ref, or null.
 *
 * **Why an event id in a URL rather than an `nevent`.** §7.3 rejects bech32 in
 * a URL on two grounds, and both apply to `nevent` exactly as they do to
 * `naddr`: a slice of it is checksum bytes rather than the identity, and relay
 * hints are part of the encoding, so one object has more than one spelling.
 *
 * A raw event id has neither problem. It is the whole identity of an event that
 * has no `d`, it is stable because nothing optional is encoded into it, and it
 * resolves with `{ids: ["<id>"]}` — one query, no index, exactly the property
 * §7.2 chose the bare uuid for. So the rule generalises rather than gaining an
 * exception: **the identity goes in the path, unencoded, and everything before
 * it is decoration.**
 */
export function eventIdFromRef(ref: string): string | null {
  const match = TRAILING_EVENT_ID_RE.exec(ref)
  return match ? match[1].toLowerCase() : null
}

/**
 * A URL shape an app says it serves — RFC 0.5 §7.5's `urls`, read off the
 * manifest event the way `web` is.
 *
 * `web` is outbound (given an object, build a link); this is inbound (given a
 * link, recover the object). Usually the same strings, separate fields because
 * they answer different questions — and because an app that changes its routes
 * still has to read the links it published under the old ones.
 */
export interface UrlPattern {
  /** e.g. `https://ship.estiva.app/issue/<slug>-<d>` */
  pattern: string
  /**
   * The kind this shape names, when the app said so.
   *
   * §7.2 says the kind comes from the path segment — but `/issue/` means 30851
   * only *to the app serving it*, and a consumer has never heard of "issue".
   * So an app MAY name the kind alongside the pattern. When it does not, a
   * consumer falls back to the kinds the manifest declares it handles, which is
   * sound because no `d` is reused under two kinds — measured across all 280
   * production records at §7's acceptance.
   */
  kind?: number
}

/** The `urls` shapes a manifest event declares. */
export function urlPatternsOf(event: { tags: string[][] }): UrlPattern[] {
  const out: UrlPattern[] = []
  for (const tag of event.tags) {
    if (tag[0] !== 'urls' || !tag[1]) continue
    const kind = tag[2] ? Number(tag[2]) : undefined
    out.push({ pattern: tag[1], ...(Number.isInteger(kind) ? { kind } : {}) })
  }
  return out
}

/** What a pasted URL turned out to name. */
export interface MatchedObjectUrl {
  /** A `d` for an addressable object, or an event id for one without. */
  identifier: string
  /**
   * How to resolve `identifier`: by `#d` for an addressable object, by `ids`
   * for an event that has none.
   *
   * Declared by the pattern's placeholder — `<d>` or `<id>` — rather than
   * guessed from the string, because a consumer that inspected the value would
   * be deciding a kind's addressing model from the shape of a hex string.
   */
  by: 'd' | 'id'
  /** Present only when the matched pattern named one. */
  kind?: number
  /**
   * The object the path names, when the identity came from the query — the
   * topic a `?thread=<id>` link opens, read off `/topic/<slug>-<d>`. Absent
   * when the path *is* the identity. A consumer resolving the thread needs
   * only `identifier`; this is for one that wants to say where it is.
   */
  within?: { identifier: string; by: 'd' | 'id' }
  /**
   * One block of the object, when the pattern declares a `<block>` in its
   * fragment and the URL carries one (SPEC §7.7, COM-2): Ship's block menu
   * copies `…/issue/<slug>-<d>#block-<id>`. The block is optional — the same
   * pattern still claims the URL without its fragment — so an app adds it to a
   * shape it already declares rather than declaring a second one.
   */
  block?: string
}

/** The placeholder a pattern's fragment uses for a block id. */
const BLOCK_PLACEHOLDER = '<block>'

/**
 * Match a pasted URL against one app's declared shapes.
 *
 * **The host and the `<type>` segment are significant; the slug is not.** That
 * is §7.2 as amended, and it is the whole of the security story here: a
 * consumer that matched on the trailing uuid alone would resolve any URL from
 * anywhere as that app's object.
 *
 * **A query parameter may carry the identity too** (FOL-38). Peek opens a
 * thread as `/topic/<slug>-<d>?thread=<id>`: the path names the topic, the
 * query names the root comment, and the link is *about the comment*. So a
 * pattern may write a placeholder in its query, and when it does, that
 * placeholder is the identity and the path's is the container (`within`).
 * A pattern with no query placeholder still ignores the query entirely — a
 * link that has been through a tracker's `?utm_…` resolves as before — and
 * when two patterns claim one URL, the one whose query placeholders the URL
 * satisfies wins over the one that ignored them, whatever order the manifest
 * declared them in. That is what lets an app declare the topic shape and the
 * thread shape as two `urls` tags rather than one grammar.
 *
 * Returns null for a URL no pattern claims, which is the honest outcome — §7.5
 * says such a URL renders as a plain link, because it is one.
 */
export function matchObjectUrl(url: string, patterns: UrlPattern[]): MatchedObjectUrl | null {
  const target = splitUrl(url)
  if (!target) return null

  let best: { specificity: number; match: MatchedObjectUrl } | null = null
  for (const { pattern, kind } of patterns) {
    const shape = splitUrl(pattern)
    if (!shape) continue
    if (shape.scheme !== target.scheme || shape.host !== target.host) continue
    // A fragment route and a path route are different shapes, not one.
    if (shape.fragmented !== target.fragmented) continue

    // The pattern's path up to its final segment: `/issue/` out of
    // `/issue/<slug>-<d>`. Compared literally and at equal depth, so `/issues`
    // never matches `/issue/…` and a nested route never matches a shallower one.
    if (shape.segments.length !== target.segments.length) continue
    const prefixMatches = shape.segments
      .slice(0, -1)
      .every((segment, i) => segment === target.segments[i])
    if (!prefixMatches) continue

    const tail = target.segments[target.segments.length - 1] ?? ''
    /*
      The pattern says which identity it carries. `<id>` is an event id, for a
      kind with no `d`; anything else is the `<d>` uuid this grammar started
      with. Read from the declaration rather than sniffed from the value: a
      64-hex string and a uuid are distinguishable today, and a consumer that
      relied on that would be inferring an app's addressing model from a
      character class.
    */
    const path = readPlaceholder(shape.segments[shape.segments.length - 1] ?? '', tail)
    if (!path) continue

    // Every placeholder the pattern's query declares must be present and must
    // parse; a `?thread=` that carries no event id names nothing, and the
    // topic shape — if declared — is what such a link falls back to.
    const declared = Object.entries(shape.query).filter(([, value]) => /<(?:d|id)>/.test(value))
    let query: { identifier: string; by: 'd' | 'id' } | null = null
    let satisfied = true
    for (const [key, placeholder] of declared) {
      const value = target.query[key]
      const read = value === undefined ? null : readPlaceholder(placeholder, value)
      if (!read) {
        satisfied = false
        break
      }
      query = read
    }
    if (!satisfied) continue

    const block = readBlock(shape.hash, target.hash)
    const match: MatchedObjectUrl = {
      ...(query ? { ...query, within: path } : path),
      ...(kind === undefined ? {} : { kind }),
      ...(block === undefined ? {} : { block }),
    }
    // A filled `<block>` breaks a tie, so an app that declares the block shape
    // beside its older shape loses no block to declaration order.
    const specificity = declared.length * 2 + (block === undefined ? 0 : 1)
    if (!best || specificity > best.specificity) best = { specificity, match }
  }
  return best?.match ?? null
}

/**
 * The block a URL's fragment names, by the pattern's `#…<block>…`; undefined
 * when the pattern declares none, the URL has no fragment, or it does not fit.
 * A fragment cut mid-escape names no block rather than throwing — the object
 * still resolves, which is what the link was mostly for.
 */
function readBlock(pattern: string, value: string): string | undefined {
  const at = pattern.indexOf(BLOCK_PLACEHOLDER)
  if (at === -1) return undefined
  const before = pattern.slice(0, at)
  const after = pattern.slice(at + BLOCK_PLACEHOLDER.length)
  if (value.length <= before.length + after.length || !value.startsWith(before) || !value.endsWith(after)) {
    return undefined
  }
  try {
    const block = decodeURIComponent(value.slice(before.length, value.length - after.length))
    return BLOCK_ID.test(block) ? block : undefined
  } catch {
    return undefined
  }
}

/** The ids a reader takes from a URL — protocol's `partsOf` takes the same. */
const BLOCK_ID = /^[A-Za-z0-9_-]{1,64}$/

/**
 * The link that opens one block of an object, built from the app's own `urls`
 * shape for its kind — the outbound half of {@link matchObjectUrl}'s `block`.
 *
 * Built from `urls` rather than `web` because NIP-89's `web` template has one
 * placeholder, `<bech32>`, and an app's `/o/<naddr>` redirect is not obliged to
 * carry a fragment through. Returns undefined when the app declares no path
 * shape for that kind with a `<block>` fragment; the caller then opens the
 * object without the block, which is still the right object.
 */
export function blockUrlOf(
  patterns: UrlPattern[],
  target: { kind: number; d: string; title?: string; block: string },
): string | undefined {
  // A `d` that is not a clean identifier would be spliced into the path raw
  // (`../settings`), and `matchObjectUrl` could never read the link back.
  if (identifierFromRef(target.d) !== target.d || !BLOCK_ID.test(target.block)) return undefined
  for (const { pattern, kind } of patterns) {
    if (kind !== target.kind) continue
    const hashAt = pattern.indexOf('#')
    if (hashAt === -1) continue
    const path = pattern.slice(0, hashAt)
    const hash = pattern.slice(hashAt + 1)
    // A fragment route (`/#/issue/<d>`) is the legacy shape, never written.
    if (hash.startsWith('/') || !hash.includes(BLOCK_PLACEHOLDER) || !path.includes('<d>')) continue
    // Only `<d>` and `<block>` are known here; a shape with any other
    // placeholder (`?thread=<id>`) would be emitted half-filled.
    if (/<(?!slug>|d>)[^>]*>/.test(path)) continue
    const ref = path.includes('<slug>-<d>') ? objectRef(target.d, target.title) : target.d
    // Replacer functions, so a `$&` in an identifier is not a replacement pattern.
    const base = path.replace(/<slug>-<d>|<d>/, () => ref)
    return `${base}#${hash.replace(BLOCK_PLACEHOLDER, () => encodeURIComponent(target.block))}`
  }
  return undefined
}

/** The identity a placeholder declares, read off the value in that position. */
function readPlaceholder(placeholder: string, value: string): { identifier: string; by: 'd' | 'id' } | null {
  const wantsEventId = placeholder.includes('<id>')
  const identifier = wantsEventId ? eventIdFromRef(value) : identifierFromRef(value)
  return identifier ? { identifier, by: wantsEventId ? 'id' : 'd' } : null
}

/**
 * Scheme, host and path segments — the whole of the URL this grammar reads.
 *
 * Hand-parsed rather than through `new URL()`, which is an ambient global this
 * package may not reach for: `tsconfig.base.json` sets `types: []` and a `lib`
 * without DOM on purpose (ADR 0002 §4a), so that a published declaration cannot
 * name a type one consumer has and another does not. The grammar is three
 * fields; a parser for it is cheaper than the constraint it would break.
 *
 * Only `http` and `https` parse, which is belt-and-braces rather than the load
 * -bearing rule: a `javascript:` or `data:` URL is already refused for having no
 * `://` authority, and any other scheme is refused by the scheme comparison
 * against a declared pattern, since every pattern an app publishes is `https`.
 * A control confirmed that — relaxing this regex to accept any scheme failed no
 * test. It stays because the cost is a character class and it makes the
 * refusal local to the parser rather than a consequence of what apps happen to
 * declare.
 */
function splitUrl(raw: string): {
  scheme: string
  host: string
  segments: string[]
  fragmented: boolean
  query: Record<string, string>
  /** A fragment that is not a route — `block-<id>` — as written; '' when none. */
  hash: string
} | null {
  const match = /^(https?):\/\/([^/?#]+)([^?#]*)(?:\?([^#]*))?(?:#(.*))?$/i.exec(raw.trim())
  if (!match) return null
  const [, scheme, host, path, search, fragment] = match

  /*
    A fragment route counts as path.

    Ship served `#/issue/<d>` until SHI-16 and still declares those shapes, so
    that links already sitting in other people's messages resolve rather than
    rendering as plain text for ever. A parser that stopped at the `#` — this
    one did — matched none of them, which a production probe caught before any
    consumer was built on it.

    Segments from the path and the fragment are concatenated rather than
    swapped, because an app may be served under a sub-path *and* use a
    fragment: Ship's own dev URL is `localhost:5190/ship/#/…`, where both
    halves carry meaning.

    `fragmented` is kept so the two do not collapse into each other. Without it
    a pattern for `/issue/<slug>-<d>` would also claim `/#/issue/<d>`, and an
    app that means different things by the two would resolve the wrong object.
  */
  const fragmentPath = fragment && fragment.startsWith('/') ? fragment : ''
  return {
    scheme: scheme.toLowerCase(),
    host: host.toLowerCase(),
    segments: [...(path ?? '').split('/'), ...fragmentPath.split('/')].filter(Boolean),
    fragmented: fragmentPath !== '',
    query: parseQuery(search ?? ''),
    hash: fragmentPath === '' ? (fragment ?? '') : '',
  }
}

/**
 * `?a=b&c=d` as a record, hand-parsed for the same reason `splitUrl` is:
 * `URLSearchParams` is the DOM's. The first spelling of a repeated key wins,
 * and a value that will not decode is kept as written rather than dropped —
 * a placeholder reader then refuses it, which is the honest answer for a
 * link something mangled.
 */
function parseQuery(search: string): Record<string, string> {
  const out: Record<string, string> = {}
  for (const pair of search.split('&')) {
    if (!pair) continue
    const eq = pair.indexOf('=')
    const rawKey = eq === -1 ? pair : pair.slice(0, eq)
    const rawValue = eq === -1 ? '' : pair.slice(eq + 1)
    let key = rawKey
    let value = rawValue
    try {
      key = decodeURIComponent(rawKey)
      value = decodeURIComponent(rawValue)
    } catch {
      // Kept as written; see above.
    }
    if (!Object.hasOwn(out, key)) out[key] = value
  }
  return out
}

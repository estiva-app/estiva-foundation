/**
 * Object URLs — RFC 0.5 §7, accepted 2026-09-03.
 *
 *     https://<app>.estiva.app/<type>s              a directory of that kind
 *     https://<app>.estiva.app/<type>/<slug>-<d>    one object
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
  identifier: string
  /** Present only when the matched pattern named one. */
  kind?: number
}

/**
 * Match a pasted URL against one app's declared shapes.
 *
 * **The host and the `<type>` segment are significant; the slug is not.** That
 * is §7.2 as amended, and it is the whole of the security story here: a
 * consumer that matched on the trailing uuid alone would resolve any URL from
 * anywhere as that app's object.
 *
 * Returns null for a URL no pattern claims, which is the honest outcome — §7.5
 * says such a URL renders as a plain link, because it is one.
 */
export function matchObjectUrl(url: string, patterns: UrlPattern[]): MatchedObjectUrl | null {
  const target = splitUrl(url)
  if (!target) return null

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

    const identifier = identifierFromRef(target.segments[target.segments.length - 1] ?? '')
    if (!identifier) continue
    return { identifier, ...(kind === undefined ? {} : { kind }) }
  }
  return null
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
function splitUrl(raw: string): { scheme: string; host: string; segments: string[]; fragmented: boolean } | null {
  const match = /^(https?):\/\/([^/?#]+)([^?#]*)(?:\?[^#]*)?(?:#(.*))?$/i.exec(raw.trim())
  if (!match) return null
  const [, scheme, host, path, fragment] = match

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
  }
}

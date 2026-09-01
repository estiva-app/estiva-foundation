/**
 * Rendering another app's objects from its published manifest — the pure part.
 *
 * Split from `foreign.ts` so it can be exercised against a live relay without a
 * Convex deployment: everything here takes a `query` function rather than
 * reaching for one. `foreign.ts` supplies the authenticated bridge; a test
 * supplies its own.
 *
 * **Nothing in this file knows what Linear-lite is.** No kind number, no field
 * name, no status vocabulary is hardcoded — every one comes off the NIP-89
 * manifest at runtime. If that stops being true the demo stops proving
 * anything: it becomes an integration written against one app, which is the
 * thing the whole exercise argues against.
 */
import { decodeNevent, encodeNaddr, encodeNevent, pointerToAddress, referenceToPointer, type AddressPointer, type EventPointer } from '@estiva-app/protocol'
import { parseProfile, type Profile, type SignedEvent } from '@estiva-app/protocol'

/** Query the relay. Returns matching events; shape mirrors the HTTP bridge. */
export type QueryFn = (filters: Record<string, unknown>[]) => Promise<SignedEvent[]>

/** An unsigned Nostr event, ready for `sign.ts`. */
export interface UnsignedActionEvent {
  pubkey: string
  created_at: number
  kind: number
  tags: string[][]
  content: string
}

/**
 * The people named on another app's objects (FEE-1).
 *
 * A manifest says a slot holds a pubkey; it never says whose. Peek showed the
 * first eight characters of the key, which is not a person — it is the thing a
 * person is behind. The name and face come from kind:0, the same place the
 * message list already gets them, so the same person reads the same way in both.
 *
 * Keyed by pubkey. A key that resolves to nothing is simply absent, and the
 * renderer decides what an unknown person looks like.
 */
export type People = Record<string, Profile>

/**
 * Looking people up, as a seam rather than a direct call.
 *
 * The browser puts a session cache in front of this: a topic with ten reference
 * widgets resolves ten times, and it is the same handful of people every time.
 * Tests and Storybook pass a fixture instead and never touch a relay.
 */
export type PeopleFn = (pubkeys: string[]) => Promise<People>

/** The default: one kind:0 query, straight to the relay. */
/**
 * How long a *name* may be believed.
 *
 * Names change rarely, so this is generous. See {@link PROFILE_MISS_TTL_MS} for
 * the half that matters.
 */
export const PROFILE_HIT_TTL_MS = 10 * 60_000

/**
 * How long an *absent* profile may be believed, and it is deliberately short.
 *
 * A miss is somebody who has not finished setting up their identity — which is
 * to say, precisely the person whose name is about to arrive. Cached as long as
 * a hit, they render as `nostr:<8 chars>` until a full reload, and a consumer
 * that re-reads on a timer looks like its refresh is broken. That is PEE-3,
 * found in Peek once its panels started polling.
 */
export const PROFILE_MISS_TTL_MS = 60_000

export interface PeopleCacheOptions {
  hitTtlMs?: number
  missTtlMs?: number
  /** Injectable clock. A test needs to move time, not wait ten minutes. */
  now?: () => number
}

/**
 * A profile store that outlives any one lookup.
 *
 * The store and the lookup have different lifetimes, which is why this is not
 * simply a wrapped {@link PeopleFn}: a consumer builds its query per call —
 * Peek's carries the viewer's token — while the profiles it finds are public
 * and worth keeping across all of them. `through` takes the lookup of the
 * moment and answers from one store.
 *
 * **Caller-owned**, like {@link createProjectionCache}. Peek's original lived in
 * a module-level `Map`, which worked but meant every test needed a reset hook
 * to undo the previous one.
 */
export interface PeopleCache {
  /** Wrap a lookup so it batches and expires against this store. */
  through(fromRelay: PeopleFn): PeopleFn
  /** The common case: {@link peopleViaRelay}, cached. */
  viaRelay(query: QueryFn): PeopleFn
  /** Forget everything. What a sign-out should call. */
  clear(): void
}

/** A profile with nothing in it is a miss — the relay had no `kind:0`. */
const isMiss = (person: People[string]) => Object.keys(person).length === 0

export function createPeopleCache(options: PeopleCacheOptions = {}): PeopleCache {
  const hitTtlMs = options.hitTtlMs ?? PROFILE_HIT_TTL_MS
  const missTtlMs = options.missTtlMs ?? PROFILE_MISS_TTL_MS
  const now = options.now ?? Date.now
  const known = new Map<string, { person: People[string]; expiresAt: number }>()

  const through = (fromRelay: PeopleFn): PeopleFn => async (pubkeys) => {
    const at = now()
    /*
      One lookup for the whole unknown set, never one per key. A screen with ten
      reference widgets asks about the same handful of people, and asking
      separately would turn one request into N — which is the cost this exists
      to avoid, not a detail of it.
    */
    const unknown = pubkeys.filter((key) => {
      const cached = known.get(key)
      return cached === undefined || cached.expiresAt <= at
    })
    if (unknown.length > 0) {
      const found = await fromRelay(unknown)
      for (const key of unknown) {
        const person = found[key] ?? {}
        known.set(key, { person, expiresAt: at + (isMiss(person) ? missTtlMs : hitTtlMs) })
      }
    }
    return Object.fromEntries(pubkeys.map((key) => [key, known.get(key)?.person ?? {}]))
  }

  return {
    through,
    viaRelay: (query) => through(peopleViaRelay(query)),
    clear: () => known.clear(),
  }
}

export function peopleViaRelay(query: QueryFn): PeopleFn {
  return async (pubkeys) => {
    if (pubkeys.length === 0) return {}
    const events = await query([
      { kinds: [KIND_PROFILE], authors: pubkeys, limit: pubkeys.length },
    ])
    const people: People = {}
    // Oldest first, so a newer profile overwrites an older one. kind:0 is
    // replaceable and the relay should hold one per author, but ordering the
    // fold is cheaper than trusting that.
    for (const event of [...events].sort(byOrder)) {
      people[event.pubkey] = parseProfile(event)
    }
    return people
  }
}

/**
 * Every pubkey an object would put on screen.
 *
 * Slots and meta carry them as values; a `pubkey` action carries the current
 * holder of the field it sets, which in the sidebar is the *only* place the
 * project's lead appears. Missing that one is what left a face-shaped button
 * showing eight hex characters.
 */
function pubkeysIn(object: ForeignObject): string[] {
  const keys: string[] = []
  for (const slot of [...Object.values(object.slots), ...object.meta]) {
    if (slot.isPubkey && slot.value) keys.push(slot.value)
  }
  for (const action of object.actions) {
    if (action.control === 'pubkey' && action.current) keys.push(action.current)
  }
  return keys
}

/** kind:0, the profile every other app publishes too. */
const KIND_PROFILE = 0

/** NIP-89 kinds. These two are protocol, not app-specific. */
const KIND_HANDLER_RECOMMENDATION = 31989
const KIND_HANDLER_INFORMATION = 31990
/**
 * Default kind for comments on a foreign object.
 *
 * NIP-22, and no app owns it — but the owning app gets to say otherwise. An app
 * whose objects live in a Folder may well treat a comment as a message in that
 * container instead, which is a better answer when the container is also a Peek
 * topic: the comment and the topic conversation become the same event rather
 * than two records nobody reconciles.
 *
 * So this is the fallback, and `commentKindsOf` reads the real one off the
 * manifest's own `comment` action. Hardcoding it here would quietly stop
 * finding comments the moment an app said something different.
 */
const KIND_COMMENT = 1111

/**
 * Every kind an app's comments might be under — what it publishes **now**, plus
 * any it has published before.
 *
 * `emits.kind` is a single number, and for a while that was enough. It stops
 * being enough the moment an app *changes* the kind it emits, because the old
 * events do not move: a `kind:9` message is not replaceable at all, so a comment
 * written under the old kind stays under it permanently. Reading only the
 * declared kind would show an object's newest comments and silently drop every
 * one written before the change — no error, nothing empty, just a thread that
 * begins in the middle.
 *
 * So the owning app may also declare `emits.alsoRead`, which is the kinds it
 * used to publish. That is the only place the knowledge actually lives; the
 * alternative is Peek hardcoding one app's history, which is exactly what the
 * note on `KIND_COMMENT` above says not to do.
 *
 * Absent `alsoRead` this returns a single kind, so a manifest written before
 * the field existed behaves exactly as it did.
 */
export function commentKindsOf(manifest: Manifest): number[] {
  const declared = manifest.actions?.find((action) => action.id === 'comment')
  const current = declared?.emits?.kind ?? KIND_COMMENT
  const superseded = declared?.emits?.alsoRead ?? []
  return [...new Set([current, ...superseded])]
}

/** How the owning app says its records should be read. */
interface RecordsRule {
  changeKind: number
  targetTag: string
  fieldTag: string
  valueTag: string
  order: string[]
  rule: string
  /**
   * A folded field whose value means "do not show this object".
   *
   * Archiving is a field, not a deletion, so an archived record still comes
   * back from every query and renders perfectly well. Without this a consumer
   * cannot tell it apart from live work — which is how a topic whose Folder
   * held three archived projects ended up showing one of them.
   *
   * Peek honours the rule without knowing what the word means: the owner says
   * which field and which value, and this stays out of it.
   */
  hiddenWhen?: { field: string; equals: string }
}

interface SlotSpec {
  /**
   * A tag on the root event, or a list of them meaning **first that resolves**.
   *
   * A list exists for the same reason `emits.alsoRead` does: an app that
   * renames a tag cannot rename it on the events it already published, so its
   * history spans both spellings permanently. Ship moving a project's title
   * from `title` to `name` is the case in hand — without a fallback, either
   * every record written before the rename renders blank or every one written
   * after does.
   *
   * Not to be confused with a `SlotSpec[]`, which the caller treats as "render
   * all of these as meta". This is one slot with several places to look.
   */
  tag?: string | string[]
  field?: string
  fold?: string
  map?: string
  as?: string
  label?: string
  truncate?: number
  default?: string
  /**
   * **Child objects, found by the tag on the child that names this one.**
   *
   * The `list` slot (RFC 0.4 §13.3, PRO-2). The only slot source that does not
   * read the root event: every other field here answers "what does this event
   * say?", and this one answers "what points at it?".
   *
   * `limit` is the producer saying how many are worth fetching. **Recursion
   * depth is deliberately not here** — a child rendered through its own
   * projection may declare a `list` too, and the app at risk of the render loop
   * is the one drawing it, so the budget is the consumer's (`MAX_LIST_DEPTH`).
   * §13.4's honour-system rule cuts that way: a producer that could set the
   * consumer's recursion budget could hang it.
   */
  children?: {
    kind: number
    via: string
    limit?: number
    /**
     * What the child's `via` tag holds — added by PRO-6.
     *
     * `address` (the default, and Ship's case) means the tag carries the
     * parent's full `kind:pubkey:d`. `identifier` means it carries only the
     * parent's `d`.
     *
     * Found by declaring a projection for a Peek Topic. A message names its
     * channel with `h`, and `h` holds the **bare channel uuid** — which is the
     * topic's `d`, not its address. Nothing in NIP-29 is going to change that,
     * so a `list` slot that could only compare addresses could not express the
     * one relationship Peek has. Defaulting to `address` keeps every manifest
     * written before this reading exactly as it did.
     */
    match?: 'address' | 'identifier'
  }
}

/** An action the owning app says other apps may perform. */
export interface ManifestAction {
  id: string
  label: string
  /** Kind(s) this applies to, as strings. */
  appliesTo: string | string[]
  emits: {
    kind: number
    field?: string
    scope?: string
    /**
     * Set by an action that creates a whole new object under this one: the tag
     * the child carries, and what it points at. `toAddressOf: "self"` means the
     * child names the object the action was invoked on.
     *
     * Peek reads these two to learn a **containment relation** — "kind X holds
     * kind Y" — without being told which app or which kinds are involved. It is
     * the only thing in the manifest that says so, which is what lets the
     * sidebar start from a Folder and find a project with issues in it.
     */
    setTag?: string
    toAddressOf?: string
    /**
     * Kinds this action *used* to emit, which consumers must still read.
     *
     * Only ever additive to a read, never to a write: `kind` is what gets
     * published, this is what also gets fetched. See `commentKindsOf`.
     */
    alsoRead?: number[]
  }
  input?: { type: string; enum?: string }
}

/**
 * An action resolved into something a renderer can draw without re-reading the
 * manifest.
 *
 * The interpretation happens here rather than in the component on purpose: the
 * widget should not have to know that `input.enum` names a vocabulary, or that
 * `as: "pubkey"` means "a person". Those are manifest semantics, and keeping
 * them on this side is what lets the React component stay a dumb renderer that
 * would work for any app.
 */
export interface ResolvedAction {
  id: string
  label: string
  control: 'select' | 'pubkey' | 'text'
  /** For `select`: the declared vocabulary, already looked up. */
  options?: { value: string; label: string; colour?: string }[]
  /** The value this field holds right now, so a control can show it. */
  current?: string
  field?: string
}

interface Manifest {
  name?: string
  about?: string
  actions?: ManifestAction[]
  records?: RecordsRule
  projections?: Record<string, { widget: string | string[]; slots: Record<string, SlotSpec | SlotSpec[]> }>
  vocabularies?: Record<string, { value: string; label: string; colour: string; stage?: string }[]>
}

/** Actions declared for this kind, resolved against the vocabularies. */
function resolveActions(
  manifest: Manifest,
  kind: number,
  folded: Record<string, { value: string }>,
): ResolvedAction[] {
  const applies = (action: ManifestAction) =>
    (Array.isArray(action.appliesTo) ? action.appliesTo : [action.appliesTo]).includes(String(kind))

  const out: ResolvedAction[] = []
  for (const action of manifest.actions ?? []) {
    if (!applies(action)) continue
    // Only field-setting changes and comments are renderable today. An action
    // that creates a whole new object (`add-issue`) needs a form and a parent,
    // so it is skipped rather than drawn as a control that cannot work.
    const isChange = !!action.emits.field
    const isComment = action.emits.scope === 'address'
    if (!isChange && !isComment) continue

    const vocab = action.input?.enum ? manifest.vocabularies?.[action.input.enum] : undefined
    out.push({
      id: action.id,
      label: action.label,
      control: vocab ? 'select' : action.input?.type === 'pubkey' ? 'pubkey' : 'text',
      options: vocab?.map((v) => ({ value: v.value, label: v.label, colour: v.colour })),
      current: action.emits.field ? folded[action.emits.field]?.value : undefined,
      field: action.emits.field,
    })
  }
  return out
}

const tagValue = (e: SignedEvent, name: string) => e.tags.find((t) => t[0] === name)?.[1]

/**
 * Does the event carry this tag with this value — on **any** of them?
 *
 * `tagValue` reads the first tag with a given name, which is the wrong test for
 * deciding whether an event would have matched a filter: a relay's `#a` matches
 * if *any* `a` tag equals the wanted value, and an event may legitimately carry
 * several. Used where a filter's own predicate is re-applied to a merged
 * response (SHI-13), so that "did this come back because of that filter?" is
 * answered the way the relay answered it.
 */
const hasTagValue = (e: SignedEvent, name: string, value: string) =>
  e.tags.some((t) => t[0] === name && t[1] === value)

/** A manifest event's `content`, or null when it is not parseable JSON. */
function parseManifest(event: SignedEvent): Manifest | null {
  try {
    return JSON.parse(event.content) as Manifest
  } catch {
    return null
  }
}

const asArray = (value: string | string[]) => (Array.isArray(value) ? value : [value])

/**
 * Which manifest wins when several claim the same kind.
 *
 * A `#k` query is NIP-89's discovery mechanism and it returns every handler for
 * a kind, ranked by nothing. So the object's **author's** kind:31989
 * recommendation is consulted first: the person who created the object is the
 * one entitled to say which app renders it, and that is a trust anchor Peek
 * already has rather than a value someone has to paste into a config file.
 *
 * The `#k` fallback exists so an object whose author never published a
 * recommendation still renders, rather than failing closed on a missing
 * preference. When it fires, `viaRecommendation` is false and the caller can
 * say so in the UI — "we guessed" and "we were told" should not look identical.
 */
/**
 * NIP-89's `web` tag: how to open one of these objects in the app that owns it.
 *
 * `["web", "https://host/#/o/<bech32>", "naddr"]` — the consumer substitutes the
 * entity it is holding. Read off the *event* rather than the manifest content,
 * because that is where NIP-89 puts it.
 *
 * Returns undefined when no usable template was published, which is an ordinary
 * state rather than an error: an app may render objects it has nowhere to open.
 */
function webTemplate(event: SignedEvent, entity: string): string | undefined {
  for (const tag of event.tags) {
    if (tag[0] !== 'web' || !tag[1]) continue
    // The third element names the entity type; NIP-89 permits omitting it, in
    // which case the template applies to whatever we are holding.
    if (tag[2] && tag[2] !== entity) continue
    if (!tag[1].includes('<bech32>')) continue
    return tag[1]
  }
  return undefined
}

/** What {@link resolveManifest} answers with. */
export interface ResolvedManifest {
  manifest: Manifest
  address: string
  viaRecommendation: boolean
  /** NIP-89 `web` template, `<bech32>` not yet substituted. */
  webTemplate?: string
}

/**
 * A memo for the half of a resolve that does not change between refreshes.
 *
 * Resolving one reference costs four round trips, and **two of them are NIP-89
 * discovery** — the author's `kind:31989` recommendation, then the `kind:31990`
 * manifest itself. A consumer that re-resolves on a timer pays for both every
 * time, and they answer the same thing until an app republishes its manifest.
 * Measured on Ship, where a reference widget re-resolves on the poll: 4
 * requests per reference per tick, identical on the second resolve, against a
 * relay that meters reads at 300 a minute.
 *
 * **Owned by the caller, not this module.** A module-level cache would be
 * invisible global state shared by every consumer in the process, impossible to
 * scope to a screen and awkward to reset in a test. A caller that wants no
 * caching passes nothing and gets exactly the old behaviour.
 *
 * Deliberately only the manifest. The object, its changes, its comments and its
 * children are the parts a refresh exists to notice, and caching those is how
 * a live widget becomes a screenshot.
 */
export interface ProjectionCache {
  /** Forget everything. Worth calling after publishing a manifest. */
  clear(): void
  /** @internal */
  lookup(key: string, now: number): { value: ResolvedManifest | null } | undefined
  /** @internal */
  remember(key: string, value: ResolvedManifest | null, now: number): void
}

/**
 * How long a manifest may be believed without asking again.
 *
 * Five minutes is a compromise with one real cost: republish a manifest and
 * consumers keep drawing the old projection for up to that long. That is
 * recoverable and self-correcting, where the alternative — asking twice per
 * reference per tick, for ever — is neither.
 */
export const MANIFEST_TTL_MS = 5 * 60_000

export function createProjectionCache(ttlMs: number = MANIFEST_TTL_MS): ProjectionCache {
  const entries = new Map<string, { at: number; value: ResolvedManifest | null }>()
  return {
    clear: () => entries.clear(),
    lookup(key, now) {
      const found = entries.get(key)
      if (!found) return undefined
      // `>=`, not `>`: a TTL of 0 must mean "never believe it", and an entry
      // exactly at the boundary has expired rather than being on its last tick.
      if (now - found.at >= ttlMs) {
        entries.delete(key)
        return undefined
      }
      return { value: found.value }
    },
    remember(key, value, now) {
      entries.set(key, { at: now, value })
    },
  }
}

/**
 * A negative answer is cached too.
 *
 * "No app claims this kind" costs the same two round trips as a hit and is just
 * as stable. Caching only successes would leave the expensive case — a
 * reference nothing can draw — paying full price on every tick for ever.
 */
export async function resolveManifest(
  pointer: AddressPointer,
  query: QueryFn,
  cache?: ProjectionCache,
): Promise<ResolvedManifest | null> {
  const key = `${pointer.kind}:${pointer.pubkey}`
  const now = Date.now()
  const memo = cache?.lookup(key, now)
  if (memo) return memo.value
  const answer = await resolveManifestUncached(pointer, query)
  cache?.remember(key, answer, now)
  return answer
}

async function resolveManifestUncached(
  pointer: AddressPointer,
  query: QueryFn,
): Promise<ResolvedManifest | null> {
  const parse = parseManifest
  const addressOf = (event: SignedEvent) =>
    `${event.kind}:${event.pubkey}:${tagValue(event, 'd') ?? ''}`

  const recommended = await query(
    [
      {
        kinds: [KIND_HANDLER_RECOMMENDATION],
        authors: [pointer.pubkey],
        '#d': [String(pointer.kind)],
        limit: 1,
      },
    ],
  )
  const manifestAddr = recommended[0]?.tags.find((t) => t[0] === 'a')?.[1]
  if (manifestAddr) {
    const [kind, pubkey, ...rest] = manifestAddr.split(':')
    const found = await query([
      { kinds: [Number(kind)], authors: [pubkey], '#d': [rest.join(':')], limit: 1 },
    ])
    const manifest = found[0] ? parse(found[0]) : null
    if (manifest) {
      return {
        manifest,
        address: manifestAddr,
        viaRecommendation: true,
        webTemplate: webTemplate(found[0], 'naddr'),
      }
    }
  }

  const claimed = await query([
    { kinds: [KIND_HANDLER_INFORMATION], '#k': [String(pointer.kind)], limit: 20 },
  ])
  // Newest wins among unrecommended candidates. Arbitrary, and honest about it:
  // there is no principled ranking without a recommendation, which is exactly
  // why the recommendation exists.
  const newest = [...claimed].sort((a, b) => b.created_at - a.created_at)
  for (const candidate of newest) {
    const manifest = parse(candidate)
    if (manifest?.projections?.[String(pointer.kind)]) {
      return {
        manifest,
        address: addressOf(candidate),
        viaRecommendation: false,
        webTemplate: webTemplate(candidate, 'naddr'),
      }
    }
  }
  return null
}

/**
 * Ordering key for an append-only event, per the manifest's `records.order`.
 *
 * The manifest declares `["ts", "created_at", "id"]` and, crucially, the
 * condition under which `ts` may be believed: only when it agrees with
 * `created_at` to the second. `created_at` has one-second resolution and the
 * relay validates it, so a `ts` pinned inside that second inherits that
 * validation and can only refine ordering *within* it.
 *
 * Peek enforces that bound itself rather than trusting the writer. Under the
 * honour-system model nothing validates these events (RFC_UPDATES.md §3), so a
 * buggy or pushy client claiming a far-future `ts` would otherwise win every
 * fold forever — in Peek's rendering as much as in the owning app's.
 */
function orderingMs(event: SignedEvent): number {
  const raw = Number.parseInt(tagValue(event, 'ts') ?? '', 10)
  if (Number.isFinite(raw) && Math.abs(Math.floor(raw / 1000) - event.created_at) <= 1) return raw
  return event.created_at * 1000
}

/** Total order, oldest first. Ties break on the lower event id (NIP-01's rule). */
function byOrder(a: SignedEvent, b: SignedEvent): number {
  const [at, bt] = [orderingMs(a), orderingMs(b)]
  if (at !== bt) return at - bt
  return a.id < b.id ? -1 : a.id > b.id ? 1 : 0
}

/** Replay change events into current field values. Last write wins per field. */
/**
 * The fold rule a manifest declares, or one that folds nothing — PRO-6.
 *
 * `records` is optional. An app with no change events needs no rule for
 * turning them into current truth, and Peek is that app: a topic's name is a
 * tag the relay wrote and a message is immutable.
 *
 * Both resolvers used to require it and return null for the whole projection,
 * so an app that declared none rendered as *nothing* — which §13.3 spends
 * several paragraphs establishing is the worst available outcome, because a
 * blank card reads as "that app is broken". It was never caught because Ship
 * is the only app that had ever published a manifest, and Ship folds. Nothing
 * in RFC 0.4 §13.1 makes `records` mandatory.
 *
 * The substitute rule below is only ever used to *fold*, never to query, and
 * that distinction is load-bearing. The first attempt used `changeKind: -1` as
 * a sentinel and let the queries run: the fake relay in the tests accepted it,
 * and production refused the entire filter with `invalid type: integer -1,
 * expected a 16-bit unsigned number`. A kind is `u16` on the wire, so there is
 * no out-of-band value to reach for — the query has to be skipped instead of
 * being made unmatchable. Callers therefore branch on `manifest.records` for
 * the filters and use this only for the fold, which runs over an empty array.
 */
function foldRuleOf(manifest: Manifest): RecordsRule {
  return (
    manifest.records ?? {
      // Never sent to a relay. See above.
      changeKind: 0,
      targetTag: 'a',
      fieldTag: 'field',
      valueTag: 'value',
      order: ['created_at', 'id'],
      rule: 'last-write-wins-per-field',
    }
  )
}

function foldChanges(changes: SignedEvent[], rule: RecordsRule) {
  const fields: Record<string, { value: string; by: string; at: number }> = {}
  for (const change of [...changes].sort(byOrder)) {
    const field = tagValue(change, rule.fieldTag)
    const value = tagValue(change, rule.valueTag)
    if (!field || value === undefined) continue // a partial change sets nothing
    fields[field] = { value, by: change.pubkey, at: change.created_at }
  }
  return fields
}

function truncate(text: string, limit?: number) {
  if (!limit || text.length <= limit) return text
  return `${text.slice(0, limit).trimEnd()}…`
}

/**
 * Which layout to draw, from a declared type or an ordered chain of them.
 *
 * RFC 0.4 §13.3. A widget is a layout *hint* rather than a semantic, so an
 * unknown one can degrade honestly: `["message", "card"]` means *render me as a
 * message if you know it, else as a card*, and a chain must terminate in a type
 * the spec closes.
 *
 * **It lives here rather than in each consumer** because two implementations
 * would disagree the first time a chain had three entries, and the whole point
 * of the chain is that producers and consumers upgrade at different times. The
 * consumer supplies what it implements; the runtime does the walking.
 *
 * `fallback` is what to draw when the chain runs out — never "nothing". §13.3's
 * argument is that a blank object is indistinguishable from one the reader may
 * not be allowed to see, and reports "that app is broken" about an app doing
 * exactly what it was told.
 */
/**
 * The widget types RFC 0.4 §13.3 closes. A chain MUST end in one of these.
 *
 * Exported because both halves need the same list and they must not drift: a
 * producer checks its chain terminates here, a consumer's fallback is drawn
 * from here. Two copies would disagree the first time the set grew, and the
 * disagreement would show up as an object rendering blank in one app only.
 */
export const CLOSED_WIDGETS = ['card', 'row', 'table', 'stat'] as const

/**
 * Why a widget declaration is not publishable, or null when it is — PRO-3.
 *
 * **The producer half of the fallback chain.** `pickWidget` below makes a
 * consumer safe against a chain it does not fully understand; this stops the
 * unrenderable chain being published in the first place. Both are needed and
 * they fail differently: without the consumer half an unknown widget renders
 * blank, and without this one a *conformant* consumer renders blank through no
 * fault of its own, having done exactly what it was told.
 *
 * A chain that does not terminate in a closed type is the PEE-10 failure with
 * a longer fuse — every consumer that has not heard of `profile` walks
 * `["profile"]` to the end and has nothing left to draw.
 *
 * Returns a sentence rather than a boolean because this is read by a person
 * publishing a manifest, and "invalid widget" tells them nothing about which
 * one or what to do.
 */
export function widgetChainProblem(declared: unknown): string | null {
  if (typeof declared === 'string') {
    return (CLOSED_WIDGETS as readonly string[]).includes(declared)
      ? null
      : `"${declared}" is not one of ${CLOSED_WIDGETS.join(', ')}. A widget outside the closed set must be declared as a chain ending in one of them — ["${declared}", "card"].`
  }
  if (!Array.isArray(declared) || declared.length === 0) {
    return 'a widget must be a type or a non-empty ordered chain of them.'
  }
  if (declared.some((entry) => typeof entry !== 'string' || entry === '')) {
    return 'every entry in a widget chain must be a non-empty string.'
  }
  const last = declared[declared.length - 1]
  if (!(CLOSED_WIDGETS as readonly string[]).includes(last)) {
    return `["${declared.join('", "')}"] ends in "${last}", which no consumer is required to implement. A chain must end in one of ${CLOSED_WIDGETS.join(', ')} so there is always something left to draw.`
  }
  return null
}

export function pickWidget<T extends string>(
  declared: string | string[],
  implemented: readonly T[],
  fallback: T,
): T {
  for (const candidate of Array.isArray(declared) ? declared : [declared]) {
    if ((implemented as readonly string[]).includes(candidate)) return candidate as T
  }
  return fallback
}

/** A slot, resolved to something a renderer can put on screen. */
export interface ResolvedSlot {
  label?: string
  value: string
  /** Set when the value came from a vocabulary — the consumer picks the colour. */
  colour?: string
  /** True when the value is a pubkey and should be shown as a person. */
  isPubkey?: boolean
  /**
   * The underlying field this slot reads, when it has a name.
   *
   * Carried so a renderer can tell that a slot and an action are two views of
   * *one* value — a status label beside a status picker is the same fact twice
   * (PEEK-18). Matching on the field is what makes that check work for any app:
   * the slot key (`status`) and the action's label ("Change status") are both
   * free-form, but a `ResolvedAction.field` and this always name the same thing
   * because the manifest wrote them both.
   *
   * Undefined for a slot with no named source — `{field: "content"}` reads the
   * event body, which no action can set.
   */
  field?: string
}

/**
 * A slot's value before any vocabulary mapping or truncation.
 *
 * Split out because "what does this object's status *say*" and "what should a
 * reader see" are different questions: the display value is a vocabulary label
 * ("In Progress"), and anything deciding on the value — the active-issue filter
 * below — has to compare the underlying one (`in_progress`).
 */
/** The first of these tags the event actually carries. */
function firstTag(root: SignedEvent, tag: string | string[] | undefined): string | undefined {
  if (!tag) return undefined
  for (const name of Array.isArray(tag) ? tag : [tag]) {
    const value = tagValue(root, name)
    if (value !== undefined && value !== '') return value
  }
  return undefined
}

function rawSlotValue(
  spec: SlotSpec,
  root: SignedEvent,
  folded: Record<string, { value: string }>,
): string | undefined {
  // `fold` first, and a spec may carry both: a field that starts as a tag on
  // the root event and is then overridden by changes (a project's lead is the
  // case in hand). Reading the tag first would render the value the object was
  // created with forever — which is exactly what someone sees right after
  // reassigning it from here.
  if (spec.fold) {
    return folded[spec.fold]?.value ?? firstTag(root, spec.tag) ?? spec.default
  }
  if (spec.tag) return firstTag(root, spec.tag)
  if (spec.field === 'content') return root.content
  /*
    `pubkey` — the event's author — added by PRO-6.

    Found by trying to declare a projection for a Peek Message. §13.3 makes
    `title` the one required slot, and a `kind:9` has no title: it has an
    author, a body and a time. The body cannot be the title, because message
    content is structured for 41% of production events and truncating structure
    is exactly what PRO-8 removed from Ship's manifest. Which leaves the author,
    and until now no slot source could name it.

    It is a genuine top-level event field, so it belongs in `field` rather than
    in a new source. Paired with `as: "pubkey"` it renders as a person, which is
    what a message wants as its title everywhere it appears.
  */
  if (spec.field === 'pubkey') return root.pubkey
  return undefined
}

function resolveSlot(
  spec: SlotSpec,
  root: SignedEvent,
  folded: Record<string, { value: string }>,
  manifest: Manifest,
): ResolvedSlot | null {
  const raw = rawSlotValue(spec, root, folded)

  if (raw === undefined || raw === '') return null

  let value = truncate(raw, spec.truncate)
  let colour: string | undefined
  if (spec.map) {
    const entry = manifest.vocabularies?.[spec.map]?.find((v) => v.value === raw)
    // A value outside the declared vocabulary is shown as-is rather than
    // dropped. Another app may have written it, and silently rendering nothing
    // would hide exactly the corruption the honour system permits.
    value = entry?.label ?? raw
    colour = entry?.colour ?? 'muted'
  }
  return {
    label: spec.label,
    value,
    colour,
    isPubkey: spec.as === 'pubkey',
    field: spec.fold ?? (Array.isArray(spec.tag) ? spec.tag[0] : spec.tag),
  }
}

/**
 * Every slot a projection declares, resolved.
 *
 * Single slots are named (`title`, `subtitle`, `status`); array specs collect
 * into `meta`. Shared so the sidebar and the inline widget resolve a projection
 * identically — two loops would drift the first time a slot type is added.
 */
function resolveSlots(
  projection: { slots: Record<string, SlotSpec | SlotSpec[]> },
  root: SignedEvent,
  folded: Record<string, { value: string }>,
  manifest: Manifest,
): { slots: Record<string, ResolvedSlot>; meta: ResolvedSlot[] } {
  const slots: Record<string, ResolvedSlot> = {}
  const meta: ResolvedSlot[] = []
  for (const [name, spec] of Object.entries(projection.slots)) {
    if (Array.isArray(spec)) {
      for (const one of spec) {
        const value = resolveSlot(one, root, folded, manifest)
        if (value) meta.push(value)
      }
    } else {
      const value = resolveSlot(spec, root, folded, manifest)
      if (value) slots[name] = value
    }
  }
  return { slots, meta }
}

/** Everything the frontend needs to draw the widget. */
export interface ForeignObject {
  /**
   * A stable unique handle for this object, whatever kind of thing it is.
   *
   * **Added by PRO-7, and it exists because not every object has an address.**
   * A replaceable record is identified by `kind:pubkey:d`; a regular event —
   * Peek's `kind:9` message is the case in hand — has no `d` at all and is
   * identified only by its event id. Before this, `address` was required and
   * doubled as the React key, the error-map key and the `data-` attribute, so
   * a non-addressable object could not be represented at all.
   *
   * Use this for identity. Use `naddr` only where an *address* is genuinely
   * required, which in practice means acting on an object.
   */
  ref: string
  /**
   * The address, `kind:pubkey:d` — **only for an addressable object.**
   *
   * Undefined for a regular event. See `ref`.
   */
  address?: string
  /**
   * The address as `naddr1…`, **only for an addressable object.**
   *
   * Carried alongside `address` because acting on an object is addressed by
   * naddr (`act.ts`), and the sidebar builds its objects rather than being
   * handed a reference somebody pasted. Without it every control in a
   * sidebar card would have to re-encode what the server already knows.
   *
   * Its absence is meaningful rather than a gap: an action emits a change
   * carrying an `a` tag, and there is nothing for that tag to point at on a
   * non-addressable object. A consumer that has no `naddr` correctly offers no
   * actions.
   */
  naddr?: string
  /** The event id — set for every object, and the only handle a regular event has. */
  eventId: string
  /**
   * Child objects from a `list` slot, each resolved through its own projection.
   *
   * Empty rather than absent when the slot is declared and nothing matched, so
   * a renderer can tell "this holds nothing" from "this holds no list".
   */
  children?: ForeignObject[]
  kind: number
  /**
   * The layout hint the owner declared — **a type or an ordered chain of them.**
   *
   * `["message", "card"]` means *render me as a message if you know it, else as
   * a card*, and a chain MUST terminate in a type RFC 0.4 §13.3 closes
   * (`card`/`row`/`table`/`stat`). A bare string is the older form and is a
   * chain of one.
   *
   * **This was typed `string` until PRO-7**, while Peek's own published manifest
   * declares `["message","card"]` — so the type said one thing and the wire said
   * another, and a consumer writing `widget === 'card'` compared a string to an
   * array and silently drew nothing. Found by Ship, the second consumer, the
   * first time anything typechecked a renderer against a real chain. That is
   * the answer to PRO-1's "what did the second consumer force to change".
   */
  widget: string | string[]
  appName?: string
  /** Named single slots: title, subtitle, status. */
  slots: Record<string, ResolvedSlot>
  /** Repeating slots, e.g. `meta`. */
  meta: ResolvedSlot[]
  comments: { id: string; author: string; body: string; createdAt: number }[]
  /**
   * The Folder this object lives in, from the root event's `h` tag.
   *
   * Needed to *write*: a change event carries the same `h`, and without it the
   * relay rejects the write outright. Reading it off the object rather than
   * asking the user is the difference between an action that works and a form
   * with a "Folder id" box in it.
   */
  folder?: string
  /**
   * Where to open this object in the app that owns it, from NIP-89's `web` tag.
   *
   * The return leg of the roundtrip. Without it a reference is a read-only
   * snapshot: Peek can render a Linear-lite issue and change its status, and
   * getting back to the issue itself means alt-tabbing and hunting for a row.
   *
   * Absent when the owning app published no template — the widget simply does
   * not offer the link, rather than guessing a URL.
   */
  openUrl?: string
  /** What the owning app says we may do to this object. */
  actions: ResolvedAction[]
  /**
   * Names and faces for every pubkey this object shows (FEE-1).
   *
   * Carried on the object rather than looked up by the renderer so a widget is
   * still a pure render of what it was handed — the same property that lets
   * Storybook draw a real person from a fixture. Empty when nothing published a
   * profile, which the renderer treats as "someone we cannot name" rather than
   * falling back to the key.
   */
  people?: People
  /** False when no author recommendation existed and a handler was guessed. */
  viaRecommendation: boolean
  /**
   * Set when the manifest resolved but the object itself did not.
   *
   * Almost always a permission problem rather than a missing object, and worth
   * distinguishing because the relay makes them look identical. Objects and
   * change events are channel-scoped, so a reader who is not a member of the
   * Folder gets zero rows — no error, just silence. The manifest and the
   * recommendation are global kinds and resolve fine without membership, so the
   * failure lands late and presents as a broken reference. Telling the user
   * "you may not have access to this Folder" is a far better guess than
   * rendering nothing.
   */
  unreachable?: boolean
}


/**
 * One resolved object, from its root event and the changes that have landed on
 * it. Shared by the inline widget and the sidebar so both draw the same shape
 * from the same rules — the difference between them is what they *fetch*, not
 * how they render.
 */
function buildObject(args: {
  root: SignedEvent
  pointer: AddressPointer
  manifest: Manifest
  projection: { widget: string | string[]; slots: Record<string, SlotSpec | SlotSpec[]> }
  folded: Record<string, { value: string }>
  viaRecommendation: boolean
  webTemplate?: string
  comments?: ForeignObject['comments']
}): ForeignObject {
  const { root, pointer, manifest, projection, folded } = args
  const naddr = encodeNaddr(pointer)
  const { slots, meta } = resolveSlots(projection, root, folded, manifest)

  /**
   * What each field holds now, however it got there.
   *
   * `resolveActions` reads the fold alone, which is right for a field that only
   * ever exists as a change — but a project's lead is seeded by a tag on the
   * root event. Without this, the assign control on a project nobody has
   * reassigned reads "Assign to me" while a lead is plainly set, and the one
   * control that is supposed to both report and set the field (PEEK-18) reports
   * nothing.
   */
  const held: Record<string, string> = {}
  for (const spec of Object.values(projection.slots).flat()) {
    // `tag` may name several spellings (see `SlotSpec`); the field this slot
    // *is* keyed on is the first, which is the one the app writes today. The
    // rest are only there to keep older records rendering.
    const field = spec.fold ?? (Array.isArray(spec.tag) ? spec.tag[0] : spec.tag)
    const raw = field && rawSlotValue(spec, root, folded)
    if (field && raw !== undefined) held[field] = raw
  }
  const objectAddress = pointerToAddress(pointer)
  return {
    // An addressable object's `ref` is its address: stable across the author
    // replacing the event, which the event id is not.
    ref: objectAddress,
    address: objectAddress,
    naddr,
    eventId: root.id,
    kind: pointer.kind,
    widget: projection.widget,
    appName: manifest.name,
    slots,
    meta,
    comments: args.comments ?? [],
    folder: tagValue(root, 'h'),
    // Substituted here rather than in the component: `<bech32>` is a NIP-89
    // detail, and the widget's job is to draw a link, not to know the spec.
    openUrl: args.webTemplate?.replace('<bech32>', naddr),
    actions: resolveActions(manifest, pointer.kind, folded).map((action) =>
      action.current === undefined && action.field
        ? { ...action, current: held[action.field] }
        : action,
    ),
    viaRecommendation: args.viaRecommendation,
  }
}

/**
 * Resolve a `nostr:naddr…` into a renderable widget.
 *
 * Returns `null` rather than throwing when the object cannot be rendered — an
 * unresolvable reference in a chat message should degrade to plain text, not
 * break the message around it.
 */
/**
 * Resolve one event by id — `nevent1…`, or a bare 64-hex id.
 *
 * The counterpart to `resolveForeignObject`, and the reason it has to exist:
 * **not every object has an address.** A `kind:9` message carries no `d`, so
 * `(kind, pubkey, d)` cannot be built for it and every resolver keyed on an
 * address is blind to it. Measured on production during PRO-6; PRO-11 is this.
 *
 * ## What it does *not* do, and why the function is short
 *
 * A regular event is immutable and has no folded state, so there is no `records`
 * rule to apply, no change events to fetch, and no "current value" that differs
 * from what is on the event. It also cannot be the target of an `a` tag, so it
 * has no comments addressed to it and **no actions** — a change names its target
 * by address, and there is nothing here to name. That absence is the model being
 * honest rather than a gap to fill later.
 *
 * ## Two round trips, and the order depends on the reference
 *
 * A manifest is found by kind. An `nevent` *may* carry its kind, and when it
 * does the manifest and the event can be fetched together. When it does not —
 * a bare id, which is what a pasted `e` tag gives you — the event has to be
 * read first to learn what kind it is. Both paths are supported because both
 * arrive in practice, and a resolver that required the richer form would refuse
 * references other clients legitimately produce.
 */
export async function resolveForeignEvent(
  reference: string,
  query: QueryFn,
  /** Defaults to asking the relay. The browser passes a cached lookup. */
  lookupPeople?: PeopleFn,
  /** See {@link ProjectionCache}. Omitting it is exactly the old behaviour. */
  cache?: ProjectionCache,
): Promise<ForeignObject | null> {
  let pointer: EventPointer
  try {
    pointer = /^[0-9a-f]{64}$/i.test(reference.replace(/^nostr:/i, ''))
      ? { id: reference.replace(/^nostr:/i, '').toLowerCase(), relays: [] }
      : decodeNevent(reference)
  } catch {
    return null
  }

  const [root] = await query([{ ids: [pointer.id], limit: 1 }])
  if (!root) {
    // Nothing to draw and nothing to say about it: unlike an addressable
    // object, there is no manifest resolved yet that could name the app or
    // offer a way in. `unreachable` needs a projection to be a useful state.
    return null
  }

  // Whoever signed it is the app's own author, which is what a `#k` lookup
  // needs when no recommendation exists. The pointer's `author` is a hint and
  // may disagree with the event; the event wins, because it is the thing.
  const resolved = await resolveManifest(
    { kind: root.kind, pubkey: root.pubkey, identifier: '', relays: pointer.relays },
    query,
    cache,
  )
  if (!resolved) return null

  const projection = resolved.manifest.projections?.[String(root.kind)]
  if (!projection) return null

  const object = buildChildObject({
    root,
    manifest: resolved.manifest,
    projection,
    records: foldRuleOf(resolved.manifest),
    webTemplate: resolved.webTemplate,
    viaRecommendation: resolved.viaRecommendation,
    // The reference as given, so "open this in the app that owns it" points at
    // the event rather than at nothing. A bare id is upgraded to an `nevent`
    // carrying what we now know, which is more than the caller had.
    nevent: encodeNevent({ id: root.id, relays: pointer.relays, pubkey: root.pubkey, kind: root.kind }),
  })

  const people = await (lookupPeople ?? peopleViaRelay(query))(pubkeysIn(object))
  return { ...object, people }
}

export async function resolveForeignObject(
  naddr: string,
  query: QueryFn,
  /** Defaults to asking the relay. The browser passes a cached lookup. */
  lookupPeople?: PeopleFn,
  /**
   * How many `list` levels have already been followed. Callers outside this
   * module leave it at 0; it is the budget that stops a child's own `list`
   * recursing forever. See `MAX_LIST_DEPTH`.
   */
  depth = 0,
  /**
   * Optional memo for the NIP-89 discovery half. See {@link ProjectionCache} —
   * omitting it is exactly the old behaviour.
   */
  cache?: ProjectionCache,
): Promise<ForeignObject | null> {
  let pointer: AddressPointer
  try {
    // Either form: a body carries `naddr1…`, an `a` tag carries the plain
    // address, and both name the same object (FEE-2).
    pointer = referenceToPointer(naddr)
  } catch {
    return null
  }
  const address = pointerToAddress(pointer)

  const resolved = await resolveManifest(pointer, query, cache)
  if (!resolved) return null
  const { manifest, viaRecommendation } = resolved
  // Substituted here rather than in the component: `<bech32>` is a NIP-89
  // detail, and the widget's job is to draw a link, not to know the spec.
  const openUrl = resolved.webTemplate?.replace('<bech32>', naddr.replace(/^nostr:/, ''))
  const commentKinds = commentKindsOf(manifest)

  const projection = manifest.projections?.[String(pointer.kind)]
  if (!projection) return null
  const records = foldRuleOf(manifest)

  /*
    One round trip for the root, its changes, its comments **and its children**.

    `#a` on both the change and the comment kind, because both point at the
    object by *address* rather than by event id — which is what makes them
    survive the author replacing the root event.

    The children used to be a second round trip, issued after the root came
    back. They never needed to be: the child filter is built from the manifest
    and the *pointer*, and an addressable event's `d` is `pointer.identifier` by
    definition — it is what we just queried by. So once the manifest is known,
    nothing about the child filter depends on the root's contents (SHI-13).

    That is the difference between two requests per reference per refresh and
    one, and with the manifest memoised it is the whole cost of a tick.
  */
  const childFilter = childFilterFor({ projection, manifest, pointer, depth })
  const events = await query([
    { kinds: [pointer.kind], authors: [pointer.pubkey], '#d': [pointer.identifier], limit: 1 },
    // Only when the app actually declares a change kind — see `foldRuleOf`.
    ...(manifest.records ? [{ kinds: [manifest.records.changeKind], '#a': [address], limit: 500 }] : []),
    { kinds: commentKinds, '#a': [address], limit: 200 },
    ...(childFilter ? [childFilter.filter] : []),
  ])

  const root = events.find(
    (e) => e.kind === pointer.kind && tagValue(e, 'd') === pointer.identifier,
  )
  if (!root) {
    // We know which app owns this and how it would be drawn; we just cannot see
    // the object. Say so rather than returning null and looking like a typo.
    return {
      ref: address,
      address,
      naddr: naddr.replace(/^nostr:/, ''),
      // Nothing was read, so there is no event to name. The reference is the
      // address; that is all this case ever knows.
      eventId: '',
      kind: pointer.kind,
      widget: projection.widget,
      appName: manifest.name,
      slots: {},
      meta: [],
      comments: [],
      actions: [],
      viaRecommendation,
      // Offered even here. "You cannot see this object" is exactly when
      // somebody wants to open it in the app that can.
      openUrl,
      unreachable: true,
    }
  }

  const folded = foldChanges(
    events.filter(
      (e) => e.kind === records.changeKind && tagValue(e, records.targetTag) === address,
    ),
    records,
  )

  /*
    Matched on the comment filter's own criteria — the kind **and** the `a` tag.

    Kind alone was safe while this was its own query: the relay only returned
    what the comment filter asked for. Now that the children ride in the same
    request (SHI-13), a child sharing the comment kind would arrive here too and
    be counted as a comment on its own parent. Peek is exactly that shape: its
    Topic declares `kind:9` messages as children and `kind:9` as its comment
    kind, so every message in the Folder would have become a comment on the
    Topic — a widget silently showing a conversation twice.
  */
  const comments = events
    .filter((e) => commentKinds.includes(e.kind) && hasTagValue(e, 'a', address))
    .sort(byOrder)
    .map((e) => ({ id: e.id, author: e.pubkey, body: e.content, createdAt: e.created_at }))

  const object = buildObject({
    root,
    pointer,
    manifest,
    projection,
    folded,
    viaRecommendation,
    webTemplate: resolved.webTemplate,
    comments,
  })
  /*
    The `list` slot — PRO-7.

    PRO-2 built this down the *folder* path only, where containment is
    discovered from a Folder's contents. An object reached by address never
    resolved it: `rawSlotValue` returns undefined for a `children` spec, so the
    slot was silently dropped. Measured on production before this: 5 of 5 real
    Peek Topics rendered a title, a subtitle and no messages — which is exactly
    what a quiet topic looks like, so nothing reported a problem.

    A child is resolved through *its own* projection, which is what makes "a
    card with its children underneath" compose rather than being a special case.
    A child may be a regular event with no address of its own (Peek's messages
    are), so this builds by event rather than by pointer.
  */
  const children = childrenFrom({
    events,
    childFilter,
    manifest,
    webTemplate: resolved.webTemplate,
    viaRecommendation,
  })

  // After the object, because who to ask about is not known until it is built.
  // Folded into the same resolve rather than left to the renderer so the
  // widget's skeleton covers the wait and a key is never briefly on screen.
  // Children are included so one lookup covers the whole tree — a message list
  // is mostly other people, and a second trip per child would show a column of
  // keys while it ran.
  const forPeople = [object, ...(children ?? [])]
  const people = await (lookupPeople ?? peopleViaRelay(query))([
    ...new Set(forPeople.flatMap(pubkeysIn)),
  ])
  return { ...object, people, ...(children ? { children: children.map((c) => ({ ...c, people })) } : {}) }
}

/**
 * The filter for a projection's `list` slot, or nothing.
 *
 * Split out from fetching so it can be built **before** the root event is in
 * hand and merged into the object's own round trip (SHI-13). Everything it
 * needs is in the manifest and the pointer: an addressable event's `d` *is*
 * `pointer.identifier`, since that is what the root filter matches on, so
 * reading it back off the root taught us nothing we did not already know.
 *
 * Returns undefined when no `list` is declared — distinct from a declared list
 * that matches nothing, which a renderer must be able to tell apart. The two
 * other "declared but not renderable" cases are folded in here too, and both
 * come back as `[]` from {@link childrenFrom}: a depth budget already spent,
 * and a child kind the manifest never says how to draw.
 */
function childFilterFor(args: {
  projection: { widget: string | string[]; slots: Record<string, SlotSpec | SlotSpec[]> }
  manifest: Manifest
  pointer: AddressPointer
  depth: number
}): { filter: Record<string, unknown>; kind: number; via: string; parent: string } | null | undefined {
  const { projection, manifest, pointer, depth } = args
  const spec = projection.slots.list
  const children = !Array.isArray(spec) ? spec?.children : undefined
  if (!children) return undefined
  // The consumer's budget, not the manifest's — see MAX_LIST_DEPTH.
  if (depth >= MAX_LIST_DEPTH) return null
  // A declared list whose child kind has no projection is not renderable, and
  // an empty list is the honest answer: the objects exist, this app has not
  // said how to draw them.
  if (!manifest.projections?.[String(children.kind)]) return null

  const parent =
    children.match === 'identifier'
      ? pointer.identifier
      : pointerToAddress({ ...pointer, relays: [] })

  return {
    filter: { kinds: [children.kind], [`#${children.via}`]: [parent], limit: children.limit ?? 100 },
    kind: children.kind,
    via: children.via,
    parent,
  }
}

/**
 * The child objects, picked back out of the merged result set.
 *
 * **Matched on the filter's own criteria, never on kind alone.** Peek's Topic
 * declares `kind:9` messages as its children and `kind:9` as its comment kind,
 * so a merged response carries both under one number and only the tag tells
 * them apart. An event can honestly be both — Ship writes a `kind:9` with an
 * `a` naming the object *and* an `h` naming the Folder — and it appeared in
 * both result sets when these were two queries. Re-applying each filter's own
 * predicate reproduces that, rather than making them compete.
 */
function childrenFrom(args: {
  events: SignedEvent[]
  childFilter: ReturnType<typeof childFilterFor>
  manifest: Manifest
  webTemplate?: string
  viaRecommendation: boolean
}): ForeignObject[] | undefined {
  const { events, childFilter, manifest, webTemplate, viaRecommendation } = args
  if (childFilter === undefined) return undefined
  if (childFilter === null) return []

  const childProjection = manifest.projections?.[String(childFilter.kind)]
  if (!childProjection) return []
  const records = foldRuleOf(manifest)

  return events
    .filter((e) => e.kind === childFilter.kind && hasTagValue(e, childFilter.via, childFilter.parent))
    .sort(byOrder)
    .map((event) =>
      buildChildObject({ root: event, manifest, projection: childProjection, records, webTemplate, viaRecommendation }),
    )
}

/**
 * Build a `ForeignObject` from an event that may have no address of its own.
 *
 * `buildObject` takes an `AddressPointer` and assumes one exists. A `kind:9`
 * has no `d` tag, so there is nothing to point at — its only handle is its
 * event id. That is the whole of PRO-6's finding (6), and it is why `ref` and
 * `eventId` exist alongside `address`.
 *
 * An object built this way carries **no actions**, and that is correct rather
 * than a limitation: an action emits a change carrying an `a` tag naming what
 * it changes, and a regular event cannot be named that way.
 */
function buildChildObject(args: {
  root: SignedEvent
  manifest: Manifest
  projection: { widget: string | string[]; slots: Record<string, SlotSpec | SlotSpec[]> }
  records: RecordsRule
  webTemplate?: string
  viaRecommendation: boolean
  /**
   * The `nevent1…` for a non-addressable object, when the caller has one.
   *
   * Only `resolveForeignEvent` passes it: a child reached through a `list` slot
   * is drawn inside its parent and has nowhere of its own to open, while an
   * event somebody referenced directly does. Without it a message has no
   * `openUrl` at all, which is PRO-11's "its web link opens that message".
   */
  nevent?: string
}): ForeignObject {
  const { root, manifest, projection, webTemplate, viaRecommendation, nevent } = args
  const identifier = tagValue(root, 'd')
  const addressable = identifier !== undefined
  const pointer: AddressPointer = {
    kind: root.kind,
    pubkey: root.pubkey,
    identifier: identifier ?? '',
    relays: [],
  }
  const address = addressable ? pointerToAddress(pointer) : undefined
  const naddr = addressable ? encodeNaddr(pointer) : undefined
  const { slots, meta } = resolveSlots(projection, root, {}, manifest)

  return {
    // A regular event's identity is its id; a replaceable one's is its address,
    // which survives the author replacing the event.
    ref: address ?? root.id,
    address,
    naddr,
    eventId: root.id,
    kind: root.kind,
    widget: projection.widget,
    appName: manifest.name,
    slots,
    meta,
    comments: [],
    folder: tagValue(root, 'h'),
    /*
      `<bech32>` is whichever form this object actually has.

      NIP-89's template says nothing about which NIP-19 entity it will be handed
      — Ship's declares `naddr` in its own tag because every Ship object is
      addressable, and a template for an app with non-addressable objects is
      handed an `nevent`. Substituting the one the object *has* is what makes a
      single template serve both, and what stops a message linking to nothing.
    */
    openUrl: (naddr ?? nevent) ? webTemplate?.replace('<bech32>', (naddr ?? nevent) as string) : undefined,
    // See the note above: nothing can be declared to act on a regular event.
    actions: [],
    viaRecommendation,
  }
}

// ── A Folder's project, for the topic sidebar (PEEK-24) ─────────────────────

/**
 * A Folder's project and the tickets in motion in it.
 *
 * Both are ordinary `ForeignObject`s — the same shape an `naddr` in a message
 * resolves to, carrying the same slots, the same declared actions and the same
 * link back into the owning app. The sidebar therefore renders the owning app's
 * objects with the owning app's affordances rather than a reduced copy of them,
 * and a ticket is as actionable there as it is inline in a conversation.
 */
export interface FolderProject {
  project: ForeignObject
  /**
   * Every ticket in the project, finished or not: started work first, then the
   * queue, then what is done. Archived ones are left out — an app hiding a
   * record from its own lists is saying it is no longer part of the project.
   */
  tickets: ForeignObject[]
  /** Tickets still to do. With `doneCount`, the total the panel counts against. */
  openCount: number
  /** Finished tickets — the numerator in the panel's "1/3". */
  doneCount: number
}

/**
 * What a status *means*. **The owning app's declaration, with a fallback.**
 *
 * *Rewritten by PRO-2.* This used to open "Peek's editorial rule, not the
 * owning app's", on the grounds that a vocabulary entry was `{value, label,
 * colour}` and said nothing about whether work was open or finished. That was
 * true, and treating it as an editorial position was the mistake: Peek is not
 * the expert on what a Ship status means. Ship is.
 *
 * A vocabulary entry now carries `stage` — `open | started | done | dropped` —
 * and that is read first. The word lists below survive only as the
 * compatibility path for a manifest published before the field existed, which
 * cannot be given one retroactively (the `emits.alsoRead` reason, one level
 * up).
 *
 * The old comment named the cost of guessing and called it acceptable: *"an app
 * whose statuses are spelled differently shows an empty section until its
 * values are added here. That is the failure worth having."* For a layer whose
 * purpose is making the third app cheap to build, it is not — the third app
 * ships, its words are not in the set, and its panel renders blank, which is
 * PEE-10's failure exactly. A declared stage is what removes the guess.
 *
 * Two named sets rather than one allowlist and an "everything else": the panel
 * reads "1/3", done over the two sets added together, and a status that is
 * neither should land in neither. A parked "Backlog" or "Triage" is real work
 * nobody is doing and it would inflate the total into meaninglessness; an
 * unrecognised status some other app invented is not evidence of anything.
 *
 * Leaving both out is also what keeps "3/3" reachable. A cancelled ticket is
 * not outstanding and never becomes done, so counting it in the total would
 * leave a finished project stuck at 3/4 for good.
 *
 * The visible cost: with something cancelled, the total is smaller than the
 * number of rows listed below it. The count is about progress through the work,
 * not about how long the list is, and a total nothing can ever complete is the
 * worse of the two.
 *
 * The other cost is honest: an app whose statuses are spelled differently shows
 * an empty section until its values are added here. That is the failure worth
 * having — the alternative is a count that quietly includes work nobody is on.
 */
const OPEN_STATUSES = new Set([
  'todo',
  'to do',
  'in progress',
  'started',
  'doing',
  'in review',
  'review',
])
const DONE_STATUSES = new Set([
  'done',
  'completed',
  'complete',
  'closed',
  'cancelled',
  'canceled',
  'duplicate',
])

/** `in_progress`, `In-Progress` and `In Progress` are the same status. */
const normalizeStatus = (value: string) => value.trim().toLowerCase().replace(/[-_\s]+/g, ' ')

/**
 * Match on either what the object *says* or what a reader *sees* — the raw
 * value (`in_progress`) or the vocabulary label ("In Progress"). Apps disagree
 * about which of the two is the human-readable one, and checking both costs
 * nothing.
 */
const inSet = (set: Set<string>) => (raw: string | undefined, label: string | undefined) =>
  [raw, label].some((v) => v !== undefined && set.has(normalizeStatus(v)))

const isOpenStatusByLabel = inSet(OPEN_STATUSES)
const isDoneStatusByLabel = inSet(DONE_STATUSES)

/** The four stages a manifest may declare. Anything else is not a stage. */
type Stage = 'open' | 'started' | 'done' | 'dropped'
const STAGES = new Set<Stage>(['open', 'started', 'done', 'dropped'])

/**
 * The stage the owning app declares for a status value, or undefined.
 *
 * `undefined` means "this manifest does not say", which is a different fact
 * from "this status is not progress" and must not be collapsed into one — the
 * caller falls back to the word lists only in the first case.
 *
 * A `stage` outside the four is ignored rather than trusted. Validation is an
 * honour system (RFC 0.4 §13.4) and this is a consumer reading another app's
 * self-description; an unrecognised value is treated as undeclared, which
 * degrades to the fallback instead of inventing a fifth stage.
 */
function declaredStage(
  manifest: Manifest,
  spec: SlotSpec | undefined,
  raw: string | undefined,
): Stage | undefined {
  if (!spec?.map || raw === undefined) return undefined
  const stage = manifest.vocabularies?.[spec.map]?.find((v) => v.value === raw)?.stage
  return stage && STAGES.has(stage as Stage) ? (stage as Stage) : undefined
}

/**
 * Is this status finished work?
 *
 * `dropped` counts as done rather than open, which is what keeps "3/3"
 * reachable: a cancelled ticket is never going to become done, so leaving it
 * outstanding pins a finished project below its total for ever. It is not
 * *progress* either, and an app that wanted to draw that distinction now can —
 * the stage is on the wire and this fold is the consumer's, not the protocol's.
 */
function isDone(stage: Stage | undefined, raw: string | undefined, label: string | undefined) {
  if (stage) return stage === 'done' || stage === 'dropped'
  return isDoneStatusByLabel(raw, label)
}

function isOpen(stage: Stage | undefined, raw: string | undefined, label: string | undefined) {
  if (stage) return stage === 'open' || stage === 'started'
  return isOpenStatusByLabel(raw, label)
}

/**
 * Started work sits above the queue.
 *
 * Both halves are open, but "in progress" is what somebody opened the panel to
 * find; ordering by activity alone would bury it under whatever was filed most
 * recently.
 */
const STARTED = new Set(['in progress', 'started', 'doing', 'in review', 'review'])
const isStartedByLabel = inSet(STARTED)

function isStarted(stage: Stage | undefined, raw: string | undefined, label: string | undefined) {
  if (stage) return stage === 'started'
  return isStartedByLabel(raw, label)
}

/**
 * The containment relation a manifest declares: "this kind holds that kind".
 *
 * Read from the `list` slot, which says it outright, falling back to the
 * inference this used to depend on. Returns null when the app says neither — in
 * which case Peek does not guess, and the sidebar shows nothing.
 */
function containmentFor(
  manifest: Manifest,
  containerKind: number,
): { childKind: number; linkTag: string; limit?: number; match?: 'address' | 'identifier' } | null {
  /*
    The declared answer first — PRO-2.

    A `list` slot says outright which kind this one holds and by which tag. What
    follows below is the older path, and it is worth naming what it does: it
    reads an action that *creates* a child (`toAddressOf: "self"`) and infers a
    *read* relationship from it. That worked, and it was a deduction from a
    write declaration — an app offering no create-action, or offering one for a
    kind it does not actually contain, was invisible or wrong respectively.

    Kept as a compatibility path rather than deleted, because a manifest
    published before PRO-2 cannot be given a `list` slot retroactively and
    consumers upgrade before producers do. It goes when nothing in use relies
    on it.
  */
  const projection = manifest.projections?.[String(containerKind)]
  const listSlot = projection && !Array.isArray(projection.slots.list) ? projection.slots.list : undefined
  if (listSlot?.children) {
    const { kind, via, limit, match } = listSlot.children
    return { childKind: kind, linkTag: via, limit, match }
  }

  for (const action of manifest.actions ?? []) {
    if (action.emits.toAddressOf !== 'self') continue
    if (!asArray(action.appliesTo).includes(String(containerKind))) continue
    return { childKind: action.emits.kind, linkTag: action.emits.setTag ?? 'a' }
  }
  return null
}

/**
 * How deep a consumer will follow `list` slots. **The consumer's budget.**
 *
 * A child rendered through its own projection may declare a `list` of its own,
 * so resolution is recursive and something has to stop it. That something is
 * here rather than in the manifest: the app at risk of the render loop is the
 * one drawing it, and a producer able to set this number could hang any
 * consumer that trusted it (RFC 0.4 §13.4 — validation is an honour system).
 *
 * One level is what the panel needs: a project and its issues. Raising it is a
 * decision about this app's boot cost, not about anyone else's data.
 */
const MAX_LIST_DEPTH = 1

/**
 * The project living in a Folder, plus the work currently in motion in it.
 *
 * Starts from a **Folder** rather than an naddr, which is the difference
 * between this and `resolveForeignObject`: a Peek topic and a Linear-lite
 * project are one container (RFC_UPDATES.md §1.1), so a topic already knows
 * enough to ask "what project is this?" without anyone pasting a reference.
 *
 * Still knows nothing about Linear-lite. Which kind is a project, which kind is
 * an issue, how they link, how status folds and what it is called all come off
 * published manifests at runtime — the same discipline as the rest of this file.
 *
 * Returns null for "nothing to show": no manifest declares a container, no
 * project in this Folder and none named by the tickets in it, or the object
 * cannot be read. All of those are ordinary states the caller renders as an
 * empty sidebar, not errors.
 */
export async function resolveFolderProject(
  folder: string,
  query: QueryFn,
  /** Defaults to asking the relay. The browser passes a cached lookup. */
  lookupPeople?: PeopleFn,
  /**
   * How many `list` levels have already been followed to get here. Callers
   * outside this module leave it at 0; it exists so that following a child's
   * own `list` is a budget check rather than a thing nobody remembered.
   */
  depth = 0,
  /** See {@link ProjectionCache}. Omitting it is exactly the old behaviour. */
  cache?: ProjectionCache,
): Promise<FolderProject | null> {
  // The render loop this forbids is not hypothetical: two folders naming each
  // other's projects resolve forever, and the manifest declaring them is
  // another app's. See MAX_LIST_DEPTH.
  if (depth > MAX_LIST_DEPTH) return null
  // 1. Which kinds are containers? A Folder query needs kind numbers up front,
  //    and the only non-app-specific source for them is the published handlers.
  //    This pass is discovery only — the manifest that actually *renders* the
  //    project is resolved below, recommendation-first, once its author is known.
  const handlerFilter = [{ kinds: [KIND_HANDLER_INFORMATION], limit: 20 }]
  const handlers = await query(handlerFilter)
  const containers = new Map<number, { childKind: number; linkTag: string; limit?: number; match?: 'address' | 'identifier' }>()
  let discovered: Manifest | undefined
  for (const event of handlers) {
    const manifest = parseManifest(event)
    for (const kind of Object.keys(manifest?.projections ?? {})) {
      const relation = manifest && containmentFor(manifest, Number(kind))
      if (relation) {
        containers.set(Number(kind), relation)
        discovered ??= manifest
      }
    }
  }
  if (containers.size === 0) {
    return null
  }

  // 2. One round trip for everything in the Folder: containers, their children,
  //    and the changes that have landed on either — `h` is what they share.
  //    Changes are needed *before* a project is chosen, because whether one is
  //    archived is itself a folded field.
  const childKinds = [...new Set([...containers.values()].map((c) => c.childKind))]
  const discoveredRule = discovered?.records
  const inFolderRaw = await query([
    { '#h': [folder], kinds: [...containers.keys(), ...childKinds], limit: 200 },
    ...(discoveredRule ? [{ '#h': [folder], kinds: [discoveredRule.changeKind], limit: 500 }] : []),
  ])

  /*
    **A Folder is not a file inside itself.**

    A channel's own `kind:39000` comes back from an `#h` query for that channel.
    It carries no `h` tag — the relay scopes a discovery event to the channel it
    describes, so it arrives with the contents. What marks it out is that its
    `d` *is* the folder uuid; a file sitting in a Folder has its own uuid,
    different from the Folder's.

    Dropped here, once, rather than at each use. Two places downstream ask "does
    this Folder hold a container", and they have to agree: `holdsContainer`
    decides whether to go looking for a project the Folder does not hold, and
    `roots` decides which container is the subject. Filtering only the second
    makes them disagree and the panel resolves to nothing at all.

    Until Peek published a manifest this could not bite, because only Ship's
    kinds were containers and a `39000` was never a candidate. PRO-6 declared
    Topic a container — it holds messages — so the Topic became a candidate,
    won the contest against the actual project, and the sidebar listed the
    *messages* as tickets. Each was titled with its author's pubkey, because a
    message resolved through Peek's own projection has `title: {field: "pubkey"}`.

    App-neutral on purpose: this is a fact about folders and discovery events,
    not about Peek.
  */
  const inFolder = inFolderRaw.filter((e) => tagValue(e, 'd') !== folder)

  const addressOfEvent = (event: SignedEvent) =>
    pointerToAddress({
      kind: event.kind,
      pubkey: event.pubkey,
      identifier: tagValue(event, 'd') ?? '',
      relays: [],
    })

  /**
   * 2b. A Folder can hold a project's *work* without holding the project.
   *
   * An event cannot change its own `h`. So a project created in one Folder and
   * later paired with a Peek topic keeps the `h` it was born with, and the
   * pairing is expressed the only way an append-only record can express it — a
   * change event. Ship published that change only in the Folder the *record*
   * lives in, so nothing carrying the topic's `h` named the project at all: the
   * query above saw a Folder full of tickets and no project, and the panel said
   * "no project linked" about a Folder holding eleven of its issues (PEEK-24).
   *
   * A consumer cannot require the producer to have got that right, and this one
   * must keep working against the events already on the relay, so it reads
   * whatever the Folder does hold.
   *
   * Two things in the Folder can name it, and both use a tag the manifest has
   * already declared rather than any new vocabulary.
   *
   * A **ticket** names its project in the containment relation's link tag,
   * which is the same tag step 5 reads to decide which tickets belong here. A
   * Folder whose tickets all point at one project *is* that project's Folder,
   * whichever Folder the project record happens to sit in.
   *
   * A **change published into this Folder** names its target in the records
   * rule's target tag. That is an app saying out loud "the object at this
   * address belongs here" — the only way to say it when the object's own `h`
   * cannot be moved, and the one that does not need a ticket to exist yet.
   * Estiva Ship writes it when a project is paired with a topic.
   *
   * Reading both matters, because they fail in opposite directions: the tickets
   * cover a Folder paired before anybody wrote the statement, and the statement
   * covers a Folder paired before anybody filed a ticket. Where they disagree
   * the sort below decides, and it already prefers whichever candidate the
   * Folder's work actually belongs to.
   *
   * Its changes come by address rather than by `h`, because they are wherever
   * the record is, not here. Skipped entirely when the Folder does hold a
   * container, which is the ordinary case and already correct.
   */
  const holdsContainer = inFolder.some((e) => containers.has(e.kind))
  const namedInFolder = holdsContainer
    ? []
    : [
        ...new Set(
          inFolder.flatMap((event) => {
            const relation = [...containers.values()].find((c) => c.childKind === event.kind)
            if (relation) {
              const link = tagValue(event, relation.linkTag)
              return link ? [link] : []
            }
            if (discoveredRule && event.kind === discoveredRule.changeKind) {
              const target = tagValue(event, discoveredRule.targetTag)
              return target ? [target] : []
            }
            return []
          }),
        ),
      ]
  // Only a container may be adopted this way. A child's link tag can name
  // anything, and a ticket that points at another ticket must not become the
  // subject of the panel.
  const linkedOutward = namedInFolder.flatMap((link) => {
    try {
      const pointer = referenceToPointer(link)
      return containers.has(pointer.kind) ? [{ link, pointer }] : []
    } catch {
      return []
    }
  })

  const adopted = linkedOutward.length
    ? await query([
        ...linkedOutward.map(({ pointer }) => ({
          kinds: [pointer.kind],
          authors: [pointer.pubkey],
          '#d': [pointer.identifier],
          limit: 1,
        })),
        ...(discoveredRule
          ? [
              {
                kinds: [discoveredRule.changeKind],
                '#a': linkedOutward.map(({ link }) => link),
                limit: 500,
              },
            ]
          : []),
      ])
    : []

  /** Everything the Folder holds, plus whatever it was adopted from. */
  const known = adopted.length ? [...inFolder, ...adopted] : inFolder

  /** Is this object one its owning app would keep out of its own lists? */
  const isHidden = (event: SignedEvent, rule: RecordsRule | undefined, source = known) => {
    if (!rule?.hiddenWhen) return false
    const applied = source.filter(
      (e) => e.kind === rule.changeKind && tagValue(e, rule.targetTag) === addressOfEvent(event),
    )
    return foldChanges(applied, rule)[rule.hiddenWhen.field]?.value === rule.hiddenWhen.equals
  }

  const roots = known
    .filter((e) => containers.has(e.kind))
    .filter((e) => !isHidden(e, discoveredRule))
  if (roots.length === 0) {
    return null
  }

  /**
   * Which project, when a Folder holds several.
   *
   * Nothing forbids more than one, and pairing makes it common rather than
   * exotic: a topic accumulates a project per attempt. Ranking by age alone
   * picked whichever was created last — in practice a stray — so the work
   * decides instead. The project the Folder's tickets point at is the project
   * the Folder is about; age only breaks the tie.
   */
  const ticketsFor = (candidate: SignedEvent) => {
    const relation = containers.get(candidate.kind)!
    const candidateAddress = addressOfEvent(candidate)
    return inFolder.filter(
      (e) => e.kind === relation.childKind && tagValue(e, relation.linkTag) === candidateAddress,
    ).length
  }
  const root = [...roots].sort(
    (a, b) => ticketsFor(b) - ticketsFor(a) || b.created_at - a.created_at,
  )[0]

  const pointer: AddressPointer = {
    kind: root.kind,
    pubkey: root.pubkey,
    identifier: tagValue(root, 'd') ?? '',
    relays: [],
  }
  const address = pointerToAddress(pointer)

  // 3. Now the authoritative manifest — the object's author gets to say which
  //    app renders their project (kind:31989), same as for an inline reference.
  const resolved = await resolveManifest(pointer, query, cache)
  if (!resolved) {
    return null
  }
  const { manifest, viaRecommendation } = resolved
  const projection = manifest.projections?.[String(root.kind)]
  if (!projection) {
    return null
  }
  const records = foldRuleOf(manifest)
  const relation = containmentFor(manifest, root.kind) ?? containers.get(root.kind)!

  // 4. Every change in the Folder, folded per object. Already fetched in step 2
  //    unless the authoritative manifest orders records differently from the one
  //    discovery happened to find, which is the only case worth a second trip.
  //    That trip asks by address as well as by Folder: an adopted project's own
  //    changes are not in this Folder, and a `#h` query alone would fold it
  //    without them and report the defaults as its state.
  const changes = !manifest.records
    ? // The app declares no change kind, so there is nothing to ask for. Not a
      // filter that matches nothing — a kind is `u16` and the relay refuses an
      // out-of-range one outright. See `foldRuleOf`.
      []
    : discoveredRule?.changeKind === records.changeKind
      ? known.filter((e) => e.kind === records.changeKind)
      : await query([
          { kinds: [records.changeKind], '#h': [folder], limit: 500 },
          ...(adopted.length ? [{ kinds: [records.changeKind], '#a': [address], limit: 500 }] : []),
        ])
  const changesFor = (target: string) =>
    changes.filter((e) => tagValue(e, records.targetTag) === target)

  const project = buildObject({
    root,
    pointer,
    manifest,
    projection,
    folded: foldChanges(changesFor(address), records),
    viaRecommendation,
    webTemplate: resolved.webTemplate,
  })

  // 5. The tickets. A child either names this project or names nothing at all —
  //    an unlinked ticket still lives in the Folder, and the Folder *is* the
  //    project, so dropping it would under-report live work.
  const ticketProjection = manifest.projections?.[String(relation.childKind)]
  const statusSpec =
    ticketProjection && !Array.isArray(ticketProjection.slots.status)
      ? ticketProjection.slots.status
      : undefined
  // A project whose tickets have no declared projection is still worth showing;
  // it just has nothing to expand into.
  /**
   * One lookup for everyone the panel could name, shared by every object it
   * returns. The project's lead is the only one drawn today; the tickets carry
   * the same map so a renderer that starts showing assignees needs no second
   * trip, and so `ForeignObject` means the same thing whichever resolver built
   * it.
   */
  const withPeople = async (objects: ForeignObject[]) => {
    const people = await (lookupPeople ?? peopleViaRelay(query))([
      ...new Set(objects.flatMap(pubkeysIn)),
    ])
    return objects.map((object) => ({ ...object, people }))
  }

  if (!ticketProjection) {
    const [only] = await withPeople([project])
    return { project: only, tickets: [], openCount: 0, doneCount: 0 }
  }

  const rows: { ticket: ForeignObject; rank: number; activityMs: number }[] = []
  let openCount = 0
  let doneCount = 0
  for (const event of inFolder) {
    if (event.kind !== relation.childKind) continue
    /*
      What the link is compared against depends on what the child carries.

      Ship's issues name their project by full address; Peek's messages name
      their channel with `h`, which holds the bare uuid — the parent's `d`, not
      its address. The manifest says which (`match`), because guessing is what
      PRO-2 removed and comparing against both would silently accept a child
      that named something else entirely whose `d` happened to collide.
    */
    const expected = relation.match === 'identifier' ? pointer.identifier : address
    const link = tagValue(event, relation.linkTag)
    if (link !== undefined && link !== expected) continue
    // Archived is the one exclusion left. Everything else the project holds is
    // listed; a record its own app hides is not part of the project any more.
    if (isHidden(event, records, changes)) continue

    const ticketPointer: AddressPointer = {
      kind: event.kind,
      pubkey: event.pubkey,
      identifier: tagValue(event, 'd') ?? '',
      relays: [],
    }
    const ticketChanges = changesFor(pointerToAddress(ticketPointer))
    const folded = foldChanges(ticketChanges, records)
    const status = statusSpec ? resolveSlot(statusSpec, event, folded, manifest) : null
    const raw = statusSpec ? rawSlotValue(statusSpec, event, folded) : undefined

    // The owning app's declaration first, the label guess only if it has none.
    const stage = declaredStage(manifest, statusSpec, raw)
    const done = isDone(stage, raw, status?.value)
    if (done) doneCount += 1
    else if (isOpen(stage, raw, status?.value)) openCount += 1
    // A status in neither set — parked, or one this consumer has never seen —
    // is still a ticket and still listed. It just cannot claim to be progress
    // in either direction, so it stays out of both counts.

    rows.push({
      ticket: buildObject({
        root: event,
        pointer: ticketPointer,
        manifest,
        projection: ticketProjection,
        folded,
        viaRecommendation,
        webTemplate: resolved.webTemplate,
      }),
      rank: isStarted(stage, raw, status?.value) ? 0 : done ? 2 : 1,
      activityMs: Math.max(event.created_at * 1000, ...ticketChanges.map(orderingMs)),
    })
  }
  // Started work, then the queue, then what is finished; within each, whatever
  // moved most recently. The whole project is here — the order is what makes it
  // scannable rather than a dump.
  rows.sort((a, b) => a.rank - b.rank || b.activityMs - a.activityMs)

  /*
    The producer's declared `limit`, applied after sorting rather than before.

    It says how many children are worth rendering, so cutting before the sort
    would drop whichever happened to be read first and could hide every started
    ticket behind a hundred finished ones. The counts above are deliberately
    computed over everything: "4 of 117" stays true when only 200 rows are
    drawn, and a total that changed with the render budget would be a different
    and worse number.
  */
  const capped = relation.limit ? rows.slice(0, relation.limit) : rows

  const [resolvedProject, ...tickets] = await withPeople([project, ...capped.map((r) => r.ticket)])
  return { project: resolvedProject, tickets, openCount, doneCount }
}

/**
 * Build the event that performs a manifest-declared action.
 *
 * Pure, and separate from the Convex action for the same reason `projection.ts`
 * is separate from `foreign.ts`: this is the part worth testing against a live
 * relay, and it must not need a deployment or a signed-in session to run.
 *
 * Returns a string on refusal rather than throwing — every failure here is
 * something a user should read.
 */
export function buildActionEvent(args: {
  manifest: { records?: RecordsRule; actions?: ManifestAction[]; vocabularies?: Manifest['vocabularies'] }
  kind: number
  /** Address of the object being acted on. */
  address: string
  /** Author of the object — needed for NIP-22's `P`/`p` tags. */
  objectAuthor: string
  folder: string
  actionId: string
  value: string
  pubkey: string
  createdAtMs: number
}): UnsignedActionEvent | string {
  const { manifest, kind, address, folder, actionId, value } = args
  const records = manifest.records
  const declared = manifest.actions?.find((a) => a.id === actionId)
  if (!records) return 'That app does not say how its records are written.'
  if (!declared) return `This app does not offer "${actionId}".`

  const appliesTo = Array.isArray(declared.appliesTo) ? declared.appliesTo : [declared.appliesTo]
  if (!appliesTo.includes(String(kind))) {
    return `"${declared.label}" does not apply to a kind ${kind}.`
  }

  // Validate against the manifest's own vocabulary. The owning app cannot
  // enforce this — anyone can publish anything (RFC_UPDATES.md §3) — so a
  // consumer that skips the check is the one putting junk in the shared record.
  // Checking here is Peek keeping its side of the honour system.
  if (declared.input?.enum) {
    const vocab = manifest.vocabularies?.[declared.input.enum] ?? []
    if (!vocab.some((entry) => entry.value === value)) {
      return `"${value}" is not one of ${vocab.map((e) => e.value).join(', ')}.`
    }
  }

  const tags: string[][] = declared.emits.field
    ? [
        [records.targetTag, address],
        [records.fieldTag, declared.emits.field],
        [records.valueTag, value],
        ['h', folder],
      ]
    : // NIP-22 comment. Built from the ratified NIP rather than from the
      // manifest, which is legitimate precisely because no app owns kind:1111 —
      // the same reason the owning app uses it. Uppercase tags name the thread
      // root, lowercase the immediate parent.
      [
        ['A', address],
        ['K', String(kind)],
        ['P', args.objectAuthor],
        ['a', address],
        ['k', String(kind)],
        ['p', args.objectAuthor],
        ['h', folder],
      ]

  // The manifest told us how it orders events; write events that can be ordered.
  // Without `ts`, a change from here and one from the owning app in the same
  // second would be separated by event id — arbitrarily, and differently
  // depending on which app you asked (FRICTION.md A6).
  if (records.order?.includes('ts')) tags.push(['ts', String(args.createdAtMs)])

  return {
    pubkey: args.pubkey,
    created_at: Math.floor(args.createdAtMs / 1000),
    kind: declared.emits.kind,
    tags,
    content: declared.emits.field ? '' : value,
  }
}

/**
 * Test seam: resolve one projection's `title` slot against one event.
 *
 * Exported so the tag-fallback rules can be pinned without standing up a fake
 * relay. `resolveSlots` and `resolveSlot` are the real path; this only picks
 * the one slot out of them.
 */
export function resolveFolderProjectSlotsForTest(
  manifest: Manifest,
  root: SignedEvent,
): string | undefined {
  const projection = manifest.projections?.[String(root.kind)]
  if (!projection) return undefined
  return resolveSlots(projection, root, {}, manifest).slots.title?.value
}

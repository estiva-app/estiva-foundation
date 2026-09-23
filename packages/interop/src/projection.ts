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
import { decodeNaddr, decodeNevent, encodeNaddr, encodeNevent, findNaddrs, pointerToAddress, referenceToPointer, type AddressPointer, type EventPointer } from '@estiva-app/protocol'
import { parseProfile, type Profile, type SignedEvent } from '@estiva-app/protocol'
import { MAX_FILTERS_PER_QUERY, RELAY_PAGE_CEILING } from '@estiva-app/protocol'

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
 * NIP-09's deletion request. Protocol, like the two above, and the one kind an
 * action may emit that is neither a change nor a comment nor a creation: an
 * action emitting it is a *deletion* (`control: 'confirm'`), and the event it
 * builds names the object's address, which is the NIP's shape for an
 * addressable target and what the relay adjudicates by author.
 */
const KIND_DELETION = 5

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

/**
 * How many comments one conversation read asks for.
 *
 * **One constant for the panel and the badge, deliberately.** A count that
 * saturated at a different number than the view it labels would put "100" next
 * to a hundred and fifty visible messages, and a reader would be right to trust
 * neither. Both {@link resolveForeignObject} and {@link conversationCountsOf}
 * use this, so a file at the cap reports the cap in both places and the badge
 * means exactly "what opening this will show you".
 */
export const CONVERSATION_LIMIT = 200

/**
 * How many messages each file's conversation holds — one round trip for all of them.
 *
 * For the question a reader actually has in front of a list: *is this one worth
 * opening*. Answering it per file through {@link resolveForeignObject} would be
 * a resolve each, which is the cost {@link resolveFolderContents} exists to
 * avoid — against a relay metering reads at 300 a minute, a folder of
 * twenty-five would not load.
 *
 * ## One filter per file, not one filter for all of them
 *
 * The obvious shape — a single `#a` naming every address — shares one `limit`
 * across every file, so one busy file starves the rest and the short results
 * are indistinguishable from "there are no more". Per file, the relay clamps
 * each filter's limit independently, so each gets its own budget. The results
 * come back merged, which is fine: every comment names its object in its own
 * `a` tag, so attribution never depends on the order they arrive in.
 *
 * Chunked at `MAX_FILTERS_PER_QUERY` because a folder may hold more files than
 * one POST accepts, and silently counting only the first 128 is the kind of
 * quiet wrong answer this module keeps removing.
 *
 * ## What a zero means
 *
 * Exactly "nothing is addressed to this file", which is **not** the same as
 * "nobody has discussed it". A Peek topic's messages carry `h` and no `a` —
 * its conversation belongs to the container rather than the object — so a topic
 * counts zero however busy it is, until a topic becomes an addressable file
 * (RFC 0.4 §11.1). Ship's issues carry `a` and count correctly. A consumer
 * showing this must not render the zero as "no discussion".
 *
 * Files with no address are absent from the result rather than zero, so a
 * consumer can tell "asked and got none" from "not askable".
 */
export async function conversationCountsOf(
  files: ForeignObject[],
  query: QueryFn,
  /** Warm from the read that produced these files; see {@link ProjectionCache}. */
  cache?: ProjectionCache,
): Promise<Record<string, number>> {
  const conversations = await conversationsOf(files, query, cache)
  const counts: Record<string, number> = {}
  for (const [ref, messages] of Object.entries(conversations)) counts[ref] = messages.length
  return counts
}

/**
 * One message of a file's conversation, as much of it as a list needs.
 *
 * Not the event: a list deciding whether a file is worth opening, or whether it
 * is unread, needs when and by whom and which thread — never the body. `root`
 * is the id of the thread's root message, which is the message's own id when
 * it *is* the root; a reader applying SPEC §11.3 needs it to find the thread's
 * marker.
 */
export interface ConversationMessage {
  id: string
  /** Unix seconds, as the event carries and as NIP-RS stores. */
  at: number
  /** Author pubkey. */
  by: string
  root: string
}

/**
 * The root of a comment's thread — NIP-22's uppercase `E` when the comment
 * carries one, else the `['e', <root>, '', 'reply']` shape §6.4's table gives
 * for a reply, else the message itself.
 */
function rootOf(event: SignedEvent): string {
  const upper = event.tags.find((t) => t[0] === 'E' && t[1])?.[1]
  if (upper) return upper
  const lower = event.tags.find((t) => t[0] === 'e' && t[1])?.[1]
  return lower ?? event.id
}

/**
 * What each file's conversation holds — one round trip for all of them.
 *
 * The read behind {@link conversationCountsOf}, returned rather than reduced
 * to a number, for the second question a list has once it knows a file is
 * worth opening: *is any of it new to me* (SPEC §11.1, FOL-16). A file's
 * read-state context is its address and its messages' own `a` tag names it,
 * so a list can judge unread per file from exactly this — each message's time,
 * author and thread against the file's marker — with no second read. Read
 * state itself is not this package's business, so nothing here knows a marker;
 * the consumer brings its own rule.
 *
 * Everything the count's doc says holds here: one filter per file, chunked at
 * `MAX_FILTERS_PER_QUERY`, attributed by every `a` tag, deduplicated across
 * filters, and a file with no address is absent rather than empty. Messages are
 * returned oldest first.
 *
 * Only what SPEC §6.4 calls a **comment** is here (CON-15). The `#a` read also
 * returns every message that merely *mentions* the file — a `kind:1111` rooted
 * on another file, a `kind:9` whose body names this one — and those are
 * *Mentioned in*, which §6.4 says MUST NOT be presented as the file's own
 * discussion. A badge counting them said "3" beside an issue with one comment.
 * See `isCommentOn` for the per-kind rule.
 */
export async function conversationsOf(
  files: ForeignObject[],
  query: QueryFn,
  /** Warm from the read that produced these files; see {@link ProjectionCache}. */
  cache?: ProjectionCache,
): Promise<Record<string, ConversationMessage[]>> {
  const addressed = files.flatMap((file) => {
    if (!file.address) return []
    try {
      return [{ file, pointer: referenceToPointer(file.address) }]
    } catch {
      return []
    }
  })
  if (addressed.length === 0) return {}

  // One manifest per app, never per file — the comment kinds are the owning
  // app's declaration and every file it owns in this list shares them.
  const byApp = new Map<string, AddressPointer>()
  for (const { pointer } of addressed) byApp.set(manifestKeyOf(pointer), pointer)
  const manifests = new Map<string, ResolvedManifest>()
  await Promise.all(
    [...byApp].map(async ([key, pointer]) => {
      const resolved = await resolveManifest(pointer, query, cache)
      if (resolved) manifests.set(key, resolved)
    }),
  )

  const asked = addressed.flatMap(({ file, pointer }) => {
    const resolved = manifests.get(manifestKeyOf(pointer))
    // No manifest, no declared comment kind: a guess of 1111 would report a
    // confident zero for an app that uses something else.
    if (!resolved) return []
    return [
      {
        ref: file.ref,
        address: file.address as string,
        filter: {
          kinds: commentKindsOf(resolved.manifest),
          '#a': [file.address],
          limit: CONVERSATION_LIMIT,
        },
      },
    ]
  })
  if (asked.length === 0) return {}

  const refOf = new Map(asked.map((a) => [a.address, a.ref]))
  const conversations: Record<string, ConversationMessage[]> = {}
  for (const a of asked) conversations[a.ref] = []

  const seen = new Set<string>()
  for (let start = 0; start < asked.length; start += MAX_FILTERS_PER_QUERY) {
    const events = await query(
      asked.slice(start, start + MAX_FILTERS_PER_QUERY).map((a) => a.filter),
    )
    for (const event of events) {
      // A relay may answer one event under two filters; counting it twice would
      // inflate the badge above what the panel then shows.
      if (seen.has(event.id)) continue
      seen.add(event.id)
      /*
        Every `a` tag, not the first one.

        The relay matches a filter against *any* of them, so an event can come
        back for an address that is not the one its first tag names — the same
        lesson `childrenFrom` already carries ("a second `a` tag still counts").
        Reading `tags.find` would attribute such a comment to nobody and quietly
        undercount.

        And only the address it is a *comment* on (CON-15). The `a` tag is the
        index of every reference, so a message that names two files in this list
        came back for both; it belongs to the one whose discussion it is, and to
        neither when it merely mentions them. `isCommentOn` is §6.4's rule.
      */
      const ref = event.tags
        .filter((t) => t[0] === 'a' && t[1] && refOf.has(t[1]) && isCommentOn(event, t[1]))
        .map((t) => refOf.get(t[1]))
        .find((found) => found !== undefined)
      if (ref !== undefined) {
        conversations[ref].push({ id: event.id, at: event.created_at, by: event.pubkey, root: rootOf(event) })
      }
    }
  }
  for (const messages of Object.values(conversations)) messages.sort((a, b) => a.at - b.at || (a.id < b.id ? -1 : 1))
  return conversations
}

/**
 * How many targets a reaction read asks about — SPEC §6.6, decided by CON-1.
 *
 * A `kind:7` carries no `h` and no `a`, so reactions are found only by asking
 * for the ids on screen, and the number asked for is a horizon every reader
 * shares: two apps with different N disagree about a count, legitimately and
 * unfixably. The value is the specification's, not this package's.
 */
export const REACTION_HORIZON = 100

/** A `kind:7` on a comment. */
export interface CommentReaction {
  id: string
  emoji: string
  by: string
  at: number
}

/** A `kind:9101` resolution assertion on a comment (PEEK-128). */
export interface CommentResolution {
  id: string
  action: 'resolved' | 'reopened'
  by: string
  at: number
  /** The assertion's free text, when it carried one. */
  message?: string
  /** The reply that carried the resolution, when the writer named one. */
  supportingEventId?: string
}

/** What has been done to one comment since it was written. */
export interface CommentDecoration {
  /**
   * The newest `kind:40003` — the body to show, and when. RFC 0.4 §7.2.1: a
   * reader MUST be told the body changed, so this is kept beside the original
   * rather than folded over it; the consumer draws the marker.
   */
  edit?: { body: string; at: number; by: string }
  /** Every reaction found, in the order the relay holds them. Empty inside the horizon means none. */
  reactions: CommentReaction[]
  /** Oldest first; the last one is the current state. Empty means never resolved. */
  resolutions: CommentResolution[]
}

/** The answer of {@link commentDecorationsOf}. */
export interface CommentDecorations {
  /** Keyed by comment id. A target nothing happened to is present, with nothing in it. */
  byId: Record<string, CommentDecoration>
  /**
   * How many of the targets were **not** asked about reactions, because they
   * fell outside the horizon. SPEC §6.6 makes reporting this a MUST: a cap
   * nobody can see is indistinguishable from "nobody reacted".
   */
  reactionTargetsOmitted: number
}

/** The three kinds a comment's decorations come in. Numbers, and here for the same reason `KIND_BARE_FILE` is. */
const KIND_REACTION = 7
const KIND_ASSERTION = 9101
const KIND_MESSAGE_EDIT = 40003

/** Ids per `#e` filter. A comfortable fraction of the relay's page, so one filter's answer is never cut. */
const DECORATION_TARGETS_PER_FILTER = 100

/**
 * What has been done to a set of comments — edits, reactions, resolutions — in
 * one request, read by `#e`.
 *
 * **A second round trip, and that is why this is a function rather than part of
 * {@link resolveForeignObject}.** Everything that read returns is addressed by
 * `#a`, so it arrives with the root. An edit (`kind:40003`), a reaction
 * (`kind:7`) and a resolution (`kind:9101`) name the *comment* by `e` and not
 * the file, so they cannot be asked for until the comment ids are known. A
 * widget that never draws comments should not pay for that, so a consumer
 * that draws a conversation asks here with the ids it has — the roots off the
 * object, the replies off its thread read — and pays once for both.
 *
 * Three rules, each from the ticket that established it:
 *
 * - **Edits fold newest-wins** (CON-8). The original stays on the relay and so
 *   does every edit; the fold is the reader's, and this is it.
 * - **Reactions have a horizon of {@link REACTION_HORIZON} targets** (SPEC
 *   §6.6, CON-1) — the *newest* targets by `at`, one budget across whatever
 *   id spaces the caller mixes, and the number left out is reported. Edits
 *   and resolutions have no horizon: they are one event per change, not one
 *   per reader.
 * - **A resolution is a `kind:9101` carrying `t=resolution`** (PEEK-128); its
 *   `action` tag is the state, its content the rationale, and a second `e`
 *   marked `support` names the reply that carried it.
 *
 * Nothing here checks who wrote an edit against who wrote the comment. The
 * relay adjudicates writes; a `40003` it stored is one it accepted.
 */
export async function commentDecorationsOf(
  targets: readonly { id: string; at: number }[],
  query: QueryFn,
): Promise<CommentDecorations> {
  const byId: Record<string, CommentDecoration> = {}
  const unique = new Map<string, number>()
  for (const t of targets) if (!unique.has(t.id)) unique.set(t.id, t.at)
  for (const id of unique.keys()) byId[id] = { reactions: [], resolutions: [] }
  if (unique.size === 0) return { byId, reactionTargetsOmitted: 0 }

  const ids = [...unique.keys()]
  // Newest first, ties on the higher id so the cut is stable between reads.
  const forReactions = [...unique]
    .sort((a, b) => b[1] - a[1] || (a[0] > b[0] ? -1 : 1))
    .slice(0, REACTION_HORIZON)
    .map(([id]) => id)

  const filters: Record<string, unknown>[] = []
  const chunked = (list: string[]) => {
    const out: string[][] = []
    for (let i = 0; i < list.length; i += DECORATION_TARGETS_PER_FILTER) {
      out.push(list.slice(i, i + DECORATION_TARGETS_PER_FILTER))
    }
    return out
  }
  for (const chunk of chunked(ids)) {
    filters.push({ kinds: [KIND_MESSAGE_EDIT, KIND_ASSERTION], '#e': chunk, limit: RELAY_PAGE_CEILING })
  }
  for (const chunk of chunked(forReactions)) {
    filters.push({ kinds: [KIND_REACTION], '#e': chunk, limit: RELAY_PAGE_CEILING })
  }

  const seen = new Set<string>()
  const edits = new Map<string, SignedEvent>()
  for (let start = 0; start < filters.length; start += MAX_FILTERS_PER_QUERY) {
    const events = await query(filters.slice(start, start + MAX_FILTERS_PER_QUERY))
    for (const event of events) {
      if (seen.has(event.id)) continue
      seen.add(event.id)
      /*
        The `e` that names one of *our* targets. A resolution carries a second
        `e` for its supporting reply, and an edit written by another app may
        carry more; the first `e` is not necessarily the target.
      */
      const target = event.tags.find((t) => t[0] === 'e' && t[1] in byId && !t[3])?.[1]
      if (!target) continue
      const into = byId[target]
      if (event.kind === KIND_MESSAGE_EDIT) {
        const current = edits.get(target)
        if (!current || byOrder(current, event) < 0) edits.set(target, event)
      } else if (event.kind === KIND_REACTION) {
        if (!forReactions.includes(target)) continue
        into.reactions.push({ id: event.id, emoji: event.content, by: event.pubkey, at: event.created_at })
      } else if (event.kind === KIND_ASSERTION) {
        if (tagValue(event, 't') !== 'resolution') continue
        const action = tagValue(event, 'action')
        if (action !== 'resolved' && action !== 'reopened') continue
        const support = event.tags.find((t) => t[0] === 'e' && t[3] === 'support')?.[1]
        into.resolutions.push({
          id: event.id,
          action,
          by: event.pubkey,
          at: event.created_at,
          ...(event.content ? { message: event.content } : {}),
          ...(support ? { supportingEventId: support } : {}),
        })
      }
    }
  }
  for (const [target, event] of edits) {
    byId[target].edit = { body: event.content, at: event.created_at, by: event.pubkey }
  }
  const oldestFirst = (a: { at: number; id: string }, b: { at: number; id: string }) =>
    a.at - b.at || (a.id < b.id ? -1 : 1)
  for (const decoration of Object.values(byId)) {
    decoration.reactions.sort(oldestFirst)
    decoration.resolutions.sort(oldestFirst)
  }
  return { byId, reactionTargetsOmitted: ids.length - forReactions.length }
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

/**
 * What invoking an action does, coarsely enough for a caller to decide whether
 * to ask first (RFC 0.4 §13.4).
 *
 * Closed, and the closure is the point: a value only means something if every
 * consumer reads it the same way.
 *
 * | | |
 * | --- | --- |
 * | `safe` | changes nothing an author would mind — invoking unprompted is fine |
 * | `writes` | publishes a change somebody will see |
 * | `destructive` | removes or supersedes something |
 *
 * **Only an explicit `safe` may be read as safe.** Absent, unrecognised, or
 * from a manifest published before this field existed all mean *unknown*, and
 * unknown has to fall on the cautious side — a consumer testing
 * `effect !== 'destructive'` gets `true` for a manifest that never said, which
 * is the wrong direction to be wrong in. That is why {@link withKnownEffect} drops
 * a value outside this set rather than passing it through: an unrecognised
 * effect is not a fourth meaning, it is a consumer that does not understand
 * this manifest yet.
 */
export type ActionEffect = 'safe' | 'writes' | 'destructive'

export const ACTION_EFFECTS: readonly ActionEffect[] = ['safe', 'writes', 'destructive']

/** An action the owning app says other apps may perform. */
export interface ManifestAction {
  id: string
  label: string
  /**
   * Prose aimed at a machine, distinct from `label`, which is a button caption
   * (RFC 0.4 §13.4).
   *
   * "Change status" tells a person which button to press and tells a caller
   * choosing *between* actions nothing at all. It was taken early because
   * adding a field costs a line and adding one after several apps have
   * published manifests is a migration across every one of them — a manifest is
   * republished by its owner alone. The same argument `emits.alsoRead` makes one
   * level down.
   *
   * **Something reads it now.** Peek's launcher selects an action from a
   * conversation by matching on this prose (INT-5), across every manifest it can
   * resolve. So a `description` written for a screen is not merely unused, it is
   * an action a caller never picks — a failure with no error in it.
   * {@link actionProblems} is the check to run before signing.
   */
  description?: string
  /** See {@link ActionEffect}. */
  effect?: ActionEffect
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
  input?: {
    type: string
    /** For a scalar input: the vocabulary its value must come from. */
    enum?: string
    /**
     * For `type: 'object'`: the fields a consumer draws, and which are required.
     *
     * **A property's name is the tag its value is written to** (PRO-4). That
     * rule was implicit — Ship's `add-issue` declares `{ title }` and a Ship
     * issue carries `["title", …]`, so it held by coincidence of naming and
     * nothing said so. It is stated here because a consumer cannot construct
     * the event without it, and RFC 0.4 §13.4 asserts the existing declaration
     * is already sufficient for one to try.
     *
     * **A property may instead target the event's `content`** — PRO-18. That
     * limit used to be recorded here as one designed around: *"nothing can
     * target an event's `content`"*. It is what made a conversation
     * undeclarable, because a message with its body in a tag is not a message,
     * and the empty `actions: []` in Peek's manifest says so in its own words.
     *
     * At most one property may do it. Two would be two writers of one field,
     * and the second silently winning is exactly the shape of bug this
     * vocabulary exists to make impossible.
     */
    properties?: Record<string, { type?: string; enum?: string; target?: 'content' }>
    required?: string[]
  }
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
/** One field of an object-creating action's form. */
export interface ActionFormField {
  /** Also the tag its value is written to — see {@link ManifestAction.input}. */
  name: string
  type: string
  required: boolean
  /**
   * Written to the event's `content` rather than to a tag — PRO-18.
   *
   * Absent for every field that is a tag, which is nearly all of them. A
   * consumer may use it to draw prose instead of a single line; it does not
   * have to, and one that ignores it still publishes the right event.
   */
  target?: 'content'
  /** When the property names a vocabulary, its entries, already looked up. */
  options?: { value: string; label: string; colour?: string }[]
}

export interface ResolvedAction {
  id: string
  label: string
  /** See {@link ManifestAction.description}. Carried through, never rendered here. */
  description?: string
  /**
   * See {@link ActionEffect}. Absent when the manifest did not say, or said
   * something this version does not recognise — both meaning *unknown*.
   */
  effect?: ActionEffect
  /**
   * The control a consumer draws. `confirm` is a deletion (FOL-33): one button
   * that asks first and takes no value, because the action emits NIP-09's
   * `kind:5` and there is nothing to type. Added in 0.25.0 — a consumer that
   * switches on this and falls through to a text input must not draw one for
   * it.
   */
  control: 'select' | 'pubkey' | 'text' | 'form' | 'confirm'
  /** For `select`: the declared vocabulary, already looked up. */
  options?: { value: string; label: string; colour?: string }[]
  /**
   * For `form`: the fields to draw, in declaration order, with any vocabulary
   * already looked up — the same service `options` performs for a `select`.
   */
  fields?: ActionFormField[]
  /**
   * For `form`: that the new object hangs under the one the action was invoked
   * on (`emits.toAddressOf: 'self'`).
   *
   * Surfaced because it is the other half of "needs a form **and a parent**",
   * which is what made these unrenderable: a consumer drawing only the
   * properties would publish an orphan.
   */
  createsUnder?: string
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
  /**
   * Which aspect of *every* file this app renders — RFC 0.5 §10.7's one
   * protocol change, and the field that tells a generic app from a specialized
   * one that happens to draw a card.
   *
   * A specialized app owns kinds and says nothing here. A generic app owns no
   * kinds and declares the one aspect it renders for everyone else's files:
   * `conversation` (Peek) or `document` (Leaf). See {@link ASPECTS}.
   *
   * What it is read for today: the bare file (§6.7) has no owner and so no
   * `web` template of its own, and the app that renders its conversation is
   * where a link to it should land. Nothing else consults it yet.
   */
  aspect?: string
}

/**
 * The aspects a generic app may declare — RFC 0.5 §10.2's three parts of a
 * file, minus `properties`, which is what a *type* adds and so what a
 * specialized app owns rather than something a generic one renders.
 */
export const ASPECTS = ['conversation', 'document'] as const
export type Aspect = (typeof ASPECTS)[number]

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
    /*
      Three shapes now, where there were two.

      A field-setting change and a comment each render as one control. An action
      that creates a whole new object was skipped, because it "needs a form and
      a parent" — and that was true right up until something drew one. It is
      the single most useful cross-app action there is, so the manifest could
      describe it and no app could offer it (PRO-4).
    */
    const isChange = !!action.emits.field
    const isComment = action.emits.scope === 'address'
    const isCreation = action.input?.type === 'object' && !!action.input.properties
    // Four, since 0.25.0. Decided by the kind before the other three, so a
    // manifest that put `scope: 'address'` on its deletion — the target *is*
    // an address — is not mistaken for a comment.
    const isDeletion = action.emits.kind === KIND_DELETION
    if (!isDeletion && !isChange && !isComment && !isCreation) continue

    if (isDeletion) {
      out.push({
        id: action.id,
        label: action.label,
        ...(action.description ? { description: action.description } : {}),
        ...(action.effect ? { effect: action.effect } : {}),
        control: 'confirm',
      })
      continue
    }

    if (isCreation) {
      const properties = action.input!.properties!
      const required = new Set(action.input!.required ?? [])
      out.push({
        id: action.id,
        label: action.label,
        ...(action.description ? { description: action.description } : {}),
        ...(action.effect ? { effect: action.effect } : {}),
        control: 'form',
        fields: Object.entries(properties).map(([name, spec]) => ({
          name,
          type: spec.type ?? 'string',
          required: required.has(name),
          /*
            Where the value is written, when it is not a tag — PRO-18.

            Carried rather than acted on here. A consumer that ignores it still
            publishes a correct event, because `buildCreationEvent` is what
            places the value; what this buys a consumer is knowing the field is
            a body rather than a label, which is the difference between drawing
            a one-line input and drawing prose.
          */
          ...(spec.target ? { target: spec.target } : {}),
          ...(spec.enum && manifest.vocabularies?.[spec.enum]
            ? {
                options: manifest.vocabularies[spec.enum].map((v) => ({
                  value: v.value,
                  label: v.label,
                  colour: v.colour,
                })),
              }
            : {}),
        })),
        // The parent is not a property and never appears in `properties`; it
        // comes from `emits`, and a form that omitted it would publish an
        // orphan the owning app cannot show anywhere.
        ...(action.emits.toAddressOf ? { createsUnder: action.emits.toAddressOf } : {}),
      })
      continue
    }

    const vocab = action.input?.enum ? manifest.vocabularies?.[action.input.enum] : undefined
    out.push({
      id: action.id,
      label: action.label,
      ...(action.description ? { description: action.description } : {}),
      ...(action.effect ? { effect: action.effect } : {}),
      control: vocab ? 'select' : action.input?.type === 'pubkey' ? 'pubkey' : 'text',
      options: vocab?.map((v) => ({ value: v.value, label: v.label, colour: v.colour })),
      current: action.emits.field ? folded[action.emits.field]?.value : undefined,
      field: action.emits.field,
    })
  }
  return out
}

/**
 * NIP-29 group metadata — the relay's own record for a channel.
 *
 * Named here because {@link folderOf} keys on it, and a bare `39000` in that
 * one comparison would read as an app's kind rather than as the relay's.
 */
export const KIND_CHANNEL_METADATA = 39000

const tagValue = (e: SignedEvent, name: string) => e.tags.find((t) => t[0] === name)?.[1]

/**
 * Which Folder an object belongs to — both spellings, in one place.
 *
 * **This lived in Peek and had to move** (PRO-18). Its comment there said so:
 * reading only `h` made five of Ship's fifteen projects unactionable, because
 * a record published globally names its Folder with `buzz-channel` instead,
 * and the fix "does belong one layer down in the runtime, where every consumer
 * would get it rather than each discovering it". This is that layer. Both tags
 * are the relay's and NIP-29's, so knowing them is not knowing what any app
 * is.
 *
 * **0.13.0 had a third case as manifest vocabulary and 0.14.0 withdrew it.** A
 * manifest could declare `records.folder: "identifier"`, meaning *my objects
 * are containers, so the Folder is the object's own `d`*. The withdrawal was
 * right and stands: its only instance was a Peek topic, RFC 0.5 §1 retires
 * that shape, and a vocabulary field whose only instance is going away is one
 * every future producer has to read and none can use.
 *
 * **What the withdrawal took with it was a working feature, and nothing
 * noticed because nothing had declared the field yet** (INT-9). A channel
 * record names no Folder by either tag above, so every write aimed at one is
 * refused for having nowhere to go — which is why Peek can declare no action on
 * a topic, four days after PRO-18 concluded a conversation had become
 * declarable. Measured on production 2026-09-08: **0 of 40 `kind:39000` events
 * carry `h` or `buzz-channel`, and 40 of 40 carry `d`.**
 *
 * So the third case comes back **as protocol rather than as vocabulary**, which
 * is the distinction 0.14.0 was actually about. A `kind:39000` is NIP-29 group
 * metadata, relay-signed, and its `d` *is* the channel id — buzz's `NOSTR.md`
 * §"Group metadata" states it, `channel_info_from_event` reads it, and the
 * relay's `h_grammar` is the same uuid. Nobody declares that and no producer
 * can opt out of it, exactly like `h` and `buzz-channel` above. It asks nothing
 * of any manifest, so it cannot be the field that every future producer reads
 * and none can use.
 *
 * **It is the last of the three to fire, and it goes quiet on its own.** FOL-3
 * makes a topic a file that carries an `h`; from that day the first clause
 * answers and this one is unreachable. A shape retired by a model change should
 * decay into dead code, not into a wrong answer — which is what the `??` order
 * buys and what the "still resolves after FOL-3" test pins.
 *
 * Narrow on purpose: **`kind:39000` and nothing else.** Not "any addressable
 * kind", which would hand every `30000`–`39999` record its own `d` as a Folder
 * and put a consumer's write in a channel that may not exist. An addressable
 * kind that is not the relay's channel record still answers `null` below, and a
 * test holds that line.
 *
 * Returns `null` when nothing says — which is a real answer. An object with no
 * Folder has nowhere for a write to go, and guessing at one publishes into
 * somebody else's channel.
 */
export function folderOf(root: SignedEvent): string | null {
  if (root.kind === KIND_CHANNEL_METADATA) {
    return tagValue(root, 'h') ?? tagValue(root, 'buzz-channel') ?? tagValue(root, 'd') ?? null
  }
  return tagValue(root, 'h') ?? tagValue(root, 'buzz-channel') ?? null
}

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

/** The addresses a body names by `nostr:naddr…`; a pointer that will not decode is prose. */
function namedInBody(body: string): Set<string> {
  const addresses = new Set<string>()
  for (const naddr of findNaddrs(body)) {
    try {
      addresses.add(pointerToAddress(decodeNaddr(naddr)))
    } catch {
      // A malformed pointer is prose.
    }
  }
  return addresses
}

/**
 * Is this event a *comment* on the address, rather than a message elsewhere
 * that merely names it?
 *
 * Both arrive by the object's `#a` read — the `a` tag is the index of every
 * reference, whichever strength — and SPEC §6.4 says an app MUST NOT present
 * the two as one list: a comment is the object's own discussion, a mention is
 * *Mentioned in*. Until CON-15 this package handed the raw `#a` union to
 * {@link resolveForeignObject}'s `comments` and {@link conversationsOf}, and
 * a widget said "3" beside an issue with one comment and two mentions. The
 * rule is §6.4's per-tag one, applied per kind (CON-13, CON-14):
 *
 * - A `kind:1111`'s uppercase `A` is the comment — NIP-22's thread root. One
 *   whose `A` is another file is that file's conversation; its `a` for this
 *   one is the index of a reference. One with no `A` at all is read by its
 *   `a`, the way §6.4 says to read it rather than drop the thread.
 * - Any other comment kind has no `A`, so its `a` is read against its body.
 *   A `kind:9` whose body names the address is the index of that reference —
 *   what Peek writes for every `[`-menu reference in a topic message — and a
 *   mention. One whose body does not is the anchor of a comment written
 *   before REW-10 moved comments to `1111`, which is not replaceable and so
 *   reads as a comment for good.
 *
 * `commentDecorationsOf` is deliberately not behind this: a reaction or a
 * status on a comment is about the *comment*, whatever that comment is about.
 */
function isCommentOn(event: SignedEvent, address: string): boolean {
  if (event.kind === KIND_COMMENT) {
    const roots = event.tags.filter((t) => t[0] === 'A' && t[1])
    return roots.length > 0 ? roots.some((t) => t[1] === address) : hasTagValue(event, 'a', address)
  }
  return hasTagValue(event, 'a', address) && !namedInBody(event.content).has(address)
}

/**
 * A manifest event's `content`, or null when it is not parseable JSON.
 *
 * Deliberately not a validator. A manifest is another app's declaration and
 * this layer's whole posture is to render what it is given — a field this
 * version does not recognise is a newer app, not a broken one, and dropping
 * unknown structure would make the layer refuse the future.
 *
 * `effect` is the one exception, and only because misreading it is unsafe
 * rather than merely wrong. See {@link ActionEffect}.
 */
function parseManifest(event: SignedEvent): Manifest | null {
  try {
    const manifest = JSON.parse(event.content) as Manifest
    if (manifest?.actions) manifest.actions = manifest.actions.map(withKnownEffect)
    return manifest
  } catch {
    return null
  }
}

/**
 * An action whose `effect` this version understands, or one with none.
 *
 * A value outside {@link ACTION_EFFECTS} is dropped rather than carried,
 * because every way of reading an unrecognised effect is a claim nobody made.
 * Absent already means "unknown, be careful"; leaving `"nuke"` in place would
 * let a consumer's `effect !== 'destructive'` answer *true* about an action
 * whose own manifest was trying to warn it.
 */
function withKnownEffect(action: ManifestAction): ManifestAction {
  if (action.effect === undefined) return action
  if (ACTION_EFFECTS.includes(action.effect)) return action
  const { effect: _dropped, ...rest } = action
  return rest
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
  /**
   * NIP-89 `web` template, `<bech32>` not yet substituted.
   *
   * The owning app's, for every kind that has an owner. For the bare file it
   * is the template of the app that renders its *conversation* — the one
   * place a link to an ownerless file can honestly land (FOL-17). Absent when
   * no app has declared that aspect.
   */
  webTemplate?: string
}

/**
 * The bare file — `kind:30840`, SPEC §6.7, decided in RFC 0.5 §10.7.
 *
 * A file **no app owns**: a `d`, a `title`, the `h` of the team it lives in, at
 * most one `a` naming the file it sits under, and a §13.3 block document (or
 * nothing) for content. A Peek topic is one. Typed kinds — a project, an issue
 * — add properties on top of this; the bare file adds none, which is exactly
 * why no app may claim it: NIP-89 ownership is keyed by kind, and an app that
 * owned the bare file would own every subject nobody has built an app for.
 *
 * So its projection lives **here, in the runtime, and not on the relay.** A
 * consumer resolving a `30840` gets this manifest before NIP-89 is consulted
 * at all — no `kind:31990` anywhere can override it. That is the test the
 * ticket names: remove every published manifest and a bare file still
 * resolves, lists its comments, and names its parent.
 *
 * The one thing the relay *is* asked is where to open it (FOL-17). An
 * ownerless file has no `web` template of its own, so the link goes to the
 * app that has declared it renders every file's conversation — Peek — read
 * off its manifest's `aspect` field by {@link resolveAspectApp}. With no such
 * manifest published the file still resolves; it just has nowhere to open.
 *
 * Its conversation is `kind:1111` anchored at its address, the shape a Ship
 * issue's comments already have, so `commentKindsOf` needs no special case.
 * Its changes are the ecosystem's `kind:1851` with the same fold rule Ship
 * declares, so a rename or a re-parent by somebody other than the author
 * folds the way an issue's `project` field does — a root tag seeds the value,
 * a change event overrides it.
 *
 * `name` is what a consumer prints where it would print the owning app's
 * name. "File" rather than "Bare file", because that word is for the
 * specification and a person looking at a card next to a Ship issue is better
 * served by the plain noun.
 */
export const KIND_BARE_FILE = 30840

/**
 * Where a `ResolvedManifest.address` would name the manifest event, this names
 * the section of the specification the manifest is built from. Not an address,
 * and deliberately not shaped like one — a consumer that tried to fetch it
 * should fail loudly rather than find something.
 */
export const BARE_FILE_MANIFEST_ADDRESS = 'spec:6.7'

const BARE_FILE_MANIFEST: Manifest = {
  name: 'File',
  about: 'A file no app owns. Its conversation is what every file has; its type adds nothing.',
  records: {
    changeKind: 1851,
    targetTag: 'a',
    fieldTag: 'field',
    valueTag: 'value',
    order: ['ts', 'created_at', 'id'],
    rule: 'last-write-wins-per-field',
    hiddenWhen: { field: 'archived', equals: 'true' },
  },
  projections: {
    [String(KIND_BARE_FILE)]: {
      widget: 'card',
      slots: {
        title: { tag: 'title', fold: 'title' },
        body: { field: 'content' },
        // A bare file may hold bare files — a sub-topic under a topic. Children
        // of *other* kinds are found the other way round, by their own `a`
        // (`parentRefOf` below), which is FOL-4's generic direction; this slot
        // is the one the existing `list` machinery can draw today.
        list: { children: { kind: KIND_BARE_FILE, via: 'a', limit: 200 } },
      },
    },
    /*
      A comment is drawn from here for the same reason a bare file is: no app
      owns `kind:1111` (NIP-22, and SPEC §6.4 — every app writes it and none
      claims it with a `k` tag), so a link to one resolves through no manifest
      on the relay. Before FOL-38 `resolveForeignEvent` on a comment answered
      null, and a pasted thread link stayed a plain link. Drawn the way Peek
      draws a `kind:9` — the author as the title, the text as the body — so a
      consumer that already has a `message` widget draws a comment with it.
    */
    [String(KIND_COMMENT)]: {
      widget: ['message', 'card'],
      slots: {
        title: { field: 'pubkey', as: 'pubkey' },
        body: { field: 'content' },
      },
    },
  },
  /*
    Three actions, and the manifest is the only place a consumer learns of any
    of them (FOL-33). A Peek page offering Rename and Delete on a bare file and
    nothing on a Ship issue does so because *this* list says `rename` and
    `delete` and Ship's does not — never because the kind is 30840. The rule is
    the one FOL-31 set for `comment`: a control is drawn from a declaration.

    `rename` is a `kind:1851` change to the `title` field, not a re-publish of
    the `30840`. The title slot already folds `title`, so a rename by anyone in
    the team lands for every reader the way a re-parent does; a re-publish
    could only ever be the author's, because a `30840` from another pubkey is a
    different address and not a refusal. `delete` is NIP-09's `kind:5` naming
    the address — the relay decides who may (the author, or the owner of an
    authoring agent; SPEC §6.5), so a consumer offers it and reports the answer
    rather than judging first.
  */
  actions: [
    {
      id: 'comment',
      label: 'Comment',
      description:
        'Say something about this file. The comment lands in the team Folder the file lives in, ' +
        'and is what every reader of the file sees under it.',
      effect: 'writes',
      appliesTo: [String(KIND_BARE_FILE)],
      emits: { kind: KIND_COMMENT, scope: 'address' },
      input: { type: 'string' },
    },
    {
      id: 'rename',
      label: 'Rename',
      description:
        'Give this file a new title. A change event, so anyone in the team may, and every app ' +
        'reading the file folds it into the title.',
      effect: 'writes',
      appliesTo: [String(KIND_BARE_FILE)],
      emits: { kind: 1851, field: 'title' },
      input: { type: 'string' },
    },
    {
      id: 'delete',
      label: 'Delete',
      description:
        'Ask the relay to delete this file. The relay decides — only its author, or the owner of ' +
        'an agent that wrote it, may — and its comments stay as separate events.',
      effect: 'destructive',
      appliesTo: [String(KIND_BARE_FILE)],
      emits: { kind: KIND_DELETION },
    },
  ],
}

function bareFileManifest(): ResolvedManifest {
  return { manifest: BARE_FILE_MANIFEST, address: BARE_FILE_MANIFEST_ADDRESS, viaRecommendation: false }
}

/**
 * How many handler events a sweep of the relay asks for.
 *
 * Every published manifest, in one filter: there are a handful per workspace,
 * and the two readers that need all of them at once — a folder read by
 * containment, and the bare file's opener below — are the two that cannot ask
 * by kind.
 */
const HANDLER_SWEEP_LIMIT = 50

/**
 * The app that renders one aspect of every file, by its manifest's `aspect`.
 *
 * NIP-89 discovery is by kind, and a generic app owns none — so it cannot be
 * found with `#k`, and there is no author to ask for a recommendation, because
 * the question is not "who owns this" but "who draws its conversation". The
 * only way to find it is to read every manifest and look, which is the same
 * sweep a folder read by containment already does.
 *
 * Newest wins when several declare the same aspect, for the reason the `#k`
 * fallback gives: there is no principled ranking without a recommendation.
 * SPEC §6.7 reserves the file author's `kind:31989` for `30840` as that
 * recommendation, and it is still not read; the day two conversation apps
 * exist is the day it needs to be.
 *
 * Memoised under a key of its own rather than per pointer: the answer does
 * not depend on whose file is being opened, so one entry serves every bare
 * file the cache ever sees.
 */
async function resolveAspectApp(
  aspect: Aspect,
  query: QueryFn,
  cache?: ProjectionCache,
  // Which `web` template to read off the opener: a file opens by its `naddr`,
  // a comment in it by its `nevent`. An app may publish one string for both,
  // as Peek does, or two.
  entity: 'naddr' | 'nevent' = 'naddr',
): Promise<ResolvedManifest | null> {
  const key = `aspect:${aspect}:${entity}`
  const now = Date.now()
  const memo = cache?.lookup(key, now)
  if (memo) return memo.value

  const handlers = await query([{ kinds: [KIND_HANDLER_INFORMATION], limit: HANDLER_SWEEP_LIMIT }])
  let answer: ResolvedManifest | null = null
  for (const candidate of [...handlers].sort((a, b) => b.created_at - a.created_at)) {
    const manifest = parseManifest(candidate)
    if (manifest?.aspect !== aspect) continue
    const template = webTemplate(candidate, entity)
    // Declaring the aspect and publishing nowhere to open a file is a manifest
    // this consumer has no use for yet; keep looking rather than answer with
    // an app that cannot be linked to.
    if (!template) continue
    answer = {
      manifest,
      address: `${candidate.kind}:${candidate.pubkey}:${tagValue(candidate, 'd') ?? ''}`,
      viaRecommendation: false,
      webTemplate: template,
    }
    break
  }
  cache?.remember(key, answer, now)
  return answer
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
 * What a batch read groups its manifest lookups by.
 *
 * `kind:pubkey` for an owned kind — the author's recommendation is part of the
 * answer, so two authors may resolve to two apps. The bare file has no owner
 * and no recommendation to consult, so its key is the kind alone: one lookup
 * for every topic in a folder, whoever started them.
 */
function manifestKeyOf(pointer: AddressPointer): string {
  return pointer.kind === KIND_BARE_FILE ? String(KIND_BARE_FILE) : `${pointer.kind}:${pointer.pubkey}`
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
  // Before the cache, not only before the network: a bare file's manifest is
  // a constant, and memoising it per author would be one entry per person who
  // ever started a topic. The projection costs zero round trips; the one it
  // pays is for *where to open the file*, which no built-in constant can
  // answer — it is whichever app has declared it renders the conversation —
  // and that answer is memoised once for every bare file (`resolveAspectApp`).
  // A comment resolves through the built-in manifest as a bare file does, and
  // opens in the same app — the one that renders every file's conversation
  // is the one that can show a thread in it (FOL-38).
  if (pointer.kind === KIND_BARE_FILE || pointer.kind === KIND_COMMENT) {
    const opener = await resolveAspectApp('conversation', query, cache, pointer.kind === KIND_COMMENT ? 'nevent' : 'naddr')
    return opener?.webTemplate
      ? { ...bareFileManifest(), webTemplate: opener.webTemplate }
      : bareFileManifest()
  }
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
 * in RFC 0.4 §13.1 makes `records` mandatory — but SPEC §7 did, and that is the
 * document a stranger implements from. It said an app **MUST** publish a
 * manifest whose content carries `records` and `projections`, so the code was
 * right and the specification was wrong, in a way that would have made anyone
 * following the text declare change events they do not have. SPEC §7.1 now says
 * `records` is OPTIONAL and states the consumer's obligation as a MUST: render
 * the projection, treat every `fold` slot as absent, fall through to its
 * `default`, and do not refuse (PRO-12).
 *
 * The citation is corrected in place rather than deleted because the two
 * documents disagreeing is the thing worth remembering: reasoning from the RFC
 * alone reached the right behaviour and the wrong justification.
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

/**
 * SPEC §13.4's content format — **re-exported from `@estiva-app/protocol`.**
 *
 * These were defined here first, because the projection layer is what needed
 * them: a slot has to tell a consumer which model its value is in. Reading a
 * tag off an event turned out to be a question about the *event* rather than
 * about the slot, and two folds outside this layer now need it — Ship's and the
 * agent's, one fold in two repositories held to a single recorded state. Making
 * either depend on the projection layer to read a tag is the wrong direction,
 * and a second copy of `'estiva-blocks-1'` is what the protocol package exists
 * to prevent.
 *
 * So the definitions moved down and this re-exports them. **Nothing this
 * package published has changed** — same names, same values, same behaviour.
 */
export {
  type ContentFormat,
  CONTENT_FORMAT_TAG,
  BLOCK_DOCUMENT_FORMAT,
  contentFormatOf,
} from '@estiva-app/protocol'
// Re-exporting does not bind the names locally, and this file folds with them.
import { contentFormatOf, type ContentFormat } from '@estiva-app/protocol'

/**
 * The one slot in SPEC §7.2's closed set that means "structured content".
 *
 * Stays here: a *slot* is this layer's subject, and the protocol package has no
 * opinion about which of them carries a body.
 *
 * Named rather than inlined because the runtime keys behaviour on it twice —
 * whether a value carries a content format, and whether it may be truncated —
 * and a consumer reads `slots.body` to find it.
 */
export const BODY_SLOT = 'body'


function foldChanges(changes: SignedEvent[], rule: RecordsRule) {
  const fields: Record<string, { value: string; by: string; at: number; format: ContentFormat }> = {}
  for (const change of [...changes].sort(byOrder)) {
    const field = tagValue(change, rule.fieldTag)
    const value = tagValue(change, rule.valueTag)
    if (!field || value === undefined) continue // a partial change sets nothing
    // The format travels with the *winning* change, not with the object. SPEC
    // §13.4: "an app MUST read the tag from the event it took the value from,
    // never from the object's root" — a description created as marker text and
    // later edited into blocks is a root with no tag and a change with one.
    fields[field] = {
      value,
      by: change.pubkey,
      at: change.created_at,
      format: contentFormatOf(change),
    }
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

/**
 * The shortest `description` that could plausibly distinguish one action from
 * another.
 *
 * A proxy, and a weak one — forty characters of nonsense passes. It is here
 * because the failure it does catch is the common one: a label pasted into the
 * description field, or a two-word caption where a sentence was wanted. Lifted
 * from Ship, which has enforced exactly this privately since PRO-5.
 */
export const MIN_ACTION_DESCRIPTION = 40

/**
 * Why an action is not worth publishing yet, or an empty list when it is.
 *
 * **The producer half of action selection**, and the same division of labour
 * {@link widgetChainProblem} draws for widgets: a consumer must stay safe
 * against a declaration it did not expect, *and* the unusable declaration
 * should not be signed in the first place. Both are needed and they fail
 * differently — a consumer alone cannot tell a bad description from a bad
 * match, and a producer alone cannot know what a consumer required.
 *
 * The failure is silent, which is the whole reason this exists. Peek's launcher
 * matches an action from a conversation on `description` (INT-5) and gates on
 * `effect`; an app whose description restates its label is not rejected
 * anywhere — its actions are simply never the one chosen, and nothing tells
 * anybody. There is no error to find.
 *
 * **Advisory, never fatal, and nothing in resolution calls it.** A weak
 * description is a worse match, not an invalid manifest — refusing to render an
 * app over its prose would be the objection that rules out iframes, wearing a
 * different hat. It is exported so a producer can run it in its own suite, the
 * way Ship does.
 *
 * Returns sentences rather than codes, for {@link widgetChainProblem}'s reason:
 * this is read by a person publishing a manifest, and "invalid description"
 * tells them neither which action nor what to write instead.
 *
 * A list rather than the first problem, because an action carries three
 * independent declarations and fixing them one round-trip at a time is a poor
 * trade for a producer. At most one is reported per declaration: a description
 * that restates its label is told that, not also that it is short.
 */
export function actionProblems(declared: unknown): string[] {
  if (typeof declared !== 'object' || declared === null || Array.isArray(declared)) {
    return ['an action must be an object declaring at least id, label and description.']
  }
  const action = declared as { id?: unknown; label?: unknown; description?: unknown; effect?: unknown }
  const id = typeof action.id === 'string' && action.id.trim() ? action.id.trim() : null
  const label = typeof action.label === 'string' ? action.label.trim() : ''
  const description = typeof action.description === 'string' ? action.description.trim() : ''
  const name = id ? `"${id}"` : 'an action with no id'

  const problems: string[] = []
  if (!id) problems.push('an action must declare an id — it is what a caller names when it picks one.')

  if (!description) {
    problems.push(
      `${name} declares no description. A caller choosing between actions reads that prose and nothing else, so an action without one is one it can never pick. Say what the action makes, for whom, and when it applies.`,
    )
  } else if (label && description.toLowerCase() === label.toLowerCase()) {
    problems.push(
      `${name} gives its label ("${label}") as its description. The label is a button caption the caller already has; the description is what tells it this action rather than another.`,
    )
  } else if (description.length < MIN_ACTION_DESCRIPTION) {
    problems.push(
      `${name} describes itself in ${description.length} characters ("${description}"). That is a caption, not prose a caller can match on — under ${MIN_ACTION_DESCRIPTION} is nearly always a label in disguise.`,
    )
  }

  if (action.effect === undefined || action.effect === null) {
    problems.push(
      `${name} declares no effect, which every consumer must read as *unknown* — so a consumer that only offers safe actions will not offer this one, and one that avoids destructive actions may. Declare ${ACTION_EFFECTS.join(', ')}.`,
    )
  } else if (typeof action.effect !== 'string' || !(ACTION_EFFECTS as readonly string[]).includes(action.effect)) {
    problems.push(
      `${name} declares effect ${JSON.stringify(action.effect)}, which is not one of ${ACTION_EFFECTS.join(', ')}. An unrecognised value is dropped rather than passed through, so this reads as if the field were absent — a typo here is invisible.`,
    )
  }

  /*
    Where a property is written — PRO-18.

    Both of these are producer mistakes a consumer cannot report at the moment
    they matter: `buildCreationEvent` refuses two content fields, but that is a
    person pressing a button and getting a sentence, long after the manifest
    was signed. This is the check that runs before signing.
  */
  const properties = (action as { input?: { properties?: Record<string, unknown> } }).input?.properties
  if (properties && typeof properties === 'object') {
    const targeted: string[] = []
    for (const [property, spec] of Object.entries(properties)) {
      const target = (spec as { target?: unknown } | null)?.target
      if (target === undefined) continue
      if (target !== 'content') {
        problems.push(
          `${name} declares "${property}" targeting ${JSON.stringify(target)}, and the only target is "content". An unrecognised one is ignored, so the value goes to a tag named "${property}" instead — which publishes, and is not where the owner meant it.`,
        )
        continue
      }
      targeted.push(property)
    }
    if (targeted.length > 1) {
      problems.push(
        `${name} writes ${targeted.length} properties to content (${targeted.join(', ')}), and an event has one. A consumer refuses the whole action rather than choosing between them.`,
      )
    }
  }

  return problems
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
   * The content model this value is written in — SPEC §13.4.
   *
   * Set only for a slot whose source can carry a body (`{field: "content"}`, or
   * a `fold` a change event has actually set). **Undefined means the value is
   * not a body at all** — a tag, a seed, a default — not that it is marker
   * text. `'marker'` is what "a body with no declared format" resolves to, and
   * that is permanent rather than a migration state.
   *
   * A consumer rendering `slots.body` must branch on this. Parsing a block
   * document as marker text, or the reverse, is forbidden outright by §13.
   */
  format?: ContentFormat
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

/**
 * A slot's value, and the content model it is written in when it has one.
 *
 * **A `body` slot always has a format; nothing else ever does.**
 *
 * The slot name is what decides, because nothing in the data can. A folded
 * `status` arrives through the same `value` tag a folded description does, and
 * — this is the part I got wrong first — a project's description arrives
 * through a *root tag*, exactly like its title. Ship writes
 * `["description", …]` and leaves `content` empty on purpose, so a reader
 * holding only tags has it without fetching content (`events.ts`). Eleven of
 * fifteen production projects are that shape.
 *
 * So "a tag is a scalar and never a body" was false, and it was false in the
 * common case. The rule is the slot, not the source:
 *
 * - a change event → the format that change declared, else `marker`
 * - a root tag, or the root's `content` → `contentFormatOf(root)`, because both
 *   are the same event and §13.4's tag describes that event's body wherever the
 *   event keeps it
 * - a `default` → `marker`; it is a literal in the manifest, so it is plain
 *   text by construction
 *
 * The one exception is `{field: "content"}`, which reports a format whatever
 * slot it was declared into. That is what keeps the PRO-8 guard below
 * reachable: `{"subtitle": {"field": "content", "truncate": 120}}` is a
 * mis-declaration, and it must not also escape the truncation rule.
 *
 * Everything else reports nothing, and `undefined` means *not a body* rather
 * than *marker*. A consumer reading `slots.body` never needs a fallback.
 */
interface RawSlotValue {
  value: string
  format?: ContentFormat
}

function rawSlotValue(
  spec: SlotSpec,
  root: SignedEvent,
  folded: Record<string, { value: string; format?: ContentFormat }>,
  isBody: boolean,
): RawSlotValue | undefined {
  // `fold` first, and a spec may carry both: a field that starts as a tag on
  // the root event and is then overridden by changes (a project's lead is the
  // case in hand). Reading the tag first would render the value the object was
  // created with forever — which is exactly what someone sees right after
  // reassigning it from here.
  if (spec.fold) {
    const change = folded[spec.fold]
    if (change) return { value: change.value, format: isBody ? (change.format ?? 'marker') : undefined }
    /*
      Nobody has changed this field, so the object's own creation value stands.
      §7.2 rule 2 covers seeding from a tag; `field: "content"` seeds from the
      event body, and the two compose — tag first, then content.

      **Needed because a description is where an app puts its body and `content`
      is where the body goes.** Ship's issue description is
      `fields.description?.value ?? event.content` and its project description
      puts a `description` tag between the two (`fold.ts`), and neither could be
      declared before this. The nearest expressible declarations were both
      wrong in the way §7.2 rule 1 already warns about: `{field: "content"}`
      alone renders the value the object was created with for ever, and
      `{fold: "description"}` alone renders blank for every object nobody has
      edited — which is most of them, and blank reads as "that app is broken"
      (PEE-10).

      The seed tag reports no format: a tag is a scalar. Content does, because
      it is the event's body whatever slot it was declared into — the same rule
      the direct `field: "content"` branch below follows, and what keeps the
      truncation guard reachable.
    */
    const seedTag = firstTag(root, spec.tag)
    if (seedTag !== undefined) return { value: seedTag, format: isBody ? contentFormatOf(root) : undefined }
    if (spec.field === 'content' && root.content !== '') {
      return { value: root.content, format: contentFormatOf(root) }
    }
    if (spec.default === undefined) return undefined
    // A default is a literal in the manifest, not a value any event carries, so
    // it is plain text by construction. Reported as `marker` rather than as
    // nothing so that a `body` always has a format — see below.
    return { value: spec.default, format: isBody ? 'marker' : undefined }
  }
  if (spec.tag) {
    const value = firstTag(root, spec.tag)
    if (value === undefined) return undefined
    return { value, format: isBody ? contentFormatOf(root) : undefined }
  }
  if (spec.field === 'content') return { value: root.content, format: contentFormatOf(root) }
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
  if (spec.field === 'pubkey') return { value: root.pubkey }
  return undefined
}

function resolveSlot(
  spec: SlotSpec,
  root: SignedEvent,
  folded: Record<string, { value: string; format?: ContentFormat }>,
  manifest: Manifest,
  name?: string,
): ResolvedSlot | null {
  const source = rawSlotValue(spec, root, folded, name === BODY_SLOT)

  if (source === undefined || source.value === '') return null
  const raw = source.value

  /*
    PRO-8's rule, now enforceable rather than only written down.

    `truncate` is a plain-text operation. Ship's manifest carried a comment
    saying so and a type that forbade the pairing, but nothing stopped another
    app publishing `{"field": "content", "truncate": 120}` — and the consumer
    would happily slice 120 characters out of a JSON block document and render
    the fragment. That is the PRO-8 defect exactly: output that is wrong and
    cannot tell that it is wrong.

    Marker text is still truncated. It degrades honestly — a cut `**bold` is
    visibly a cut, and 548 published messages are written in it.
  */
  const structured = source.format === 'blocks' || source.format === 'unknown'
  let value = structured ? raw : truncate(raw, spec.truncate)
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
    // Present only on a slot that can carry a body. Absent is the honest shape
    // for a title read from a tag — and it keeps the key out of every existing
    // consumer's deep comparisons, which is not the reason but is a real cost
    // avoided: `format: undefined` is an own property to `deepStrictEqual`.
    ...(source.format ? { format: source.format } : {}),
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
  folded: Record<string, { value: string; format?: ContentFormat }>,
  manifest: Manifest,
): { slots: Record<string, ResolvedSlot>; meta: ResolvedSlot[] } {
  const slots: Record<string, ResolvedSlot> = {}
  const meta: ResolvedSlot[] = []
  for (const [name, spec] of Object.entries(projection.slots)) {
    if (Array.isArray(spec)) {
      for (const one of spec) {
        // An array spec collects into `meta`, so the name it was declared under
        // is not the slot's meaning — nothing in an array is a body.
        const value = resolveSlot(one, root, folded, manifest)
        if (value) meta.push(value)
      }
    } else {
      const value = resolveSlot(spec, root, folded, manifest, name)
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
  /**
   * Whether the owning app declares a child list **and** says how to draw it.
   *
   * For a consumer deciding whether to offer an expander. `children` answers a
   * different question: it is absent until something has actually fetched them,
   * so a folder listing — which deliberately does not, see
   * {@link resolveFolderContents} — cannot use it to tell "has issues" from
   * "nobody asked yet". Without this the only options were a disclosure on
   * every row, including a Peek topic that can never have one, or none at all.
   *
   * Note what it is *not*: a promise that children exist. A project with no
   * issues still declares the list, and expanding it is the honest empty answer
   * rather than a control that was wrong to offer.
   */
  listsChildren?: boolean
  /**
   * The file this one names as its parent, when its app declares the relation.
   *
   * **For a listing that draws nesting.** A folder read by containment lists an
   * app's records by `h`, and Ship writes `h` on an issue as well as on its
   * project — so the project and its issues arrive as peers. Drawing the
   * project's children under it then shows every issue twice: once nested and
   * once at the top level. A consumer cannot tell which files are children,
   * because the tag that says so is named by the *parent kind's* projection and
   * never reaches the consumer.
   *
   * So this is that tag, resolved: the address in the child's own `via` tag.
   * It is set whether or not the parent is in the same listing — whether to
   * nest, hide, or label "in <parent>" is the consumer's decision, and the two
   * cases genuinely differ.
   *
   * Absent for a file whose app declares no such relation, and for a `match:
   * 'identifier'` list, where the child names only the parent's `d` and an
   * address cannot be built from it without inventing a pubkey.
   */
  parentRef?: string
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
  folded: Record<string, { value: string; format?: ContentFormat }>
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
    const raw = field ? rawSlotValue(spec, root, folded, false)?.value : undefined
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
    listsChildren: listsChildrenOf(projection, manifest),
    parentRef: parentRefOf(manifest, pointer.kind, root, folded),
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
    { kinds: commentKinds, '#a': [address], limit: CONVERSATION_LIMIT },
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

    Then narrowed to §6.4's *comment* strength (CON-15): the `a` tag is also the
    index of a mention, and a mention is not this object's discussion. See
    `isCommentOn` for the per-kind rule.
  */
  const comments = events
    .filter((e) => commentKinds.includes(e.kind) && isCommentOn(e, address))
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
/**
 * The child list a projection declares, shape only.
 *
 * Split out so {@link childFilterFor} and {@link ForeignObject.listsChildren}
 * read the *same* declaration. They answer different questions — "what should I
 * fetch" and "is a disclosure control honest" — and a consumer that offered an
 * expander where nothing could ever be fetched would be the second kind of lie
 * this module keeps eliminating.
 */
function declaredChildSpec(projection: {
  slots: Record<string, SlotSpec | SlotSpec[]>
}): { kind: number; via: string; limit?: number; match?: string } | undefined {
  const spec = projection.slots.list
  return !Array.isArray(spec) ? spec?.children : undefined
}

/** Whether the owning app also says how to *draw* that kind. */
function drawsKind(manifest: Manifest, kind: number): boolean {
  return !!manifest.projections?.[String(kind)]
}

/**
 * The parent this file names, per whichever projection claims it as a child.
 *
 * Read off the *parent kind's* declaration rather than the child's, because
 * that is where the relation lives: Ship's project says
 * `list: { children: { kind: 30851, via: 'a' } }`, and nothing on the issue's
 * own projection mentions a project at all.
 *
 * An issue carries several `a` tags in general, so the value is matched on the
 * parent kind's prefix rather than taken positionally — the same reason
 * `conversationCountsOf` reads every `a` tag instead of the first.
 */
function parentRefOf(
  manifest: Manifest,
  kind: number,
  root: SignedEvent,
  folded: Record<string, { value: string }> = {},
): string | undefined {
  /*
    A bare file names its own parent — one `a` tag, any kind — and that is the
    other direction from everything below, where the *parent's* projection
    says which tag on a child points at it. Both are needed: the declared
    direction lets Ship's project list its issues without an issue knowing what
    a project is; this one lets a topic sit under a project, an issue, or a kind
    nobody has met, without that kind's owner declaring bare files as children.
    Re-parenting is a `parent` change event, seeded by the root tag, the way an
    issue's `project` field works (SPEC §6.7).
  */
  if (kind === KIND_BARE_FILE) {
    const moved = folded.parent?.value
    if (moved) return moved
    return root.tags.find((t) => t[0] === 'a' && t[1] && /^\d+:[0-9a-f]{64}:/.test(t[1]))?.[1]
  }
  for (const [parentKind, projection] of Object.entries(manifest.projections ?? {})) {
    const children = declaredChildSpec(projection as { slots: Record<string, SlotSpec | SlotSpec[]> })
    if (!children || children.kind !== kind) continue
    /*
      `match: 'identifier'` names the parent's `d` and not its address. Building
      one would mean assuming the parent shares the child's pubkey, which is the
      kind of guess this module refuses elsewhere — so it stays absent.
    */
    if (children.match === 'identifier') continue
    const found = root.tags
      .filter((t) => t[0] === children.via && t[1])
      .map((t) => t[1])
      .find((value) => value.startsWith(`${parentKind}:`))
    if (found) return found
  }
  return undefined
}

/** Both halves of the question a disclosure control asks. */
function listsChildrenOf(
  projection: { slots: Record<string, SlotSpec | SlotSpec[]> },
  manifest: Manifest,
): boolean {
  const children = declaredChildSpec(projection)
  return !!children && drawsKind(manifest, children.kind)
}

function childFilterFor(args: {
  projection: { widget: string | string[]; slots: Record<string, SlotSpec | SlotSpec[]> }
  manifest: Manifest
  pointer: AddressPointer
  depth: number
}): { filter: Record<string, unknown>; kind: number; via: string; parent: string } | null | undefined {
  const { projection, manifest, pointer, depth } = args
  const children = declaredChildSpec(projection)
  if (!children) return undefined
  // The consumer's budget, not the manifest's — see MAX_LIST_DEPTH.
  if (depth >= MAX_LIST_DEPTH) return null
  // A declared list whose child kind has no projection is not renderable, and
  // an empty list is the honest answer: the objects exist, this app has not
  // said how to draw them.
  if (!drawsKind(manifest, children.kind)) return null

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
    listsChildren: listsChildrenOf(projection, manifest),
    // Same field in both builders: a consumer must not get it on a file read one
    // way and not the other. A child already knows its parent contextually, but
    // an inconsistent shape is what makes a consumer defensive about a value it
    // should be able to trust.
    parentRef: parentRefOf(manifest, root.kind, root),
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
    const raw = statusSpec ? rawSlotValue(statusSpec, event, folded, false)?.value : undefined

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
/**
 * NIP-01's parameterized-replaceable range. An event in it is addressed by
 * `(kind, pubkey, d)`, so one created without a `d` has no address — it cannot
 * be referenced, commented on, or acted upon, and the owning app will not find
 * it where it looks.
 */
const isAddressableKind = (kind: number) => kind >= 30000 && kind < 40000

/**
 * The event an object-creating action publishes.
 *
 * Split out because it shares almost nothing with a change: the tags come from
 * the form rather than from `records`, and the result is a new object rather
 * than a statement about an existing one.
 *
 * **Every refusal names what was allowed**, and that is the requirement rather
 * than a nicety. The owning app cannot enforce any of this — anyone can publish
 * anything — so a consumer that guesses is the one putting junk in a shared
 * record, and a consumer told only "invalid" cannot do better next time.
 */
function buildCreationEvent(args: {
  declared: ManifestAction
  vocabularies?: Manifest['vocabularies']
  address: string
  folder: string
  value: string | Record<string, string>
  newId?: string
  pubkey: string
  createdAtMs: number
}): UnsignedActionEvent | string {
  const { declared, address, folder, value, newId } = args
  const properties = declared.input!.properties!
  const required = declared.input!.required ?? []

  if (typeof value === 'string') {
    return `"${declared.label}" takes a form: ${Object.keys(properties).join(', ')}.`
  }

  const allowed = Object.keys(properties)
  for (const name of Object.keys(value)) {
    if (!allowed.includes(name)) {
      return `"${name}" is not a field of "${declared.label}" — it takes ${allowed.join(', ')}.`
    }
  }
  for (const name of required) {
    if (!value[name]?.trim()) return `"${name}" is required by "${declared.label}".`
  }
  /*
    A property may name a vocabulary of its own, checked exactly as a scalar
    action's is — the honour system does not get weaker because there are
    several fields. Ship declares none today (`add-issue` takes a bare title),
    so this is a path an app grows into rather than one in use.
  */
  for (const [name, held] of Object.entries(value)) {
    const vocabName = properties[name]?.enum
    if (!vocabName || !held) continue
    const vocab = args.vocabularies?.[vocabName] ?? []
    if (!vocab.some((entry) => entry.value === held)) {
      return `"${held}" is not one of ${vocab.map((e) => e.value).join(', ')}.`
    }
  }

  if (isAddressableKind(declared.emits.kind) && !newId) {
    return `Creating a kind ${declared.emits.kind} needs an identifier, and none was supplied.`
  }

  /*
    At most one property may target `content` — PRO-18.

    Checked before anything is built rather than trusted, because two of them
    is a producer bug whose symptom is one field silently disappearing into the
    other. The honour system means a manifest can say this; it does not mean a
    consumer has to publish the result.
  */
  const bodyFields = Object.keys(properties).filter((name) => properties[name]?.target === 'content')
  if (bodyFields.length > 1) {
    return `"${declared.label}" declares ${bodyFields.length} fields writing to content (${bodyFields.join(', ')}), and an event has one.`
  }
  const bodyField = bodyFields[0]

  const tags: string[][] = []
  if (isAddressableKind(declared.emits.kind)) tags.push(['d', newId!])
  // A property's name is the tag it writes, unless it declared `content`. See
  // `ManifestAction.input`.
  for (const [name, held] of Object.entries(value)) {
    if (held !== '' && name !== bodyField) tags.push([name, held])
  }
  // The parent. `toAddressOf: "self"` names the object the action was invoked
  // on; any other value is a shape nothing declares yet, and guessing at one
  // would publish a link the owning app never asked for.
  if (declared.emits.setTag && declared.emits.toAddressOf === 'self') {
    tags.push([declared.emits.setTag, address])
  }
  tags.push(['h', folder])

  return {
    pubkey: args.pubkey,
    created_at: Math.floor(args.createdAtMs / 1000),
    kind: declared.emits.kind,
    tags,
    content: bodyField ? (value[bodyField] ?? '') : '',
  }
}

export function buildActionEvent(args: {
  manifest: { records?: RecordsRule; actions?: ManifestAction[]; vocabularies?: Manifest['vocabularies'] }
  kind: number
  /** Address of the object being acted on. */
  address: string
  /** Author of the object — needed for NIP-22's `P`/`p` tags. */
  objectAuthor: string
  folder: string
  actionId: string
  /**
   * A scalar for a change or a comment; `{ property: value }` for an
   * object-creating action, whose form has several fields.
   */
  value: string | Record<string, string>
  /**
   * A fresh identifier for an object being created, when its kind is
   * parameterized-replaceable and therefore needs a `d`.
   *
   * Supplied rather than generated: ADR 0002 §10 constraint 2 — the runtime
   * reaches for nothing and is handed everything. It also makes the built event
   * a pure function of its inputs, which is what lets a test assert on one.
   */
  newId?: string
  pubkey: string
  createdAtMs: number
}): UnsignedActionEvent | string {
  const { manifest, kind, address, folder, actionId, value } = args
  const records = manifest.records
  const declared = manifest.actions?.find((a) => a.id === actionId)
  if (!declared) return `This app does not offer "${actionId}".`

  const appliesTo = Array.isArray(declared.appliesTo) ? declared.appliesTo : [declared.appliesTo]
  if (!appliesTo.includes(String(kind))) {
    return `"${declared.label}" does not apply to a kind ${kind}.`
  }

  // An object-creating action is a different event entirely — a new object
  // rather than a change to one — so it branches before the scalar path.
  if (declared.input?.type === 'object' && declared.input.properties) {
    return buildCreationEvent({ ...args, declared, vocabularies: manifest.vocabularies })
  }

  if (typeof value !== 'string') {
    return `"${declared.label}" takes a single value, not a form.`
  }

  /*
    A deletion is NIP-09, built from the NIP rather than from the manifest for
    the same reason a comment is: no app owns `kind:5`. The `a` tag names the
    object — the shape for an addressable target, and the branch on which the
    relay checks the actor against the *address's* author rather than one
    event's — and `k` says what kind it was, as the NIP asks. No `h`: the
    request is about the object, not about a channel, and the relay does not
    read one here. Before the fold-rule check because, like a creation, a
    deletion folds nothing.

    The value is ignored rather than refused. A consumer's confirm dialog has
    nothing to pass, and `''` is what it will pass.
  */
  if (declared.emits.kind === KIND_DELETION) {
    return {
      pubkey: args.pubkey,
      created_at: Math.floor(args.createdAtMs / 1000),
      kind: KIND_DELETION,
      tags: [
        ['a', address],
        ['k', String(kind)],
      ],
      content: '',
    }
  }

  /*
    **A fold rule is needed to write a change, and only to write a change.**

    This was the first line of the function, refusing every action of every app
    that declares no `records` — which read as a guard and was a gate on an
    unrelated feature. PRO-12 settled the principle on the read side: *"SPEC
    mandates `records`; the runtime correctly stopped requiring it."* The write
    side never followed, and the tags below are the only place it is used.

    Found by INT-9 against production, and only there: Peek declares no fold
    rule, deliberately — *"a topic's name is a tag the relay wrote, and a
    message is immutable. A consumer that folded nothing would render both
    correctly."* So Peek's first action was refused with "That app does not say
    how its records are written", which is true, irrelevant, and impossible to
    act on. A creation reads nothing and folds nothing; there is nothing for a
    fold rule to say about it.
  */
  if (!records) return 'That app does not say how its records are written.'

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

// ── The folder read model — RFC 0.4 §4 and §5 ───────────────────────────────

/**
 * The Folder as the relay maintains it — RFC 0.4 §12.1.
 *
 * Relay-signed, addressable, and **global**. §4.2 is worth reading before
 * changing that last word: three of the four properties a folder must have are
 * impossible if its state carries an `h`, because `h` files it under a channel
 * and gates reads by access. Exploring folders you are not in, following one,
 * and a file having one home while being referenced from elsewhere all need an
 * address that resolves without membership. So the channel keeps doing access
 * and conversation, and the folder becomes a layer above it.
 *
 * **Read-only here.** A client changes a folder by publishing a `kind:1852`
 * command and the relay emits the new state (§4.1). A folder is not a
 * user-signed event because NIP-01 addressable events are single-signer by
 * construction — the address is `(pubkey, kind, d)`, so a second person adding
 * a file would not replace your folder, they would create a different one.
 */
export const KIND_FOLDER_STATE = 30890

/**
 * NIP-29 group metadata — the Folder's channel.
 *
 * Named here for two unrelated jobs: it carries the folder's `name` before any
 * folder state exists, and its own address is what makes a Peek topic a file
 * like any other (§5.2).
 */
const KIND_CHANNEL = 39000

/** The `name` tag, when there is an event to read it off at all. */
const nameOf = (event: SignedEvent | undefined) => (event ? tagValue(event, 'name') : undefined)

/** One folder, enough to draw a sidebar row. */
export interface FolderSummary {
  /**
   * The folder's uuid. **One uuid, three roles** — the channel id, the `h` on
   * everything in it, and the `d` on both its `39000` and its `30890` (§5.2,
   * measured across all of production's channels).
   */
  id: string
  name?: string
  /** True once the relay maintains state for it, rather than it being a bare channel. */
  hasState: boolean
  /**
   * The folders whose state lists this one as a file — present only when there
   * are any.
   *
   * A channel is addressable (§5.2), so a folder can be placed inside another
   * the way any file is, and Peek's topics are (FOL-22): each is a channel
   * listed by its team's state. A sidebar that drew every channel as a top-level
   * folder would show the team and, beside it, every topic in it. This is what
   * lets a consumer tell the two apart without reading any folder's contents:
   * `listFolders` already holds every state, so the answer is free.
   */
  listedIn?: string[]
}

/** A folder and everything in it, each file drawn through its owner's manifest. */
export interface FolderContents extends FolderSummary {
  /** The folder state's address, absent until a state event exists. */
  address?: string
  /**
   * The files this folder holds.
   *
   * **Peers by construction, not by special case.** A Peek topic and a Ship
   * project sit side by side because both are `a` tags in one list, and §5.2's
   * finding is exactly that one tag type is enough to name either: a channel
   * turned out to be addressable after all, so a topic needs no wrapper and no
   * second mechanism. Nothing in this function knows what either app is.
   *
   * Ordered as the folder lists them. A file that resolved to nothing is
   * **absent rather than marked** — see {@link resolveFolderContents}.
   */
  files: ForeignObject[]
  /**
   * Where the list came from, because the two are not equivalent.
   *
   * `state` is the model. `channel` is the approximation available before a
   * folder has any state: containment inferred from `h`, which can list an
   * app's records and **can never list a topic**, because under `h` the topic
   * *is* the container rather than a thing inside it. A consumer that needs to
   * explain a short list is reading this field.
   */
  source: 'state' | 'channel'
}

/**
 * Every folder this identity can see, for a sidebar.
 *
 * Both shapes in one pass: folders the relay maintains state for, and bare
 * channels that have none yet. A channel with state appears once, named by its
 * state — the folder's name is the folder's to say.
 *
 * **A direct route, deliberately.** §4.2's post-mortem on REW-11 is that
 * discovering children only through their parent loses them when the parent
 * goes; a sidebar built by walking something else would inherit exactly that.
 * This asks for folders by kind.
 */
export async function listFolders(query: QueryFn): Promise<FolderSummary[]> {
  const events = await query([
    { kinds: [KIND_FOLDER_STATE], limit: 500 },
    { kinds: [KIND_CHANNEL], limit: 500 },
  ])
  const byId = new Map<string, FolderSummary>()
  for (const event of events) {
    const id = tagValue(event, 'd')
    if (!id) continue
    const state = event.kind === KIND_FOLDER_STATE
    const existing = byId.get(id)
    // State wins over the channel for the name, whichever order they arrived.
    if (existing && !state) continue
    byId.set(id, {
      id,
      name: tagValue(event, 'name') ?? existing?.name,
      hasState: state || (existing?.hasState ?? false),
    })
  }
  /*
    A folder listed in another folder's state is a file there. Read off the
    states already in hand: an `a` naming a `kind:39000` is a channel, and its
    `d` is the folder's id. Both `KIND_CHANNEL` and the state's own `d` are
    uuids, so no address has to be built to compare them.
  */
  const listedIn = new Map<string, string[]>()
  for (const event of events) {
    if (event.kind !== KIND_FOLDER_STATE) continue
    const container = tagValue(event, 'd')
    if (!container) continue
    for (const tag of event.tags) {
      if (tag[0] !== 'a' || !tag[1]) continue
      const [kind, , identifier] = tag[1].split(':')
      if (Number(kind) !== KIND_CHANNEL || !identifier || identifier === container) continue
      const containers: string[] = listedIn.get(identifier) ?? []
      if (!containers.includes(container)) containers.push(container)
      listedIn.set(identifier, containers)
    }
  }
  await placeRecordChannels(events, byId, listedIn, query)
  for (const [id, containers] of listedIn) {
    const folder = byId.get(id)
    if (folder) folder.listedIn = containers
  }
  return [...byId.values()].sort((a, b) => (a.name ?? a.id).localeCompare(b.name ?? b.id))
}

/**
 * A record's own channel is listed wherever the record is (FOL-42).
 *
 * A state lists a record — a Ship project, say — by its address, and the record
 * names the channel its conversation lives in with {@link folderOf}'s tags. No
 * state lists that channel, so without this `listFolders` reports it placed
 * nowhere, and a consumer folding an unread verdict into the containers of a
 * channel (Peek's team dot) has nowhere to fold it: correct, and drawn
 * nowhere. Measured on production 2026-09-22: of the 43 records the six
 * states list, 23 name a channel other than the state's own and no state lists
 * any of them. This places 21 channels and moves no top-level Folder.
 *
 * Derived rather than published, so it cannot drift: a `kind:1852` adding each
 * channel to its team would have to be repeated by every app that places a
 * record, and would stay wrong the first time one did not.
 *
 * Both of `folderOf`'s spellings, because production has both — about half of
 * Ship's project records carry `buzz-channel` and half an `h` naming their own
 * channel. Nothing here knows either app: the tags are the relay's.
 *
 * Two channels are never placed this way:
 *
 * - **The container itself.** A file published *into* its Folder carries that
 *   Folder's `h` — every Peek file does — and a Folder is not inside itself.
 * - **A channel with state of its own.** That is a Folder in its own right, and
 *   a sidebar draws it as a section exactly when nothing lists it; states place
 *   it, by `kind:1852`, and a tag on some record must not take a section out of
 *   somebody's sidebar. Measured: one project's `buzz-channel` is such a Folder.
 *
 * **One extra request, and a refused one throws** like the Folder read before
 * it. The roots are read in one POST, grouped by `(kind, author)` like
 * `resolveFolderContents` does.
 *
 * 0.28.0 swallowed a refusal and returned the listing without these
 * placements, reasoning that every placement it still reported was true. On
 * production that was the bug it was meant to prevent: Peek reads the listing
 * once per page load, the load is when the relay's budget is most contested,
 * and one refused read on 2026-09-22 left a project's channel unplaced for the
 * whole session — the team's dot dark, and nothing anywhere saying why. A
 * listing missing placements looks exactly like a correct one, so only the
 * caller can recover, and only if it is told. Keeping the last good listing
 * and retrying is the caller's to do.
 */
async function placeRecordChannels(
  events: SignedEvent[],
  byId: Map<string, FolderSummary>,
  listedIn: Map<string, string[]>,
  query: QueryFn,
): Promise<void> {
  const containersOf = new Map<string, { pointer: AddressPointer; containers: string[] }>()
  for (const event of events) {
    if (event.kind !== KIND_FOLDER_STATE) continue
    const container = tagValue(event, 'd')
    if (!container) continue
    for (const tag of event.tags) {
      if (tag[0] !== 'a' || !tag[1]) continue
      let pointer: AddressPointer
      try {
        pointer = referenceToPointer(tag[1])
      } catch {
        continue
      }
      if (pointer.kind === KIND_CHANNEL) continue
      const key = `${pointer.kind}:${pointer.pubkey}:${pointer.identifier}`
      const entry = containersOf.get(key) ?? { pointer, containers: [] }
      if (!entry.containers.includes(container)) entry.containers.push(container)
      containersOf.set(key, entry)
    }
  }
  if (containersOf.size === 0) return

  const groups = new Map<string, { kind: number; pubkey: string; identifiers: string[] }>()
  for (const { pointer } of containersOf.values()) {
    const key = `${pointer.kind}:${pointer.pubkey}`
    const group = groups.get(key) ?? { kind: pointer.kind, pubkey: pointer.pubkey, identifiers: [] }
    group.identifiers.push(pointer.identifier)
    groups.set(key, group)
  }
  const filters: Record<string, unknown>[] = []
  for (const { kind, pubkey, identifiers } of groups.values()) {
    for (let start = 0; start < identifiers.length; start += RELAY_PAGE_CEILING) {
      const chunk = identifiers.slice(start, start + RELAY_PAGE_CEILING)
      filters.push({ kinds: [kind], authors: [pubkey], '#d': chunk, limit: chunk.length })
    }
  }
  const roots: SignedEvent[] = []
  for (let start = 0; start < filters.length; start += MAX_FILTERS_PER_QUERY) {
    roots.push(...(await query(filters.slice(start, start + MAX_FILTERS_PER_QUERY))))
  }

  // Newest wins, as it does for any addressable event a relay has not yet replaced.
  const newest = new Map<string, SignedEvent>()
  for (const root of roots) {
    const key = `${root.kind}:${root.pubkey}:${tagValue(root, 'd') ?? ''}`
    const held = newest.get(key)
    if (!held || root.created_at > held.created_at) newest.set(key, root)
  }
  for (const [key, { containers }] of containersOf) {
    const root = newest.get(key)
    const channel = root && folderOf(root)
    if (!channel || byId.get(channel)?.hasState) continue
    for (const container of containers) {
      if (container === channel) continue
      const placed = listedIn.get(channel) ?? []
      if (!placed.includes(container)) placed.push(container)
      listedIn.set(channel, placed)
    }
  }
}

/**
 * Everything in one folder, resolved through the manifests of the apps that own it.
 *
 * The cross-app read the whole model rests on: given a folder id, list its
 * files whatever kind they are and whoever wrote them, so two apps drawing the
 * same folder show the same things. Both apps consume this rather than either
 * one owning it.
 *
 * ## A file the reader cannot see is absent, not "unavailable"
 *
 * The one rule here that is a product decision rather than a mechanism, and a
 * deliberate divergence from upstream's NIP-MP, whose fold requires the
 * opposite for public repositories. **The count is the disclosure**: a folder
 * that renders three rows and two greyed-out placeholders has told an outsider
 * how much they are missing, which for a folder named after a person is the
 * sensitive part. So an address that resolves to nothing is dropped, and
 * nothing in the return value counts what was dropped.
 *
 * This is why the batch below cannot use {@link resolveForeignObject}
 * unchanged: that returns `unreachable: true` so an inline reference can say
 * "you may not have access", which is right for one pasted link and wrong for
 * a list.
 *
 * ## Round trips do not grow with the folder
 *
 * **Flat in the number of files, linear in the number of apps.** The folder
 * itself, the handler sweep, the contents, one query for every root at once
 * and every change with it, and one for the people — then two more per
 * distinct `(kind, author)` for NIP-89 discovery, which {@link ProjectionCache}
 * memoises away.
 *
 * Measured against production, reading three folders through one cache:
 *
 * | folder | files | cold | warm |
 * | --- | --- | --- | --- |
 * | Shared foundation packages | 24 | 11 | 5 |
 * | Feedback on Peek | 25 | 9 | 5 |
 * | Folders | 9 | 6 | 4 |
 *
 * Twenty-five files and nine cost the same warm, which is the property worth
 * having. A resolve per file would have been four *each* against a relay that
 * meters reads at 300 a minute — a folder of twenty-five would not have loaded.
 */
export async function resolveFolderContents(
  folder: string,
  query: QueryFn,
  /** Defaults to asking the relay. The browser passes a cached lookup. */
  lookupPeople?: PeopleFn,
  /** See {@link ProjectionCache}. Omitting it is exactly the old behaviour. */
  cache?: ProjectionCache,
): Promise<FolderContents> {
  // 1. The folder itself. Both kinds in one trip: the state is the model and
  //    the channel is what names a folder that has none yet.
  const identity = await query([
    { kinds: [KIND_FOLDER_STATE], '#d': [folder], limit: 1 },
    { kinds: [KIND_CHANNEL], '#d': [folder], limit: 1 },
  ])
  const state = identity.find((e) => e.kind === KIND_FOLDER_STATE && tagValue(e, 'd') === folder)
  const channel = identity.find((e) => e.kind === KIND_CHANNEL && tagValue(e, 'd') === folder)

  const summary: FolderSummary & { address?: string } = {
    id: folder,
    name: nameOf(state) ?? nameOf(channel),
    hasState: !!state,
    ...(state
      ? { address: pointerToAddress({ kind: state.kind, pubkey: state.pubkey, identifier: folder, relays: [] }) }
      : {}),
  }

  const { addresses, placed } = state
    ? // §5.2: one tag type lists every file, topics included, with no special
      //  case. The order is the folder's, so it is preserved rather than sorted.
      {
        addresses: [...new Set(state.tags.filter((t) => t[0] === 'a' && t[1]).map((t) => t[1]))],
        placed: new Map<string, SignedEvent[]>(),
      }
    : await addressesByContainment(folder, query)

  if (addresses.length === 0) {
    return { ...summary, files: [], source: state ? 'state' : 'channel' }
  }

  // 2. Group by (kind, author): one manifest answers for every file an app owns
  //    in this folder, and the cache makes the second folder free.
  const pointers = addresses.flatMap((address) => {
    try {
      return [{ address, pointer: referenceToPointer(address) }]
    } catch {
      // An `a` tag nothing can parse is somebody else's bug and not worth a
      // whole folder. Dropped like any other unresolvable file.
      return []
    }
  })
  const groups = new Map<string, { pointer: AddressPointer; addresses: string[] }>()
  for (const { address, pointer } of pointers) {
    const key = `${pointer.kind}:${pointer.pubkey}`
    const group = groups.get(key)
    if (group) group.addresses.push(address)
    else groups.set(key, { pointer, addresses: [address] })
  }

  // Keyed by app rather than by group: the bare file's manifest does not
  // depend on who wrote the file, so a folder of topics from five people
  // resolves it once, cache or no cache.
  const byApp = new Map<string, AddressPointer>()
  for (const { pointer } of groups.values()) byApp.set(manifestKeyOf(pointer), pointer)
  const manifests = new Map<string, ResolvedManifest>()
  await Promise.all(
    [...byApp].map(async ([key, pointer]) => {
      const resolved = await resolveManifest(pointer, query, cache)
      if (resolved) manifests.set(key, resolved)
    }),
  )

  // 3. Every root, and every change against every address, in two filters.
  //    Change kinds are a set because two apps may fold differently, and a kind
  //    is a u16 — the relay refuses an out-of-range one outright, so an app
  //    declaring no `records` contributes no filter rather than an empty one.
  const changeKinds = [
    ...new Set(
      [...manifests.values()].flatMap((r) => (r.manifest.records ? [r.manifest.records.changeKind] : [])),
    ),
  ]
  const events = await query([
    ...[...groups.values()].map(({ pointer, addresses: group }) => ({
      kinds: [pointer.kind],
      authors: [pointer.pubkey],
      '#d': group.map((a) => referenceToPointer(a).identifier),
      limit: group.length,
    })),
    ...(changeKinds.length
      ? [{ kinds: changeKinds, '#a': addresses, limit: 500 }]
      : []),
  ])

  // 4. Build each file, in the order the folder listed them.
  const files: ForeignObject[] = []
  for (const { address, pointer } of pointers) {
    const resolved = manifests.get(manifestKeyOf(pointer))
    // No app claims this kind, so there is no projection to draw it with.
    if (!resolved) continue
    const projection = resolved.manifest.projections?.[String(pointer.kind)]
    if (!projection) continue
    const root = events.find(
      (e) => e.kind === pointer.kind && e.pubkey === pointer.pubkey && tagValue(e, 'd') === pointer.identifier,
    )
    // The disclosure rule. Absent, not "unavailable".
    if (!root) continue

    const records = foldRuleOf(resolved.manifest)
    const folded = foldChanges(
      events.filter((e) => e.kind === records.changeKind && hasTagValue(e, records.targetTag, address)),
      records,
    )
    // An app hiding a record from its own lists is saying it is not part of the
    // folder any more. `hiddenWhen` is the app's own declaration of that.
    if (records.hiddenWhen && folded[records.hiddenWhen.field]?.value === records.hiddenWhen.equals) {
      continue
    }
    /*
      A placed file stays listed only while the placement is current.

      The statement that placed it says "field f of this object is this
      folder". The object's own fold — every change against its address,
      wherever each was published — knows what f is *now*. If the two agree,
      the file is here; if the fold has moved on, somebody has since placed it
      somewhere else and this folder is holding a statement that has been
      superseded, which an append-only stream cannot retract. Ship linking a
      project to a second team is the case: the first team's Folder keeps the
      old statement for ever, and without this check would list the project
      for ever.

      Compared through the app's own field and value tags, so nothing here
      knows the field is called `folder`.
    */
    const placements = placed.get(address)
    if (placements) {
      const current = placements.some((statement) => {
        const field = tagValue(statement, records.fieldTag)
        return field !== undefined && folded[field]?.value === folder
      })
      if (!current) continue
    }
    files.push(
      buildObject({
        root,
        pointer,
        manifest: resolved.manifest,
        projection,
        folded,
        viaRecommendation: resolved.viaRecommendation,
        webTemplate: resolved.webTemplate,
      }),
    )
  }

  const people = await (lookupPeople ?? peopleViaRelay(query))([
    ...new Set(files.flatMap(pubkeysIn)),
  ])
  return {
    ...summary,
    files: files.map((file) => ({ ...file, people })),
    source: state ? 'state' : 'channel',
  }
}

/**
 * The contents of a folder that has no state event — containment by `h`.
 *
 * **The approximation, and it is worth being precise about what it cannot do.**
 * Before folder state exists, the only thing on the wire saying a file is in a
 * folder is the file's own `h` (or `buzz-channel`, for a record published
 * globally — {@link folderOf} has both spellings and why). That lists an app's
 * records perfectly well and **cannot list a topic**: under `h` the topic is
 * the container, so it would have to be inside itself.
 *
 * Kept because both wire shapes coexist permanently — no migration is
 * available, and a reader that only understood folder state would show every
 * folder on production as empty.
 *
 * Two filters rather than one: an `#h` query does not return a record placed
 * globally, and reading only `h` was what made five of Ship's fifteen projects
 * unactionable before `folderOf` existed.
 *
 * ## And the files placed here — the union rule (FOL-20)
 *
 * A folder lists the files whose `h` it is **and** the files placed in it.
 * An event cannot change its own `h`, so a project filed in one Folder and
 * later linked to a team keeps the `h` it was born with, and the only thing
 * that can say "it belongs over there now" is a change event. Ship publishes
 * that change twice — into the record's own Folder, and *into the Folder
 * being linked*: a `kind:1851` carried by the team's `h`, targeting the
 * project, whose value is the team Folder itself. The second copy is the
 * placement, and it is what this reads.
 *
 * {@link resolveFolderProject} has read the same statement since PEEK-24 to
 * answer "which project is this topic paired with". This is the listing's
 * half of it, and it is the rule the tidy-up rests on: five team Folders,
 * fourteen projects linked into them and none re-created, so a team Folder
 * whose `h` is on nothing lists its projects anyway.
 *
 * App-neutral by the same discipline as everything else here. The change
 * kinds and target tags come off the published `records` rules, and a
 * placement is recognised by shape rather than by vocabulary: a change
 * carried in this folder, naming a target, **whose value is this folder's
 * id**. That last clause is what separates a placement from an ordinary edit
 * somebody published into the wrong Folder — the relay accepts those — which
 * would otherwise list a file wherever a stray change about it had landed.
 * Whether the placement is still *current* is decided in
 * {@link resolveFolderContents}, once the target's fold is known.
 *
 * One request either way: the change filter rides in the same `/query` as
 * the two containment filters, and the change kinds come off the handler
 * sweep this already made.
 */
async function addressesByContainment(
  folder: string,
  query: QueryFn,
): Promise<{ addresses: string[]; placed: Map<string, SignedEvent[]> }> {
  // Which kinds could be files? Every kind any app declares a projection for.
  // The only non-app-specific source for a kind number is a published manifest.
  const handlers = await query([{ kinds: [KIND_HANDLER_INFORMATION], limit: HANDLER_SWEEP_LIMIT }])
  const manifests = handlers.flatMap((event) => parseManifest(event) ?? [])
  // The bare file is listed by no manifest on the relay — its projection is
  // built in — so it has to be asked for by name, or a folder with no state
  // would show every project and issue and none of the topics.
  const kinds = [
    ...new Set([
      KIND_BARE_FILE,
      ...manifests.flatMap((manifest) =>
        Object.keys(manifest.projections ?? {}).map(Number).filter(Number.isFinite),
      ),
    ]),
  ]
  // Every app's change kind, each with the tags that make one a placement. A
  // kind is a u16 and the relay refuses an out-of-range one, so an app with no
  // `records` contributes nothing rather than an empty rule.
  const rules = new Map<number, RecordsRule>()
  for (const manifest of manifests) {
    if (manifest.records) rules.set(manifest.records.changeKind, manifest.records)
  }

  const found = await query([
    { '#h': [folder], kinds, limit: 500 },
    { '#buzz-channel': [folder], kinds, limit: 500 },
    ...(rules.size ? [{ '#h': [folder], kinds: [...rules.keys()], limit: 500 }] : []),
  ])
  const held = found.filter((event) => kinds.includes(event.kind))

  const addressOf = (event: SignedEvent) =>
    pointerToAddress({
      kind: event.kind,
      pubkey: event.pubkey,
      identifier: tagValue(event, 'd') ?? '',
      relays: [],
    })
  // Newest first, whichever event put the file here. A placement's time is
  // the statement's, so a project linked in yesterday sorts above one whose
  // record has sat here for a month — the order a person expects of "recently
  // added".
  const newest = new Map<string, number>()
  const seen = (address: string, at: number) => newest.set(address, Math.max(newest.get(address) ?? 0, at))

  for (const event of held) {
    const d = tagValue(event, 'd')
    /*
      Two exclusions, and both are about what a file *is*.

      **A file is addressable** — RFC 0.4 §5, "anything with an address
      that a folder can list". A `kind:9` message carries no `d`, so it
      has no address, so it is conversation rather than contents. That is
      the whole discriminator and it needs no kind numbers.

      **A folder is not a file inside itself.** A channel's own `39000`
      comes back from an `#h` query for that channel — the relay scopes a
      discovery event to the channel it describes, so it arrives with the
      contents. What marks it out is that its `d` *is* the folder uuid.
    */
    if (d === undefined || d === folder) continue
    seen(addressOf(event), event.created_at)
  }
  const contained = new Set(newest.keys())

  const placed = new Map<string, SignedEvent[]>()
  for (const event of found) {
    const rule = rules.get(event.kind)
    if (!rule) continue
    const target = tagValue(event, rule.targetTag)
    // A file already here by `h` needs no placement, and reading one for it
    // would subject it to the currency check that placements alone deserve.
    if (!target || contained.has(target)) continue
    if (tagValue(event, rule.valueTag) !== folder) continue
    placed.set(target, [...(placed.get(target) ?? []), event])
    seen(target, event.created_at)
  }

  return {
    addresses: [...newest].sort((a, b) => b[1] - a[1]).map(([address]) => address),
    placed,
  }
}

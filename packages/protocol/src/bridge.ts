/**
 * Buzz's HTTP bridge — `POST /events`, `POST /query` — with NIP-98 auth.
 *
 * Behaviours here were established against a running relay, not inferred. Three
 * that bite, and the first is the one that makes a green deploy lie:
 *
 *  - **HTTP 200 does not mean accepted.** A duplicate channel create returns
 *    `200 {"accepted":false,"message":"duplicate: channel already exists"}`.
 *    The `accepted` field is authoritative and the status code alone would read
 *    rejections as successes. This is SPEC §5's C3 conformance check.
 *  - **`/query` takes a bare ARRAY of filters**, not a single filter object.
 *    Sending one object gets `invalid type: map, expected a sequence`.
 *  - **A non-member read is answered `403 relay_membership_required`.** There is
 *    no backend identity that can see anything, which is why reads are
 *    viewer-driven.
 *
 * ## The parsers are exported separately, and that is the point
 *
 * {@link parsePublishResponse} and {@link parseQueryResponse} existed twice
 * before SHA-3 — once in Peek's browser bridge, once in Ship's `Relay` — with
 * the same `accepted` handling written out both times. They are exported on
 * their own so an app with its own transport (Peek signs its auth event through
 * Estiva ID, which is `@estiva-app/identity`'s job, not this package's) still
 * shares the *interpretation of the answer*. Getting the bytes right and then
 * reading `200` as success is a way to fail that no test notices.
 */
import { authorizationHeader } from './nip98.js'
import type { SignedEvent } from './events.js'
import type { Signer } from './sign.js'

export interface PublishResult {
  ok: boolean
  eventId?: string
  reason?: string
  /** The relay already had this state — not a failure. */
  duplicate?: boolean
  /** The HTTP status, for a caller that wants to distinguish 403 from 500. */
  httpStatus?: number
  /**
   * The relay's own `message`, on the branch where the publish succeeded.
   *
   * For an ordinary event this is absent or uninteresting. For a **command
   * kind** it is the answer: `handle_dm_open` (`41010`) replies
   * `response:{"channel_id":…,"created":…}`, and that uuid is the only place
   * the created channel is named — the client cannot derive it, and no query
   * returns it. Until DMS-3 this branch dropped `message`, so a caller opening
   * a DM through {@link Relay.publish} could not learn what it had opened.
   *
   * Kept raw. {@link commandPayload} parses the `response:` form; a message
   * that is not one (`"duplicate: already processed"`) is still readable here.
   */
  message?: string
}

/**
 * The JSON a command kind answered with, or `undefined` if it did not answer.
 *
 * Buzz command kinds put their result in `IngestResult.message` as the string
 * `response:<json>`. Two ways there is nothing to parse, and a caller must
 * handle both because neither is an error:
 *
 *  - **A replay.** `persist_command_event` keys on the *event id*, not on what
 *    the command means, so re-publishing byte-identical bytes short-circuits to
 *    `accepted:true`, `"duplicate: already processed"`, **no payload**. Measured
 *    on production 2026-09-17; the relay does not re-run the handler, so it has
 *    nothing to say. Two clients opening the same DM in the same wall-clock
 *    second sign identical events, so this is a race, not a corner case — and
 *    the way through is a *distinct* event (bump `created_at`), which re-runs
 *    the handler and answers with the payload again.
 *  - **A plain-language message**, which some kinds answer with instead.
 */
export function commandPayload(result: Pick<PublishResult, 'message'>): Record<string, unknown> | undefined {
  const message = result.message
  if (!message?.startsWith('response:')) return undefined
  try {
    const parsed: unknown = JSON.parse(message.slice('response:'.length))
    return typeof parsed === 'object' && parsed !== null ? (parsed as Record<string, unknown>) : undefined
  } catch {
    return undefined
  }
}

/**
 * The relay's answer to `POST /events`, interpreted.
 *
 * `duplicate` is reported as `ok`: "already exists" is the desired end state, so
 * a caller creating a channel that is already there has succeeded. Every other
 * `accepted: false` is a failure the caller must surface — SPEC §9's C9, which
 * is not decoration: once no app can sign locally, an identity-service outage
 * looks exactly like nothing happening.
 */
/**
 * The most events one `/query` will return, however large a `limit` the filter
 * names.
 *
 * Buzz clamps a REQ to the NIP-11 `limitation.max_limit` it advertises. That
 * value **halved from 10000 to 1000** when the fork caught up with upstream
 * (upstream #3635 aligned the advertised limit with the REQ ceiling), and
 * **NIP-01 has no truncation signal** — a caller asking for more receives a
 * short list and no indication why. Peek loses old history, Ship loses issues,
 * and every local signal stays green.
 *
 * It lives here because the number is a property of the *relay*, and had been
 * copied as a literal into four call sites across two apps and the agent, none
 * of which could know when the relay changed it.
 *
 * A page size, not a promise: {@link Relay.queryAll} never assumes this value
 * is the relay's real ceiling — see its note on why.
 */
export const RELAY_PAGE_CEILING = 1000

/**
 * The most filters one `POST /query` will carry.
 *
 * Measured against production 2026-09-07 by binary search: **128 accepted, 129
 * refused** with `too many explicit channels`. The relay counts filter
 * *occurrences*, not distinct Folders — 300 filters over 36 Folders is refused
 * just the same — so the bound is on the array's length and nothing else.
 *
 * Like {@link RELAY_PAGE_CEILING} this is a property of the relay rather than
 * of this client, and it is a *page size, not a promise*: a batch that is
 * refused falls back rather than assuming this number is still right.
 */
export const MAX_FILTERS_PER_QUERY = 128

/**
 * How many of a {@link Relay.queryAll} call's filters may be in flight at once.
 *
 * Filters are independent — only paging *within* one is a cursor walk — and
 * running them one after another made a read as slow as the sum of its parts.
 * Measured on Ship's `loadAll` against production: **33 filters, 66 sequential
 * round trips, median 206 ms, 100% of wall clock spent inside `query` one
 * request at a time.** At a concurrency of 8 the same read returned a
 * byte-identical answer in 1.9 s instead of 9.0 s.
 *
 * Bounded rather than unbounded on purpose. A workspace's filter count grows
 * with its Folders, so `Promise.all` over all of them would open a fan-out
 * whose width is set by the *data* — fine at 33, an accidental flood at 500,
 * and the relay is shared. Eight is enough to hide the latency without any
 * caller having to think about it.
 *
 * Pass `concurrency: 1` to restore the strictly serial read.
 *
 * ## This does not buy a caller more relay budget
 *
 * Concurrency changes how fast a read spends its requests, never how many it
 * makes. Buzz meters `POST /query` against `human_api_calls_per_min` — a fixed
 * 60-second window, **default 300, applied to every bridge call whatever tier
 * the caller is** (`enforce_http_admission` in `api/bridge.rs` reads the human
 * limit unconditionally). At 66 requests, one Ship workspace read is 22% of a
 * minute's entire allowance, so no client gets more than ~4.5 of them a minute
 * however it schedules them.
 *
 * A poller therefore has to slow down as its reads get faster, or it simply
 * spends the same budget sooner and starts collecting
 * `rate-limited: quota exceeded`. Making a read cheap is the fix for that;
 * making it parallel is not.
 */
export const DEFAULT_QUERY_CONCURRENCY = 8

export interface QueryAllOptions {
  /** Events per request. Defaults to {@link RELAY_PAGE_CEILING}. */
  pageSize?: number
  /** Give up after this many pages *per filter*, rather than looping forever. */
  maxPages?: number
  /** Filters in flight at once. Defaults to {@link DEFAULT_QUERY_CONCURRENCY}; 1 is serial. */
  concurrency?: number
  /**
   * Ask for every filter's first page in one request. On by default.
   *
   * `false` restores the pre-PER-1 shape — one request per filter — which is
   * what the paging tests drive, and what a caller wants if it has reason to
   * distrust the relay's per-filter clamp.
   */
  batch?: boolean
}

export function parsePublishResponse(status: number, text: string): PublishResult {
  let parsed: { accepted?: boolean; event_id?: string; message?: string; error?: string }
  try {
    parsed = JSON.parse(text)
  } catch {
    return { ok: false, reason: `unparseable response: ${text.slice(0, 200)}`, httpStatus: status }
  }
  if (status < 200 || status >= 300) {
    return { ok: false, reason: parsed.error ?? text.slice(0, 200), httpStatus: status }
  }
  if (parsed.accepted === false) {
    const duplicate = (parsed.message ?? '').startsWith('duplicate:')
    return { ok: duplicate, duplicate, eventId: parsed.event_id, reason: parsed.message, httpStatus: status }
  }
  /*
    `duplicate:` arrives on *both* branches and means the same thing on each —
    the relay already had this state. A channel create that loses the race says
    it with `accepted:false`; a command event replayed byte-for-byte says it
    with `accepted:true` (measured). A caller that reads `duplicate` to decide
    whether to expect a payload must see it either way, or the accepted replay
    looks like a command that simply answered nothing.
  */
  const result: PublishResult = { ok: true, eventId: parsed.event_id, httpStatus: status }
  if (parsed.message !== undefined) {
    result.message = parsed.message
    if (parsed.message.startsWith('duplicate:')) result.duplicate = true
  }
  return result
}

export interface QueryResult {
  ok: boolean
  events: SignedEvent[]
  reason?: string
  httpStatus?: number
}

/** The relay's answer to `POST /query`, interpreted. */
export function parseQueryResponse(status: number, text: string): QueryResult {
  if (status < 200 || status >= 300) {
    let reason = text.slice(0, 200)
    try {
      reason = JSON.parse(text).error ?? reason
    } catch {
      // keep the raw text
    }
    return { ok: false, events: [], reason, httpStatus: status }
  }
  try {
    const parsed = JSON.parse(text)
    return { ok: true, events: Array.isArray(parsed) ? parsed : [], httpStatus: status }
  } catch {
    return { ok: false, events: [], reason: `unparseable response: ${text.slice(0, 200)}`, httpStatus: status }
  }
}

/**
 * Just enough of `fetch` to post a body and read the answer.
 *
 * A parameter rather than an ambient global, per ADR 0002 §4a — `fetch` is in
 * neither `lib.es2022` nor a package that may assume `lib.dom`. The default
 * below reads the runtime's own, so no consumer has to pass one.
 */
export type FetchLike = (
  url: string,
  init: { method: string; headers: Record<string, string>; body: string },
) => Promise<{ status: number; text(): Promise<string> }>

/** See {@link FetchLike}. Read inside a method, so importing touches no global. */
declare const fetch: FetchLike

/** Extra headers to send with every relay request, resolved per request. */
export type RelayHeaders = () => Record<string, string> | Promise<Record<string, string>>

export interface RelayOptions {
  /**
   * ## Why `headers` is a callback
   *
   * Buzz reads more than NIP-98 off a request. A NIP-OA owner attestation travels
   * in `x-auth-tag`, and on a closed relay it is what admits an agent whose
   * *owner* is a member — so it is required on **every** call, `/query` included,
   * not just on writes.
   *
   * A callback rather than a fixed object because what it carries can expire: an
   * agent's attestation is minted with its token and replaced when that token is
   * renewed. A snapshot taken at construction would work for one TTL and then
   * fail as a `403 relay_membership_required` that looks nothing like an expiry.
   *
   * Empty by default, so an app with no such credential is unaffected.
   */
  headers?: RelayHeaders
  /** Override the transport. Defaults to the runtime's `fetch`. */
  fetch?: FetchLike
}

/**
 * A relay client that signs its own NIP-98 auth.
 *
 * Takes a {@link Signer} rather than a key or a token, which is what lets the
 * same class serve a script holding a secret key and a browser signing through a
 * remote service.
 */
/**
 * A function saying which filter of a batch an event came from, or `null` when
 * that cannot be decided with certainty.
 *
 * Two discriminators, both exact, and between them they cover every batched
 * read the suite performs:
 *
 * - **`#h`**, when every filter names exactly one Folder and no two name the
 *   same. A filter asking for Folder A cannot match an event that is not in A,
 *   so the event's own `h` tag is the answer. This is the workspace read.
 * - **`kinds`**, when every filter names a non-empty kind list and no kind
 *   appears in two of them. Then the event's `kind` is the answer, whatever
 *   else the filters constrain — extra constraints only ever narrow a filter,
 *   they cannot make it match a kind it did not ask for. This is the discovery
 *   pair, `{kinds:[30850]}` and `{kinds:[30851]}`.
 *
 * Anything else returns `null` and the chunk is paged the old way. The bar is
 * "certain", not "usually right": a wrong attribution under-counts a run,
 * declares a clamped filter complete, and silently drops the rest of a Folder —
 * the exact bug this read path exists to prevent.
 */
type Discriminator = (event: SignedEvent) => number | null

function byFolder(filters: Record<string, unknown>[]): Discriminator | null {
  const slot = new Map<string, number>()
  for (const [index, filter] of filters.entries()) {
    const h = filter['#h']
    if (!Array.isArray(h) || h.length !== 1 || typeof h[0] !== 'string') return null
    if (slot.has(h[0])) return null
    slot.set(h[0], index)
  }
  return (event) => {
    let found: number | null = null
    for (const tag of event.tags) {
      if (tag[0] !== 'h' || typeof tag[1] !== 'string') continue
      const candidate = slot.get(tag[1])
      if (candidate === undefined) continue
      // Two `h` tags naming two different filters: no answer exists.
      if (found !== null && found !== candidate) return null
      found = candidate
    }
    return found
  }
}

function byKind(filters: Record<string, unknown>[]): Discriminator | null {
  const slot = new Map<number, number>()
  for (const [index, filter] of filters.entries()) {
    const kinds = filter.kinds
    if (!Array.isArray(kinds) || kinds.length === 0) return null
    for (const kind of kinds) {
      if (typeof kind !== 'number' || slot.has(kind)) return null
      slot.set(kind, index)
    }
  }
  return (event) => slot.get(event.kind) ?? null
}

function discriminate(filters: Record<string, unknown>[]): Discriminator | null {
  return byFolder(filters) ?? byKind(filters)
}

/** The batched response split into one run per filter, or `null` if any event is unclaimed. */
function splitRuns(
  count: number,
  events: SignedEvent[],
  which: Discriminator,
): SignedEvent[][] | null {
  const runs: SignedEvent[][] = Array.from({ length: count }, () => [])
  for (const event of events) {
    const index = which(event)
    if (index === null) return null
    runs[index].push(event)
  }
  return runs
}

export class Relay {
  private readonly url: string
  private readonly signer: Signer
  private readonly headers: RelayHeaders
  private readonly transport: FetchLike | undefined
  /**
   * The largest page this relay has ever handed back, across every call.
   *
   * A *lower bound* on the relay's real clamp, and the only one obtainable
   * without trusting anybody: the relay returned this many events in one
   * response, so its ceiling is at least this large. {@link Relay.pageFilter}
   * uses it to tell a short page apart from a clamped one — see there.
   *
   * Per instance and never reset, so the second read through a long-lived
   * `Relay` is cheaper than the first.
   */
  private observedPageCeiling = 0

  constructor(url: string, signer: Signer, options: RelayOptions | RelayHeaders = {}) {
    this.url = url.replace(/\/+$/, '')
    this.signer = signer
    // A bare callback was the old second argument in Ship's client; accepting
    // both keeps that call site working rather than making a behavioural change
    // ride along with an extraction.
    const opts: RelayOptions = typeof options === 'function' ? { headers: options } : options
    this.headers = opts.headers ?? (() => ({}))
    this.transport = opts.fetch
  }

  private async post(path: string, payload: unknown): Promise<{ status: number; text: string }> {
    const url = `${this.url}${path}`
    const body = JSON.stringify(payload)
    const auth = await authorizationHeader(this.signer, { url, method: 'POST', body })
    const send = this.transport ?? fetch
    const res = await send(url, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        ...(await this.headers()),
        // Rebuilt per request AND unique per request — identical requests in the
        // same second would otherwise collide on the auth event id and the relay
        // rejects the second as a replay. See nip98.ts on the nonce.
        //
        // Listed after the spread so a caller's headers cannot displace it:
        // authorization is this client's own contract with the relay, not
        // something an ambient credential gets to override.
        authorization: auth,
      },
      body,
    })
    return { status: res.status, text: await res.text() }
  }

  async publish(event: SignedEvent): Promise<PublishResult> {
    const { status, text } = await this.post('/events', event)
    return parsePublishResponse(status, text)
  }

  /**
   * `filters` is an array — the bridge expects `Vec<Value>`.
   *
   * Throws on a transport-level failure rather than returning an empty array,
   * because "no events" and "the relay refused you" are not the same answer and
   * a caller that cannot tell them apart renders an empty screen either way.
   */
  async query(filters: Record<string, unknown>[]): Promise<SignedEvent[]> {
    const { status, text } = await this.post('/query', filters)
    const result = parseQueryResponse(status, text)
    if (!result.ok) throw new Error(`query failed: ${result.reason}`)
    return result.events
  }

  /**
   * Every event matching `filters`, paged, rather than the first page.
   *
   * `query` returns whatever one request yielded, which is a trap the moment a
   * kind grows past the relay's ceiling: the caller cannot distinguish "that is
   * all of them" from "that is as many as I will give you".
   *
   * **Why this does not stop at a short page.** The obvious loop — page until a
   * page comes back smaller than the page size — is wrong, because it trusts
   * {@link RELAY_PAGE_CEILING} to equal the relay's real limit. If the relay's
   * were ever *lower*, every page would look short and the first one would be
   * mistaken for the whole set: the original bug, reintroduced. So the rule is
   * **whether the `until` cursor still advances**, which holds whatever the true
   * ceiling is, at the cost of one extra round trip at the end.
   *
   * `until` is inclusive in NIP-01, so the boundary event repeats on the next
   * page; dedup by id absorbs that. Dedup is deliberately *not* the termination
   * signal — under two filters matching the same events, a page of already-seen
   * ids means "this filter overlaps the last one", not "stop".
   *
   * **Throws rather than truncating** when the cursor cannot advance and the
   * page is full: more than `pageSize` events then share one `created_at`, no
   * value of `until` reaches past them without skipping some, and no correct
   * answer exists from this API — so it says so instead of returning a
   * plausible subset.
   *
   * **Filters run concurrently, up to {@link DEFAULT_QUERY_CONCURRENCY}.** They
   * are independent of one another; only the pages inside one are a cursor
   * walk. Doing them in sequence made a read cost the sum of every filter's
   * latency, which is what put Ship's workspace read at nine seconds against a
   * five-second poll — long enough that a write's re-read had usually not
   * finished before the next one began.
   *
   * The concurrency is deliberately **not observable in the answer**: results
   * are collected per filter and concatenated in filter order, so the returned
   * array is identical to the serial one, and a failure reports the
   * lowest-indexed filter's error rather than whichever lost the race.
   */
  async queryAll(
    filters: Record<string, unknown>[],
    options: QueryAllOptions = {},
  ): Promise<SignedEvent[]> {
    const pageSize = options.pageSize ?? RELAY_PAGE_CEILING
    const maxPages = options.maxPages ?? 100
    const concurrency = Math.max(1, options.concurrency ?? DEFAULT_QUERY_CONCURRENCY)

    /*
      Per filter, in filter order — not one shared accumulator.

      Concurrency must not be observable in the answer. Collecting each
      filter's pages into its own slot and concatenating in order at the end
      makes the output byte-identical to the serial version, whatever order the
      responses actually arrive in. Dedup then runs over that ordered
      concatenation, so an id first seen under filter 0 still belongs to filter
      0's run of events, exactly as before.
    */
    const perFilter: SignedEvent[][] = new Array(filters.length)
    const failures: unknown[] = new Array(filters.length)

    /*
      One request for every filter's first page, before any of them is paged.

      The old shape spent one HTTP request per filter, and that is the unit the
      relay meters: `enforce_http_admission` runs on the *call*, before the
      filters are even parsed, at 300 a minute shared across every app one
      person has open. Measured on Ship's `loadAll` against production
      2026-09-07: **39 requests and 1015 ms warm, 2.83 MiB down**, of which
      every single request was a first page — nothing was paging at all.

      What makes this safe rather than merely cheaper is that `POST /query`
      **concatenates per filter, in filter order, and clamps `limit` per
      filter** — all three measured, not assumed:

      - 10 filters at `limit: 5` returned 48 events, not 5.
      - The same filter twice in one POST returned 236 events, not 118: the
        relay does not dedupe across filters, so a run's length is its own.
      - Three Folder filters batched came back element-for-element identical to
        the same three read one at a time.

      That last one is the whole argument. `queryAll`'s contract is that the
      answer is the serial concatenation; a batched response *is* that
      concatenation, so this is a transport change and not a semantic one.
    */
    const unresolved = new Set<number>(filters.map((_, index) => index))
    /*
      A filter the batch could not settle keeps its first page anyway: it is
      handed back as a seed so `pageFilter` resumes from that page's cursor
      instead of asking for it a second time. Without this the widest filter —
      which ties its own bound on every read and so is never settled — would pay
      for its first page twice, and the widest filter is the one every workspace
      read has.
    */
    const seeds: (SignedEvent[] | undefined)[] = new Array(filters.length)
    if (options.batch !== false && filters.length > 1) {
      await this.batchFirstPages(filters, pageSize, perFilter, unresolved, seeds)
    }

    const remaining = [...unresolved]
    let next = 0
    let failed = false

    const worker = async (): Promise<void> => {
      for (;;) {
        // Stop *starting* filters once one has failed. The serial version never
        // reached them at all; this is as close as a fan-out gets, and it keeps
        // a broken read from firing the whole remaining queue at the relay.
        if (failed) return
        const slot = next++
        if (slot >= remaining.length) return
        const index = remaining[slot]
        try {
          perFilter[index] = await this.pageFilter(filters[index], pageSize, maxPages, seeds[index])
        } catch (error) {
          failures[index] = error
          failed = true
          return
        }
      }
    }

    await Promise.all(
      Array.from({ length: Math.min(concurrency, remaining.length) }, () => worker()),
    )

    /*
      The lowest-indexed failure, not the first to reject in wall-clock time.

      Under `Promise.all` the error a caller sees would otherwise depend on
      which request happened to lose the race, so two runs of the same broken
      read could report different filters. Serial order is the one order that
      is reproducible, and it is what the serial version reported.
    */
    const firstFailure = failures.findIndex((error) => error !== undefined)
    if (firstFailure !== -1) throw failures[firstFailure]

    const seen = new Set<string>()
    const out: SignedEvent[] = []
    for (const events of perFilter) {
      for (const e of events) {
        if (seen.has(e.id)) continue
        seen.add(e.id)
        out.push(e)
      }
    }
    return out
  }

  /**
   * Every filter's first page, in as few requests as the relay will allow.
   *
   * Fills `perFilter` for each filter it can prove complete and removes it from
   * `unresolved`; everything else is left for {@link Relay.pageFilter}, which is
   * unchanged and remains the only thing that pages.
   *
   * **Proving a filter complete needs its own run's length**, and a flat
   * response only yields that if the events can be attributed. Two ways, and
   * the code takes whichever applies:
   *
   * 1. **By `h` tag**, when every filter in the chunk names exactly one Folder
   *    and no two name the same one. Exact — an event carries the Folder it is
   *    in — and it is the shape every workspace read in the suite actually
   *    sends.
   * 2. **By the total**, otherwise. If the whole chunk came back under the
   *    largest page this relay has ever produced, no single run reached that
   *    bound either, so none was clamped. Weaker, and it cannot fire on a cold
   *    `Relay` that has no evidence yet — deliberately, per SHA-15.
   *
   * When neither applies the chunk is simply left unresolved: one request is
   * spent and the old path runs, which is a cost in requests and never in
   * correctness.
   */
  private async batchFirstPages(
    filters: Record<string, unknown>[],
    pageSize: number,
    perFilter: SignedEvent[][],
    unresolved: Set<number>,
    seeds: (SignedEvent[] | undefined)[],
  ): Promise<void> {
    for (let start = 0; start < filters.length; start += MAX_FILTERS_PER_QUERY) {
      const indices = filters
        .slice(start, start + MAX_FILTERS_PER_QUERY)
        .map((_, offset) => start + offset)
      if (indices.length < 2) continue

      /*
        Do not spend a request on a batch whose answer could not be used.

        Both proofs can be checked before asking: attribution is a property of
        the filters alone, and the total rule needs a ceiling this `Relay` has
        actually observed. With neither available the batch would cost one
        request and resolve nothing — a real regression for a cold read of
        filters that carry no `#h`, which is Ship's own discovery pair.
      */
      const which = discriminate(indices.map((i) => filters[i]))
      if (!which && this.observedPageCeiling === 0) continue

      /*
        A refused batch fails the whole read. It is **not** caught and retried
        one filter at a time.

        Falling back would be the friendlier-looking choice and it is the wrong
        one: the most likely reason a batch is refused is the quota, and the
        single worst response to being told to slow down is to turn one request
        into another thirty-six. `queryAll` already refuses to fire the rest of
        a queue once a filter has failed; this is that same rule for the batch.

        The cost is error *identity* — a caller sees the batch's error rather
        than the lowest-indexed filter's. For a transport refusal, which is
        what this path actually meets, those are the same error.
      */
      const events = await this.query(indices.map((i) => ({ ...filters[i], limit: pageSize })))

      const runs = which ? splitRuns(indices.length, events, which) : null
      if (runs) {
        /*
          Update the observed ceiling from each run *before* testing it, exactly
          as `pageFilter` does — so the widest filter ties its own bound and is
          left to confirm itself rather than being declared complete.

          Never from the chunk total. That number is the sum of several runs,
          and a bound raised above what the relay actually produced would make a
          genuinely clamped page look short — SHA-8, reintroduced through the
          back door.
        */
        for (const run of runs) {
          if (run.length > this.observedPageCeiling) this.observedPageCeiling = run.length
        }
        for (const [offset, run] of runs.entries()) {
          if (run.length < pageSize && run.length < this.observedPageCeiling) {
            perFilter[indices[offset]] = run
            unresolved.delete(indices[offset])
          } else {
            seeds[indices[offset]] = run
          }
        }
        continue
      }

      if (events.length < pageSize && events.length < this.observedPageCeiling) {
        // No run can exceed the total, so no run reached the ceiling. The
        // response is already the serial concatenation, so it can be adopted
        // whole: the first slot carries it and the rest are empty, which
        // concatenates to exactly the same array.
        perFilter[indices[0]] = events
        for (const index of indices.slice(1)) perFilter[index] = []
        for (const index of indices) unresolved.delete(index)
      }
    }
  }

  /**
   * One filter, paged to exhaustion. The sequential half, and it has to be:
   * `until` is a cursor, so page N+1's request is not known until page N has
   * answered. Only the filters are independent, which is why they are the
   * axis {@link Relay.queryAll} parallelises.
   */
  private async pageFilter(
    filter: Record<string, unknown>,
    pageSize: number,
    maxPages: number,
    seed?: SignedEvent[],
  ): Promise<SignedEvent[]> {
    const out: SignedEvent[] = []
    let until: number | undefined
    /*
      `seed` is this filter's first page, already fetched in the batch and
      already judged inconclusive there — so the completeness test is not
      repeated here, only the cursor is taken from it. The request that produced
      it is the one this loop would otherwise make first: same filter, same
      `limit`, no `until`.
    */
    if (seed && seed.length > 0) {
      out.push(...seed)
      until = Math.min(...seed.map((e) => e.created_at))
    }
    for (let page = 0; ; page++) {
      if (page >= maxPages) {
        throw new Error(
          `queryAll: gave up after ${maxPages} pages — refusing to return a partial set`,
        )
      }
      const events = await this.query([
        { ...filter, limit: pageSize, ...(until === undefined ? {} : { until }) },
      ])
      if (events.length === 0) break
      out.push(...events)

      /*
        A page smaller than one this relay has already delivered is the end of
        the filter, and no confirming round trip is needed to know it.

        The reason the confirmation existed is real: a page shorter than the
        `limit` we asked for is ambiguous, because the relay clamps to
        `min(requested, ceiling)` and might have clamped at exactly this many.
        But that requires the ceiling to *equal* this page's size — and the
        ceiling is one constant for the relay, already known to be at least
        `observedPageCeiling`. So `n < observedPageCeiling` rules the clamp out
        arithmetically rather than by trusting anything.

        Deliberately not NIP-11's `limitation.max_limit`. That number is a
        claim: a relay advertising more than it clamps to would make every page
        look short and the first one get mistaken for the whole set, which is
        exactly the SHA-8 bug this loop exists to prevent. An observed page is
        evidence — the relay demonstrably produced it.

        Conservative before it has evidence: the first filter through a fresh
        `Relay` still pays the confirmation, and so does any page that ties the
        largest seen so far — which means **the widest filter always confirms**,
        since it ties its own bound on every read. So the floor is one request
        per filter plus one, not one per filter.

        Measured on Ship's `loadAll` against production: **66 requests to 35
        cold and 34 warm**, the same fold event for event, and 8.8 s to 0.9 s
        alongside the concurrency of 0.4.0.
      */
      if (events.length > this.observedPageCeiling) this.observedPageCeiling = events.length
      if (events.length < pageSize && events.length < this.observedPageCeiling) break

      const oldest = Math.min(...events.map((e) => e.created_at))
      if (until !== undefined && oldest >= until) {
        if (events.length >= pageSize) {
          throw new Error(
            `queryAll: more than ${pageSize} events share created_at=${until} — cannot page without skipping`,
          )
        }
        break
      }
      until = oldest
    }
    return out
  }
}

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
  return { ok: true, eventId: parsed.event_id, httpStatus: status }
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

    let next = 0
    let failed = false

    const worker = async (): Promise<void> => {
      for (;;) {
        // Stop *starting* filters once one has failed. The serial version never
        // reached them at all; this is as close as a fan-out gets, and it keeps
        // a broken read from firing the whole remaining queue at the relay.
        if (failed) return
        const index = next++
        if (index >= filters.length) return
        try {
          perFilter[index] = await this.pageFilter(filters[index], pageSize, maxPages)
        } catch (error) {
          failures[index] = error
          failed = true
          return
        }
      }
    }

    await Promise.all(
      Array.from({ length: Math.min(concurrency, filters.length) }, () => worker()),
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
   * One filter, paged to exhaustion. The sequential half, and it has to be:
   * `until` is a cursor, so page N+1's request is not known until page N has
   * answered. Only the filters are independent, which is why they are the
   * axis {@link Relay.queryAll} parallelises.
   */
  private async pageFilter(
    filter: Record<string, unknown>,
    pageSize: number,
    maxPages: number,
  ): Promise<SignedEvent[]> {
    const out: SignedEvent[] = []
    let until: number | undefined
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

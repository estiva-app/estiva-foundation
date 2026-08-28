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
   */
  async queryAll(
    filters: Record<string, unknown>[],
    options: { pageSize?: number; maxPages?: number } = {},
  ): Promise<SignedEvent[]> {
    const pageSize = options.pageSize ?? RELAY_PAGE_CEILING
    const maxPages = options.maxPages ?? 100
    const seen = new Set<string>()
    const out: SignedEvent[] = []

    for (const filter of filters) {
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
        for (const e of events) {
          if (seen.has(e.id)) continue
          seen.add(e.id)
          out.push(e)
        }
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
    }
    return out
  }
}

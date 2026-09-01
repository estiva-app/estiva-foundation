# @estiva-app/protocol

Every entry answers the wire question explicitly, including when the answer is
nothing (ADR 0002 §4b). A change to the bytes an app publishes is a MAJOR — in
`0.x`, a MINOR — even when no TypeScript signature moved.

## 0.4.0 — 2026-09-01

**Wire behaviour: unchanged.** No builder, tag layout, id computation or
signature input moved. `queryAll` returns the same array it always did — see
below, that is the property the tests are about.

- **`queryAll` runs its filters concurrently**, bounded by the new
  `DEFAULT_QUERY_CONCURRENCY` (8) and overridable per call via
  `QueryAllOptions.concurrency`. `concurrency: 1` is the old serial read
  exactly.

  Filters handed to one call are independent; only the pages *inside* a filter
  are a cursor walk, and those stay sequential because page N+1's `until` is
  not known until page N has answered. Running the filters in sequence made a
  read cost the sum of every filter's latency. Measured on Ship's `loadAll`
  against production: **33 filters, 66 round trips, median 206 ms, 100% of wall
  clock spent inside `query` one request at a time.** The same read, same relay,
  same credentials, through this build: **9.0 s → 1.68 s, and the fold compares
  equal event for event** — every project and issue address with its status,
  every change id, every conversation id.

  The concurrency is deliberately not observable in the answer. Results are
  collected per filter and concatenated in filter order, and a failure reports
  the **lowest-indexed** filter's error rather than whichever request lost the
  race — so a broken read names the same filter twice running.

- **What this does not buy you: relay budget.** Buzz meters `POST /query`
  against `human_api_calls_per_min` — a fixed 60-second window, default 300,
  applied to every bridge call whatever tier the caller is. One Ship workspace
  read is 66 of those. Concurrency changes when a read spends its requests,
  never how many, so a poller that simply reads more often now spends the same
  allowance sooner. Documented at `DEFAULT_QUERY_CONCURRENCY` because it is the
  first thing a caller will get wrong.

Additive, and behaviour under a caller's existing call changes (requests now
overlap), so a MINOR: ADR 0002 §4b puts the break on MINOR within `0.x`.

## 0.3.0 — 2026-09-01

*Backfilled 2026-09-01. This release shipped without an entry, and so did 0.2.0
below — the file's own rule is that every release answers the wire question, and
twice it went unanswered. Recorded now from the release commits rather than left
as a gap.*

**Wire behaviour: unchanged.** NIP-19 is an encoding of a pointer, not of an
event; nothing an app publishes moved.

- **`nevent`** — `EventPointer`, `encodeNevent`, `decodeNevent`. An event that
  is not addressable had no reference form at all, so a plain `kind:9` message
  could be resolved by nothing. TLV type 0 carries the event id as 32 raw
  bytes, where `naddr` carries a UTF-8 `d`; that difference is the whole of the
  codec.

## 0.2.0 — 2026-08-28

*Backfilled 2026-09-01, from the release commit — see the note under 0.3.0.*

**Wire behaviour: unchanged.** A read-path fix; no published bytes moved.

- **`RELAY_PAGE_CEILING`, and `queryAll` pages instead of truncating.** Buzz
  clamps a REQ to its advertised NIP-11 `max_limit`, which halved from 10000 to
  1000, and NIP-01 has no truncation signal — so a caller asking for 2000 got
  1000 and no indication why. `limit: 2000` was a literal at four call sites
  across two apps and the agent, none of which could know when the relay changed
  it.

## 0.1.2 — 2026-08-27

**Wire behaviour: unchanged.** One constant added. No builder, tag layout, id
computation or signature input moved, and nothing an app already publishes
changes shape.

- **`KIND.APP_DATA = 30078`.** Two things in the suite need this number —
  NIP-RS read state (SPEC §11.6) and app-private user-owned storage (SPEC §12) —
  and a kind number is a fact about the relay rather than about an app, so the
  alternative was each of them defining it separately. Added when the second
  consumer appeared (CRO-11's stars migration) rather than speculatively.

  It carries the correction that made §12 possible: **the kind is not reserved
  for read state**, despite the relay naming its own constant `KIND_READ_STATE`.
  The NIP-RS handling is a narrow predicate — kind 30078, exactly one `d`
  matching `read-state:<32 lowercase hex>`, exactly one `["t","read-state"]` —
  and ingest performs no other `d`-tag validation. Anything outside it is an
  ordinary addressable event. A `d` beginning `read-state:` brings hard-deletion
  of superseded blobs with it, which app data must not acquire by accident, and
  the doc comment says so at the point of use.

Additive, so a PATCH: ADR 0002 §4b puts the break on MINOR within `0.x`.

## 0.1.1 — 2026-08-27

**Wire behaviour: unchanged.** Nothing in `src/` changed except the version
constant. The `dist/` a consumer receives is byte-identical to 0.1.0's apart from
that string, and no builder, tag layout, id computation or signature input moved.

**This release exists to exercise the release path, and that is the honest
description of it.** ADR 0002 §4c decided that releases publish through trusted
publishing (OIDC) with no npm credential in GitHub. 0.1.0 could not test that: a
package's first publish is necessarily manual, because a trusted publisher is
configured on a package that already exists. So until this tag, §4c was a
decision nobody had executed, and the trusted publisher was configured and
unexercised — the state in which a misconfiguration is cheapest to find and most
likely to be discovered at the worst moment instead.

What it carries, for completeness rather than as a reason to upgrade:

- **`npm run typecheck` worked in CI and failed on a fresh clone.** It was
  `tsc -p tsconfig.json --noEmit && tsc -p tsconfig.test.json`; the second pass
  typechecks `test/**/*.ts`, which import `../dist/index.js` on purpose because
  dist is what ships, so TypeScript resolves them to `dist/index.d.ts` — which
  does not exist until something builds. CI runs `build` first, so it was green.
  A fresh clone got eleven `TS2307`s that read as a broken package. Now
  `npm run build && tsc -p tsconfig.test.json`, which is one `tsc` invocation
  fewer, since the build already typechecks `src`.

**A consumer on `^0.1.0` needs to do nothing.** The range already admits this
version, neither changed file ships in the tarball's functional surface
(`tsconfig.test.json` is not in `files`, and `scripts` do not run for a
consumer), and the only observable difference is `PROTOCOL_VERSION`.

## 0.1.0 — 2026-08-27

First release. SHA-3.

**Wire behaviour: unchanged.** This is an extraction, not a change. The bytes are
pinned to what `peek-app/convex/nostr/` and `estiva-ship/lib/nostr/` were
producing before the package existed — `test/wire-vectors.json`, recorded from
those two trees at `98d284f` and `82e048b` — and all 12 event shapes both apps
implemented had byte-identical ids in both. Nothing in this release makes an app
publish a different event than it published yesterday.

Two things arrive here as the union of what the copies had, and neither changes
an existing app's output:

- **`buildMessage` takes `about`.** Peek's builder emitted `a` tags for
  cross-app routing; Ship's had no such parameter and could not emit one at all.
  Peek's shape ships. Omitting `about` produces byte-identical output to Ship's
  old builder — the `message-*` vectors pin both arms.
- **`KIND` is the union of both apps' constants.** A kind number is a fact about
  the relay, not about an app, and a subset is how an app ends up unable to
  *read* a kind its neighbour writes. Ship gains `NIP29_EDIT_METADATA`,
  `NIP29_DELETE_GROUP`, `ASSERTION`, `COMMENT` and `RELAY_AUTH` in its type
  surface; Peek gains `HIGHLIGHT`, `FILE` and `COMPONENT`. Nothing publishes
  anything new as a result.

One deliberate API reconciliation, called out because it is the one place a call
site had to change:

- **NIP-98 exports an unsigned builder plus a signer**, which was Peek's shape.
  Ship had a combined `buildAuthEvent(args & { secretKeyHex })`. The unsigned
  form is the one that works for an app holding no keys, and the combined form is
  `signEvent(buildUnsignedAuthEvent(args), secret)` — one line. The *tags* the
  two produced were already identical; the `nip98-auth-*` vectors pin that.

Also here, moved rather than written: the **relay socket client** (`createLiveRelay`,
PEE-5) and the **refcounted per-channel subscription manager**
(`createChannelSubscriptions`, PEE-6). Both were built inside `peek-app` because
Gate 2 had not happened when they were due, and both were Peek-only until now.
The only behavioural difference is that the REQ subscription id prefix is a
`subscriptionPrefix` option instead of the hardcoded `peek-`; it appears in the
relay's logs and nowhere else.

`Relay`'s second argument now accepts either the bare headers callback it took in
Ship or an options object (`{ headers, fetch }`), so the existing call sites bind
unchanged and a test can inject a transport.

### What this release does not include

The fold, and anything that interprets events. `foldFolder` stays in Ship,
`foldResolution` and the projection stay in Peek, and each app keeps its own
conformance fixture. See the README on the line this package does not cross.

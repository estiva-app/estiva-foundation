# @estiva-app/protocol

Every entry answers the wire question explicitly, including when the answer is
nothing (ADR 0002 §4b). A change to the bytes an app publishes is a MAJOR — in
`0.x`, a MINOR — even when no TypeScript signature moved.

## 0.13.0 — 2026-09-03

**Wire behaviour: unchanged.** Two readers over the resolved tree; nothing
about what an app publishes moves.

- **New: `standaloneReference` and `referencesIn` — where a reference belongs.**

  A reference that is the whole of a paragraph is somebody **attaching** an
  object. A reference inside a sentence is somebody **naming** one mid-thought,
  and cutting it out of the prose loses the sentence. Until now every app cut
  out every pointer, because a description had no structure to put a widget
  into; §13.3 gave it one.

  **The rule is here rather than in either app because two apps disagreeing
  about it makes the same body read differently in each** — SPEC §10's test.
  `stripNaddrs` applied separately by each consumer was never going to hold
  that line.

- **`referencesIn` reads the tree, not the string.** So a pointer quoted inside
  `` `code` `` is not counted: §13.1 makes code literal, and a pointer somebody
  quoted as an example is not one they are attaching. `findNaddrs` reads the
  raw text and cannot tell the difference — it stays, because widgets below the
  text are still driven from it, but this is the one to reach for when the
  question is what the *reader* sees.

  Control: letting any block count as standalone fails 1 test.

## 0.12.0 — 2026-09-03

**Wire behaviour: unchanged.** No builder, tag layout, id computation or
signature input moved. This adds a codec and a mark; nothing here changes what
an app publishes.

- **New: `encodeNpub` / `decodeNpub`.** NIP-19's simplest form and the one a
  mention needs — no TLV, just the 32 bytes bech32-encoded. `decodeNpub` is
  forgiving about a `nostr:` prefix and about case, for the same reason
  `decodeNaddr` is: what arrives was pasted by a person.

- **New: SPEC §13.1's `reference` mark is now parsed.** It was specified in
  §13.1 and implemented nowhere; a `nostr:` URI in a body was plain text. Now
  `parseInlineMarks` splits it into its own run carrying `reference`, the JSON
  encoding gets `{"type":"reference","attrs":{"uri":…}}`, and `RenderInline`
  carries it through to a consumer.

  **Why this matters, and it is not presentation.** A mention written as a
  display name needs the reader to hold the writer's directory, and message
  content is immutable — so a rename desynchronises the text from the `p` tags
  **permanently**. An `npub` needs nothing and survives a rename, because it
  never said the name.

  `text` stays the URI, which is what §13.1 requires a reader that cannot
  resolve one to show: "the URI's own label or its shortened form, never
  blank."

- **A reference inside `code` is not split.** Code content is literal (§13.1),
  and a URI somebody quoted as an example is not a link to follow. A reference
  inside *bold* keeps the bold, because the reference pass runs after the
  marker scan rather than instead of it.

- **New: `findNostrUris` and `NOSTR_URI_RE`** — every `nostr:` reference in a
  body, people included. Broader than `findNaddrs`, which answers "what objects
  does this embed" and drives widgets; this answers "what does this point at
  inline".

  Control: neutering the reference pass fails 5 tests.

## 0.11.0 — 2026-09-03

**Wire behaviour: unchanged.** No builder, tag layout, id computation or
signature input moved. This adds a reader for a tag SPEC §13.6 defines, and
nothing here writes one.

- **New: `anchors.ts` — a comment anchored to one block, SPEC §13.6.**
  `BLOCK_ANCHOR_TAG`, `blockAnchorOf`, `resolveBlockAnchor`, and the
  `BlockAnchor` union.

  **`resolveBlockAnchor` returns which of four states an anchor is in, rather
  than a block or `undefined`**, and that shape is the point. §13.6 requires a
  reader to distinguish *unanchored*, *resolved*, *unaddressable* and
  *detached*, because the pair that matters — detached and unanchored — render
  identically and mean opposite things: a remark about a paragraph somebody
  deleted, versus a remark about the whole object. A signature that lets a
  caller collapse them is a signature that invites the defect.

  Control: making `detached` return `unanchored` fails exactly the two tests
  written to catch it.

- **`unaddressable` is its own state, not a kind of detachment.** Marker text
  has no addressable sub-unit (§13.1), so an anchor against it never resolves
  and nothing was deleted. A reader saying "that paragraph is gone" about a
  marker-text description is wrong twice over.

- **A body that claims `blocks` and does not parse is `unaddressable`, not an
  exception.** It has no parts either, and a reader that throws renders nothing
  at all.

## 0.10.0 — 2026-09-02

**Wire behaviour: unchanged.** No builder, tag layout, id computation or
signature input moved. What this adds is the bridge that lets an app with a
*text* editor publish a **block document**, which is how a description acquires
addressable blocks before anybody builds a block editor.

- **New: `markerTextToBlockDocument` and `blockDocumentToMarkerText`.** Marker
  text in, a §13.3 document out, and back again.

  **`markerTextToBlockDocument` takes the previous document and carries its ids
  across**, and that is the entire point rather than a nicety. A description is
  replaced wholesale on every save; re-parsing into fresh blocks each time
  re-mints every id, and **every comment anchored to one detaches silently** —
  a detached comment renders exactly like one that was never anchored. The
  matching rule is written down in the module header: same type and identical
  text wherever it moved to, then same type at the same index, then a fresh id.

  Its limit is documented *and asserted*: a block moved **and** edited in one
  save matches neither pass and gets a new id. There is a test that fails if
  that ever silently changes, so the header cannot drift from the behaviour.

  Control: disabling the carry-forward fails 5 tests, including the corpus one.

- **An ordered list keeps the number its author wrote.** `BodySegment` of type
  `numbered` gains `start`, `RenderBlock` gains `start`, and a block document
  carries `attrs.start` — all absent when the list begins at 1.

  This is a **pre-existing rendering defect**, not something the bridge
  introduced. A body can hold two numbered runs split by a paragraph, the
  second written `2.` to continue the first; every renderer built on
  `parseBodySegments` has drawn it as `1.` since the dialect existed. One real
  body in the 152-body corpus does exactly this, and the round trip is what
  made it visible — renumbering somebody's list is a change to what they wrote,
  and it would have been written back to the relay permanently once a
  description is re-saved as blocks.

- **A NUL byte, removed from this package's own source.** `keyOf` used a
  literal `\x00` as its separator, which makes a file *binary* to the tools
  that read source: `grep` skips it and reports nothing, so a search for a
  symbol in that file comes back empty and looks like an answer. Ship's
  `fold.ts` carries a comment about this exact trap; this hit it anyway. It is
  an escape now.

## 0.9.0 — 2026-09-02

**Wire behaviour: unchanged.** Nothing about the bytes moved. One function and
two constants moved *between packages*, and `@estiva-app/interop` re-exports
them, so **no consumer of either package has to change anything.**

- **`contentFormatOf`, `CONTENT_FORMAT_TAG` and `BLOCK_DOCUMENT_FORMAT` move
  here from `@estiva-app/interop`.** They were defined there because the
  projection layer needed them first, and reading a tag off an event looked
  like a question about a slot.

  It is not — it is a question about an event, which is this package's subject.
  **Two folds outside the projection layer now need it**: Ship's and the
  agent's, which are one fold in two repositories held to a single recorded
  state by a conformance fixture. Making either depend on the projection layer
  to read a tag is the wrong direction, and a second copy of
  `'estiva-blocks-1'` is what this package exists to prevent.

- **`ContentFormat` is the name; `RenderFormat` is now an alias for it.** 0.8.0
  shipped `RenderFormat` and `interop` shipped `ContentFormat`, and they were
  the same three-value union declared twice — a duplicate introduced by 0.8.0
  and removed by this release. The old name still exports, so 0.8.0's consumers
  keep compiling.

- `interop` is unchanged in behaviour and re-exports all three names, with its
  147 tests passing untouched. `BODY_SLOT` stays in `interop`: a *slot* is that
  layer's subject, and this package has no opinion about which one carries a
  body.

## 0.8.0 — 2026-09-02

**Wire behaviour: unchanged.** No builder, tag layout, id computation or
signature input moved. This release adds a resolver, and a resolver reads what
somebody else published.

- **New: `render.ts` — one resolved tree, whichever model the body is in.**
  `toRenderTree(value, format)` and `renderTreeText`. Marker text and a block
  document both become the same `RenderBlock[]`, so a consumer writes one
  mapper instead of two, and a block document's ids survive into it while
  marker text correctly has none.

  **This is what SPEC §13.5's "safe by construction" means in practice.** The
  safety is not a component — it is that an app is never handed a string it has
  to interpret. Marks are decided, blocks are decided, and there is nothing
  left to parse, so an app that maps this tree *cannot* accidentally render
  markup. There is a corpus test asserting every character of output came from
  the input; making the resolver append four characters fails 4 tests.

- **A tree rather than a shared component, and not for the reason the ticket
  said.** RIC-6 justified it as "Ship is vanilla `h()` and Peek is React". That
  was true when the ticket was written and is no longer: Ship's UI is React +
  Vite and both apps already depend on `@estiva-app/ui`, so a shared component
  was available. It is still a tree, for a better reason — **how rich text
  looks is the consumer's**, which is RFC 0.4 §13.1's rule for projections and
  SPEC §10's line about sharing the wire and never the interpretation. A shared
  component would make Ship and Peek look alike by construction, which nobody
  asked for.

- **`'unknown'` is handled here rather than in each consumer.** A format
  declared after this code was written becomes one unmarked paragraph of the
  raw value, which §13.5 says is conformant. Leaving that to consumers is how
  one of them ends up guessing.

- **A mis-tagged body degrades instead of throwing.** A `'blocks'` value that
  is not a document renders as its own text. A reader that throws renders an
  empty field, and an empty field is indistinguishable from a description
  nobody wrote.

## 0.7.0 — 2026-09-02

**Wire behaviour: unchanged.** No builder, tag layout, id computation or
signature input moved. This release adds a second content model — the one SPEC
§13.3 specifies for a rich text field — and nothing yet publishes one.

- **New: `blocks.ts` — the rich text field, SPEC §13.3.** `parseBlockDocument`,
  `serializeBlockDocument`, `validateBlockDocument`, `newBlockId`,
  `assignMissingBlockIds`, `blockIds`, `findBlock`, `inlineTextOf`,
  `documentText`.

  **`assignMissingBlockIds` mints only what is missing**, and that is the whole
  point rather than an optimisation. An editor rebuilds its document on every
  keystroke; a rebuild that re-mints ids detaches every anchored comment on the
  next edit, and nothing reports it. A block id is what RFC 0.4 §6 anchoring
  binds to, so the function makes the safe path the easy one. There is a test
  that fails if it is changed to mint unconditionally.

- **New: the inline vocabulary's second serialisation** (§13.1) —
  `markersToInlineNodes`, `inlineNodesToMarkers`, `inlineNodesToText`. Held back
  from 0.6.0 on purpose: it had no consumer until the block model existed.

  Mark order in the JSON encoding is **deterministic**, because two encoders
  disagreeing about array order produce documents that differ byte-for-byte
  while meaning the same thing, and every equality check downstream — a diff, a
  dedupe, a cache key — is then wrong about it.

- **An unknown block type is not an error anywhere in this module.** §13.3
  requires a reader to draw its inline text and forbids dropping it silently,
  the same discipline §7.5 applies to widgets and for the same reason:
  consumers upgrade at different times. `validateBlockDocument` passes it,
  round-tripping preserves it whole, and `inlineTextOf` reads its text by shape
  rather than by name.

- **The `content-format` tag is deliberately NOT defined here.** §13.4's read
  rule is `contentFormatOf` in `@estiva-app/interop`, added in #26, because it
  is a question about an event and its slot rather than about a document.
  A second copy of `'estiva-blocks-1'` in this package is precisely the
  divergence this package exists to prevent, so `blocks.ts` never names it.

- **Tests: the claim §13 makes, checked rather than asserted.** The 152 real
  published bodies from 0.6.0 now go through both encodings, and no character
  changes its marks. Two controls were run against it — dropping `code` from
  the JSON encoding fails 4 tests, re-minting ids unconditionally fails 2.

## 0.6.0 — 2026-09-02

**Wire behaviour: unchanged.** No builder, tag layout, id computation or
signature input moved. This release adds a parser, and a parser reads bytes
somebody else already published.

**What it does change is what readers draw**, which is not the wire and is not
nothing: an app that upgrades starts rendering backtick spans in messages that
have been on the relay for weeks. Measured 2026-09-02, that is **200 of 548
published message bodies** — the most common construct in the corpus, more
common than bold, and until now rendered by nobody. Upgrading is visible to
users on history, not only on new messages.

- **New: `content.ts` — the message marker dialect, SPEC §13.2.** `parseInlineMarks`,
  `wrapInlineMarks`, `parseBodySegments` and `stripInlineFormatting`, moved out
  of Peek's `src/lib/textParsing.ts` rather than written fresh, so the behaviour
  that was already shipping is preserved by construction. Peek's own tests for
  them are ported verbatim into `test/content.test.ts` as the proof.

  Only the **mark** layer moved. Peek's mentions and bracket references resolve
  against its own directory and fixtures, and they stay there — a mention is
  RIC-2's, and dragging its regexes along would have imported one app's mock
  data into the shared package.

- **New in the dialect: `code` and fenced code** (SPEC §13.1, §13.2). A code
  span carries `code` and never combines with another mark, and its content is
  never parsed for further marks — so `` `**x**` `` is four literal characters
  and a name.

- **SPEC §13.2's rule 2 does not fence a backtick**, and the corpus is why.
  Rule 2 keeps `2*3*4` literal, which an asymmetric prose marker needs and a
  backtick does not — applying it anyway left `` `main`s `` unparsed, a code
  span followed by a plural or possessive. Eight such spans in six published
  messages. SPEC was amended to say so (estiva-docs#56) rather than the parser
  quietly disagreeing with it.

- **Fixed while extracting: `stripInlineFormatting` was not idempotent.** It
  removed the heading prefix before the quote prefix, so `> # Heading` — the
  shape every project brief in this workspace is written in — came back as
  `# Heading` and previews showed a stray `#`. Prefixes are now stripped until
  the line stops changing. **This bug was invisible to the tests it shipped
  with** and was found by running the function over 152 real published bodies.

- **New: `test/corpus-bodies.json`** — 152 real message bodies from production.
  A parser checked only against fixtures written beside it is checked against
  its own assumptions; both defects above came from this file and neither came
  from the unit tests.

## 0.5.0 — 2026-09-01

**Wire behaviour: unchanged.** No builder, tag layout, id computation or
signature input moved. `queryAll` returns the same events; it asks for them in
half as many requests.

- **A short page no longer always costs a confirming round trip.** `queryAll`
  spent two requests on every filter, including one holding three events, and
  on Ship's `loadAll` that doubling was **33 filters → 66 requests** against a
  relay that meters `POST /query` at 300 a minute.

  The confirmation existed for a real reason: a page shorter than the requested
  `limit` is ambiguous, because the relay clamps to `min(requested, ceiling)`
  and may have clamped at exactly that many. The ambiguity dissolves
  arithmetically rather than by trusting anyone — a clamp at `n` requires the
  ceiling to *equal* `n`, the ceiling is one constant for the relay, and the
  largest page it has already handed back is a lower bound on it. So
  `n < observedPageCeiling` rules the clamp out on evidence the relay itself
  produced.

  **Deliberately not NIP-11's `limitation.max_limit`.** That number is a claim,
  and a relay advertising more than it clamps to would make every page look
  short and the first one get mistaken for the whole set — the SHA-8 bug, back.
  Buzz currently advertises 1000 and clamps at 1000, so trusting it would work
  today; the source default in `nip11.rs` is 10000 against a `buzz-db` clamp of
  1000, so it has not always been true, and being right by luck is not a
  design. Substituting a trusted 1000 for the observed bound fails the SHA-8
  regression test outright, which is the control that settles it.

  Conservative before it has evidence: the first filter through a fresh `Relay`
  still confirms, and so does the **widest** filter on every read, since it
  ties its own bound. The floor is therefore one request per filter *plus one*.

  Measured on Ship's `loadAll` against production, published client versus this
  one: **66 requests → 35 cold, 34 warm — 48% fewer — 8.8 s → 0.9 s, and the
  fold compares equal event for event** (every project and issue address with
  its status, every change id, every conversation id).

- **This still does not fit a five-second poll.** 34 requests × 12 reads a
  minute is 408 against a 300 budget; at a ten-second poll it is 204 and fits.
  The remaining half is the caller's cadence, not this package's.

Additive with no signature change, but the request pattern a caller produces
changes, so a MINOR: ADR 0002 §4b puts the break on MINOR within `0.x`.

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

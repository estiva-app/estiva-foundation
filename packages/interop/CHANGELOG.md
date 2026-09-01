# @estiva-app/interop

Every entry answers the **manifest** question explicitly, including when the
answer is nothing (ADR 0002 §4b). A change to what a manifest may declare, or to
how a declaration is read, is a MAJOR — in `0.x`, a MINOR — even when no
TypeScript signature moved. A consumer upgrading must be able to tell whether
manifests already published still mean what they meant.

## 0.4.0 — 2026-09-01

**Manifest behaviour: unchanged.** Nothing a manifest may declare moved. What
moves is a cache that had been living in one app.

- **`createPeopleCache()`** — the foreign-profile cache, with its batching and
  its two TTLs, lifted out of Peek.

  It was written there for PEE-3, and the shape is the interesting part.
  `PROFILE_HIT_TTL_MS` is ten minutes because names change rarely;
  `PROFILE_MISS_TTL_MS` is one, because **a miss is somebody who has not
  finished setting up their identity — precisely the person whose name is about
  to arrive.** Cached as long as a hit, they render as `nostr:<8 chars>` until a
  full reload, and a consumer that re-reads on a timer looks like its refresh is
  broken.

  Ship needed the same behaviour, and a second consumer is what moves something
  out of one app rather than duplicating it. Without it Ship re-read `kind:0`
  for every author of every child on every tick: a referenced Peek topic with 50
  messages cost **2 requests a tick where a Ship object cost 1** — the cross-app
  case PRO-7 exists for being the dearest rather than the cheapest.

  **Store and lookup have different lifetimes**, which is why this is a cache
  with `through(fromRelay)` rather than a wrapped function. A consumer builds
  its query per call — Peek's carries the viewer's token — while the profiles it
  finds are public and worth keeping across all of them. `viaRelay(query)` is
  the common case. Caller-owned, like `createProjectionCache`; Peek's original
  was a module-level `Map`, which worked but meant every test needed a reset
  hook to undo the previous one.

  Peek's seven cases travel with it, converted from vitest **by hand** — a regex
  pass over an earlier suite produced assertions with no `assert` in them, which
  read fine and test nothing — and five more pin the store's lifetime, which the
  original could not express.

Additive, so a MINOR by the rule ADR 0002 §4b sets for `0.x`.

## 0.3.0 — 2026-09-01

**Manifest behaviour: unchanged.** Nothing a manifest may declare moved, and
nothing already published means anything different. What changes is how many
round trips reading one costs.

- **`createProjectionCache()`**, passed as the last argument to
  `resolveForeignObject`, `resolveForeignEvent` and `resolveFolderProject`.
  Omitting it is exactly the old behaviour.

  A consumer that re-resolves on a timer paid the whole resolve every tick, and
  **two of the four round trips were NIP-89 discovery** — the author's
  `kind:31989` recommendation, then the `kind:31990` manifest. Those answer the
  same thing until an app republishes. Memoised per kind and author with a
  five-minute TTL; a negative answer is cached too, because "no app claims this
  kind" costs the same two round trips and is just as stable.

  **Owned by the caller.** A module-level cache would be invisible global state
  shared by every consumer in a process, impossible to scope to a screen and
  awkward to reset in a test.

  Deliberately only the manifest. The object, its changes, its comments and its
  children are what a refresh exists to notice — caching those is how a live
  widget becomes a screenshot, which is the defect PRO-10 was filed for.

- **A `list` slot no longer costs a round trip of its own.** The child filter is
  built from the manifest and the *pointer*, and an addressable event's `d` is
  `pointer.identifier` by definition — it is what the root filter matches on. So
  the second query never needed to wait for the first, and the children now ride
  in the same request.

  The two together: **10 requests a tick to 3** for three references on one Ship
  issue, measured against production — one per reference — rendering identically
  (title, kind, comment count, child count, widget). A comment posted between
  ticks appeared on the next one-request resolve, so the widget is still live.

- **Comments and children are now matched on their filter's own criteria**, not
  on kind. This is load-bearing rather than tidying: Peek's Topic declares
  `kind:9` messages as children *and* `kind:9` as its comment kind, so merging
  the two filters into one request puts both under one number and only the tag
  separates them. Matching on kind alone would have made every message in a
  Folder a comment on its own Topic. The predicate uses **any** matching tag,
  as a relay's `#a` does — an event may carry several, and reading only the
  first would silently drop a comment that references something else before its
  parent.

Additive, with a changed request pattern, so a MINOR: ADR 0002 §4b puts the
break on MINOR within `0.x`.

## 0.2.0 — 2026-09-01

**Manifest behaviour: unchanged for addressable objects.** What changes is that
objects which have *no address* can now be resolved at all.

- **`resolveForeignEvent(reference, query)`** — resolve one event by id, from an
  `nevent1…` or a bare 64-hex id.

  The counterpart to `resolveForeignObject`, and PRO-11's reason to exist: a
  `kind:9` message carries no `d`, so `(kind, pubkey, d)` cannot be built for it
  and every resolver keyed on an address is blind to it. Measured on production
  during PRO-6.

  It is deliberately thinner. A regular event is immutable and has no folded
  state, so there is no `records` rule to apply and no change events to fetch;
  it cannot be the target of an `a` tag, so it has no comments addressed to it
  and **no actions**. That last absence is the model being honest rather than a
  gap — a change names its target by address, and there is nothing here to name.

  Two round trips, and the order depends on the reference. A manifest is found
  by kind; an `nevent` *may* carry its kind, and a bare id — which is what a
  pasted `e` tag gives you — does not, so the event is read first to learn what
  it is. Both arrive in practice.

- **`<bech32>` in a `web` template is substituted with whichever form the object
  has.** NIP-89 says nothing about which NIP-19 entity a template is handed;
  Ship's declares `naddr` because every Ship object is addressable. Substituting
  the form the object *actually has* is what lets one template serve both, and
  what stops a message linking to nothing.

- **`peerDependencies` rise to `@estiva-app/protocol >=0.3.0`**, which is where
  `decodeNevent` lives. Unlike 0.1.0's `>=0.2.0`, this range is justified by
  something the package uses — that one was a fact about the workspace and this
  is a fact about the code.

## 0.1.2 — 2026-08-31

**Manifest behaviour: unchanged.** A build fix; 0.1.1 was tagged and never
published, so this is the first release carrying its peer-range change.

- **`prebuild` builds `@estiva-app/protocol` first.** This package resolves that
  one's *types* through its `dist/`, which does not exist in a fresh checkout
  until it has been built — so `npm run build -w packages/interop`, which is
  exactly what the release workflow runs, failed with four TS2307s that read as
  if this package were broken.

  **It is the first foundation package that depends on another one.** protocol,
  identity and hello have no workspace siblings, so every release before this
  was independent and the workflow never had to care.

  Building every package instead would not have fixed it: `npm run build
  --workspaces` runs alphabetically, and `interop` sorts before `protocol`.
  Measured rather than assumed — that was the first fix attempted and it failed
  the same way. The dependency belongs in the package that has it.

## 0.1.1 — 2026-08-31 (tagged, never published)

**Manifest behaviour: unchanged.** No resolution, declaration or export moved.

- **`peerDependencies` relaxed to `@estiva-app/protocol >=0.1.2`**, from
  `>=0.2.0`.

  The stricter range was not justified by anything this package uses. It was
  chosen because the foundation repo happened to sit at 0.2.0 when the package
  was written — a fact about the workspace, not about the dependency.

  Found the way these things are found: **the second consumer tried to install
  it.** Peek is on `protocol@0.1.2` and `npm install` refused with `ERESOLVE`,
  which would have forced an unrelated protocol upgrade to adopt this package.
  Verified rather than assumed before relaxing — all four symbols this package
  imports (`encodeNaddr`, `pointerToAddress`, `referenceToPointer`,
  `parseProfile`) are exported by 0.1.2, and 0.2.0's change was to `Relay`'s
  paging, which this package does not use because it takes a `QueryFn` instead
  of a client.

  This is SHA-7's lesson one level up. The package shipped with one consumer
  that happened to be on the newer protocol, so nothing exercised the floor of
  the range until somebody else installed it.

## 0.1.0 — 2026-08-31

First publish. Extracted from `peek-app/interop/`, which was extracted from
`peek-app/convex/nostr/projection.ts` (PRO-1) — a path that said Convex about a
file whose own header said it knew nothing about the app it rendered.

**Manifest behaviour: unchanged from what is live.** Peek and Ship have been
publishing and reading these manifests on production throughout; this packages
the reader without altering what it reads.

What it resolves:

- **`resolveManifest`** — find the app that handles a kind, preferring the
  object author's own `kind:31989` recommendation over a guess.
- **`resolveForeignObject`** — an `naddr` or `kind:pubkey:d` to slots, meta,
  actions, comments, children and people. Reports `unreachable` when the
  manifest resolved and the object did not, because the relay answers
  "forbidden" and "empty" identically.
- **`resolveFolderProject`** — the container a Folder holds, and its children.
- **`buildActionEvent`** — the unsigned event a declared action emits.
- **`pickWidget` / `widgetChainProblem` / `CLOSED_WIDGETS`** — the fallback
  chain, from both sides. A consumer walks it; a producer is stopped from
  publishing one that ends nowhere.

**Not here, and not by omission:** no fold, no rendering, no relay client. See
the README's last section for why each is excluded.

### Why it is 0.1.0 and not 1.0.0

Two consumers have exercised it — Peek since it was written, Ship since PRO-7 —
and the second one changed the API on contact: `ForeignObject.widget` was typed
`string` while the wire carried a chain, which no amount of use by the first
consumer had revealed. **A third consumer will do it again.** The version says
so.

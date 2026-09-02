# @estiva-app/interop

Every entry answers the **manifest** question explicitly, including when the
answer is nothing (ADR 0002 §4b). A change to what a manifest may declare, or to
how a declaration is read, is a MAJOR — in `0.x`, a MINOR — even when no
TypeScript signature moved. A consumer upgrading must be able to tell whether
manifests already published still mean what they meant.

## 0.7.0 — 2026-09-02

**Manifest behaviour: a `body` slot now reports which content model it is
written in, and a structured value is no longer truncated.** No manifest changes
shape. A manifest that already declares `{"body": {"field": "content"}}` starts
resolving with a `format`; one that declares `truncate` on a value whose event
says it is a block document stops having it applied.

PRO-2 held the `body` slot open because "structured content" had no specified
format. RIC-1 decided it (SPEC §13): messages are marker text, rich text fields
are JSON block documents, and the two share an inline vocabulary and nothing
else. §13 forbids reading either as the other, so a consumer needs to be told
which one it has — and that is what a `ResolvedSlot` now carries.

- **`ResolvedSlot.format`** — `'marker' | 'blocks' | 'unknown'`, and **absent
  when the value is not a body at all**. Absent is not the same as `'marker'`: a
  folded `status` arrives through the same `value` tag a folded description
  does, so nothing in the data distinguishes them and only the slot they were
  declared into does.

  `'unknown'` exists so a consumer can decline. A format specified after this
  runtime was written must not be parsed as either model, and §13.5 makes
  rendering it as plain text conformant.

- **`contentFormatOf(event)`, `CONTENT_FORMAT_TAG`, `BLOCK_DOCUMENT_FORMAT`,
  `BODY_SLOT`** are exported. The default lives here rather than in each
  consumer for the reason `CLOSED_WIDGETS` does: two copies of *absent means
  marker* disagree the first time a third format exists, and the disagreement
  shows up as one app rendering JSON at a person.

- **The format is read from the event the value came from**, never from the
  object's root — SPEC §13.4. A description created as marker text and later
  edited into blocks is a root with no tag and a change with one, and the fold
  takes the change's value, tag and all.

- **A `fold` may now be seeded from `content`, not only from a tag** —
  `{"fold": "description", "field": "content"}`. §7.2 rule 2 already allowed a
  fold seeded from a tag, for the reason that tag-alone goes stale and
  fold-alone loses the creation value. A body lives in `content`, so the same
  argument reaches there, and until now neither of Ship's descriptions could be
  declared at all: an issue's is `fields.description?.value ?? event.content`,
  and a project's puts a `description` tag between the two. The chain is fold,
  then tag, then content.

  Found by trying to declare the slot rather than by reading the spec. The two
  expressible declarations were both wrong in the way §7.2 rule 1 warns about:
  `{field: "content"}` renders the creation value for ever, and
  `{fold: "description"}` renders blank for every object nobody has edited —
  most of them — and blank reads as "that app is broken" (PEE-10).

- **`truncate` is refused on a structured value.** PRO-8 established that
  truncating structure produces output that is wrong and cannot tell that it is
  wrong; it was enforced by a comment in Ship's manifest and a type only Ship
  had. Any manifest could publish `{"field": "content", "truncate": 120}`, and
  the consumer would have sliced a JSON document. Marker text is still
  truncated — a cut `**bold` is visibly cut.

**Absence of a declaration stays a declaration, permanently.** 731 published
bodies carry no `content-format` tag and none of them can be given one: roots
are replaceable by their author alone, messages and changes not at all, and
REW-11 established that rewriting stamps a `created_at` the relay will not
backdate. Untagged means marker text for good, not during a window.

## 0.6.0 — 2026-09-01

**Manifest behaviour: an object-creating action is now offered instead of
skipped.** No manifest changes shape; one that already declares
`input.type: "object"` starts being rendered, which is the point (RFC 0.4
§13.4).

- **`resolveActions` no longer drops them.** It used to say why: *"an action
  that creates a whole new object needs a form and a parent, so it is skipped
  rather than drawn as a control that cannot work."* True until something drew
  one — and the consequence was that a manifest could describe the single most
  useful cross-app action and no app could offer it. Ship has declared
  `add-issue` with a real schema the whole time.

  They resolve with `control: 'form'`, `fields` (each with any vocabulary
  already looked up, the same service `options` performs for a `select`), and
  **`createsUnder`** — the other half of "needs a form *and a parent*". A
  consumer drawing only the properties would publish an orphan.

- **`buildActionEvent` takes `{ property: value }`** for those actions, and a
  `newId` for the object being created.

  `newId` is supplied rather than generated: ADR 0002 §10 constraint 2 — the
  runtime reaches for nothing and is handed everything — and it makes the built
  event a pure function of its inputs. It is **required** for a kind in NIP-01's
  parameterized-replaceable range, because an object published without a `d` has
  no address at all: nothing can reference it, comment on it, or act on it.

**The rule that makes construction possible, previously implicit: a property's
name is the tag its value is written to.** It held for Ship by a coincidence of
naming — `add-issue` declares `{ title }` and a Ship issue carries
`["title", …]` — and nothing said so, while RFC 0.4 §13.4 asserts the existing
declaration is already sufficient for a consumer to try. Stated now at the point
of use.

Its limit, recorded rather than designed around: **nothing can target an event's
`content`.** Ship's issue description lives there and is therefore not creatable
from another app, which is why `add-issue` declares only a title.

**Every refusal names what was allowed** — an undeclared field, a required one
left empty, a value outside a declared vocabulary, and a scalar handed to a form
or the reverse. That is a requirement rather than a nicety: the owning app
cannot enforce any of it, so a consumer that guesses is the one putting junk in
a shared record, and one told only "invalid" cannot do better next time.

Verified against production, through Ship's live manifest: resolved as a form,
built, published, **and Ship's own fold shows an ordinary issue** — right title,
default status, right parent. The fixture was deleted afterwards.

Additive, so a MINOR by the rule ADR 0002 §4b sets for `0.x`.

## 0.5.0 — 2026-09-01

**Manifest behaviour: two optional fields an action may now declare.** Nothing
already published means anything different, and a manifest that declares neither
resolves exactly as before.

- **`ManifestAction.description`** — prose aimed at a machine, distinct from
  `label`, which is a button caption (RFC 0.4 §13.4). "Change status" tells a
  person which control to press and tells a caller choosing *between* actions
  nothing.

- **`ManifestAction.effect`** — `safe` | `writes` | `destructive`, whether
  invoking without confirmation is acceptable. Exported as `ActionEffect` and
  `ACTION_EFFECTS` so no consumer has to spell the set out.

Both are carried onto `ResolvedAction`. **Nothing reads them yet, and that is
expected** — they are here because adding a field costs a line and adding one
after several apps have published manifests is a migration across every one of
them, and a manifest is republished by its owner alone. The same argument
`emits.alsoRead` makes one level down.

**An unrecognised `effect` is dropped rather than carried**, which is the only
part of this that is a decision rather than a declaration. Every way of reading
`"nuke"` is a claim nobody made; absent already means *unknown, be careful*, and
leaving an uninterpretable value in place would let a consumer's
`effect !== 'destructive'` answer **true** about an action whose own manifest was
trying to warn it. Forward compatibility falls out of the same rule: a consumer
that does not know a future `reversible` treats it as unknown rather than as
permission.

That is the one field `parseManifest` sanitises, and deliberately the only one.
A manifest is another app's declaration and this layer renders what it is given
— a field this version does not recognise is a newer app, not a broken one.
`effect` is the exception because misreading it is *unsafe* rather than merely
wrong.

Additive, so a MINOR by the rule ADR 0002 §4b sets for `0.x`.

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

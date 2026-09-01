# @estiva-app/interop

Every entry answers the **manifest** question explicitly, including when the
answer is nothing (ADR 0002 §4b). A change to what a manifest may declare, or to
how a declaration is read, is a MAJOR — in `0.x`, a MINOR — even when no
TypeScript signature moved. A consumer upgrading must be able to tell whether
manifests already published still mean what they meant.

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

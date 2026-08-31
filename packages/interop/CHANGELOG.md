# @estiva-app/interop

Every entry answers the **manifest** question explicitly, including when the
answer is nothing (ADR 0002 §4b). A change to what a manifest may declare, or to
how a declaration is read, is a MAJOR — in `0.x`, a MINOR — even when no
TypeScript signature moved. A consumer upgrading must be able to tell whether
manifests already published still mean what they meant.

## 0.1.0 — unreleased

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

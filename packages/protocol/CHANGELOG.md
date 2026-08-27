# @estiva-app/protocol

Every entry answers the wire question explicitly, including when the answer is
nothing (ADR 0002 §4b). A change to the bytes an app publishes is a MAJOR — in
`0.x`, a MINOR — even when no TypeScript signature moved.

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

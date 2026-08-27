# @estiva-app/protocol

The Estiva wire format, once. Buzz-shaped Nostr event builders, the NIP-01 id
preimage, NIP-19 `naddr`, NIP-98 HTTP auth, Schnorr signing, and the two relay
clients.

```bash
npm install @estiva-app/protocol
```

No registry auth, no `.npmrc`, no token. That is [ADR 0002 §3](../../../estiva-docs/decisions/0002-foundation-packages.md).

## The line this package does not cross

**In: the bytes.** Everything whose correctness the *relay* judges — event
construction, tag order, the id hash, the signature input, `naddr`, the NIP-98
header, and the `accepted` semantics of the HTTP bridge.

**Not in: the fold, or anything that interprets events.** How an app turns a
stream of events into current truth is where apps are *supposed* to differ
(ADR 0001 §8). `foldFolder` stays in Ship, `foldResolution` and the projection
stay in Peek, and each app's conformance fixture stays with it.

When adding something here, the test is not "both apps need it". It is **"would
the relay notice if the two apps disagreed?"**

## Why one implementation, when the suite's whole claim is independence

SPEC §10 used to argue the duplication *was* the architecture: three apps each
implementing NIP-01 serialization is what makes "apps sharing no code work on the
same data" a real statement rather than a claim about siblings.

That was right about the claim and wrong about the mechanism, and the third copy
settled it. A second hand-written event-id hash is not a demonstration of
independence, it is a divergence the relay notices and we do not — and it had
already happened. Peek's `buildMessage` grew an `about` parameter emitting `a`
tags; Ship's never did. The same logical message produced different bytes
depending on which app sent it, **nothing failed, and each copy was
self-consistent.** Between the other two copies, a `diff -r` somebody had to
remember to run was the entire safety mechanism.

What makes the interop claim true is that the apps share no interpretation and no
database — still exactly the case. They now agree on the wire format on purpose
rather than by coincidence. SPEC §10 was amended by SHA-3 to say so.

## A MAJOR here is a protocol event, not a TypeScript event

A change to the bytes an app publishes — id computation, serialization order, tag
semantics, signature input — is a MAJOR **even when the TypeScript signature is
identical** (ADR 0002 §4b). Every release note answers the wire question
explicitly, including when the answer is:

> **Wire behaviour:** unchanged.

A missing line is what lets a bytes-changing release pass as a refactor.

## What holds that claim up

Four checks, and the important thing about them is that none of the four is a
green tick next to a value somebody chose.

| check | what it is |
| --- | --- |
| `test/wire.test.mjs` | 21 vectors **recorded from `peek-app/convex/nostr/` and `estiva-ship/lib/nostr/` before this package existed** — the bytes the two apps were already publishing. All 12 shapes both apps implemented had identical ids in both. |
| the same file, `production kind:*` | 8 events read back off `https://estiva.estiva.app`. Their `id` and `sig` are the **relay's**, so reproducing the id checks against the authority rather than against ourselves. |
| `test/oracle.test.mjs` | `nostr-tools` as an independent implementation, with a negative control that fails when the bytes are wrong. Plus the canonical NIP-19 `npub` vector from the specification, which is the only thing that catches bech32m-instead-of-bech32. |
| `test/runtime.test.mjs` | the barrel imports and works with `WebSocket`, `fetch`, `btoa`, `document`, `process`, `Buffer` and friends deleted — with its own negative control. |

**Do not regenerate `wire-vectors.json` to make a failing test pass.** That erases
the finding. Regenerating is correct only when a builder is deliberately given a
new shape, and then the release note says so under *Wire behaviour*.

A green suite is still not the last word. The relay is the only authority on
whether the wire format is right, and a passing test run is compatible with a
rejected event. So there is a fifth check, and it is hand-run because it needs a
real workspace credential — and a credential in CI is the standing secret ADR
0002 §4c spent a failed release deciding not to have:

```bash
npm run build -w packages/protocol && set -a && . ~/.estiva-agent.env && set +a && npm run verify:live -w packages/protocol
```

It publishes a **real signed `kind:9007`** naming a channel that already exists,
so the relay answers `200 {"accepted":false,"duplicate: channel already
exists"}` — proof the event was parsed, its id recomputed and its signature
verified — while creating nothing. Then two negative controls, without which "it
works" is indistinguishable from "the rule was removed":

- the same signed event with **two tags swapped** and `id`/`sig` left alone. The
  relay's own words, 2026-08-27: `400 invalid: invalid event id: computed
  70f206d4…, got b9d1e606…`. It recomputes the id independently, so agreement on
  the good event is agreement about the bytes rather than indifference to them.
- a `kind:0`, which `/sign` refuses for every app unconditionally —
  `422 policy_violation`. The gates are live, not open.

Run it before tagging any release whose *Wire behaviour* line is not
"unchanged", and again afterwards against the **published tarball** rather than
the workspace, because built is not published.

## `nostr-tools` was evaluated, and is a devDependency rather than a dependency

SHA-3 asked for an hour on this before packaging a hand-rolled hash. Measured,
2026-08-27, against `nostr-tools@2.25.0`:

| question | answer |
| --- | --- |
| does `getEventHash` agree with `computeEventId`? | **Yes, on all 103 events** recorded from production, and on every vector here. `verifyEvent` verified all 103 relay signatures. |
| does `nip19` round-trip our pointers? | **Yes, exactly** — including a `d` tag containing colons. |
| is its `naddr` string the same as ours? | **No.** It emits the TLVs in a different order, so the same pointer encodes to a different string. Every decoder involved reads TLVs by type and is order-tolerant, so they interoperate — but naddrs must never be compared as strings. |
| does its NIP-98 fit? | **No.** `getToken` emits `u`, `method`, `payload` and **no nonce**. Buzz records each auth event id in a Redis replay set and `created_at` has one-second resolution, so two identical requests in one second would collide and the second is refused as `NIP-98: replay detected`. Ours adds a nonce for exactly that reason. |
| its NIP-42? | `makeAuthEvent` emits relay-then-challenge, which happens to match ours. Buzz looks both tags up by name, so it is not load-bearing either way. |
| cost of depending on it | it needs `@noble/hashes@2` and `@noble/curves@2`; Peek is on `^1.8.0`/`^1.9.2` and Ship pins `1.8.0`/`1.9.2`. Adopting it puts **two majors of `@noble/*` in every consumer's tree**, and noble v2 renamed its subpaths (`/sha256` → `/sha2`), so it is not a drop-in. |
| what it does not cover at all | the Buzz kind constants, `canonicalChannelName`, the tag layouts Buzz validates (`h`, the NIP-10 marked-reply form, the `a` about tag), the 30850/30851/1851 shapes, and the `accepted`-field semantics of the bridge. Those stay ours regardless. |

**Decision: keep our own thin implementation and use `nostr-tools` as an
independent oracle in the test suite.** That is strictly better than either option
the ticket floated — a third-party cross-check with no dependency, no second
noble, and no bytes for consumers. It is also what replaces `diff -r`: a check
that fails on its own rather than one somebody has to remember to run.

## Runtime requirements, and why they are not in the types

The package compiles with `types: []` and no `lib: dom` so one published `.d.ts`
works in Peek's Convex tree, Peek's browser bundle and the agent's `tsx` run
(ADR 0002 §4a). None of `URL`, `btoa`, `fetch`, `WebSocket`, `TextDecoder` or the
timer functions is in `lib.es2022`, so each is **declared inside the module that
needs it** and **read inside a function body**:

- declaring it inside a module means nothing lands in a consumer's global scope;
- reading it inside a function means importing the package touches no global, so
  a backend that only wants the event builders does not crash on a `WebSocket`
  its runtime has never heard of.

The transport-shaped ones are parameters as well as globals: `Relay` takes an
optional `fetch`, `createLiveRelay` takes an optional `socketFactory`, and the
defaults read the runtime's own.

One honest exception, found by writing the test: **`@noble/curves` reads
`TextEncoder` while its module body runs.** So "no globals at all" is not a
property this package can have while it depends on `@noble/*`. `TextEncoder`,
`TextDecoder` and `URL` are WHATWG universals present in every runtime the suite
targets, and that is the line.

## Consumers

Peek, Ship and `estiva-agent` — see [CONSUMERS.md](../../CONSUMERS.md). A
breaking change is not published until every one of them has an open upgrade PR,
authored by whoever makes the break (ADR 0002 §5).

## Releasing

```bash
git tag protocol@0.1.1 && git push origin protocol@0.1.1
```

`release.yml` checks the tag against `package.json`, builds, and publishes
through trusted publishing (OIDC). No npm credential exists in GitHub. See the
[repo README](../../README.md) for the once-per-package manual first publish.

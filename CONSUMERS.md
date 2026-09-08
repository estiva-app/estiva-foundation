# Consumers

Who depends on what. **A breaking change is not published until every consumer
listed here has an open upgrade PR, authored by the person making the break** —
ADR 0002 §5. This file is what makes "every consumer" a list somebody can read
rather than folklore.

Keep it current in the same PR that adds or drops a dependency.

| package | consumer | repo | notes |
| --- | --- | --- | --- |
| `@estiva-app/hello` | — | — | throwaway; installed and removed during SHA-1's proof |
| `@estiva-app/protocol` | Peek, Ship, estiva-agent, **`@estiva-app/identity`** | `estiva-app/peek`, `estiva-app/ship`, `estiva-app/estiva-agent` | **SHA-3, all three live.** The vendored copies are deleted and `diff -r` is no longer the safety mechanism. What is still duplicated between Ship and the agent is `src/` and `lib/nostr/signer.ts`, held by a byte-identical `scripts/conformance.test.ts` |
| `@estiva-app/platform` | Peek, Ship | `estiva-app/peek`, `estiva-app/ship` | **SHA-7 created it, 0.1.0 not yet published.** The socket plumbing, refactored out of Peek's `liveTopics.ts` rather than moved — ADR 0002 §10 scores that file ❌ on constraints 1 and 2, so `git mv` was never available. Peek migrates onto it as its first consumer; Ship is the second, and that is PER-3. The row was previously attributed to SHA-2, whose PWA export now *adds to* this package rather than creating it |
| `@estiva-app/identity` | Peek, Ship | `estiva-app/peek`, `estiva-app/ship` | SHA-4, extracted during REW-2. Takes `protocol` as a **peer** from 0.2.0, which is when `POST /sign` moved in — so a `protocol` break is now an `identity` consumer too |
| `@estiva-app/ui` | Peek, Ship | `estiva-app/peek`, `estiva-app/ship` | SHA-5, extracted during REW-3 |
| `@estiva-app/interop` | Peek, Ship | `estiva-app/peek`, `estiva-app/ship` | **PRO-9, not yet published.** Ship consumes it today as a vendored copy at `interop/`, pinned by sha256 in `scripts/vendor.test.ts`; Peek from source at `interop/`. Both switch to the registry when this publishes, and Ship's copy is deleted the same day |

The scaffold REW-1 produces consumes all four, which makes app number four a
consumer the day it is created. That is the reason this list exists now rather
than at four apps.

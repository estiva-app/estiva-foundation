# @estiva-app/platform

## 0.3.0

When a tab re-reads, and when the relay has asked it to wait (PER-13). Additive.

Ship's `useRefresh` + `relayBudget` taken out of the app, so Peek can stop
firing every read twice per tab switch and stop retrying refused reads in a
herd. On 2026-09-23 one person's key reached 306 requests in a minute across
two Peek tabs and a Ship tab, against buzz's 300-per-pubkey window.

- `createRefreshScheduler({ document, window, budget })` — one `focus` and one
  `visibilitychange` listener per tab, fanned out to every subscriber. Two
  triggers inside `mergeMs` (default 1 s) are one read, per subscriber. The
  interval never runs in a hidden tab. Nothing runs while the budget is paused,
  and nothing is queued for when it ends.
- `createRelayBudget({ channel? })` — the pause the relay's `retry in N s`
  names. Extends, never shortens. `whenClear()` resolves once it has passed.
  Given a `BroadcastChannel`, a pause one tab learns holds in the app's others.
- `isRateLimited`, `retryHintMs`, `DEFAULT_BACKOFF_MS`, `MIN_BACKOFF_MS`,
  `DEFAULT_MERGE_MS`.

## 0.2.0

A Folder notification may carry the event that caused it (PER-8). Additive:
every existing listener keeps compiling and behaving as before.

- `watchFolders`' listener is called `(folder, event)`. The wide filter always
  had the event in hand and dropped it, so a reader that keeps what it has read
  — Peek's sidebar, which re-read 90 days of every Folder to learn about the one
  message the socket had just delivered — had nothing to apply and could only
  re-read, against a relay quota metered per HTTP request.
- `watchFolders` takes `since`, bounding what the REQ replays on subscribe and
  on every reconnect. Without it the relay replays up to its default limit,
  shared across every Folder in the filter.
- `FolderListener` is `(event?) => void` and `FolderActivity.notify` takes the
  event. A notification with nothing to carry — another app's record moved —
  still sends none, so a missing event means "re-read", never "nothing".

## 0.1.0

First release. The plumbing a second consumer of the live socket needs, taken
out of `peek-app/src/nostr/liveTopics.ts` and refactored to take its
environment injected rather than relocated — ADR 0002 §10 scores that file ❌
on constraint 1 and ❌ on constraint 2, so a `git mv` was never available.

- `createLiveClient` / `createLiveClientHolder` — one socket per tab, the
  credential read per connect, and the network coming back. The holder is a
  mechanism; the single module binding stays in the app.
- `watchFolders` — a whole workspace in one REQ per 128 Folders, reporting
  which Folder changed rather than what changed. This is the capability the
  second consumer forced: `createChannelSubscriptions` is one REQ per channel,
  which a 34-Folder workspace pays on every connect and reconnect against a
  budget that refuses the 51st unpaced REQ.
- `createFolderActivity` — from Peek's `foreignActivity.ts`, which was already
  written as a factory for this reason and came over unchanged in substance.
  Renamed because "foreign" was Peek's framing: a workspace reader watching its
  own Folders is in the same position mechanically.
- `browserOnlineSource` / `assumeOnline` — `navigator.onLine` and the two window
  events as an injected source, so nothing here touches a global at module
  scope and the suite runs with no DOM.

`liveProjection.ts` and `freshness.ts` stayed in Peek on purpose: the first is
Convex-shaped, the second is product voice.

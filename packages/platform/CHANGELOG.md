# @estiva-app/platform

## 0.6.0

The copy answers a pooled list it has seen every value of (PEE-4, Peek opens
instantly). Additive; a copy written by 0.5 is read as before.

Apps pool a set into one list — `'#e': [the newest messages]`,
`'#a': [25 addresses]`, `authors: [everyone named]` — and the list changes
whenever the set does, so after a reload a read asked a list the relay never
saw, though it had answered every value in it. Such a filter is now answered
when, for one of its list fields, filters the same in every other field
(`limit` aside) were answered **whole** and their lists hold every value it
asks. Whole means not cut by its `limit`: under it, or past the most events
the filter can match (one version of each replaceable event per author, of each
addressable one per author and `d`, one event per id).

- `answer` and the corrections a relay answer makes look only at the held
  events of the filter's `ids`, else its `kinds`, not the whole copy: on a
  reload at Peek's Topics, about a hundred reads spent 64 ms scanning it.
- `SnapshotRecord.whole` and `SnapshotChange.whole`: the keys of filters whose
  last answer was whole. Both storages keep them; a record without them covers
  nothing until its filters are answered again.

## 0.5.0

A copy on the device a reload draws from (PEE-2, Peek opens instantly). Additive.

`createEventSnapshot` keeps one person's signed events from one relay —
never a folded view — and answers the same filters from them on the next
load, before the relay has. Every relay answer it takes in is also a
correction, since the relay has no sequence number to replay: what matches a
filter the relay just answered and is not in that answer is dropped (a
deletion, a lost Folder); a cut answer judges only the window it covers; a
`kind:5` drops what its own author signed; a replaceable event keeps its
newest. A filter it never saw answered is not answered (`null`), and `since`
and `until` are not part of a filter's key. It keeps the plaintext of a
person's own blob beside its event, so the same ciphertext is never
decrypted twice.

- `createEventSnapshot({ storage, scope, version, maxEvents?, saveAfterMs?, now?, timers? })`
  → `{ ready, answer(filters), absorb(filters, events), plaintextOf, keepPlaintext, size, flush, close, discard }`.
  An answer absorbed before `ready` is applied over the stored copy; a failed
  save is asked again; `close` writes what changed, `discard` (sign-out) does not.
  A `kind:5` drops `e` targets and `a` coordinates its own author signed.
  A plaintext is kept only beside the person's own replaceable event.
- `SnapshotStorage` — `load(scope)` → `{ epoch, record }`, `save(scope, change)`
  with `change.epoch`, `clear()`. `clear` counts a sign-out, and a save naming
  an older count writes nothing: a copy opened before a sign-out, in any tab,
  cannot write the person's data back after it.
  A copy written under another `version` is dropped unread; past `maxEvents`
  (10,000) the least recently seen go.
- `indexedDbSnapshotStorage(indexedDB, name?)` — the browser's storage, the
  factory passed in (the package compiles without `lib: dom`);
  `memorySnapshotStorage()` for tests and browsers without it; `clear()` is
  sign-out.
- `snapshotScope(relayUrl, pubkey)`, `snapshotFilterKey(filter)`,
  `matchesSnapshotFilter(filter, event)`.

## 0.4.0

One read a tab holds on to, and reads again when it fails (FOL-5). Additive.

`createRetryingRead` is Peek's FOL-42 `useFolders` without React or a relay:
a failure is read again on a backoff (5 s doubling to 60 s, or the relay's own
`retry in Ns` for a quota refusal), a failure never replaces a good answer, and
the answer is held past the component that asked. Ship's Folder listing read
once and turned one failure into an empty list for the session, which dropped
every project out of its team until a reload.

- `createRetryingRead<T>({ retryable?, firstRetryMs?, maxRetryMs?, freshMs?, now?, timers? })`
  → `{ snapshot, subscribe, ensure(load), reload(load), dispose, clear }`.
  Wrap it with `useSyncExternalStore(read.subscribe, read.snapshot)`. Retries
  run only while something is subscribed; `clear()` forgets the answer, and a
  read in flight across it writes nothing.
- `retryDelayMs(failures, error)`, `RETRY_FIRST_MS`, `RETRY_MAX_MS`.

## 0.3.1

Subscribers on one interval share one timer (PER-6). No API change.

0.3.0 started a `setInterval` per subscriber, at the moment it subscribed, so
three views on one page on the same 10 s woke at three unrelated phases — Ship's
project page read every ~3 s, and never inside the 1 s merge. Now there is one
timer per distinct `intervalMs`, and every subscriber on it wakes in the same
tick.

- A subscriber that joined less than half an interval ago sits out a tick: its
  caller has just done its own first read. Its first scheduled refresh comes
  between 0.5× and 1.5× the interval after subscribing, then on the shared beat.
- Different intervals still have separate timers, and separate phases.

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

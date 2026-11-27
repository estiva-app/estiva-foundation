# @estiva-app/platform

## 0.15.0

A catch-up refused for the person's quota waits out the pause and compares
again, instead of asking the question whole (THE-15). The relay's quota is the
person's, spent by all their apps, and its pause is short (buzz counts it over
5 s); asking whole the moment it said to back off cost one of Miky's reopens
7 MB more on 26 Nov.

- `catchUp` reads a refused reconciliation's `rate-limited: … retry in Ns`
  and, when the stated wait (at least 1 s) is at most `quotaWaitMs` (default
  `CATCH_UP_QUOTA_WAIT_MS`, 5 s), waits it and compares that question once
  more. A refusal that names no wait, a longer one, or a second refusal asks
  the question whole, as before.
- `CatchUpOptions.sleep` for a test's clock.

## 0.14.0

A file list (SPEC §6.13, `"fields": "newest"`) catches up from the copy too
(THE-9). The copy remembers the ids of each list's last answer — its first
records, and the changes whose `a` names one of them — and `catchUp` tells the
relay those, downloading only what changed since: a reopen with nothing new
fetches none of the list again. Needs a relay whose NIP-77 takes `fields`
(buzz from estiva-app/buzz#74); one that refuses it gets the list asked plainly.

- `held(filter)` answers a list read with its last answer's events, and `null`
  for one never answered or whose `limit` could cut it. Only a `limit` at least
  the most first records the filter can match (interop's `authors`, one kind
  and `#d`) leaves a list catch-up-able.
- After a catch-up, a list's ids are what it held, less what the relay no
  longer lists, plus what it fetched. An id leaving a list leaves only that
  list: a replaced change or a deleted file stays held and readable by id.
- A plain answer to several filters is split per list: a first record to each
  list it matches, a change to the lists of the file its `a` names. An answer
  of the relay's whole page of first records (1,000) is not remembered.
- A list is never windowed or split by time: its `since` and `until` pick first
  records, and a change goes with its file. A list the relay calls too big is
  asked plainly.
- Stored with the copy (`SnapshotRecord.lists`), written only when a list
  changed; a save of events alone keeps the stored lists. At most
  `SNAPSHOT_MAX_LISTS` (500, option `maxLists`) are remembered, the least
  recently answered forgotten first. `snapshotListKey(filter)` is exported.
- Not covered: interop's team listing asks `#buzz-channel` beside `#h`, which
  neither the copy nor a catch-up takes; it is still asked plainly until
  interop finds a team's projects by §6.13's rule (a blocker in the project).

## 0.13.1

A windowed question (`limit`) caught up from a copy that holds more than its
window no longer answers older events the relay did not compare (THE-6 review).
When messages in the window were deleted, or a team in it was lost, older
held events below the window filled the gap, and those could be deleted or out
of reach too. Now only what the relay compared counts; a window left short is
asked again, as the code already intended.

## 0.13.0

The copy on the device can catch a question up with NIP-77 (THE-5). It
downloads only what it is missing and drops what is gone or can no longer be
read, where today it asks for everything again. Needs `@estiva-app/protocol`
0.70.0 for `LiveRelay.reconcile`.

- `catchUp(snapshot, filters, relay, options?)` catches each filter up and
  returns the answer asking again would give, with what it cost (`reconciled`,
  `asked`, `fetched`, `dropped`). For each filter it asks plainly instead when
  the relay does not speak NIP-77 or refuses, when the filter is one the copy
  cannot judge (`search`), when it holds fewer than `CATCH_UP_SMALLEST_HELD`
  events, or when a windowed (`limit`) question's window moved further than
  catching up saves. A question the relay calls too big is split by time. The
  relay side is `CatchUpRelay`: whether it speaks NIP-77
  (`relaySpeaksNip77(nip11)`), `reconcile`, and a plain `query`.
- `EventSnapshot.held(filter)` and `caughtUp(asked, reconciled, fetched,
  gone)` are the copy's two halves of a catch-up. A catch-up also marks every
  event the relay still returns as seen, so the events it never sends again
  are not the first to be trimmed.
- Fixed: a question with no `limit`, or with one past the relay's own 1,000
  (`relayMaxLimit`, `SNAPSHOT_RELAY_MAX_LIMIT`), was treated as answered in
  full. A copy holding more than 1,000 matches then dropped the older ones the
  relay had simply not sent.
- `SNAPSHOT_MAX_EVENTS` goes from 10,000 to 20,000. One open of Peek's Desk
  reads 9,000–12,000 events, so a copy capped at 10,000 dropped part of what
  every reopen reads, and a catch-up would have fetched that part again each
  time.

## 0.12.0

A failure report says why (Miky, 23 Nov). Sentry filed every "Could not load"
in an app under one error, so nine reports after the per-minute fixes could
not be told from the limit without reading two servers' logs; none was it.

- `FAILURE_REASONS` and `FailureReason`: `told-to-wait` (the relay's
  per-minute limit), `id-told-to-wait` (Estiva ID's own limit), `relay-busy`,
  `signed-out`, `not-reached`, `no-access`, `other`. Estiva ID keeps the same
  list and files each reason of a failure as its own error.
- `reporter.failure(what, reason?)`, and the reporter's `reason` option for a
  screen that holds only "it failed". The body's `reason` is sent only for a
  failure and only from the list; a failure nothing was heard for carries
  none and stays in the error it was in. Once per name and reason per screen.
- `failureReasonOf(error, status?, from?)` reads the reason from what a
  request threw or answered (its `name`, its status, the relay's prefix); the
  wording is never sent. `from: 'id'` is for Estiva ID's answers: its 429 is
  `id-told-to-wait`, never the relay's limit.
- `createHeardFailures()`: the app's transport calls `heard(reason)` on each
  failed request, and `recent()` is the latest one within `HEARD_FOR_MS`
  (15 s), for the `reason` option.

## 0.11.0

The page-open timer counts a new tab's sign-in pass, and Peek's saved picture
is a second number (Miky, 19 Nov).

- `pageTimer.leaving()`: call it just before the tab leaves for Estiva ID to
  sign in. The open still running goes on in the page the tab comes back to,
  from its own start, as the speed kit counts it; nothing is sent from the
  page that left. `browserPage(window)` keeps it in the tab's
  `sessionStorage`, taken once, and only if the next page starts within 10 s
  of leaving (a sign-in that asked for a passkey is not the wait we time).
- `picture: () => number | undefined`: when the page load drew a saved
  picture of the page first, the moment it showed on the page's clock. The
  load's timing then carries `pictureMs`, from the same start as `waitMs`;
  an open inside the app never does.

## 0.10.0

A page-open timer beside the error reporter: how long a person waited for a
page to open goes to Estiva ID's `POST /timing`, signed in, and on to Sentry
(record page-open-timings-go-to-sentry-named-by-the-person-built-from-an-allowed-list).

- `createPageTimer({ endpoint, release, token, screen, screens, page })` gives
  `loaded()` (call once at boot: a new tab or a reload, timed from the page's
  own start), `opened()` (call as the app navigates: a click, back or forward)
  and `stop()`. `browserPage(window)` is the `page` for a real tab.
- The wait ends when the last loading placeholder outside `aside` and `nav`
  went (`PLACEHOLDER_SELECTOR`, the speed kit recorder's own) and none came
  back for `quietMs` (1 s). An open with no placeholder by
  `noPlaceholderAfterMs` (5 s), or left before one showed, is sent as
  `ready: 'no-placeholder'`; one still loading after `giveUpAfterMs` (60 s) as
  `'gave-up'`.
- The body is `{ release, screen, how, waitMs, ready }` and nothing else;
  `how` is `new-tab`, `reload` or `in-app`. A screen off `screens` is
  `<unknown>`.
- An open the person leaves while it is still loading (another page, another
  tab) is sent as `ready: 'left'`, the wait until they left, counted apart
  (Miky, 19 Nov). Thrown away: an open in a tab hidden from the start, one
  hidden before anything drew, any while signed out, and one that fails to send.
- Its own allowance, `maxPerHour` (120) per tab, apart from the error
  reporter's. The page is watched only while an open runs.

## 0.9.0

A failure the app tells a person about, and a write the relay refuses, are
reported too (PROD-5), not only crashes.

- `reporter.failure(what)`: what failed, one of `FAILURES` (`not-sent`,
  `not-saved`, `not-moved`, `not-loaded`, `sign-in-failed`, …); a name off the
  list is sent as `unnamed`. The message the person saw is never sent: most
  name a title, a person or the relay's own sentence.
- `reporter.refused(code)`: the relay's refusal code as protocol's
  `refusalCodeOf` reads it (`archived`, `busy`, `http-500`); any other shape is
  sent as `uncoded`. Records a `write-refused` step.
- Both are sent once per name per screen per tab, with no wording and no frames, under
  their own ceiling (`maxHandledPerTab`, default 10) apart from crashes, so a
  relay that keeps refusing cannot use up the crash budget. A relay answering
  "busy" a hundred times sends one report.
- The body gains `named` and `how: 'failure' | 'refused'`; Estiva ID keeps the
  same list. `report(error, how)` takes only the crash kinds.

## 0.8.0

An error reporter every app shares (PROD-2): when a part of the page breaks, a
short report goes to Estiva ID's `POST /report`, signed in, and on to Sentry.

- `createErrorReporter({ endpoint, release, origin, token, screen, screens })`
  gives `report(error, how)`, `step({ screen } | { action })` and
  `listen(window)`. `screens` is the app's list of route patterns.
- A report is built from a fixed list: the kind of error, its wording with
  quoted text, unquoted input, addresses and long ids removed (`scrubMessage`),
  the stack frames in the app's own `/assets/` bundles (`readFrames`; any other
  frame keeps neither file nor name, and a line of the error's own wording is
  never read as a frame), the screen as one of `screens` (else `<unknown>`),
  the release, and the last ten steps, each rebuilt as a listed screen or one
  of our named actions. Anything thrown that is not an `Error` is reported by
  its kind alone.
- Each kind of error is sent once per tab, ten at most; nothing is sent while
  signed out, and a failed send never throws into the page.

## 0.7.1

A reaction or its taking back now reaches a Folder watch (COMM-4).

- `watchFolders` used to drop every event without an `h` tag. A `kind:7` and a
  `kind:5` carry none: the relay files them under their target's Folder and
  sends them only to a subscription naming it. A subscription naming one
  Folder now hands them to it. One naming several still drops them: nothing
  says which Folder, and handing one to each would make a wide watch (Ship's)
  re-read them all. Seen on production: a
  reaction QA-1 added in Peek reached an open Leaf tab's socket and never its
  comment column.

## 0.7.0

Loading what is opened next, without slowing a click (PEE-5, Peek opens
instantly). Additive.

- `createPacer` — Peek's socket pacer (OPT-2), moved here, with lanes. `click`
  is as before: newest first, a read waiting past `STARVED_AFTER_MS` first,
  spilling to HTTP when allowed. `ahead` takes only what a window leaves over —
  never while a click waits, never past `perWindow - reserve` (a quarter by
  default) — in the order asked, and over HTTP only when its own `spill`
  allows. `promote()` moves the waiting
  `ahead` reads into the click lane; `waiting()` counts both.
- `createInFlight(max, aheadMax)` — at most `max` REQs on the wire, at most
  `aheadMax` of them `ahead`; a freed slot goes to a waiting click first.
- `loadAhead(steps, { concurrency })` — an app's steps in order, `concurrency`
  (2) at a time, once; the first that throws stops it, `stop()` starts nothing
  more, and `done` says what loaded and why it stopped.

## 0.6.1

The copy writes only what changed (PEE-4, Peek opens instantly). A relay answer
used to mark every event it carried for writing, held already or not, so each
Peek page load re-wrote thousands of unchanged events. A reload during such a
write waited behind it: as QA-1, the copy took 2–6 s to be read and a topic
opened after a reload waited for the relay instead.

- An event the copy already holds, unchanged — same signature, content and kept
  plaintext — is written again only when its last-seen time is
  `SNAPSHOT_SEEN_REFRESH_MS` (an hour, `seenRefreshMs` to change it) old. In
  memory its last-seen time is always the newest, so this page drops the least
  recently seen past `maxEvents` as before; a copy read after a reload may be
  out by up to that hour.
- Measured on Peek's first-load probe as QA-1: after a reload, each save puts
  0–10 events instead of 800–2,400, and the copy is read in 0.2–0.3 s.

## 0.6.0

The copy answers a pooled list it has seen every value of (PEE-4, Peek opens
instantly). Additive; a copy written by 0.5 is read as before.

Apps pool a set into one list — `'#e': [the newest messages]`,
`'#a': [25 addresses]`, `authors: [everyone named]` — and the list changes
whenever the set does, so after a reload a read asked a list the relay never
saw, though it had answered every value in it. Such a filter is now answered
when, for one of its list fields, filters the same in every other field
(`limit` aside) were answered **whole** and their lists hold every value it
asks. Whole means not cut by its `limit` — under it, or past the most events
the filter can match (one version of each replaceable event per author, of each
addressable one per author and `d`, one event per id) — and asked with no
`since` or `until`: an answer from a cursor on says nothing about before it.

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

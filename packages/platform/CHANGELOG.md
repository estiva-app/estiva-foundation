# @estiva-app/platform

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

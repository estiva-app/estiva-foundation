# @estiva-app/platform

The browser lifecycle two Estiva apps share.

`@estiva-app/protocol` owns the wire — event construction, ids, signatures, and
the two relay clients — and deliberately contains no fold. This package sits
above it and holds the things that are about **running in a tab**: the one
socket a tab should have, its credential read on every connect, and the network
coming back.

```bash
npm install @estiva-app/platform
```

`@estiva-app/protocol` is a peer dependency.

## Why it exists

`createLiveRelay` and `createChannelSubscriptions` were extracted into
`protocol` with a single caller, and the plumbing a *second* app needs never
moved with them. It stayed in `peek-app/src/nostr/liveTopics.ts`, which
[ADR 0002](https://github.com/estiva-app/estiva-docs/blob/main/decisions/0002-foundation-packages.md)
§10 scores ❌ on constraint 1 (imports) and ❌ on constraint 2
(environment injected), and calls "the bill SHA-7 is paying".

Three behaviours, each of which fails as a healthy-looking socket that delivers
nothing:

- **One instance per tab.** `max_subscriptions` is per connection and the relay
  authenticates a connection once, so a connection per component mount is wrong
  rather than merely wasteful. React StrictMode makes it concrete: anything
  owned by an effect is built twice.
- **The credential read per connect, never captured.** A token captured at
  module load survives a silent renewal as a dead credential, and a reconnect
  then signs its `22242` with it.
- **The network coming back.** Reconnection is driven by `onclose`, and a
  socket whose peer became unreachable stays `OPEN` until TCP gives up. Without
  an `online`/`offline` signal it reports `live`, delivers nothing, and never
  retries.

## Usage

```ts
import {
  browserOnlineSource,
  createLiveClientHolder,
} from '@estiva-app/platform'

// The app holds the one module-scope binding. This package holds none — that
// is the constraint-2 failure it exists to stop repeating.
const holder = createLiveClientHolder()

export function liveClient() {
  return holder.get({
    relayUrl: RELAY_URL,
    // Read fresh on every connect attempt.
    getCredential: () => {
      const token = validToken()
      return token && { accessToken: token.accessToken, pubkey: token.pubkey }
    },
    sign: signViaEstivaId,
    online: browserOnlineSource(window),
    subscriptionPrefix: 'my-app-',
    // Told what happened, never asked what to do — your freshness model stays
    // yours.
    observe: { onState: recordRelayState, onOnline: recordOnline },
  })
}
```

### Watching one channel, or a whole workspace

Two paths, and the difference is a cost rather than a preference.

```ts
// Per channel, refcounted: one REQ each, every consumer sees every event.
// What a message projection wants.
client.subscriptions.subscribe(channelUuid, (event) => project(event))

// A whole workspace in one REQ per 128 Folders. You are told which Folder
// changed, never what changed.
client.watchFolders(folderIds, (folder) => refresh(folder), { kinds: [9, 1111] })
```

`REQ` is a client→server frame, so it is metered on the relay's
`LimitType::WsEvents`. Measured against production: **50 unpaced REQs are
accepted and the 51st is refused** `rate-limited: quota exceeded`. So a
34-Folder workspace on the per-channel path spends 34 frames on every connect
*and every reconnect*; `watchFolders` spends one.

Holding subscriptions, by contrast, costs nothing measurable — the probe round
trip was 44.2 ms whether 1, 34 or 100 were open.

### One thing to know before relying on `watchFolders`

The wide filter is measured, not assumed: one filter carrying 34 `#h` delivered
34 of 34 live against `wss://estiva.estiva.app`.

It is also a property of the **deployed relay branch**. `nfb-demo-kinds` carries
a plural `extract_channel_ids_from_filters` that returns the whole channel set;
on `origin/main`'s singular version the same filter registers as a *global*
subscription, and `fan_out_scoped` branches on the event's `channel_id` and
never consults it for anything carrying an `h`. That build delivers **0 of 34,
with no error at all** — EOSE, `live`, silence.

So anything depending on this should be able to answer *"did an event I did not
publish actually arrive?"*, because nothing else distinguishes the two cases.
Pass `kinds` while you are at it: a kindless wide filter was refused outright on
that other build with `restricted: p-gated events require #p matching your
pubkey`.

### Refreshing, and waiting when the relay says so

Buzz meters `POST /query` at 300 a minute **per pubkey**, so every tab and app
signed in as one person shares one allowance. Build one budget and one
scheduler per tab:

```ts
import { createRefreshScheduler, createRelayBudget } from '@estiva-app/platform'

// The transport writes it; the cadence reads it.
export const relayBudget = createRelayBudget({
  // Optional: the app's other tabs learn a pause from this one.
  channel: new BroadcastChannel('my-app-relay-budget'),
})
export const refreshScheduler = createRefreshScheduler({ document, window, budget: relayBudget })

// In the transport, on every answer:
if (status === 429 || isRateLimited(body)) relayBudget.noteRateLimited(body)

// In a hook: focus, becoming visible, and every 30 s while visible. A tab
// switch raises two events and costs one read; nothing runs while paused.
useEffect(() => refreshScheduler.subscribe(reload, { interval: !live }), [live])

// Before retrying a refused read: every waiter goes after the longest pause
// anybody learned, not its own shorter one.
await relayBudget.whenClear()
```

Nothing here gates a read. A read somebody asked for by clicking still goes out
at once; only the cadence backs off.

## What this deliberately does not know

Where anything is stored. Peek's version took a `LiveProjectionApi`, and
extracting that as-is would have baked a Convex assumption into a package two
apps depend on. This delivers frames and connection state and nothing else, so
it bets on neither outcome of "do we need Convex": if Convex stays nothing here
changes, and if it goes this is already right.

Your freshness states and their copy are product voice and stay in your app.
`observe` is how they get what they need.

## License

MIT

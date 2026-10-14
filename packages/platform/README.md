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

### A copy on the device, so a reload draws at once

`createEventSnapshot` keeps what the relay told one person — signed events,
never a folded view — and answers the same filters from it on the next load.
Fold its answer as you fold the relay's, then send the relay the read as
before and fold again: the relay's answer replaces the copy's.

```ts
import { createEventSnapshot, indexedDbSnapshotStorage, snapshotScope } from '@estiva-app/platform'

const storage = indexedDbSnapshotStorage(indexedDB, 'my-app-copy')
const copy = createEventSnapshot({
  storage,
  scope: snapshotScope(relayUrl, pubkey),
  version: 1, // bump when what you fold from it changes meaning
})

// In the transport, on every answer the relay gives:
copy.absorb(filters, events)

// Before the relay answers: null means the copy cannot answer this read whole.
await copy.ready
const drawnFirst = copy.answer(filters)

// Signing out: every copy goes, and one still open — in this tab or another —
// can never write the person's data back (the storage counts sign-outs).
copy.discard()
await storage.clear()
```

It answers a read it has seen answered, and a pooled list it has not, when
reads the same in every other field (`limit` aside) were answered whole and
together named every value in it — `'#e': [the newest messages]` after the
newest changed. `since` and `until` are the clock and not part of the question.

Every answer is also a correction: an event the copy holds that matches a
filter the relay just answered, and is not in that answer, is dropped — a
deletion, or a Folder the person lost. A `kind:5` drops what its author
signed. `keepPlaintext` keeps the plaintext of the person's own blob beside
the event, so an unchanged blob needs no decrypt on the next load. Never
publish over something drawn from the copy: it may be older than the relay.

### Loading what is opened next, without slowing a click

`createPacer` holds a tab's socket reads to the relay's meter (buzz: 50 REQs
per 5 s per pubkey), in two lanes. A `click` read — what the person asked for —
goes newest first, and may spill to HTTP after waiting. An `ahead` read takes
only what a window leaves over: never while a click waits, never past
`perWindow - reserve`, never over HTTP. `promote()` moves the `ahead` reads
still waiting into the click lane, for the moment the person acts: an app's
caches hand a click the read already out for the same thing. `createInFlight`
keeps the same split for REQs on the wire.

`loadAhead` runs an app's list of steps in order, a few at a time, once; the
first that throws stops it, and what loaded stays.

```ts
import { createInFlight, createPacer, loadAhead } from '@estiva-app/platform'

const pacer = createPacer({ perWindow: 40, windowMs: 5_000, reserve: 15 })
const wire = createInFlight(4) // two of them at most for `ahead`

// In the socket reader:
await pacer.take(reqs, { lane, spill })
const release = await wire.acquire(lane)

// Once the first page has drawn:
const loader = loadAhead([
  { label: 'Topics', run: () => readTopicsAhead() },
  { label: 'Open work 1', run: () => readTopicAhead(first) },
])
addEventListener('pointerdown', () => pacer.promote(), true)
const { loaded, stoppedBy } = await loader.done
```

What a step reads and where it keeps it are the app's: a step that reads into
the same cache a click reads from is what makes the click draw at once.

## What this deliberately does not know

Where anything is stored, beyond the copy's storage you hand it. Peek's version took a `LiveProjectionApi`, and
extracting that as-is would have baked a Convex assumption into a package two
apps depend on. This delivers frames and connection state and nothing else, so
it bets on neither outcome of "do we need Convex": if Convex stays nothing here
changes, and if it goes this is already right.

Your freshness states and their copy are product voice and stay in your app.
`observe` is how they get what they need.

## License

MIT

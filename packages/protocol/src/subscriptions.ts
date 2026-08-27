/**
 * One REQ per channel, refcounted (PEE-6).
 *
 * Two components can be looking at the same channel — the conversation and the
 * sidebar — and the last one to unmount is the one that should close the REQ.
 * This sits over `liveRelay` and owns exactly that: one relay subscription per
 * channel uuid, shared by every consumer, closed when the last releases.
 *
 * Reconnection is deliberately **not** handled here. `createLiveRelay` re-issues
 * every registered subscription after it re-authenticates, so a channel with a
 * live refcount comes back on its own. Duplicating that logic would give two
 * places to get it wrong.
 *
 * **Built inside Peek** (PEE-6) because Gate 2 had not happened when it was due.
 * SHA-3 is the ticket that owed the move.
 *
 * ## The trap: one subscription per channel, always
 *
 * **Never build one subscription covering several channels.** Depending on the
 * filter it either fails loudly or, worse, returns correct history and then
 * receives **zero live events** — EOSE right, live empty, nothing to
 * distinguish it from working until somebody notices nothing ever arrives.
 *
 * Verified in Buzz rather than taken on trust, because the whole point is that
 * it is invisible:
 *
 *   1. `extract_channel_id_from_filters` (`handlers/req.rs`) returns `None` the
 *      moment two distinct `#h` values appear, or any filter lacks `#h`.
 *   2. With `channel_id: None` the subscription registers in the **global**
 *      indexes (`subscription.rs`).
 *   3. `fan_out_scoped` handles a channel-scoped event by consulting only
 *      `channel_kind_index` and `channel_wildcard_index`. A global subscription
 *      is in neither.
 *   4. The file states it outright: *"Global subscriptions (channel_id = None)
 *      do NOT receive channel-scoped events."*
 *
 * Historical delivery at REQ time takes a different path (`per_filter_channel`)
 * which handles multi-`#h` correctly. That asymmetry is the whole illusion.
 *
 * **Which of the two failures you get depends on whether the filter names
 * kinds**, and this was measured against production rather than reasoned about.
 * A global subscription must clear `p_gated_filters_authorized`
 * (`handlers/req.rs`), whose first test is:
 *
 *     let can_match_p_gated = filter.kinds.as_ref().is_none_or(|ks| …);
 *     if !can_match_p_gated { return true; }
 *
 * So a **kindless** multi-`#h` filter *could* match a p-gated kind, has no
 * `#p`, and is refused outright — a live probe against
 * `wss://estiva.estiva.app` got `CLOSED … "restricted: p-gated events require
 * #p matching your pubkey"` immediately. But a filter naming only ordinary
 * kinds — `{"#h":[a,b],"kinds":[9]}` — returns early as authorized, registers
 * globally, and dies **silently**.
 *
 * That is the dangerous one, and it is the shape somebody optimising "one
 * subscription for messages across all my channels" would naturally write. The
 * ticket describes this variant; the loud one is a newer gate sitting in front
 * of it.
 *
 * **There is a second entrance to the same trap, and it is the likelier one.**
 * `extract_channel_id_from_filters` only counts an `#h` value it can
 * `parse::<uuid::Uuid>()`; anything else leaves `filter_has_channel` false and
 * falls through to the same global registration. So passing a **topic id**
 * where a channel uuid belongs produces the same broken subscription — and
 * Peek's topic ids are Convex ids, which are not uuids. Because this module
 * always builds a kindless filter, that lands on the loud arm above rather than
 * the silent one; it is still a subscription that never delivers, and it still
 * fails asynchronously as a `CLOSED` frame the app would have to interpret.
 * Throwing at the call site names the cause instead. RFC 0.3's note on this ticket
 * asks specifically that a topic id never become the subscription key; that is
 * why {@link createChannelSubscriptions} validates the shape and throws rather
 * than letting a bad key reach the relay. In Peek `topics.channelUuid` is also
 * `v.optional`, so "absent on older topics" is a real case, not a theoretical
 * one, and it must not arrive here as `undefined`.
 *
 * ## One kindless filter is enough
 *
 * `{"#h":[uuid]}` with no `kinds` registers in the channel **wildcard** index
 * and therefore receives every kind in the channel. Reactions (kind:7) and
 * deletions (kind:5) carry no `h` tag of their own, but `filters_match`
 * (`buzz-core/src/filter.rs`) falls back to `StoredEvent.channel_id` for `#h`
 * when an event has no `h` tags at all — the channel is derived from the target
 * at ingest. So messages, reactions, deletions and assertions all arrive on this
 * one subscription.
 *
 * That is strictly better than the HTTP path it replaces, which needs four
 * sequential round trips and caps reactions to the newest 100 messages per
 * topic. The cap is deliberately not ported.
 *
 * `kinds: []` would be worse than useless — Buzz indexes such a subscription
 * *nowhere* and it silently receives nothing — which is another reason this
 * builds the filter itself rather than accepting one.
 */
import type { SignedEvent } from './events.js'
import type { LiveRelay, Subscription } from './live.js'

/** Canonical v4-shaped uuid, as `crypto.randomUUID()` produces. */
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

export type ChannelEventHandler = (event: SignedEvent) => void

export interface ChannelSubscription {
  /** Idempotent. Closes the REQ only when the last consumer releases. */
  release(): void
}

export interface ChannelSubscriptions {
  /**
   * Watch one channel. Safe to call many times for the same channel — the
   * relay sees one REQ, and every consumer sees every event.
   *
   * @throws if `channelUuid` is not a uuid. See the trap above: a topic id here
   * would be accepted by the relay and then silently deliver nothing.
   */
  subscribe(channelUuid: string, onEvent: ChannelEventHandler): ChannelSubscription
  /** Channels with at least one live consumer. Test and diagnostic seam. */
  activeChannels(): string[]
  /** How many consumers hold `channelUuid`. Test and diagnostic seam. */
  subscriberCount(channelUuid: string): number
  /** Release everything. Does not close the underlying relay connection. */
  close(): void
}

interface ChannelEntry {
  relaySub: Subscription
  listeners: Set<ChannelEventHandler>
}

export function createChannelSubscriptions(
  relay: Pick<LiveRelay, 'subscribe'>,
  options: { onListenerError?: (error: unknown) => void } = {},
): ChannelSubscriptions {
  const channels = new Map<string, ChannelEntry>()

  function dispatch(channelUuid: string, event: SignedEvent) {
    const entry = channels.get(channelUuid)
    if (!entry) return
    // A copy, because a listener is allowed to release during dispatch — and
    // one that throws must not stop the others from being told. A single
    // component's bug should not silently stop the whole channel updating.
    for (const listener of [...entry.listeners]) {
      try {
        listener(event)
      } catch (error) {
        options.onListenerError?.(error)
      }
    }
  }

  return {
    subscribe(channelUuid, onEvent) {
      if (!UUID.test(channelUuid)) {
        throw new Error(
          `channelSubscriptions: "${channelUuid}" is not a channel uuid. ` +
            'Buzz can only scope a subscription by an #h it can parse as a uuid; ' +
            'anything else registers globally and then receives no channel events at all. ' +
            "Pass the channel's uuid, never an application id for the thing " +
            'rendered in it — Peek\'s topic ids are Convex ids, which are not uuids.',
        )
      }

      let entry = channels.get(channelUuid)
      if (!entry) {
        const listeners = new Set<ChannelEventHandler>()
        // One channel, one filter, no `kinds` — see the header. Built here
        // rather than accepted from the caller so neither half of the trap is
        // reachable through this API.
        const relaySub = relay.subscribe([{ '#h': [channelUuid] }], (event) =>
          dispatch(channelUuid, event),
        )
        entry = { relaySub, listeners }
        channels.set(channelUuid, entry)
      }
      entry.listeners.add(onEvent)

      let released = false
      return {
        release() {
          if (released) return
          released = true
          const current = channels.get(channelUuid)
          if (!current) return
          current.listeners.delete(onEvent)
          if (current.listeners.size > 0) return
          // Last one out closes the REQ.
          channels.delete(channelUuid)
          current.relaySub.close()
        },
      }
    },

    activeChannels: () => [...channels.keys()],
    subscriberCount: (channelUuid) => channels.get(channelUuid)?.listeners.size ?? 0,

    close() {
      for (const entry of channels.values()) entry.relaySub.close()
      channels.clear()
    },
  }
}

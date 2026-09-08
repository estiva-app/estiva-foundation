/**
 * "Is the network believed reachable?", as an injected dependency.
 *
 * A socket cannot notice the network coming back on its own. Reconnection is
 * driven by `onclose`, and a connection whose peer became unreachable stays
 * `OPEN` until TCP gives up — which can be minutes, and browser devtools'
 * offline mode frequently never closes it at all. So the socket sits reporting
 * `live`, delivering nothing, and never reconnects.
 *
 * Peek solved that with `window.addEventListener('offline', …)` inside the
 * module that owned its relay. That is the second of the four extractability
 * constraints failed (ADR 0002 §10): an environment touch reached for rather
 * than received, which makes the module un-instantiable twice and untestable
 * without a browser.
 *
 * Hence an interface. {@link browserOnlineSource} is the browser
 * implementation, and it takes its window as an argument — so nothing in this
 * package touches a global at module scope, and a test supplies a fake.
 */

/** What this package needs of `window`. Deliberately tiny. */
export interface OnlineTarget {
  navigator: { onLine: boolean }
  addEventListener(type: 'online' | 'offline', listener: () => void): void
  removeEventListener(type: 'online' | 'offline', listener: () => void): void
}

export interface OnlineSource {
  /** The current belief. */
  online(): boolean
  /** Called on every change. Returns an unsubscribe; calling it twice is harmless. */
  subscribe(listener: (online: boolean) => void): () => void
}

/**
 * `navigator.onLine` and the two window events, as a source.
 *
 * The events are the one authority here a socket cannot second-guess, which is
 * why this exists at all rather than a timer.
 */
export function browserOnlineSource(target: OnlineTarget): OnlineSource {
  const listeners = new Set<(online: boolean) => void>()
  let attached = false

  const announce = (online: boolean) => {
    for (const listener of [...listeners]) {
      // Isolated, for the same reason `folder-activity` isolates its own: the
      // most important subscriber here is the one that reconnects the socket,
      // and one app listener throwing must not be what stops it running.
      try {
        listener(online)
      } catch {
        /* a listener's own problem */
      }
    }
  }
  const onOnline = () => announce(true)
  const onOffline = () => announce(false)

  return {
    online: () => target.navigator.onLine,
    subscribe(listener) {
      listeners.add(listener)
      if (!attached) {
        // Attached on first use and never in module scope, so importing this
        // package registers nothing.
        target.addEventListener('online', onOnline)
        target.addEventListener('offline', onOffline)
        attached = true
      }
      return () => {
        listeners.delete(listener)
        if (listeners.size === 0 && attached) {
          target.removeEventListener('online', onOnline)
          target.removeEventListener('offline', onOffline)
          attached = false
        }
      }
    },
  }
}

/**
 * Always online, and never changes.
 *
 * For a consumer with no `window` — a Node probe, the agent, a server-side
 * test. Not a stub: "this environment has no opinion" is a real answer, and it
 * is better than a package that assumes a browser.
 */
export function assumeOnline(): OnlineSource {
  return { online: () => true, subscribe: () => () => {} }
}

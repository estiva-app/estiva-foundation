/**
 * `@estiva-app/platform` — the browser lifecycle two Estiva apps share.
 *
 * Not the wire: `@estiva-app/protocol` owns event construction, ids, signatures
 * and the two relay clients, and deliberately contains no fold. This package
 * sits above it and holds the things that are about *running in a tab* — the
 * one socket a tab should have, the credential read per connect, the network
 * coming back, and (SHA-2) the PWA's manifest, service worker and update flow.
 *
 * ## The rule this package is here to keep
 *
 * ADR 0002 §10's four constraints, and the two that `liveTopics.ts` failed:
 * nothing here imports an app's data layer, store or config, and every
 * environment touch is an injected parameter rather than a module-level global.
 * That is why {@link browserOnlineSource} takes its window and
 * {@link createLiveClientHolder} hands the app a holder instead of keeping one.
 *
 * A module-level singleton is usually holding something it reached for rather
 * than received, and the two failures arrive together.
 */
export {
  MAX_FOLDERS_PER_SUBSCRIPTION,
  createLiveClient,
  createLiveClientHolder,
  type FolderWatch,
  type LiveClient,
  type LiveClientHolder,
  type LiveClientObservers,
  type LiveClientOptions,
} from './live-client.js'
export {
  createFolderActivity,
  type FolderActivity,
  type FolderListener,
} from './folder-activity.js'
export { assumeOnline, browserOnlineSource, type OnlineSource, type OnlineTarget } from './online.js'

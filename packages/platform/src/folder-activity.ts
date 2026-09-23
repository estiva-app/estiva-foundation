/**
 * "Something changed in this Folder" — a notification, not an event.
 *
 * Arrived in Peek as `foreignActivity.ts`, whose header already anticipated
 * this move: *"A module-level emitter is what `liveTopics.ts` did, and SHA-7 is
 * the bill for it. This exports a factory; the app instantiates one and passes
 * it in, and a test makes its own."* It came over unchanged in substance.
 *
 * ## Why it carries no event
 *
 * Peek does not store other apps' records and should not start — Convex holds
 * Peek's things, the relay holds the shared ones (ADR 0001). The panel reads
 * those records off the relay directly, so the useful signal is *"re-read
 * now"*, not the bytes.
 *
 * That also keeps it correct for kinds nobody has invented yet. A fourth app
 * publishing its own records into a shared Folder gets a live panel without any
 * reader learning what those records are.
 *
 * ## The rename
 *
 * "Foreign" was Peek's framing: the records belonged to another app. A workspace
 * reader watching its own Folders is in the same position mechanically and the
 * word stops fitting, so the shared name is about the Folder rather than about
 * whose records are in it.
 *
 * ## …unless it has one to give (PER-8)
 *
 * "Re-read now" was the right signal while nobody held what they had read. Once
 * a reader keeps the events it already has — Peek's sidebar re-read 90 days of
 * every Folder to learn about the one message the socket had just delivered, and
 * spent the relay's per-request HTTP quota doing it — the event is the whole
 * point. So a notification *may* carry the event that caused it. A listener
 * that ignores the argument is exactly the listener it was before, and a
 * notification with nothing to carry (another app's record moved) still sends
 * none, so a reader must treat a missing event as "re-read", not as "nothing".
 */
import type { SignedEvent } from '@estiva-app/protocol'

export type FolderListener = (event?: SignedEvent) => void

export interface FolderActivity {
  /**
   * Say that something changed in `folder`, and hand over the event when there
   * is one. Safe for a folder nobody watches.
   */
  notify(folder: string, event?: SignedEvent): void
  /** Watch one folder. Returns an unsubscribe; calling it twice is harmless. */
  watch(folder: string, listener: FolderListener): () => void
  /** Folders with at least one listener. Test and diagnostic seam. */
  watched(): string[]
}

export function createFolderActivity(): FolderActivity {
  const listeners = new Map<string, Set<FolderListener>>()
  return {
    notify(folder, event) {
      for (const listener of listeners.get(folder) ?? []) {
        // One bad listener must not stop the others, and must not surface
        // somewhere unrelated as a relay error.
        try {
          listener(event)
        } catch {
          /* a listener's own problem */
        }
      }
    },
    watch(folder, listener) {
      let forFolder = listeners.get(folder)
      if (!forFolder) {
        forFolder = new Set()
        listeners.set(folder, forFolder)
      }
      forFolder.add(listener)
      return () => {
        const current = listeners.get(folder)
        if (!current) return
        current.delete(listener)
        if (current.size === 0) listeners.delete(folder)
      }
    },
    watched: () => [...listeners.keys()],
  }
}

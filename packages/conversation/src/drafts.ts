/**
 * Drafts — CON-10.
 *
 * A message you started and did not send is still there when you come back, in
 * the composer you were typing in and in no other. Moved here from Peek's and
 * Ship's `src/lib/drafts.ts`, which were one file copied (CON-5); Peek's
 * `container` key comes with it.
 *
 * ## Local, and never on the relay
 *
 * A draft is **unsent**. Publishing one — even to SPEC §12's app-private
 * layer — turns something a person chose not to say into something the
 * workspace holds, and a `kind:5` is a request rather than a reversal. The
 * cost is the right way round: drafts do not follow you to another device.
 *
 * ## The key is the whole feature
 *
 * PEE-7's two symptoms — text appearing in a topic it was not written for, and
 * text lost on returning to the thread it *was* written for — are one bug: the
 * composer's text was not keyed by **destination**. {@link draftKeys} is the
 * only place that decides, and two apps using it cannot disagree about where
 * a draft belongs.
 *
 * ## Injected storage
 *
 * Everything takes its storage rather than reaching for `localStorage`, which
 * is what lets it run with no browser and makes "storage is unavailable" a
 * case rather than a crash. {@link DraftStorage} is the three methods of the
 * Web Storage API this uses, declared here so no DOM type is published.
 */

/** How long a draft survives. A draft from months ago reappearing surprises more than it helps. */
export const DRAFT_MAX_AGE_MS = 30 * 24 * 60 * 60 * 1000

/**
 * The longest draft that is kept. `localStorage` is a shared ~5 MB budget and a
 * runaway paste should not evict everything else; beyond this the draft is not
 * stored, and the text stays in the field in front of the person.
 */
export const DRAFT_MAX_CHARS = 8000

/** Namespaced and versioned, so a shape change can be ignored rather than mis-read. */
const PREFIX = 'estiva.draft.v1:'

/**
 * Where a draft belongs. **A thread is keyed by its own root event, not by the
 * surface showing it**: a reply half-written on an issue page and the same
 * thread seen from a project's Activity are one destination, so one draft.
 */
export const draftKeys = {
  /** Starting a conversation about an object — its address. */
  object: (addr: string) => `object:${addr}`,
  /** Replying in a thread — the thread's root event id. */
  thread: (rootEventId: string) => `thread:${rootEventId}`,
  /** Writing into a container itself — a Peek topic, a DM — by the id a person navigates between. */
  container: (id: string) => `container:${id}`,
}

/** The part of the Web Storage API a draft store uses. `window.localStorage` is one. */
export interface DraftStorage {
  getItem(key: string): string | null
  setItem(key: string, value: string): void
  removeItem(key: string): void
}

/**
 * A draft as a composer seeds from it: the marker text, and the keys of the
 * people it names urgently (CON-31).
 *
 * The text cannot carry the urgency. An urgent mention of somebody with a key
 * is written as the same `nostr:npub…` as an ordinary one, and the urgency is
 * the `["urgent", <pubkey>]` tag the send adds (SPEC §13.1) — so a draft kept
 * as text alone came back as an ordinary mention and was sent as one.
 */
export interface Draft {
  text: string
  /** Whom the urgent chips named, by key; absent when none did. What `urgentTagsFor` takes. */
  urgent?: string[]
}

interface StoredDraft {
  text: string
  /** When it was last typed, for the age cap. */
  at: number
  /** Absent in a draft with no urgent mention, and in every draft kept before CON-31. */
  urgent?: string[]
}

const HEX_KEY = /^[0-9a-f]{64}$/

export interface DraftStore {
  /** The draft's text for this key, or `undefined` — including when storage is unusable. */
  read(key: string): string | undefined
  /** The whole draft — its text and its urgent picks — or `undefined`, as {@link DraftStore.read}. */
  readDraft(key: string): Draft | undefined
  /**
   * Keep this text, and whom it names urgently (the composer's urgent chips, by
   * key). An empty or whitespace-only draft is a cleared one.
   */
  write(key: string, text: string, urgent?: readonly string[]): void
  /** Forget it — what a successful send calls. */
  clear(key: string): void
}

/** A store that keeps nothing, for when there is no storage to use. */
export const NO_DRAFTS: DraftStore = { read: () => undefined, readDraft: () => undefined, write: () => {}, clear: () => {} }

/**
 * A draft store over some storage. **Every operation is guarded**: a private
 * window, cleared site data, blocked storage or a full quota all surface as
 * "no draft" rather than a broken composer.
 */
export function createDraftStore(storage: DraftStorage | undefined, now: () => number = Date.now): DraftStore {
  if (!storage) return NO_DRAFTS

  const remove = (key: string) => {
    try {
      storage.removeItem(PREFIX + key)
    } catch {
      // The draft is already unreachable as far as anybody reading it is concerned.
    }
  }

  const readDraft = (key: string): Draft | undefined => {
    try {
      const raw = storage.getItem(PREFIX + key)
      if (!raw) return undefined
      const draft = JSON.parse(raw) as Partial<StoredDraft>
      if (typeof draft?.text !== 'string' || typeof draft?.at !== 'number') {
        // Another version's shape, or corrupted: better dropped than shown.
        remove(key)
        return undefined
      }
      if (now() - draft.at > DRAFT_MAX_AGE_MS) {
        remove(key)
        return undefined
      }
      // A malformed `urgent` costs the urgency, not the text: the words are what a person would miss.
      const urgent = Array.isArray(draft.urgent) ? draft.urgent.filter((k): k is string => typeof k === 'string' && HEX_KEY.test(k)) : []
      return urgent.length > 0 ? { text: draft.text, urgent } : { text: draft.text }
    } catch {
      return undefined
    }
  }

  return {
    read: (key) => readDraft(key)?.text,
    readDraft,

    write(key, text, urgent) {
      // Whitespace is not a draft: emptying the field forgets it.
      if (!text.trim()) return remove(key)
      if (text.length > DRAFT_MAX_CHARS) return remove(key)
      try {
        const picks = [...new Set(urgent ?? [])]
        const draft: StoredDraft = picks.length > 0 ? { text, at: now(), urgent: picks } : { text, at: now() }
        storage.setItem(PREFIX + key, JSON.stringify(draft))
      } catch {
        // Quota, or storage refused. The text is still in the field.
      }
    },

    clear: remove,
  }
}

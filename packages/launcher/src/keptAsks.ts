import { createContext, useContext } from 'react'

/** One sentence the person sent in this tab, as Recent lists it (KIN-12). */
export interface KeptAskRow {
  id: number
  /** The sentence as it was sent. */
  text: string
  /** Where it was asked: the conversation, page or issue, by its name. */
  where: string
  /** Worked on, or answered and not yet looked at; `null` once seen. */
  status: 'working' | 'waiting' | null
}

/** What a box held by `useKeptLauncher` knows of the other asks this tab holds. */
export interface KeptAsks {
  /** The others, newest first, the ones with an answer waiting before the rest. */
  asks: readonly KeptAskRow[]
  /** Show that ask in place of this box. */
  show: (id: number) => void
  /** Forget that ask: its box, its request and its answer go. */
  forget: (id: number) => void
  /** Clear recent: every other ask goes. */
  clear: () => void
}

/** Filled by `useKeptLauncher` around each box it draws; `null` for a box mounted on its own (a story, a test). */
export const KeptAsksContext = createContext<KeptAsks | null>(null)

export function useKeptAsks(): KeptAsks | null {
  return useContext(KeptAsksContext)
}

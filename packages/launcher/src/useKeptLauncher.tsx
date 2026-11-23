import { createContext, useCallback, useContext, useState, type ReactNode } from 'react'
import type { LauncherState } from './CommandLauncher.js'

/** What the frame's launcher is given to draw: the box as it is held right now. */
export interface KeptLauncherBox<Context> {
  /** What the app captured when the box was last opened. */
  context: Context
  open: boolean
  /** Escape or a click outside while the box holds something. */
  onHide: () => void
  /** The box is finished with. */
  onClose: () => void
  onState: (state: LauncherState) => void
}

/**
 * The command launcher as an app's frame holds it: opened by the bar's search and
 * Cmd/Ctrl+K, and **hidden, not thrown away, while it holds something** (KIN-2,
 * "In Peek's ⌘K, Escape keeps your sentence and the answer").
 *
 * Until KIN-2 closing the box unmounted it, which dropped the words, the level,
 * the request in flight and the answer. Now Escape, a click outside or a second
 * Ctrl+K hides a box that holds any of those, and the next open shows it as it
 * was. A box holding nothing is unmounted as before, so an idle app carries no
 * launcher. Acting on what it shows (opening a result, running an action,
 * putting an answer in the composer) still closes it for good.
 *
 * **In this tab only.** A reload forgets it, and it does not follow the person
 * to another app (Miky, 20 November 2026).
 *
 * **The context is captured at each open** by the app's `capture` and
 * frozen while the box is shown. Words that were never sent are then about
 * where the person is now; a sentence that was sent keeps the conversation it
 * was asked in, which the launcher pins (Miky, 23 November 2026).
 *
 * **The dot.** While the box is hidden, the search says what it is doing for
 * the person: working on what they sent, or waiting with an answer they have
 * not looked at. Shown, they are looking at it, so there is no dot; and an
 * answer that has been seen does not light it again.
 *
 * **One for the whole app.** Hold it above the routes and give each frame's
 * search what {@link useKeptSearch} reads: going from one page to another
 * keeps it.
 *
 * `render` draws the app's own launcher (its `CommandLauncher` with its host)
 * from the box held here.
 */
export function useKeptLauncher<Context>(
  capture: () => Context,
  render: (box: KeptLauncherBox<Context>) => ReactNode,
): {
  toggle: () => void
  searchStatus: 'working' | 'waiting' | undefined
  searchStatusLabel: string | undefined
  launcher: ReactNode
} {
  const [held, setHeld] = useState<{ context: Context; open: boolean } | null>(null)
  const [box, setBox] = useState<LauncherState>({ holds: false, status: null })
  const holds = box.holds

  // Escape or a click outside: hidden while it holds something, gone otherwise.
  const dismiss = useCallback(() => setHeld((v) => (v && holds ? { ...v, open: false } : null)), [holds])

  // The bar's search field and Cmd/Ctrl+K, from anywhere — browsing or typing in
  // a composer alike — both land here. A second Ctrl+K dismisses it. A click on
  // the field leaves focus in the composer, so the context sees it (0.60.1).
  const toggle = useCallback(() => {
    setHeld((v) => (v?.open ? (holds ? { ...v, open: false } : null) : { context: capture(), open: true }))
  }, [holds, capture])

  const searchStatus = held && !held.open && box.status ? box.status : undefined
  const searchStatusLabel = searchStatus && (searchStatus === 'working' ? 'working on what you asked' : 'an answer is waiting')

  const launcher = held && render({ context: held.context, open: held.open, onHide: dismiss, onClose: () => setHeld(null), onState: setBox })

  return { toggle, searchStatus, searchStatusLabel, launcher }
}

/** What a frame's search needs of the kept launcher: how to open it, and what the field says while it is hidden. */
export type KeptSearch = Omit<ReturnType<typeof useKeptLauncher>, 'launcher'>

/** Filled by the app, above its routes, with what {@link useKeptLauncher} returned. */
export const KeptSearchContext = createContext<KeptSearch | null>(null)

/** The app's kept launcher, for a frame's search; `null` where nothing above holds one (a story, a test of one page). */
export function useKeptSearch(): KeptSearch | null {
  return useContext(KeptSearchContext)
}

import { createContext, useCallback, useContext, useRef, useState, type ReactNode } from 'react'
import type { LauncherState } from './CommandLauncher.js'
import { KeptAsksContext, type KeptAskRow, type KeptAsks } from './keptAsks.js'

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

interface Held<Context> {
  id: number
  context: Context
  state: LauncherState
  /** When its sentence was sent, in this tab's order: Recent lists the newest first. */
  sentAt: number
}

interface Kept<Context> {
  boxes: readonly Held<Context>[]
  /** The box ⌘K shows, and whether it is shown now. */
  shown: { id: number; open: boolean } | null
}

const NOTHING: LauncherState = { holds: false, status: null }

/** A box stays while it is the one ⌘K shows, or while it holds a sentence that was sent. */
function prune<Context>(kept: Kept<Context>): Kept<Context> {
  const boxes = kept.boxes.filter((b) => b.id === kept.shown?.id || b.state.ask)
  return boxes.length === kept.boxes.length ? kept : { ...kept, boxes }
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
 * launcher.
 *
 * **Every sentence sent in this tab is kept** (KIN-12; Miky, 23 and 25 November
 * 2026). Each one keeps its own box, mounted and hidden, so its request runs on
 * and its answer waits. ⌘K in the place the shown ask was asked shows it; anywhere
 * else it opens a fresh box about where the person is, and the asks wait under its
 * Recent (`KeptAsksContext`), picked to show again. Opening a result or using the
 * answer closes the box but keeps the ask; only Ctrl+Backspace on its row, Clear
 * recent or a reload forget it. Words that were never sent are not an ask: they
 * follow the person, as before.
 *
 * **In this tab only.** A reload forgets it, and it does not follow the person
 * to another app (Miky, 20 November 2026). Nothing is written to the browser.
 *
 * **The context is captured at each open** by the app's `capture` and
 * frozen while the box is shown. Words that were never sent are then about
 * where the person is now; a sentence that was sent keeps the conversation it
 * was asked in, which the launcher pins (Miky, 23 November 2026).
 *
 * **The dot.** The search says what the asks it is not showing are doing: working
 * on what the person sent, or waiting with an answer they have not looked at. A
 * shown answer is seen, and does not light it again.
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
  const [kept, setKept] = useState<Kept<Context>>({ boxes: [], shown: null })
  const ids = useRef(0)
  const sends = useRef(0)

  // The bar's search field and Cmd/Ctrl+K, from anywhere — browsing or typing in
  // a composer alike — both land here. A second Ctrl+K dismisses it. A click on
  // the field leaves focus in the composer, so the context sees it (0.60.1).
  const toggle = useCallback(() => {
    // Captured once, outside React's updater, which may run twice.
    let captured: { context: Context } | undefined
    const here = () => (captured ??= { context: capture() }).context
    setKept((k) => {
      const shown = k.shown && k.boxes.find((b) => b.id === k.shown?.id)
      if (k.shown?.open && shown) return shown.state.holds ? { ...k, shown: { ...k.shown, open: false } } : prune({ ...k, shown: null })
      // The ask it last showed, where it was asked; or words never sent, wherever the person is now.
      if (shown && (!shown.state.ask || shown.state.ask.here)) {
        const context = here()
        return { boxes: k.boxes.map((b) => (b.id === shown.id ? { ...b, context } : b)), shown: { id: shown.id, open: true } }
      }
      const id = ++ids.current
      return prune({ boxes: [...k.boxes, { id, context: here(), state: NOTHING, sentAt: 0 }], shown: { id, open: true } })
    })
  }, [capture])

  /*
    Each box's own callbacks, made once per box: the launcher reports its state
    from an effect that depends on `onState`, so a new function every render
    would report again every render.
  */
  const perBox = useRef(new Map<number, Pick<KeptLauncherBox<Context>, 'onHide' | 'onClose' | 'onState'>>())
  const callbacksFor = (id: number) => {
    let made = perBox.current.get(id)
    if (!made) {
      made = {
        // Escape or a click outside: the launcher only hides a box that holds something.
        onHide: () => setKept((k) => (k.shown?.id === id ? { ...k, shown: { id, open: false } } : k)),
        // Done with: an ask stays under Recent, anything else goes.
        onClose: () => setKept((k) => prune(k.shown?.id === id ? { ...k, shown: null } : k)),
        onState: (state) =>
          setKept((k) => {
            const box = k.boxes.find((b) => b.id === id)
            if (!box) return k
            const sent = state.ask && state.ask.text !== box.state.ask?.text
            return prune({ ...k, boxes: k.boxes.map((b) => (b.id === id ? { ...b, state, sentAt: sent ? ++sends.current : b.sentAt } : b)) })
          }),
      }
      perBox.current.set(id, made)
    }
    return made
  }

  const showing = kept.shown?.open ? kept.shown.id : null
  const others = kept.boxes.filter((b) => b.id !== showing)
  const searchStatus = others.some((b) => b.state.status === 'working') ? 'working' : others.some((b) => b.state.status === 'waiting') ? 'waiting' : undefined
  const searchStatusLabel = searchStatus && (searchStatus === 'working' ? 'working on what you asked' : 'an answer is waiting')

  const rows: (KeptAskRow & { sentAt: number })[] = kept.boxes.flatMap((b) =>
    b.state.ask ? [{ id: b.id, text: b.state.ask.text, where: b.state.ask.where, status: b.state.status, sentAt: b.sentAt }] : [],
  )
  rows.sort((a, b) => Number(b.status === 'waiting') - Number(a.status === 'waiting') || b.sentAt - a.sentAt)

  const asksFor = (from: Held<Context>): KeptAsks => ({
    asks: rows.filter((r) => r.id !== from.id),
    // The box it was picked in goes, unless it holds something of its own.
    show: (id) => setKept((k) => prune({ boxes: k.boxes.map((b) => (b.id === id ? { ...b, context: from.context } : b)), shown: { id, open: true } })),
    forget: (id) => setKept((k) => ({ boxes: k.boxes.filter((b) => b.id !== id), shown: k.shown?.id === id ? null : k.shown })),
    clear: () => setKept((k) => ({ ...k, boxes: k.boxes.filter((b) => b.id === from.id || !b.state.ask) })),
  })

  for (const id of perBox.current.keys()) if (!kept.boxes.some((b) => b.id === id)) perBox.current.delete(id)

  const launcher = kept.boxes.length ? (
    <>
      {kept.boxes.map((b) => (
        <KeptAsksContext.Provider key={b.id} value={asksFor(b)}>
          {render({ context: b.context, open: showing === b.id, ...callbacksFor(b.id) })}
        </KeptAsksContext.Provider>
      ))}
    </>
  ) : null

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

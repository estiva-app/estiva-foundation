import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { IconAlignLeft, IconDownload, IconEraser, IconPencil, IconRefresh, IconSparkles, IconWriting, IconCornerDownLeft } from '@tabler/icons-react'
import { Avatar, KindIcon, CommandPalette, CommandPaletteAnswer, type CommandPaletteChip, CommandPaletteForm, type CommandPaletteGroup, CommandPaletteQuote, type CommandPaletteRow, CommandPaletteSearch, CommandPaletteWorking, FieldLine, isApplePlatform, isPlainClick, useToast } from '@estiva-app/ui'
import { ActionFormFields } from './ActionFormFields.js'
import { useKeptAsks } from './keptAsks.js'
import { applyPrefill, draftValues, missingFields, seedDraft, withAnswer, type FormDraft } from './formDraft.js'
import { KIND_CHANNEL_METADATA, type ResolvedAction } from '@estiva-app/interop'
import { addrToNaddr } from '@estiva-app/protocol'
import { fileEmptyState, isPrompt, launcherMatch, matchPeople, messageEmptyState, type MessageSearchState } from './launcherSearch.js'
import type { PrefillAvailability } from './promptApi.js'
import { downloadGuessModel, guessAvailability, guesserFor, type GuessOption } from './actionGuess.js'
import { probeable } from './actionCatalogue.js'
import { draftInstruction, formSchema, prefillInstruction, threadContext, usablePrefill } from './prefill.js'
import { answerInstruction, parseAnswer, selectMessages, type NumberedMessage } from './askThread.js'
import {
  PARENT_FIELD,
  asLauncherCreation,
  changeActionFrom,
  changeVocabulariesFrom,
  creationsFor,
  launcherActionFrom,
  proseSubmission,
  readKindOf,
  splitSubmission,
  type CreatableKindRead,
} from './liveAction.js'
import type { LauncherAction, LauncherApp, VocabOption } from './launcherActions.js'
import { openOf, type LauncherContext, type LauncherFailure as Failure, type LauncherHost, type LauncherMessageRow, type LauncherOpen, type LauncherPerson as Person } from './host.js'

/**
 * The launcher (Cmd/Ctrl+K anywhere, or the top bar's search field): the
 * words, rows and levels, drawn in the kit's `CommandPalette` (UIG-29).
 *
 * **One box for every app** (KIN-4). It was Peek's until 23 November 2026 and
 * is mounted by each app now. What only the app knows arrives as its `host`
 * (`host.ts`): where the person is, how a result opens, the people, the relay's
 * search, the manifest runtime, the app's marks and words.
 *
 * **What is the kit's, and what is here.** The window, the field, the
 * rows, the footer and every key are `CommandPalette`'s (Katerina, 16
 * September, P1 and P2): the arrows, Enter, Tab to go in, Backspace to go back,
 * Ctrl+Enter, where focus goes. This file holds which
 * levels there are, which rows exist on each, what the search shows, what the
 * apps' manifests declare, Ask, Draft and Make, and what a form sends.
 *
 * **The levels are a stack**, so every way back puts back what was there:
 *
 * - the first level: this conversation, recents and apps before you type;
 *   apps, this conversation, people, actions, files and messages for one or
 *   two words; and from the third word a prompt — the field grows, Enter asks
 *   about the open conversation and the answer shows in place, with up to
 *   three title matches and the suggested actions as rows under it
 * - inside an app: the actions its manifest declares
 * - Draft: the draft, then what you can do with it as rows
 * - a form: creating something, or changing something the thread refers to
 *
 * The design is the approved prototype and the key list
 * (`uig29-review/KEY-LIST.md`), with the UX review's rulings R1–R15 and the
 * nine bugs F1–F9 it found in the launcher this replaces.
 */

type Intent = 'ask' | 'draft'

type Level =
  | { kind: 'first' }
  | { kind: 'app'; app: LauncherApp }
  | { kind: 'draft' }
  | {
      kind: 'form'
      action: LauncherAction
      /** The app it was reached through, when it was. */
      app?: LauncherApp
      /** The sentence a suggested action was picked under: the form is filled from it (Miky, 20 November 2026). */
      sentence?: string
    }

/** One level, and what was typed on it — kept when you go further in and come back. */
interface Frame {
  level: Level
  query: string
}

/**
 * An answer and the messages it is allowed to have come from (INT-3).
 *
 * `sources` is a subset of what retrieval chose, never a superset. Nothing
 * here is persisted: the answer is shown and forgotten.
 */
interface AskAnswer {
  text: string
  sources: NumberedMessage[]
  /** Nothing in the question matched, so recency chose the messages. */
  byRecency: boolean
  /** Messages the context budget could not take. */
  omitted: number
  /** Replies the snapshot never held (INT-8). */
  repliesNotRead: number
}

/** What an app's manifest says it can create, read when first needed. */
type LiveRead =
  | { state: 'loading' }
  /** `parents` by action id: Ship's issue goes under a project, its project in a Folder (MAN-8). */
  | { state: 'ready'; actions: LauncherAction[]; parents: Record<string, VocabOption[]>; withheld?: number }
  | { state: 'none' }
  | { state: 'failed' }

/**
 * What the frame needs to know about the box (KIN-2).
 *
 * `holds`: there are words in the field, a level is open, or a sentence was sent, so dismissing hides the box
 * instead of closing it. `status` is for the dot on the top bar's search while the box is hidden: `working` on a
 * sentence the person sent, `waiting` with an answer (or the news that none came) they have not looked at.
 *
 * why: https://github.com/estiva-app/estiva-docs/blob/main/decisions/intelligence-works-in-the-background-and-reaches-you-only-by-naming-you.md
 * The dot is the answer to the person's own sentence. Nothing they did not send may light it.
 */
export interface LauncherState {
  holds: boolean
  status: 'working' | 'waiting' | null
  /**
   * A sentence the person sent, which the frame keeps under Recent until they forget it (KIN-12): the sentence, the
   * name of where it was asked, and whether the person is there now.
   */
  ask?: { text: string; where: string; here: boolean }
}

export interface CommandLauncherProps {
  /** What only the app knows: see `host.ts`. */
  host: LauncherHost
  /** Captured by the app at the invoking keystroke or click. */
  context: LauncherContext
  /** The box is finished with: something was chosen or done, or it was dismissed holding nothing. The frame unmounts it. */
  onClose: () => void
  /**
   * Shown or hidden (KIN-2). A hidden box stays mounted, so its words, its level, a request in flight and the answer
   * are all still there when it is shown again. Default shown.
   */
  open?: boolean
  /** Escape or a click outside while the box holds something: the frame hides it. Without it, dismissing closes. */
  onHide?: () => void
  /** Whether the box holds anything worth keeping, and what the search should say about it while it is hidden. */
  onState?: (state: LauncherState) => void
  /** Open inside an app (tests only). */
  initialAppId?: string
  /** Open with an action's form already up (tests only; needs initialAppId). */
  initialActionId?: string
}

const icon = (Glyph: typeof IconPencil) => <Glyph size={16} stroke={1.5} />
/** What the guess reads for an app's declared action: the catalogue's words for that id, never the manifest's (KIN-7). */
const guessWording = (app: LauncherApp, actionId: string): string => {
  const own = app.actions.find((action) => action.id === actionId)
  // An id the catalogue does not know was written by whoever published the manifest: none of its words reach the model.
  return own?.guessAs ?? own?.label ?? `Another action in ${app.label}`
}
/** The typing pause after which the guess is asked (KIN-7): short, because Edge takes ~1.4 s to answer and the order should settle within about two seconds. */
const GUESS_PAUSE_MS = 150

/** Just the prose of what is open, oldest first: what goes in a prompt. */
const bodies = (opened: LauncherOpen | undefined): string[] => (opened?.messages ?? []).map((m) => m.body)

/** Where the app has no message search: nothing typed, nothing found, nothing asked. */
const NO_MESSAGES: { state: MessageSearchState; rows: readonly LauncherMessageRow[]; unroutable: number } = { state: { kind: 'idle' }, rows: [], unroutable: 0 }
const useNoMessageSearch = () => NO_MESSAGES

/** The footer's "where": the composer the launcher was opened over, in words. */
function whereFrom(context: LauncherContext, words: LauncherHost['words']): string {
  const label = context.composer?.label
  if (!label) return openOf(context) ? words.inOpen : words.anywhere
  if (label.startsWith('Reply to ')) return `In a reply to ${label.slice('Reply to '.length)}`
  return `In ${label}`
}

/** Where a sentence was asked, as its row under Recent names it: "in Weekly sync", "in Launch plan" (KIN-12). */
function placeName(context: LauncherContext): string {
  const label = context.composer?.label
  if (label) return label.startsWith('Reply to ') ? `a reply to ${label.slice('Reply to '.length)}` : label
  const open = openOf(context)
  return open?.title || (open?.kind === 'page' ? 'a page' : 'a conversation')
}

/** An ask's mark under Recent: the prompt's sparkles on the row's tile, with the search's own dot while it works or waits unseen. */
function AskMark({ status }: { status: 'working' | 'waiting' | null }) {
  return (
    <span className="relative flex size-8 items-center justify-center rounded-sm bg-bg-inset text-text-secondary">
      <IconSparkles size={16} stroke={1.5} />
      {status && (
        <>
          <span className="sr-only">{status === 'working' ? 'working on what you asked' : 'an answer is waiting'}</span>
          <span
            aria-hidden
            className={`absolute -right-0.5 -top-0.5 h-2 w-2 rounded-full bg-accent-primary${status === 'working' ? ' animate-working motion-reduce:animate-none' : ''}`}
          />
        </>
      )}
    </span>
  )
}

function initialStack(apps: readonly LauncherApp[], appId?: string, actionId?: string): Frame[] {
  const first: Frame = { level: { kind: 'first' }, query: '' }
  const app = apps.find((a) => a.id === appId)
  if (!app) return [first]
  const inApp: Frame = { level: { kind: 'app', app }, query: '' }
  const action = app.actions.find((a) => a.id === actionId)
  return action ? [first, inApp, { level: { kind: 'form', action, app }, query: '' }] : [first, inApp]
}

/** A form's draft is kept per action, so leaving and coming back finds it as it was (R1 A). */
const formKey = (level: Extract<Level, { kind: 'form' }>) =>
  `${level.action.target ?? level.app?.id ?? ''}:${level.action.id}`

export function CommandLauncher({ host, context: openedHere, onClose: finished, open = true, onHide, onState, initialAppId, initialActionId }: CommandLauncherProps) {
  /*
    What the app hands over, under the names this file has always used for
    them. Read on every render, so each is as fresh as the app's own hooks.
  */
  const LAUNCHER_APPS = host.apps
  /*
    INT-13 (Miky, 2026-10-12): the app the launcher runs in is not one to go
    into. Its actions have their own group on the first level, and Apps lists the
    others — the same rows one level deeper would be the same thing twice.
  */
  const HOST_APPS = useMemo(() => probeable(LAUNCHER_APPS.filter((app) => app.isHost)), [LAUNCHER_APPS])
  const OTHER_APPS = useMemo(() => LAUNCHER_APPS.filter((app) => !app.isHost), [LAUNCHER_APPS])
  const appMark = (app: { id: string }, size = 14) => host.mark(app.id, size)
  /** A stored body as one line of words — markdown and a heading's marker gone. */
  const asWords = host.plain
  const { words } = host
  /** What one part of what is open is called: a message, or a page's passage (KIN-5). */
  const part = words.part ?? { one: 'message', many: 'messages' }
  const { canPrefill, downloadModel, hasPromptApi, prefillAvailability, promptForObject, promptForText } = host.model

  const [stack, setStack] = useState<Frame[]>(() => initialStack(LAUNCHER_APPS, initialAppId, initialActionId))
  const frame = stack[stack.length - 1]
  const level = frame.level
  const query = frame.query
  const q = query.trim().toLowerCase()

  /*
    The question being answered, and what kind of answer. Separate from what is
    in the field. An ask is answered on the first level, under the prompt; a
    draft has a level of its own.

    `sentFrom` is where it was sent from (KIN-2; Miky, 23 November 2026). The box
    can be hidden and shown again somewhere else. Words that were never sent
    follow the person: the box is about wherever it was opened last. A sentence
    that was sent stays about the conversation it was asked in, with that
    conversation's name above the field, until it is acted on or the field is
    changed.
  */
  const { pathname, search } = host.path
  /** The page the person is on, as the router has it. */
  const here = pathname + search
  /** The place a sentence asked here is about (`LauncherHost.path`): on Peek's Desk, the file it shows, not the page. */
  const place = host.path.place || pathname
  /*
    The place as last drawn, for a wait that outlives this render (`putInComposer`). Set while drawing, not in
    an effect: the page's message box registers from its own effect, which runs before this one's.
  */
  const placeNow = useRef(place)
  placeNow.current = place
  const [request, setRequest] = useState<{ intent: Intent; text: string } | null>(null)
  const [sentFrom, setSentFrom] = useState<{ context: LauncherContext; path: string; place: string } | null>(null)
  const [draft, setDraft] = useState<string | null | false>(null)
  const [answer, setAnswer] = useState<AskAnswer | null | false>(null)
  const context = request && sentFrom ? sentFrom.context : openedHere
  /** Send, or drop (`null`), a request. What the last one brought goes with it at once, so an old answer is never read as the new one's. */
  const send = (next: { intent: Intent; text: string } | null) => {
    // Asking again from the same sentence keeps where it was first asked.
    if (next && (!request || !sentFrom)) setSentFrom({ context: openedHere, path: here, place })
    setDraft(null)
    setAnswer(null)
    setRequest(next)
  }

  /*
    Done with the box. A sentence that was sent is kept under Recent (KIN-12), and
    picking it shows the sentence and its answer: never the level it was left on,
    such as a form already submitted from under the answer.
  */
  const onClose = () => {
    if (request?.intent === 'ask' && sentFrom) setStack([{ level: { kind: 'first' }, query: request.text }])
    finished()
  }

  const setQuery = (next: string) => {
    setCannotAsk(null)
    // A changed sentence is a new one: its answer no longer answers it, and a request in flight is abandoned (KIN-2).
    if (level.kind === 'first' && request?.intent === 'ask' && next.trim() !== request.text) send(null)
    setStack((s) => [...s.slice(0, -1), { ...s[s.length - 1], query: next }])
  }
  const push = (...levels: Level[]) => setStack((s) => [...s, ...levels.map((l) => ({ level: l, query: '' }))])
  const back = () => setStack((s) => (s.length > 1 ? s.slice(0, -1) : s))

  const navigate = host.navigate
  const { showToast } = useToast()
  /* Where the launcher was opened: a recent that is the page you are on is not somewhere to go (Katerina, 16 September). */
  const isOpenPerson = (id: string) => host.isOpenPerson?.(id) ?? false
  // The file that is open is never a result, nor a recent.
  const isOpenFile = host.file.isOpen
  // The app's people: a row opens the person (in Peek, their DM; REM-3).
  const people = host.people
  const recents = host.recents?.list ?? []
  /** The other sentences sent in this tab, when the frame keeps them (KIN-12). */
  const kept = useKeptAsks()

  /*
    Files and messages live on the relay, matched by word starts as everything
    else in the panel is (`lib/launcherSearch`). Searched on the first level only (F9): inside an app the
    results were never shown, and the relay was asked anyway on every pause.
  */
  /** The first level's field has become a prompt: its third word (`isPrompt`). */
  const prompting = level.kind === 'first' && isPrompt(query)
  // Messages are a search's results; under a prompt only titles stay, so the relay is not asked for them.
  // An app with nowhere to open a message has no message search (Leaf, Ship): the group is then never drawn.
  const useMessageSearch = host.useMessageSearch ?? useNoMessageSearch
  const { state: messageState, rows: messageFound, unroutable } = useMessageSearch(level.kind === 'first' && !prompting ? query : '')
  const { state: fileState, hits: fileHits } = host.useFileSearch(level.kind === 'first' ? query : '')

  const { creatableUnder, applyAction, resolveObject } = host.manifests
  const { startConversationInDm } = host
  const canSendToDm = !!startConversationInDm

  /*
    PEE-3's targets: the objects this conversation already refers to, resolved
    for their titles and their declared field-setting actions. Captured at the
    invoking keystroke, so the list is the thread the person was looking at. A
    reference that will not resolve, or has no naddr to act on, is dropped: a
    row for an object nobody can act on is a row that cannot succeed.
  */
  const [targets, setTargets] = useState<{ address: string; label: string; actions: ResolvedAction[] }[]>([])
  const opened = openOf(context)
  const conversationRefs = opened?.references
  useEffect(() => {
    if (!conversationRefs?.length) return
    let cancelled = false
    Promise.all(
      conversationRefs.map((ref) =>
        resolveObject(ref)
          .then((object) => {
            if (!object?.naddr) return null
            return {
              address: object.naddr,
              // Untitled, it is named by what it is — "Topic", never "Peek" (PRO-24).
              label: object.slots?.title?.value ?? host.manifests.objectLabel?.(object) ?? 'Untitled',
              actions: object.actions ?? [],
            }
          })
          .catch(() => null),
      ),
    ).then((resolved) => {
      if (!cancelled) setTargets(resolved.filter((t): t is NonNullable<typeof t> => t !== null))
    })
    return () => {
      cancelled = true
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [conversationRefs?.join('|')])

  /* One row per (object, field-setting action) pair: "Set status · Billing entry" is the thing somebody means. */
  const changeRows = useMemo(() => {
    const out: { action: LauncherAction; vocabularies: Record<string, VocabOption[]> }[] = []
    // A change does not say the kind it writes: an app that says what it may sign is offered none (KIN-5 review).
    if (host.maySign) return out
    for (const target of targets) {
      for (const resolved of target.actions) {
        const action = changeActionFrom(resolved, target)
        if (action) out.push({ action, vocabularies: changeVocabulariesFrom(resolved) })
      }
    }
    return out
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [targets, !host.maySign])

  /*
    What each app declares it can create — INT-9: a row exists only because a
    manifest, read just now, says the action does.

    Read per app and kept per app, which is F2's fix: the list was one slot,
    so after visiting Ship, Peek offered Ship's "Add issue". Read when first
    needed rather than at every open — going into an app, or typing on the
    first level, where an action can be found by its name (C4).
  */
  const [live, setLive] = useState<Record<string, LiveRead>>({})
  const asked = useRef(new Set<string>())
  /** Read when the manifests' actions arrive, so a new function each render reads nothing again. */
  const maySign = useRef(host.maySign)
  useEffect(() => {
    maySign.current = host.maySign
  })
  /*
    One read per parent kind, shared by every app — MAN-8. An app's creations
    are no longer all on its own kind: Ship's `add-project` is on a Folder,
    which is Peek's, so Ship's section reads Peek's kind too and Peek's reads
    it once for both. `creationsFor` sorts the actions back to the app that
    declared them.
  */
  const kindReads = useRef(new Map<number, Promise<CreatableKindRead | null>>())
  const readKinds = useCallback(
    // Rejects only when `required` — the app's own kind — could not be read;
    // another kind that failed is read as nothing there.
    // The host reads its own kind alone (INT-13): it is read on every opening, and declares nothing on another.
    async (required: number, ownKindOnly = false): Promise<Map<number, CreatableKindRead | null>> => {
      // A team is read whichever apps are listed: what another app declares on one (Ship's New project) is found
      // there, and an app that does not list Peek still offers it (KIN-11, Leaf).
      const kinds = ownKindOnly ? [required] : [...new Set([...probeable(LAUNCHER_APPS).map((app) => readKindOf(app) as number), KIND_CHANNEL_METADATA])]
      const reads = await Promise.allSettled(
        kinds.map((kind) => {
          let read = kindReads.current.get(kind)
          if (!read) {
            read = creatableUnder(kind)
            // A failure is not kept, so the next visit asks again.
            read.catch(() => kindReads.current.delete(kind))
            kindReads.current.set(kind, read)
          }
          return read
        }),
      )
      const out = new Map<number, CreatableKindRead | null>()
      kinds.forEach((kind, i) => {
        const read = reads[i]
        if (read.status === 'fulfilled') out.set(kind, read.value)
        else if (kind === required) throw read.reason
        else out.set(kind, null)
      })
      return out
    },
    [creatableUnder],
  )
  const readLive = useCallback(
    (app: LauncherApp) => {
      // An app with no parent kind is never probed: nothing about it is live.
      const kind = readKindOf(app)
      if (kind === undefined || asked.current.has(app.id)) return
      asked.current.add(app.id)
      setLive((l) => ({ ...l, [app.id]: { state: 'loading' } }))
      readKinds(kind, !!app.isHost)
        .then((reads) => {
          const found = creationsFor(app, reads)
          if (!found) {
            // Signed out, or the app declares nothing creatable. Not an error.
            setLive((l) => ({ ...l, [app.id]: { state: 'none' } }))
            return
          }
          const actions: LauncherAction[] = []
          let withheld = 0
          const parents: Record<string, VocabOption[]> = {}
          for (const creation of found) {
            // Never an action whose event this app may not sign: Leaf offers no Create issue (KIN-5).
            // A resolved action does not say its kind: the registry's entry for it does, and one it does not know is
            // not offered where the app says what it may sign.
            const emitted = app.actions.find((a) => a.id === creation.action.id)?.emits?.kind
            if (maySign.current && (typeof emitted !== 'number' || !maySign.current(emitted))) {
              withheld++
              continue
            }
            // The noun of the kind it goes on — the app's own for its own kind (INT-9), "Folder" on a Folder.
            const converted = launcherActionFrom(creation.action, { parentNoun: creation.parentNoun, submitLabel: creation.action.label })
            if (!converted) continue
            // A Folder's built-in new file is Peek's Create topic (INT-12); a conversation knows its DMs (REC-1).
            // A DM is somewhere to write only in an app that can send to one: elsewhere it is neither marked nor offered.
            const action = asLauncherCreation(canSendToDm ? creation : { action: creation.action }, converted)
            actions.push(action)
            parents[action.id] = canSendToDm ? creation.parents : creation.parents.filter((p) => !creation.dms?.includes(p.value))
          }
          setLive((l) => ({ ...l, [app.id]: { state: 'ready', actions, parents, withheld } }))
        })
        .catch((error: unknown) => {
          // A read that fails must produce a sentence, not silence.
          console.warn('[nostr] reading another app’s creatable actions failed:', error)
          setLive((l) => ({ ...l, [app.id]: { state: 'failed' } }))
        })
    },
    [readKinds, canSendToDm],
  )
  useEffect(() => {
    if (level.kind === 'app') readLive(level.app)
    // The host's actions are on the first level before anything is typed (INT-13), so it is read on opening.
    if (level.kind === 'first') HOST_APPS.forEach(readLive)
    if (level.kind === 'first' && q) probeable(LAUNCHER_APPS).forEach(readLive)
  }, [level, q, readLive])

  const liveActions = (app: LauncherApp): LauncherAction[] => {
    const read = live[app.id]
    return read?.state === 'ready' ? read.actions : []
  }

  /*
    What the browser says about the model, resolved once per open.

    'unavailable' counts as ready on purpose: it is a browser that answered,
    and Chrome says it while working, so a session is attempted. 'unanswered'
    does not — a browser that never answers is how a row hangs for ever.
  */
  const [availability, setAvailability] = useState<PrefillAvailability | null>(null)
  useEffect(() => {
    let cancelled = false
    void prefillAvailability().then((answer) => !cancelled && setAvailability(answer))
    return () => {
      cancelled = true
    }
  }, [])
  const modelReady = availability === 'available' || availability === 'unavailable'

  /*
    INT-10 — the model can be fetched, and the launcher offers it, where the Ask
    rows would have been. Nothing starts a download but choosing the row (PEE-6).
  */
  const modelDownloadable = availability === 'downloadable' || availability === 'downloading'
  /** The guess's model can be fetched (KIN-7): the Download row offers it under a prompt, and only that row fetches it. */
  const [guessDownloadable, setGuessDownloadable] = useState(false)
  /** The options the guess is asked about, as last drawn: what the Download row fetches the model for. */
  const guessOptionsRef = useRef<GuessOption[]>([])
  const [download, setDownload] = useState<number | 'failed' | null>(null)
  const startDownload = useCallback(() => {
    if (typeof download === 'number') return
    setDownload(0)
    // The guess's model, where the browser has it to fetch: the same row, the same click (KIN-7).
    // Its progress shows on the row only when the answers' model is not also coming (that one reports its own).
    const guessFetch = guessDownloadable
      ? downloadGuessModel(guessOptionsRef.current, modelDownloadable ? undefined : (fraction) => setDownload(Math.round(fraction * 100)))
      : Promise.resolve(true)
    const answerFetch = modelDownloadable ? downloadModel((fraction) => setDownload(Math.round(fraction * 100))) : Promise.resolve(true)
    void Promise.all([answerFetch, guessFetch]).then(([ok, guessOk]) => {
      // No cancellation guard: the fetch belongs to the browser and outlives the launcher.
      setDownload(ok && guessOk ? null : 'failed')
      if (ok) setAvailability('available')
      if (guessOk) setGuessDownloadable(false)
    })
  }, [download, guessDownloadable, modelDownloadable])

  const hasThread = (opened?.messages?.length ?? 0) > 0

  // ── Ask and Draft ───────────────────────────────────────────────────────────

  /** A cited message the thread has not loaded — see the source row. */
  const [unreachable, setUnreachable] = useState<string | null>(null)
  /** An answer action that could not be done, by its label: said under the answer, which stays. */
  const [actionFailed, setActionFailed] = useState<string | null>(null)
  /** Why Enter could not ask, said once under the prompt until the words change. */
  const [cannotAsk, setCannotAsk] = useState<string | null>(null)

  useEffect(() => {
    setDraft(null)
    setAnswer(null)
    setUnreachable(null)
    setActionFailed(null)
    if (!request) return
    const messages = opened?.messages ?? []
    if (messages.length === 0) return
    let cancelled = false

    void (async () => {
      if (request.intent === 'draft') {
        // A draft is written from the thread as a whole: the brief is what to say.
        const conversation = threadContext(bodies(opened))
        if (!conversation) return
        const written = await promptForText(draftInstruction(conversation, request.text))
        if (!cancelled) setDraft(written ?? false)
        return
      }

      /*
        Retrieval first, generation second (INT-3): which messages the answer
        could have come from is decided here, without a model, so a citation can
        be chosen from or ignored but never invented.
      */
      const selection = selectMessages(request.text, messages)
      const raw = await promptForText(answerInstruction(request.text, selection.chosen, opened))
      if (cancelled) return
      if (!raw) {
        setAnswer(false)
        return
      }
      const { text, cited } = parseAnswer(raw, selection.chosen.length)
      // Citations narrow the source list; they never widen it.
      const sources = cited.length > 0 ? selection.chosen.filter((c) => cited.includes(c.n)) : selection.chosen
      setAnswer({
        text,
        sources,
        byRecency: selection.byRecency,
        omitted: selection.omitted,
        repliesNotRead: selection.chosen.reduce((n, c) => n + (c.message.repliesNotRead ?? 0), 0),
      })
    })()

    return () => {
      cancelled = true
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [request, bodies(opened).join('\u0000')])

  /** Go into Draft with what was typed on the first level as the brief (R8: leaving keeps it). */
  const openDraft = () => {
    const text = query.trim()
    setStack((s) => [...s, { level: { kind: 'draft' }, query: text }])
    send(text ? { intent: 'draft', text } : null)
  }

  /*
    Enter on a prompt. The box is the same in every browser and on every page
    (Miky, 20 November 2026), so where nothing can answer, Enter says why in
    one line instead of doing something else.
  */
  const ask = () => {
    const text = query.trim()
    // An open conversation with nothing in it yet is not "no conversation": say which it is.
    if (!hasThread) return setCannotAsk(opened ? words.nothingYet : words.nothingOpen)
    if (modelDownloadable) return setCannotAsk('Download the on-device model below to ask.')
    // Not yet answered (the first moments after opening) is not a no: the ask is tried, and says so if nothing comes back.
    // A browser with no Prompt API answers 'unavailable' too, which counts as ready above; it is asked here outright.
    if (!hasPromptApi() || (availability !== null && !modelReady)) return setCannotAsk('Asking needs this browser’s on-device model, which is not turned on.')
    setCannotAsk(null)
    send({ intent: 'ask', text })
  }

  /*
    What the top bar's search says while the box is hidden (KIN-2): working on
    a sentence that was sent, or waiting with an answer nobody has looked at.
    "No answer came back" waits the same way, so a failure is not mistaken for
    work still going (Miky, 23 November 2026). Once the box has been open on
    the answer it has been seen, and the dot does not come back.
  */
  const working = !!request && hasThread && (request.intent === 'ask' ? answer === null : draft === null)
  const arrived = !!request && (request.intent === 'ask' ? answer !== null : draft !== null)
  const [seen, setSeen] = useState(false)
  useEffect(() => setSeen(false), [request])
  useEffect(() => {
    if (open && arrived) setSeen(true)
  }, [open, arrived])
  const holds = stack.length > 1 || query.trim() !== '' || request !== null
  const status = working ? 'working' : arrived && !seen ? 'waiting' : null
  /* The sentence that was sent, for Recent (KIN-12): what it was, where, and whether that is where the person is now. */
  const askText = request?.intent === 'ask' && sentFrom ? request.text : null
  const askWhere = askText !== null && sentFrom ? placeName(sentFrom.context) : ''
  const askHere = askText !== null && sentFrom?.place === place
  useEffect(
    () => onState?.(askText === null ? { holds, status } : { holds, status, ask: { text: askText, where: askWhere, here: askHere } }),
    [holds, status, askText, askWhere, askHere, onState],
  )
  // Unmounted, it holds nothing and says nothing.
  useEffect(() => () => onState?.({ holds: false, status: null }), [onState])

  /** Escape, or a click outside: hidden while there is something to keep, closed otherwise. */
  const dismiss = () => (holds && onHide ? onHide() : onClose())

  /*
    An answer or a draft goes into the composer of the conversation it is
    about (Miky, 23 November 2026). After the box was hidden and shown again
    somewhere else, that is not the composer on screen: Peek opens the
    conversation it was asked in and puts the text there. The box only hides
    until that has happened, so text that found no composer is not lost.
  */
  const putInComposer = (text: string) => {
    const composer = host.composer
    // Offered only over a composer, which only an app that has one captures.
    if (!composer) return
    const label = sentFrom?.context.composer?.label
    if (!sentFrom || !onHide) {
      composer.insertText(text)
      onClose()
      return
    }
    // Still on that page: its message box is on screen, whatever else the address now carries (a thread, a message
    // it scrolled to) and whichever box has the cursor.
    if (sentFrom.place === place && composer.insertTextInto(label, text)) return onClose()
    const lost = () =>
      showToast({
        label: `Could not reach the message box of ${label ? `“${label}”` : 'that conversation'}. Open it and choose this again: the answer is still in search.`,
        type: 'error',
      })
    // The same address and no such box on it: there is nowhere to go, so say so and keep the text.
    if (sentFrom.path === here) return lost()
    onHide()
    navigate(sentFrom.path)
    // A name is not an address: if the person leaves that page before its box opens, nothing is written.
    const to = sentFrom.path
    /*
      The address alone is not the conversation: a DM picked on Peek's Desk is not in it, so going back to
      `/app/desk` can show another DM, whose box may carry the same name. Only the place it was asked in takes it.
    */
    const asked = sentFrom.place
    const stillThere = () => window.location.pathname + window.location.search === to && placeNow.current === asked
    void composer.insertTextWhenOpens(label, text, stillThere).then((placed) => (placed ? onClose() : lost()))
  }

  // ── Forms ───────────────────────────────────────────────────────────────────

  const [drafts, setDrafts] = useState<Record<string, FormDraft>>({})
  const [attempted, setAttempted] = useState<Record<string, boolean>>({})
  const [submitting, setSubmitting] = useState(false)
  const [submitError, setSubmitError] = useState<{ text: string; failure?: Failure } | null>(null)
  host.useReportFailure(submitError?.failure)

  const formLevel = level.kind === 'form' ? level : null
  /*
    Create topic opens on the Folder of the topic you are in (INT-12), when that
    Folder is one of its choices — a Folder with state. Anywhere else, and in a
    Folder that is not offered, the field starts empty and says so.
  */
  const seedFor = (form: Extract<Level, { kind: 'form' }>): FormDraft => {
    // A creation on a team starts in the team you are in: a topic, and a document from Leaf (KIN-9).
    const onATeam = form.action.id === 'create-file' || form.action.fields.some((f) => f.key === PARENT_FIELD && f.parentNoun === 'team')
    const here = onATeam ? host.currentFolder?.() : undefined
    const read = form.app ? live[form.app.id] : undefined
    const match =
      here && read?.state === 'ready' ? read.parents[form.action.id]?.find((p) => p.value.endsWith(`:${here}`)) : undefined
    return seedDraft(form.action, match ? { [PARENT_FIELD]: match.value } : undefined)
  }
  const formDraft = formLevel ? (drafts[formKey(formLevel)] ?? seedFor(formLevel)) : null
  const setFormDraft = (next: FormDraft) => formLevel && setDrafts((d) => ({ ...d, [formKey(formLevel)]: next }))

  // A form's error belongs to that visit to it.
  useEffect(() => setSubmitError(null), [level])

  /*
    PEE-5 — the form arrives filled in from the conversation, where the model
    is already on the person's own device. Nothing is offered or waited for
    (PEE-6): the form opens at once, and this lands values in the fields
    nobody has touched, or does not.

    A form opened from a suggested action is filled from the sentence it was
    picked under as well, and from the sentence alone where no conversation is
    open (Miky, 20 November 2026).
  */
  const prefillFor = formLevel && !formLevel.action.target ? formKey(formLevel) : null
  const sentence = formLevel?.sentence
  useEffect(() => {
    if (!formLevel || !prefillFor) return
    const conversation = threadContext(bodies(opened))
    if (!conversation && !sentence) return
    // A New document's text is the answer you read, or nothing: never one the model wrote (KIN-9's Decided line).
    const answerOnly = formLevel.app?.actions.find((a) => a.id === formLevel.action.id)?.startsWithAnswer
    const fields = answerOnly ? formLevel.action.fields.filter((f) => f.control !== 'prose') : formLevel.action.fields
    const built = formSchema(fields, formLevel.app?.vocabularies ?? {})
    if (!built) return
    let cancelled = false
    void (async () => {
      if (!(await canPrefill())) return
      const suggested = await promptForObject(prefillInstruction(formLevel.action.label, conversation, sentence), built.schema)
      if (cancelled) return
      const usable = usablePrefill(suggested, built.keys)
      if (Object.keys(usable).length === 0) return
      setDrafts((d) => ({ ...d, [prefillFor]: applyPrefill(d[prefillFor] ?? seedFor(formLevel), usable) }))
    })()
    return () => {
      cancelled = true
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [prefillFor, sentence, bodies(opened).join('\u0000')])

  const parentOptionsFor = (form: Extract<Level, { kind: 'form' }>): Record<string, VocabOption[]> => {
    const out: Record<string, VocabOption[]> = {}
    /*
      A retired topic's channel is never somewhere to start a conversation
      (FOL-26): its conversation is on a file now, and a `kind:9` into it is
      what FOL-25 has to be sure nothing can write before the channel goes.
      The relay lists it among the newest `39000`s until then, so it is
      dropped here, by the same table the old links redirect through.
    */
    const live39000 = (options: VocabOption[]) => options.filter((p) => !host.parentRefusal?.(p.value))
    const read = form.app ? live[form.app.id] : undefined
    if (read?.state === 'ready') out[PARENT_FIELD] = live39000(read.parents[form.action.id] ?? [])
    return out
  }

  /**
   * A validated form arrives here as `{ fieldKey: value }`. `applyAction` turns
   * it into the event the declaration describes, signs and publishes it
   * (PEE-1), and the new object's reference goes into the active composer
   * (PEE-2).
   */
  const submitAction = async (form: Extract<Level, { kind: 'form' }>, values: Record<string, string>, formats?: FormDraft['formats']) => {
    const { action } = form
    /*
      A CHANGE carries a target chosen with the row, and the runtime takes a
      scalar for it (PEE-3). It is declared by the object's own manifest, so
      the live-read check below does not apply to it.
    */
    if (action.target) {
      const value = values[action.fields[0]?.key ?? '']
      if (!value) return
      setSubmitting(true)
      setSubmitError(null)
      const result = await applyAction({ naddr: action.target, actionId: action.id, value })
      setSubmitting(false)
      if (!result.ok) {
        setSubmitError({ text: result.reason ?? 'The relay rejected the change.', failure: 'not-saved' })
        return
      }
      showToast({ label: `${action.label} · ${action.targetLabel ?? 'saved'}`, type: 'success' })
      onClose()
      return
    }

    /*
      Declared means "a manifest read just now says this exists", reached by
      going into the app or by accepting a proposal — INT-9. A submission that
      closes saying nothing is indistinguishable from one that worked, which is
      how three dead rows survived being used.
    */
    const appLabel = form.app?.label ?? 'That app'
    const declared = form.app ? liveActions(form.app).some((a) => a.id === action.id) : false
    if (!declared) {
      setSubmitError({ text: `${appLabel} has not published this action, so there is nothing to send.`, failure: 'unnamed' })
      return
    }
    // Create topic's members are Peek's to write once the file exists (INT-12), never a property of it.
    const { [action.membersField ?? '']: memberList, ...declaredValues } = values
    const members = action.membersField ? (memberList ?? '').split(',').filter(Boolean) : []
    const { parent, properties: typed } = splitSubmission(action.membersField ? declaredValues : values)
    const { properties, contentFormat } = proseSubmission(action, typed, formats)
    if (!parent) {
      setSubmitError({ text: 'Choose where this should go before creating it.' })
      return
    }
    // The pickers drop a retired topic's channel (FOL-26); a prefilled draft
    // does not go through a picker, so the same rule holds here too.
    const refused = host.parentRefusal?.(parent)
    if (refused) {
      setSubmitError({ text: refused })
      return
    }
    // DMs only, also for a prefilled draft: Peek has no screen for a Folder's own chat (parked, Miky 2026-10-17, REC-1 2726532e).
    // And only where the app can send to a DM: without that, a DM would go on as a Folder's conversation, which a DM never takes (SPEC §3.2).
    if (action.id === 'start-a-conversation' && !(startConversationInDm && action.dmParents?.includes(parent))) {
      setSubmitError({ text: 'Start a conversation in one of your DMs.' })
      return
    }
    setSubmitting(true)
    setSubmitError(null)
    /*
      A conversation started in a DM is the DM's own message, sent by Peek's
      chat code as its composer sends one (REC-1): the Folder's Start a
      conversation is not offered on a DM, which is no Folder (SPEC §3.2).
    */
    if (action.dmParents?.includes(parent) && startConversationInDm) {
      let sent: Awaited<ReturnType<typeof startConversationInDm>>
      try {
        sent = await startConversationInDm({ channel: parent.split(':')[2] ?? '', body: properties.message ?? '' })
      } catch (error) {
        // A send that throws (signing, the network) says so, as the Folder's path does below.
        setSubmitting(false)
        setSubmitError({ text: error instanceof Error ? error.message : String(error), failure: 'not-sent' })
        return
      }
      setSubmitting(false)
      if (!sent.ok) {
        setSubmitError({ text: sent.reason ?? 'The relay rejected it.', failure: 'not-sent' })
        return
      }
      // C5, as a conversation started in a Folder says it.
      showToast({ label: `Created in ${appLabel}`, type: 'success' })
      onClose()
      return
    }
    let result: Awaited<ReturnType<typeof applyAction>>
    try {
      // The parent is addressed, not named: `applyAction` resolves the manifest from the object —
      // or, for another app's creation on it, the manifest that declared it (MAN-8).
      result = await applyAction({
        naddr: addrToNaddr(parent, []),
        actionId: action.id,
        value: properties,
        ...(contentFormat ? { contentFormat } : {}),
        ...(action.declaredBy ? { declaredBy: action.declaredBy } : {}),
      })
    } catch (error) {
      setSubmitting(false)
      setSubmitError({ text: error instanceof Error ? error.message : String(error), failure: 'not-created' })
      return
    }
    setSubmitting(false)
    if (!result.ok) {
      // The runtime's own words: it is the only participant that knows what the manifest allowed.
      setSubmitError({ text: result.reason ?? 'The relay rejected it.', failure: 'not-created' })
      return
    }
    if (result.created) {
      let placed: boolean
      try {
        // An app with no composer has nowhere to leave it, which is no failure: `context.composer` is absent there too.
        placed = host.composer?.insertReference(addrToNaddr(result.created, [])) ?? false
      } catch (error) {
        // The object WAS created, so "failed" would be a lie about the half that worked.
        setSubmitError({ text: `Created, but its reference could not be encoded: ${error instanceof Error ? error.message : String(error)}`, failure: 'not-added' })
        return
      }
      // No composer is legitimate; a composer that was open and is gone is the trace going missing.
      if (!placed && context.composer) {
        setSubmitError({ text: 'Created, but its reference could not be placed — the composer is gone.', failure: 'not-added' })
        return
      }
    }
    // A new issue whose text did not land (ISS-6): it exists, so the form closes, as sending it again would file a
    // second one, and the person is told to add the text in the issue, whose reference is now in the thread.
    if (result.textNotSaved) {
      showToast({ label: 'Created, but its text was not saved. Open it and add the text again.', type: 'error', failure: 'not-added' })
      host.afterCreate?.()
      onClose()
      return
    }
    // A `listed` creation whose Folder command was refused (SPEC §7.3): the
    // object exists and its Folder does not show it, which is not a success.
    if (result.incomplete) {
      setSubmitError({ text: `Created, but its team does not list it yet: ${result.incomplete}`, failure: 'not-added' })
      return
    }
    /*
      Each person added becomes a member of the new topic (SPEC §11.8), so they
      are told when it has something unread — a `kind:1851` each, by the
      membership seam. The creator already is one, by creating it.
    */
    if (members.length > 0 && result.created) {
      const folder = parent.split(':')[2] ?? ''
      const refused: string[] = []
      for (const person of members) {
        // An app that cannot add a member says so by name, as a refusal does: the people were chosen and are not in.
        const added = host.addMember ? await host.addMember(result.created, folder, person) : false
        if (added !== true) refused.push((people ?? []).find((p) => p.id === person)?.name ?? `${person.slice(0, 8)}…`)
      }
      if (refused.length > 0) {
        // The topic exists, so the form closes: sending it again would make a second one.
        showToast({ label: `Created, but ${refused.join(', ')} could not be added as members.`, type: 'error', failure: 'not-added' })
        host.afterCreate?.()
        onClose()
        return
      }
    }
    // A new file is in a Folder's list now: the open sections, the tree's among them, read it again (INT-12).
    if (result.created) host.afterCreate?.()
    const title = properties.title?.trim()
    // C5: say it worked, where the person is looking.
    showToast({ label: title ? `“${title}” created in ${appLabel}` : `Created in ${appLabel}`, type: 'success' })
    onClose()
  }

  // ── Rows ────────────────────────────────────────────────────────────────────

  const close = (then: () => void) => () => {
    then()
    onClose()
  }

  /*
    A file the person opened — a bare-file topic, a Ship issue — by its address
    and the title it had then (FOL-36, `lib/recents`). A bare file is Peek's
    own topic; a Ship project or issue wears Ship's glyph; anything else is a
    file — the kit's `KindIcon`, as every app draws them (`fileGlyph`). Every one on the row's tile (Katerina, 7 October): here a
    topic's circle is never a status — a recent does not know whether the topic
    is resolved — so it is an icon like the others, not a mark of its own.
  */
  /*
    With a summary, it is the second line and an issue's project moves up beside
    the title, as `[` draws it; without one, an issue's project is the second
    line, and anything else is the title alone (SUM-7, the SearchRow story).
  */
  const fileRow = (f: { id: string; title: string; summary?: string; caption?: string }, forget?: () => void): CommandPaletteRow => {
    const glyph = host.file.glyph(f.id)
    /*
      A lit file shows its card beside the box, so two like titles can be told apart without opening either (KIN-3;
      Miky's 5 November prototype): the card a link to it draws, in every list, Recent included (Miky, 23 Nov). A topic
      has none: its card is its latest conversation, which the box is not for.
    */
    const card = host.file.preview?.(f.id)
    return {
      id: `file-${f.id}`,
      label: f.title,
      ...(f.summary ? { description: f.summary, aside: f.caption || undefined } : f.caption ? { description: f.caption } : {}),
      icon: <KindIcon kind={glyph} tone="inherit" />,
      onSelect: close(() => host.file.open(f.id, f.title)),
      onForget: forget,
      /*
        A link on the card (its title, a project's issue, its comments) opens through the app's router as any card's does;
        the box is done with then, as when the row itself is chosen.
      */
      ...(card
        ? {
            preview: (
              // Not a control: it hears the card's own links (focusable, keyed) as they open, to close the box.
              <div onClick={(event) => isPlainClick(event) && (event.target as Element).closest('a') && onClose()}>{card}</div>
            ),
          }
        : {}),
    }
  }

  const personRow = (p: Person, forget?: () => void): CommandPaletteRow => ({
    id: `person-${p.id}`,
    label: p.name,
    description: p.role,
    leading: <Avatar src={p.avatarSrc} name={p.name} bot={p.bot} size={24} />,
    onSelect: close(() => host.openPerson(p.id)),
    onForget: forget,
  })

  const appRow = (app: LauncherApp): CommandPaletteRow => ({
    id: `app-${app.id}`,
    label: app.label,
    // No count: it counted the registry's proposals, not what the app offers (R12).
    description: app.description,
    icon: appMark(app),
    onSelect: () => push({ kind: 'app', app }),
    onGoIn: () => push({ kind: 'app', app }),
  })

  const changeRowsFor = (list: typeof changeRows): CommandPaletteRow[] =>
    list.map(({ action }) => ({
      id: `change-${action.target}-${action.id}`,
      label: action.label,
      description: action.targetLabel,
      icon: icon(IconPencil),
      onSelect: () => push({ kind: 'form', action }),
    }))

  /** Under a prompt, where the model could run but is not here yet: the offer to fetch it (INT-10). Never a nag: only a prompt shows it. */
  const downloadRows = (): CommandPaletteRow[] => {
    // Only where the row has always been, with a conversation to ask about; the same click also fetches the
    // guess's model (KIN-7). The guess alone never adds the row: it would offer gigabytes for an order.
    if (hasThread && (modelDownloadable || guessDownloadable)) {
      const label =
        download === 'failed'
          ? 'This browser refused the model — asking is unavailable here'
          : typeof download === 'number'
            ? `Downloading the on-device model… ${download}%`
            : availability === 'downloading'
              ? 'The on-device model is downloading — show progress'
              : words.downloadModel
      return [
        {
          id: 'model-download',
          label,
          description:
            download === 'failed'
              ? undefined
              : typeof download === 'number'
                ? 'Keep working — this continues if you close the launcher.'
                : 'Several gigabytes, once per browser. It runs on this device; nothing is sent anywhere.',
          icon: icon(IconDownload),
          // The progress is on this row, and a person who asked for the download is owed sight of it.
          onSelect: () => download !== 'failed' && startDownload(),
        },
      ]
    }
    return []
  }

  /*
    What a sentence might want done: every action the installed apps declare,
    each with its app's mark, as rows (Miky, 20 November 2026) — then Draft a
    reply, where there is a conversation, a composer for it to go to and a
    model to write it. Enter asks until an arrow lights one of these.
  */
  /** The app's own actions (`host.ownActions`: Leaf's New document), as rows; choosing one does it and closes the box. */
  const ownRows = (prefix: string): CommandPaletteRow[] =>
    (host.ownActions ?? []).map((action) => ({
      id: `${prefix}-own-${action.id}`,
      label: action.label,
      ...(action.description ? { description: action.description } : {}),
      icon: action.icon ?? icon(IconPencil),
      onSelect: () => {
        action.run()
        onClose()
      },
    }))

  /** The Suggested rows in their usual order, each with what the on-device guess reads for it (KIN-7). */
  const suggestedEntries = (typed: string): { row: CommandPaletteRow; wording: string; name?: string }[] => {
    const own = host.ownActions ?? []
    return [
      ...ownRows('suggested').map((row, at) => ({ row, wording: own[at]?.guessAs ?? row.label, ...(own[at] ? { name: own[at].id } : {}) })),
      ...probeable(LAUNCHER_APPS).flatMap((app) =>
        liveActions(app).map((action) => ({
          row: {
            id: `suggested-${app.id}-${action.id}`,
            label: action.label,
            description: app.isHost ? undefined : app.label,
            leading: <span className="flex size-8 items-center justify-center">{appMark(app, 16)}</span>,
            onSelect: () => {
              const level = { kind: 'form', action, app, sentence: typed } as const
              // Picked under an answer, a new document starts with it as its text (KIN-9). Only an action the registry
              // marks: the live one comes from a manifest on the relay.
              if (answer && app.actions.find((a) => a.id === action.id)?.startsWithAnswer) setDrafts((d) => ({ ...d, [formKey(level)]: withAnswer(d[formKey(level)] ?? seedFor(level), action, answer.text) }))
              setStack((s) => [...s, { level, query: '' }])
            },
          },
          // Only words this package wrote: a live row's label comes from a manifest on the relay, and whoever wrote
          // that could word it to win every sentence, or to fail the check and switch the guess off.
          wording: guessWording(app, action.id),
          // The model's label for it, only where this package wrote the id: a relay-written one is `option-<n>` (KIN-7).
          ...(app.actions.some((known) => known.id === action.id) ? { name: action.id } : {}),
        })),
      ),
      ...(hasThread && modelReady && context.composer
        ? [
            {
              row: {
                id: 'draft',
                label: 'Draft a reply',
                // Peek's own action, so it carries Peek's mark like the rows above it.
                ...(HOST_APPS[0]
                  ? { leading: <span className="flex size-8 items-center justify-center">{appMark(HOST_APPS[0], 16)}</span> }
                  : { icon: icon(IconWriting) }),
                onSelect: openDraft,
              },
              wording: 'Draft a reply to the conversation that is open',
              name: 'draft-reply',
            },
          ]
        : []),
    ]
  }

  /** The Suggested rows, the guessed one first where the guess is sure (KIN-7). */
  const suggestedRows = (typed: string): CommandPaletteRow[] => {
    const rows = suggestedEntries(typed).map((entry) => entry.row)
    const at = guessFirst === null ? -1 : rows.findIndex((row) => row.id === guessFirst)
    return at <= 0 ? rows : [rows[at] as CommandPaletteRow, ...rows.slice(0, at), ...rows.slice(at + 1)]
  }

  /*
    The guess (KIN-7). The options are the Suggested rows with what the model
    reads for each. The session and its check start as the box opens, so the
    first sentence does not wait for them; each typing pause asks once, and an
    answer for a sentence since changed is dropped. Once the person has moved
    the pointer or an arrow key, the order holds until they type again: a row
    must not change under the hand reaching for it.
  */
  const guessOptions: GuessOption[] = suggestedEntries('').map((entry) => ({
    id: entry.row.id,
    wording: entry.wording,
    ...(entry.name ? { name: entry.name } : {}),
  }))
  const guessKey = JSON.stringify(guessOptions)
  guessOptionsRef.current = guessOptions
  const [guessFirst, setGuessFirst] = useState<string | null>(null)
  const guessHeld = useRef(false)
  useEffect(() => {
    let cancelled = false
    const options = JSON.parse(guessKey) as GuessOption[]
    // One row has nothing to be put first: no guess, and no model to offer for it (Leaf's New document alone).
    if (options.length < 2) {
      setGuessDownloadable(false)
      return
    }
    void guessAvailability(options).then((said) => !cancelled && setGuessDownloadable(said === 'downloadable' || said === 'downloading'))
    void guesserFor(options)
    return () => {
      cancelled = true
    }
  }, [guessKey])
  useEffect(() => {
    guessHeld.current = false
    if (!prompting) {
      setGuessFirst(null)
      return
    }
    let cancelled = false
    const sentence = query.trim()
    const timer = setTimeout(() => {
      void guesserFor(JSON.parse(guessKey) as GuessOption[])
        .then((guess) => (guess ? guess(sentence) : null))
        .then((first) => {
          if (cancelled || guessHeld.current) return
          guessedFor.current = sentence
          setGuessFirst(first)
        })
    }, GUESS_PAUSE_MS)
    return () => {
      cancelled = true
      clearTimeout(timer)
    }
  }, [prompting, query, guessKey])
  /** The sentence the order on screen was guessed for: a hold never freezes an earlier sentence's guess. */
  const guessedFor = useRef('')
  const holdGuess = useCallback(() => {
    if (guessHeld.current) return
    guessHeld.current = true
    if (guessedFor.current !== query.trim()) setGuessFirst(null)
  }, [query])
  const holdGuessOnArrow = useCallback(
    (event: React.KeyboardEvent) => {
      if (event.key === 'ArrowDown' || event.key === 'ArrowUp') holdGuess()
    },
    [holdGuess],
  )

  const firstLevel = (): { groups: CommandPaletteGroup[]; pending?: string; notes: string[]; empty?: string } => {
    const typed = query.trim()

    if (!q) {
      /*
        Files take the three slots, in the order they were opened (FOL-36): a
        topic started since #194 is a bare file and opens on the file's page.
        A file carries its own title. A recent Convex topic has nothing to open
        since FOL-23 and is skipped.
      */
      const recentTopics = recents
        .flatMap((r) =>
          r.kind === 'file' && !isOpenFile(r.id)
            ? [fileRow(r, () => host.recents?.forget({ kind: 'file', id: r.id }))]
            : [],
        )
        .slice(0, 3)
      const recentPeople = recents
        .filter((r) => r.kind === 'person' && !isOpenPerson(r.id))
        .flatMap((r) => (people ?? []).filter((p) => p.id === r.id))
        .slice(0, 2)
      /*
        The sentences sent in this tab come first (KIN-12; Miky, 23 and 25
        November 2026): the sentence, where it was asked, and the search's dot
        while it works or its answer waits unseen. Picking one shows it, about
        where it was asked.
      */
      const askRows: CommandPaletteRow[] = (kept?.asks ?? []).slice(0, 3).map((a) => ({
        id: `ask-${a.id}`,
        label: a.text,
        description: `in ${a.where}`,
        leading: <AskMark status={a.status} />,
        onSelect: () => kept?.show(a.id),
        onForget: () => kept?.forget(a.id),
      }))
      const recentRows = [
        ...askRows,
        ...recentTopics,
        ...recentPeople.map((p) => personRow(p, () => host.recents?.forget({ kind: 'person', id: p.id }))),
      ]
      const recentGroup: CommandPaletteGroup = {
        label: 'Recent',
        rows: recentRows.length
          ? [
              ...recentRows,
              {
                id: 'clear-recent',
                label: 'Clear recent',
                icon: icon(IconEraser),
                onSelect: () => {
                  host.recents?.clear()
                  kept?.clear()
                },
              },
            ]
          : [],
      }
      /* An answer waits: Recent comes first, so the waiting ask is the lit row and Enter opens it (Miky, KIN-8). */
      const waits = kept?.asks.some((a) => a.status === 'waiting') ?? false
      /*
        The host's own actions, before anything is typed (INT-13, Miky
        2026-10-12): below this conversation, above Recent, under "Actions" —
        "You're in Peek, no need to call it 'Peek'" (Miky, the issue's
        conversation). Empty while its manifest is read, so the group is simply
        not drawn yet.
      */
      const hostRows = HOST_APPS.flatMap((app) =>
        liveActions(app).map((action) => ({
          id: `host-${app.id}-${action.id}`,
          label: action.label,
          icon: icon(IconPencil),
          onSelect: () => push({ kind: 'form', action, app }),
        })),
      )
      const hostGroups = [{ label: 'Actions', rows: [...ownRows('host'), ...hostRows] }]
      // No Ask, Draft or Make rows: you ask by writing a sentence (Miky, 20 November 2026).
      const hereGroups = [{ label: words.openGroup, rows: changeRowsFor(changeRows) }, ...hostGroups]
      return {
        groups: [...(waits ? [recentGroup, ...hereGroups] : [...hereGroups, recentGroup]), { label: 'Apps', rows: OTHER_APPS.map(appRow) }],
        notes: [],
      }
    }

    // An app whose name starts with what was typed goes first (R6); not the host, whose actions are its own group (INT-13).
    const apps = OTHER_APPS.filter((a) => launcherMatch(a.label, query)).map(appRow)
    const changes = changeRowsFor(
      // One row, one text: "rename launch" finds Rename on *Launch plan*.
      changeRows.filter(({ action }) => launcherMatch(`${action.label} ${action.targetLabel ?? ''}`, query)),
    )
    const peopleHits = matchPeople(people ?? [], query).map((p) => personRow(p))
    // An app's action by its name: "add" finds "Add issue · Ship", and Enter opens its form (C4).
    const actionHits = [
      ...ownRows('action').filter((row) => launcherMatch(row.label, query)),
      ...probeable(LAUNCHER_APPS).flatMap((app) =>
      liveActions(app)
        .filter((a) => launcherMatch(a.label, query))
        .map((action) => ({
          id: `action-${app.id}-${action.id}`,
          label: action.label,
          description: app.label,
          icon: icon(IconPencil),
          // The host is not somewhere to go into (INT-13), so going back from its form is the first level.
          onSelect: () => (app.isHost ? push({ kind: 'form', action, app }) : push({ kind: 'app', app }, { kind: 'form', action, app })),
        })),
      ),
    ]

    /*
      Which hits have somewhere to open, and what each row says, is the app's
      (`host.useMessageSearch`): it knows its routes. A hit with nowhere to
      open is not a row; how many there were is said below, because a silent
      cap reads as "that is all there was".
    */
    const messageRows = messageFound.slice(0, 5).map(
      (row): CommandPaletteRow => ({
        id: `message-${row.id}`,
        label: row.label,
        description: row.description,
        leading: row.leading,
        onSelect: close(row.open),
      }),
    )

    /*
      Files whose title holds what was typed (SUM-7), found and ranked as `[`
      finds them — the best match first, an open one before a closed or
      archived one — and never the file already open, as Recent skips it.
    */
    const fileRows = fileHits
      .filter((hit) => !isOpenFile(hit.id))
      .slice(0, 5)
      .map((hit) => fileRow({ id: hit.id, title: hit.title, summary: hit.summary, caption: hit.caption }))

    const searching = messageState.kind === 'searching'
    const messageNote = searching ? null : messageEmptyState(messageState)
    // One relay that failed both searches is said once, by the messages' line.
    const fileNote = messageState.kind === 'failed' ? null : fileEmptyState(fileState)
    const groups: CommandPaletteGroup[] = [
      { label: 'Apps', rows: apps },
      { label: words.openGroup, rows: changes },
      { label: 'People', rows: peopleHits },
      { label: 'Actions', rows: actionHits },
      { label: 'Files', rows: fileRows },
      { label: 'Messages', rows: messageRows },
    ]
    const anyRows = groups.some((g) => g.rows.length > 0)
    const searchingFiles = fileState.kind === 'searching'
    return {
      groups,
      pending: searching ? 'Searching messages…' : searchingFiles ? 'Searching files…' : undefined,
      notes: [
        ...(fileNote ? [fileNote] : []),
        // A plain "No messages matched" says nothing new beside rows that did match.
        ...(messageNote && !(anyRows && messageNote === 'No messages matched.') ? [messageNote] : []),
        ...(unroutable > 0 ? [`${unroutable} more in conversations not in your sidebar.`] : []),
      ],
      empty: !anyRows && !searching && !searchingFiles ? `Nothing is called “${typed}”. Try a person or an app.` : undefined,
    }
  }

  const appLevel = (app: LauncherApp): { groups: CommandPaletteGroup[]; pending?: string; empty?: string } => {
    const read = live[app.id]
    const actions = liveActions(app)
    const rows = actions
      .filter((a) => !q || launcherMatch(a.label, query))
      .map((action) => ({ id: action.id, label: action.label, icon: icon(IconPencil), onSelect: () => push({ kind: 'form', action, app }) }))
    const loading = readKindOf(app) !== undefined && (!read || read.state === 'loading')
    return {
      groups: [{ label: `${app.label} actions`, rows }],
      // Say what is happening rather than showing an empty section: a blank list
      // reads as "this app offers nothing", which is a different and wrong statement.
      pending: loading ? `Reading ${app.label}’s manifest…` : undefined,
      empty: loading
        ? undefined
        : read?.state === 'failed'
          ? `Could not read ${app.label}’s manifest — its actions are unavailable.`
          : actions.length === 0
            ? read?.state === 'ready' && read.withheld
              ? `What ${app.label} creates is made in ${app.label}, not here.`
              : `${app.label} has not published anything to create here yet.`
            : `${app.label} has no action called “${query.trim()}”.`,
    }
  }

  /*
    The first level once the field is a prompt (its third word). The search's
    results leave; what stays under the field is the answer, up to three files
    whose *title* holds every word — a name of three words still finds its
    file (Miky, 20 November 2026) — and what the sentence might want done.
  */
  const promptFace = (): { groups: CommandPaletteGroup[]; pending?: string; body: React.ReactNode } => {
    const typed = query.trim()
    const titleRows = fileHits
      .filter((hit) => !isOpenFile(hit.id) && launcherMatch(hit.title, typed))
      .slice(0, 3)
      .map((hit) => fileRow({ id: hit.id, title: hit.title, summary: hit.summary, caption: hit.caption }))
    const { body, groups: answerGroups } = askView()
    return {
      body,
      groups: [
        ...answerGroups,
        { label: 'Files', rows: titleRows },
        { label: 'On-device model', rows: downloadRows() },
        { label: 'Suggested', rows: suggestedRows(typed) },
      ],
      pending: fileState.kind === 'searching' ? 'Searching files…' : undefined,
    }
  }

  /** Under a prompt: why Enter could not ask, or the answer on its way, or the answer and the rows it came from. */
  const askView = (): { groups: CommandPaletteGroup[]; body: React.ReactNode } => {
    const typed = query.trim()
    if (cannotAsk) return { body: <FieldLine>{cannotAsk}</FieldLine>, groups: [] }
    if (request?.intent !== 'ask') return { body: undefined, groups: [] }
    const changed = typed !== request.text
    {
      const body =
        answer === null ? (
          <CommandPaletteWorking>{words.reading}</CommandPaletteWorking>
        ) : answer === false ? (
          <FieldLine>No answer came back. Edit the question and press Enter to try again.</FieldLine>
        ) : (
          <div data-testid="answer">
          <CommandPaletteAnswer
            note={
              [
                changed ? 'You changed the question. Press Enter to ask again.' : null,
                answer.byRecency
                  ? `Nothing here matched the question, so the last ${part.many} were read instead.`
                  : answer.omitted > 0
                    ? `${answer.omitted} ${answer.omitted === 1 ? part.one : part.many} did not fit and ${answer.omitted === 1 ? 'was' : 'were'} not read.`
                    : null,
                answer.repliesNotRead > 0
                  ? `${answer.repliesNotRead} ${answer.repliesNotRead === 1 ? 'reply was' : 'replies were'} not read — open a conversation to ask about its replies.`
                  : null,
                unreachable
                  ? opened?.kind === 'page'
                    ? 'That part could not be shown on the page.'
                    : 'That message is not loaded in the thread — scroll up to load earlier messages.'
                  : null,
                actionFailed ? `${actionFailed} did not work. The answer is still here.` : null,
              ]
                .filter(Boolean)
                .join(' ') || undefined
            }
          >
            {answer.text}
          </CommandPaletteAnswer>
          </div>
        )
      const sources: CommandPaletteRow[] =
        answer && request
          ? answer.sources.map(({ n, message }) => ({
              id: `source-${message.id}`,
              label: asWords(message.body),
              // A part of a page's own text has no author: it says where it is, with the text's mark (KIN-5).
              description: `[${n}] ${[message.author, message.where ?? message.timestamp].filter(Boolean).join(' · ')}`,
              ...(message.author ? { leading: <Avatar name={message.author} size={24} /> } : { icon: icon(IconAlignLeft) }),
              onSelect: () => {
                // Shown first, closed second: a cited message can sit above the loaded window, and the app says so.
                if (host.showSource(message)) onClose()
                else setUnreachable(message.id)
              },
            }))
          : []
      const next: CommandPaletteRow[] =
        answer && request && context.composer
          ? [
              {
                id: 'answer-to-composer',
                label: 'Put the answer in the composer',
                description: 'It will not send. Edit it first.',
                icon: icon(IconCornerDownLeft),
                onSelect: () => putInComposer(answer.text.replace(/\s*\[\d+\]/g, '')),
              },
            ]
          : []
      // What the app can turn the answer into: a comment, a block in the page (Leaf; Miky, KIN-5 kickoff).
      /*
        Not once the question was changed: the answer on screen is to the old one. Not on another page either: the
        answer is about where it was asked, and must not be written into a page it was never about (KIN-5 review).
      */
      const askedHere = !sentFrom || sentFrom.place === place
      if (answer && request && host.answerActions && !changed && askedHere) {
        // In the order the answer first cites them; an answer that cites nothing cites nothing, not every part read.
        const firstCited = [...new Set([...answer.text.matchAll(/\[(\d+)\]/g)].map((m) => Number(m[1])))]
        const cited = firstCited.flatMap((n) => answer.sources.find((s) => s.n === n)?.message ?? [])
        const turnedInto = { text: answer.text.replace(/\s*\[\d+\]/g, ''), cited }
        for (const action of host.answerActions(turnedInto)) {
          next.push({
            id: `answer-${action.id}`,
            label: action.label,
            ...(action.description ? { description: action.description } : {}),
            ...(action.icon ? { icon: action.icon } : {}),
            onSelect: () => {
              void Promise.resolve()
                .then(() => action.run())
                .catch(() => false)
                .then((done) => (done ? onClose() : setActionFailed(action.label)))
            },
          })
        }
      }
      return {
        body,
        groups: [
          { label: sources.length === 1 ? 'Source' : 'Sources', rows: sources },
          { label: 'Next', rows: next },
        ],
      }
    }
  }

  const draftLevel = (): { groups: CommandPaletteGroup[]; body: React.ReactNode } => {
    const typed = query.trim()
    const changed = typed !== '' && typed !== request?.text
    const askAgain: CommandPaletteRow[] = changed
      ? [
          {
            id: 'again',
            label: `Write a draft: “${typed}”`,
            icon: icon(request ? IconRefresh : IconWriting),
            onSelect: () => send({ intent: 'draft', text: typed }),
          },
        ]
      : []
    const againLabel = request ? 'Write again' : 'Draft'
    {
      const body = !request ? (
        <FieldLine>Say what the reply should say, then press Enter.</FieldLine>
      ) : draft === null ? (
        <CommandPaletteWorking>Writing a draft…</CommandPaletteWorking>
      ) : draft === false ? (
        <FieldLine>No draft came back. Edit what it should say and press Enter to try again.</FieldLine>
      ) : (
        // Shown before it goes anywhere: seeing it first costs nothing.
        <div data-testid="draft">
          <CommandPaletteQuote>{draft}</CommandPaletteQuote>
        </div>
      )
      const next: CommandPaletteRow[] =
        typeof draft === 'string' && request
          ? [
              {
                id: 'draft-to-composer',
                label: 'Put it in the composer',
                description: 'It will not send. Edit it first.',
                icon: icon(IconCornerDownLeft),
                // At the cursor, never replacing, and never sending.
                onSelect: () => putInComposer(draft),
              },
              { id: 'draft-again', label: 'Write it again', icon: icon(IconRefresh), onSelect: () => send({ ...request }) },
            ]
          : []
      return { body, groups: [{ label: againLabel, rows: askAgain }, { label: 'Next', rows: next }] }
    }
  }

  // ── The level on screen ─────────────────────────────────────────────────────

  const modKey = isApplePlatform() ? 'Cmd' : 'Ctrl'
  const where = whereFrom(context, words)
  /*
    The conversation a sentence typed here would be asked about, named above
    the field from the moment the box opens: a name that arrived with the third
    word would push the line being typed down. The footer's "In …" says the
    same thing, so it steps aside while the name is above the field.
  */
  const about = hasThread ? context.composer?.label : undefined

  const content = (() => {
    if (level.kind === 'form' && formDraft) {
      const { action, app } = level
      const vocabularies = action.target
        ? changeRows.find((r) => r.action.target === action.target && r.action.id === action.id)?.vocabularies
        : undefined
      const owner = app?.label
      const chip: CommandPaletteChip = { label: `${action.targetLabel ?? owner ?? ''} · ${action.label}`, onBack: back }
      /*
        A change that changes nothing waits, and says why (F4). The field holds
        the value the object has now until somebody picks another.
      */
      const field = action.target ? action.fields[0] : undefined
      const unchanged = field && draftValues(action, formDraft)[field.key] === (field.defaultValue ?? '')
      const key = formKey(level)
      return (
        <CommandPaletteForm
          chip={chip}
          icon={action.target ? icon(IconPencil) : appMark({ id: app?.id ?? '' }, 16)}
          submitLabel={action.submitLabel}
          onSubmit={() => {
            setAttempted((a) => ({ ...a, [key]: true }))
            if (Object.keys(missingFields(action, formDraft)).length > 0) return
            void submitAction(level, draftValues(action, formDraft), formDraft.formats)
          }}
          submitWaits={unchanged && field ? `Choose a different ${field.label.toLowerCase()} first` : undefined}
          working={
            submitting
              ? action.target
                ? { button: 'Saving…', line: `Saving to ${action.targetLabel ?? 'it'}…` }
                : { button: 'Creating…', line: `Creating it in ${owner ?? 'the app'}…` }
              : undefined
          }
          error={submitError?.text}
        >
          <ActionFormFields
            form={host.form}
            app={app}
            action={action}
            vocabularies={vocabularies}
            parentOptions={parentOptionsFor(level)}
            draft={formDraft}
            onDraft={setFormDraft}
            missing={attempted[key] ? missingFields(action, formDraft) : undefined}
          />
        </CommandPaletteForm>
      )
    }

    if (level.kind === 'app') {
      const { groups, pending, empty } = appLevel(level.app)
      return (
        <CommandPaletteSearch
          query={query}
          onQueryChange={setQuery}
          placeholder={level.app.placeholder}
          groups={groups}
          chip={{ label: level.app.label, leading: appMark(level.app, 16), onBack: back }}
          pending={pending}
          empty={empty}
        />
      )
    }

    if (level.kind === 'draft') {
      const { groups, body } = draftLevel()
      return (
        <CommandPaletteSearch
          query={query}
          onQueryChange={setQuery}
          placeholder="What should the reply say?"
          groups={groups}
          // The mode only; the field keeps the sentence (R9).
          chip={{ label: 'Draft', leading: <IconWriting size={16} stroke={1.5} />, onBack: back }}
        >
          {body}
        </CommandPaletteSearch>
      )
    }

    const placeholder = hasThread ? words.searchOrAsk : words.search
    if (prompting) {
      const { groups, pending, body } = promptFace()
      return (
        <CommandPaletteSearch
          query={query}
          onQueryChange={setQuery}
          placeholder={placeholder}
          groups={groups}
          pending={pending}
          about={about}
          prompt={{ onSubmit: ask, submitWord: 'ask' }}
        >
          {body}
        </CommandPaletteSearch>
      )
    }

    const { groups, pending, notes, empty } = firstLevel()
    return (
      <CommandPaletteSearch
        query={query}
        onQueryChange={setQuery}
        placeholder={placeholder}
        groups={groups}
        pending={pending}
        notes={notes}
        empty={empty}
        about={about}
      />
    )
  })()

  return (
    <CommandPalette
      open={open}
      onOpenChange={(next) => !next && dismiss()}
      label="Launcher"
      where={level.kind === 'first' && about ? undefined : where}
      modKey={modKey}
      // The footer says what Escape will do: the box comes back with what it holds (KIN-2).
      escWord={holds && onHide ? 'hide' : 'close'}
    >
      {/*
        The pointer or an arrow holds the guessed order until the next key (KIN-7); `contents` draws no box. One wrapper
        around every face, never one per face: a face drawn in a different tree remounts the field, and the person
        typing loses it mid-word (the third word, deleting it, Draft and back; found by Peek's suite on 0.3.0).
      */}
      <div className="contents" onPointerMoveCapture={holdGuess} onKeyDownCapture={holdGuessOnArrow}>
        {content}
      </div>
    </CommandPalette>
  )
}

import type { ReactNode } from 'react'
import type { ResolvedAction } from '@estiva-app/interop'
import type { KindIconProps } from '@estiva-app/ui'
import type { DocumentMentions, DocumentReferences, ReferenceViewProps } from '@estiva-app/ui/editor'
import type { LauncherApp } from './launcherActions.js'
import type { CreatableKindRead } from './liveAction.js'
import type { MessageSearchState } from './launcherSearch.js'
import type { LauncherModel } from './promptApi.js'

/**
 * What an app hands the launcher (KIN-4).
 *
 * The box, its levels, the prompt, Ask and Draft, the forms and what Escape
 * keeps are the package's. What only the app knows comes in here: where the
 * person is, how a result opens, who the people are, how the relay is searched,
 * the manifest runtime's calls, and the app's own marks and words.
 *
 * **Build it in a component, from the app's own hooks, on every render.** Its
 * members are values and callbacks, read at the moment they are used. The
 * three members named `use…` are hooks the launcher calls itself, because what
 * they are asked depends on what is typed: pass the same function every time,
 * and an optional one either always or never while the box is mounted.
 *
 * A member marked optional is something not every app has (a message search, a
 * composer, DMs). Without it the launcher draws nothing for it; it never
 * offers what the app could not do.
 */
export interface LauncherHost {
  /** Every app the launcher knows, the one it runs in marked `isHost` (`launcherApps`). */
  apps: readonly LauncherApp[]
  /** An app's mark, at this height in pixels. */
  mark: (appId: string, size: number) => ReactNode
  /** The app's own words: the ones that name it, or what is open in it. */
  words: LauncherWords

  /** Where the person is, as the app's router has it. */
  path: { pathname: string; search: string }
  /** Go to a path of this app. */
  navigate: (path: string) => void

  /** The workspace's people, or undefined while they are read. */
  people: readonly LauncherPerson[] | undefined
  /** Open a person: in Peek, their DM. */
  openPerson: (id: string) => void
  /** The person whose page is open, who is then not somewhere to go. */
  isOpenPerson?: (id: string) => boolean

  /** A file by its address: how it is drawn in a row, where it opens, and its card beside the box. */
  file: {
    glyph: (id: string) => KindIconProps['kind']
    open: (id: string, title: string) => void
    /** The file the person is on, which is never a result. */
    isOpen: (id: string) => boolean
    /** The card a link to it draws, or nothing for a file that has none (a topic). */
    preview?: (id: string) => ReactNode
  }

  /** What the person opened last in this app, newest first. */
  recents?: {
    list: readonly LauncherRecent[]
    forget: (recent: Pick<LauncherRecent, 'kind' | 'id'>) => void
    clear: () => void
  }

  /** Files by title, as `[` finds them. A hook. */
  useFileSearch: (query: string) => { state: MessageSearchState; hits: readonly LauncherFileHit[] }
  /**
   * Messages, where the app can open one (Peek). A hook. The app decides which
   * hits have somewhere to open and draws their rows; `unroutable` is how many
   * did not, so the launcher can say so.
   */
  useMessageSearch?: (query: string) => { state: MessageSearchState; rows: readonly LauncherMessageRow[]; unroutable: number }
  /** A stored body as one line of words, its markup gone. */
  plain: (body: string) => string

  /** The manifest runtime, as this app reaches the relay. */
  manifests: {
    creatableUnder: (kind: number) => Promise<CreatableKindRead | null>
    applyAction: (args: LauncherApply) => Promise<LauncherApplied>
    resolveObject: (reference: string) => Promise<LauncherObject | null>
    /** What an untitled object is called: "Topic", never the app's name. */
    objectLabel?: (object: LauncherObject) => string | undefined
  }

  /** What answers a prompt and fills a form: the browser's on-device model (`onDeviceModel`). */
  model: LauncherModel

  /** The box a draft or an answer can be put in, where the app has one. */
  composer?: {
    /** Into the composer that has the cursor. */
    insertText: (text: string) => void
    /** Into the composer of that name, if it is on screen. */
    insertTextInto: (label: string | undefined, text: string) => boolean
    /** Into the composer of that name once it opens, unless the person has left by then. */
    insertTextWhenOpens: (label: string | undefined, text: string, stillThere: () => boolean) => Promise<boolean>
    /** A link to what was just created; false when no composer took it. */
    insertReference: (naddr: string) => boolean
  }
  /** Show the message an answer cites; false when it cannot be reached. */
  showSource: (message: LauncherMessage) => boolean

  /** What a form's fields need of the app: `[` and `@` in a description, and the person picker. */
  form: LauncherFormHost

  /** The team the person is in, which Create topic opens on. */
  currentFolder?: () => string | undefined
  /** Why nothing can be created under this parent, or null: a retired topic's channel in Peek. */
  parentRefusal?: (address: string) => string | null
  /** A conversation started in a DM is the app's own message, not a Folder's action (Peek). Without it no DM is offered and nothing is sent to one. */
  startConversationInDm?: (args: { channel: string; body: string }) => Promise<{ ok: boolean; reason?: string }>
  /** Make a person a member of a file just created; true, or why not. Without it the people chosen are named as not added. */
  addMember?: (file: string, folder: string, person: string) => Promise<true | string>
  /** Something was created: the lists on screen read again. */
  afterCreate?: () => void

  /**
   * Whether this app may sign an event of this kind (its allowed kinds in Estiva ID). An action whose event it may not
   * sign is never offered: Leaf does not offer Ship's Create issue (KIN-5). Without it, every declared action is offered,
   * as in Peek.
   */
  maySign?: (kind: number) => boolean
  /**
   * The app's own actions that are no manifest's yet, offered beside the declared ones: Leaf's New document, which opens
   * Leaf's own dialog (KIN-5; KIN-9 puts it in Leaf's manifest).
   */
  ownActions?: readonly LauncherOwnAction[]
  /**
   * What an answer about what is open can be turned into, in this app: a comment on the passage it cites first, a block
   * in the page (Leaf). Offered under the answer, after the composer's row where the app has a composer.
   */
  answerActions?: (answer: LauncherAnswer) => readonly LauncherAnswerAction[]

  /** Report a failure the person was shown. A hook. */
  useReportFailure: (failure: LauncherFailure | undefined) => void
}

/** The failures the launcher can show, by the names the apps report them under (`Failure` in `@estiva-app/platform`). */
export type LauncherFailure = 'not-saved' | 'unnamed' | 'not-sent' | 'not-created' | 'not-added'

export interface LauncherWords {
  /** The footer, with nothing open: "Anywhere in Peek". */
  anywhere: string
  /** The footer, with something open and no composer named: "In this conversation". */
  inOpen: string
  /** The field, with nothing open: "Search Peek, or choose an app". */
  search: string
  /** The field, with something open: "Search, or ask about this conversation". */
  searchOrAsk: string
  /** The group of changes to what the open thing refers to: "This conversation". */
  openGroup: string
  /** Enter on a prompt with nothing open: "Open a conversation to ask about it." */
  nothingOpen: string
  /** Enter on a prompt about something empty: "Nothing has been said here yet." */
  nothingYet: string
  /** While an answer is on its way: "Reading the thread…" */
  reading: string
  /** The row that fetches the model: "Download the on-device model to ask about conversations". */
  downloadModel: string
  /** What one part of what is open is called, when it is not a message: "passage" on a page. Default "message". */
  part?: { one: string; many: string }
}

/** An action of the app's own, offered among the declared ones. */
export interface LauncherOwnAction {
  id: string
  label: string
  /** The second line: where it acts, "In Launch team". */
  description?: string
  icon?: ReactNode
  /** Do it. The box closes. */
  run: () => void
}

/** An answer about what is open, as an answer action receives it. */
export interface LauncherAnswer {
  /** The answer's words, its citation marks taken out. */
  text: string
  /** The parts it cites, in the order it first cites them. */
  cited: readonly LauncherMessage[]
}

/** Something an answer can be turned into. */
export interface LauncherAnswerAction {
  id: string
  label: string
  description?: string
  icon?: ReactNode
  /** Do it: true when it was done and the box can close, false when it could not be (the box says so and stays). */
  run: () => boolean | Promise<boolean>
}

export interface LauncherPerson {
  id: string
  name: string
  role?: string
  avatarSrc?: string
  bot?: boolean
  pubkey?: string
}

export type LauncherRecent =
  | { kind: 'topic'; id: string }
  | { kind: 'person'; id: string }
  | { kind: 'file'; id: string; title: string; summary?: string; caption?: string }

export interface LauncherFileHit {
  id: string
  title: string
  summary?: string
  caption?: string
}

export interface LauncherMessageRow {
  id: string
  label: string
  description?: string
  leading?: ReactNode
  open: () => void
}

/** One message of what is open: what an answer is read from and cites. */
export interface LauncherMessage {
  id: string
  author: string
  /** As the thread shows it; shown on a citation, never parsed. */
  timestamp: string
  body: string
  /** The conversation it belongs to, when that is not the one on screen. */
  conversationId?: string
  /** Replies it has that were not read. */
  repliesNotRead?: number
  /** Where it sits, said on its citation in place of the time: "In the page", "Comment on the whole document". */
  where?: string
  /** A comment whose thread was resolved: the answer is told so. */
  resolved?: boolean
}

/**
 * What the person was doing when they opened the box, captured by the app at
 * that keystroke or click.
 *
 * What is open is a conversation (Peek) or a page (Leaf's page, a Ship issue or
 * project drawn in Leaf; KIN-5). A page's parts are its blocks, in order, and
 * then every comment on it, resolved ones marked (Miky, KIN-5 kickoff).
 */
export interface LauncherContext {
  /** The composer an insert would land in. Present when the app has one open. */
  composer?: { label?: string }
  /** What is open: its parts, in order, and the files it refers to. */
  open?: LauncherOpen
  /** Peek's shape before KIN-5: the same as `open` with `kind: 'conversation'`. */
  conversation?: { references: readonly string[]; messages: readonly LauncherMessage[] }
}

/** What is open, and what an ask about it reads. */
export interface LauncherOpen {
  kind: 'conversation' | 'page'
  /** Its name, which the prompt gives the model: a page's title. */
  title?: string
  references: readonly string[]
  /** Its parts: a conversation's messages, oldest first; a page's blocks, then its comments. */
  messages: readonly LauncherMessage[]
}

/** What is open, from either shape. */
export function openOf(context: LauncherContext): LauncherOpen | undefined {
  return context.open ?? (context.conversation ? { kind: 'conversation', ...context.conversation } : undefined)
}

export interface LauncherApply {
  naddr: string
  actionId: string
  value: string | Record<string, string>
  contentFormat?: string
  declaredBy?: string
}

export interface LauncherApplied {
  ok: boolean
  reason?: string
  /** The address of what was created. */
  created?: string
  textNotSaved?: boolean
  incomplete?: string
}

export interface LauncherObject {
  naddr?: string
  noun?: string
  appName?: string
  slots?: { title?: { value?: string } }
  actions?: ResolvedAction[]
}

export interface LauncherFormHost {
  /** `[` in a description: what it offers, in the app's words. */
  references: DocumentReferences
  /** `@` in a description: who can be mentioned, and how a mention is written. */
  mentions: DocumentMentions
  /** How a reference draws inside the field. */
  referenceView: (props: ReferenceViewProps) => ReactNode
  /** The person picker: one person, or several. */
  personField: (props: {
    value: LauncherPerson[]
    single: boolean
    onChange: (next: LauncherPerson[]) => void
    placeholder?: string
  }) => ReactNode
}

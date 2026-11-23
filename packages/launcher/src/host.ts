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
 * they are asked depends on what is typed: pass the same function every time.
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
  /** A conversation started in a DM is the app's own message, not a Folder's action (Peek). */
  startConversationInDm?: (args: { channel: string; body: string }) => Promise<{ ok: boolean; reason?: string }>
  /** Make a person a member of a file just created; true, or why not. */
  addMember?: (file: string, folder: string, person: string) => Promise<true | string>
  /** Something was created: the lists on screen read again. */
  afterCreate?: () => void

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
}

/**
 * What the person was doing when they opened the box, captured by the app at
 * that keystroke or click.
 *
 * It is still a conversation's shape, because Peek is the one app that mounts
 * the box so far (KIN-4). Leaf's page and Ship's issue arrive with their own
 * tickets, which may widen it.
 */
export interface LauncherContext {
  /** The composer an insert would land in. Present when the app has one open. */
  composer?: { label?: string }
  /** What is open: its messages, oldest first, and the files it refers to. */
  conversation?: { references: readonly string[]; messages: readonly LauncherMessage[] }
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

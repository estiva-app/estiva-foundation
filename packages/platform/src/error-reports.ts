/**
 * The error reporter every Estiva app shares: when a part of the page breaks,
 * one short report goes to Estiva ID's `POST /report`, which checks the
 * sign-in, rebuilds the report from the same list and passes it to Sentry.
 *
 * The report is **built from a fixed list**, never filtered afterwards: the
 * kind of error, its wording with quoted text and addresses removed, the stack
 * frames in the app's own bundles, the kind of screen (a route pattern, never
 * the address), the app's version, and the last few steps in our own words.
 * The apps decrypt messages and documents in the browser, so anything else an
 * error carries may be something a person wrote, and is left out.
 *
 * Each kind of error is sent once per tab, and a tab sends at most ten. Nothing
 * is sent before sign-in.
 *
 * Estiva ID's `src/domain/error-reports.ts` holds the server's copy of the same
 * rules; a change to one is a change to both.
 */

/** Our own named actions: the only words a step may carry besides a screen. Estiva ID keeps the same list. */
export type ReportAction = 'sent-message' | 'write-refused'
const ACTIONS: readonly string[] = ['sent-message', 'write-refused'] satisfies ReportAction[]

export type ReportStep = { screen: string } | { action: ReportAction }

/**
 * How it was met: a crash (`error`, `unhandled-rejection`, `boundary`), a
 * failure the app told the person about (`failure`), or a write the relay
 * refused (`refused`).
 */
export type ReportHow = 'error' | 'unhandled-rejection' | 'boundary' | 'failure' | 'refused'

/**
 * What failed, as the app told the person: the only words a failure report
 * carries. The message a person saw is never sent, because most of them name
 * a title, a person or the relay's own sentence. `unnamed` is a failure whose
 * place names none: still reported, with its screen and trail. Estiva ID keeps
 * the same list, with the sentence Sentry shows for each.
 */
export const FAILURES = [
  'not-sent',
  'not-saved',
  'not-deleted',
  'not-moved',
  'not-joined',
  'not-left',
  'not-added',
  'not-created',
  'not-archived',
  'not-restored',
  'not-renamed',
  'not-resolved',
  'not-loaded',
  'not-reached',
  'not-signed',
  'signed-out',
  'sign-in-failed',
  'link-not-valid',
  'not-approved',
  'unnamed',
] as const
export type Failure = (typeof FAILURES)[number]

/**
 * Why a failure the app showed happened: the only words a failure's `reason`
 * may be. Estiva ID keeps the same list, and Sentry files each reason of a
 * failure as its own error, so "the relay said wait" is told apart from "the
 * sign-in had lapsed" without reading two servers' logs (23 Nov: nine "Could
 * not load" reports after the per-minute fixes, none of them the limit).
 * - `told-to-wait`: the relay's per-minute limit (`rate-limited: quota exceeded`);
 * - `id-told-to-wait`: Estiva ID's own limit on signing or decrypting (429);
 * - `relay-busy`: the relay too busy to answer, through protocol's quiet retries;
 * - `signed-out`: the sign-in had lapsed (a 401, or no token to sign with);
 * - `not-reached`: the request never got an answer (offline, cut, timed out);
 * - `no-access`: the relay refused the read as not this person's to make;
 * - `other`: a failed request that is none of these.
 * A failure nothing was heard for carries no reason.
 *
 * why: https://github.com/estiva-app/estiva-docs/blob/main/decisions/error-reports-go-to-hosted-sentry-built-from-an-allowed-list.md
 */
export const FAILURE_REASONS = [
  'told-to-wait',
  'id-told-to-wait',
  'relay-busy',
  'signed-out',
  'not-reached',
  'no-access',
  'other',
] as const
export type FailureReason = (typeof FAILURE_REASONS)[number]

/**
 * The reason a request failed, read from what it threw or answered: the
 * error's `name` and `status` and the relay's own prefix, never its wording
 * sent on. `status` is for a caller that holds an HTTP answer and no error.
 */
export function failureReasonOf(error: unknown, status?: number): FailureReason {
  const name = error instanceof Error ? error.name : ''
  const text = (error instanceof Error ? error.message : typeof error === 'string' ? error : '').toLowerCase()
  const code = status ?? (error as { status?: unknown; httpStatus?: unknown } | null)?.status ?? (error as { httpStatus?: unknown } | null)?.httpStatus
  // Estiva ID's refusals first: its limit is not the relay's, and its 401 is a lapsed sign-in.
  if (name === 'SignerTokenExpired' || code === 401 || text.includes('not signed in')) return 'signed-out'
  if (name === 'SignRefused') return code === 429 ? 'id-told-to-wait' : 'other'
  if (text.includes('rate-limited') || text.includes('quota exceeded')) return 'told-to-wait'
  if (name === 'RelayBusyError' || code === 502 || code === 503 || text.includes('the relay is busy')) return 'relay-busy'
  if (code === 429) return 'told-to-wait'
  if (code === 403 || /^(query failed: )?(restricted|auth-required|blocked):/.test(text)) return 'no-access'
  if (name === 'AbortError' || name === 'TimeoutError' || (name === 'TypeError' && /fetch|network|load failed/.test(text))) return 'not-reached'
  return 'other'
}

/** How long a failed request explains a failure shown after it. */
export const HEARD_FOR_MS = 15_000

/**
 * What the app's requests last heard, for a failure drawn a moment later by a
 * screen that holds only "it failed": the transport calls `heard` with each
 * failed request's reason, and the reporter's `reason` option reads `recent`.
 * The latest one within {@link HEARD_FOR_MS} wins; older, nothing.
 */
export function createHeardFailures(options: { now?: () => number; holdMs?: number } = {}) {
  const now = options.now ?? (() => Date.now())
  const holdMs = options.holdMs ?? HEARD_FOR_MS
  let last: { reason: FailureReason; at: number } | undefined
  return {
    /** A request failed for `reason` (a name outside the list is `other`). Never throws. */
    heard(reason: FailureReason): void {
      last = { reason: (FAILURE_REASONS as readonly string[]).includes(reason) ? reason : 'other', at: now() }
    },
    /** The latest reason still fresh, or nothing. */
    recent(): FailureReason | undefined {
      return last && now() - last.at <= holdMs ? last.reason : undefined
    },
  }
}

/** A refusal's code as the relay client reads it (`archived`, `busy`, `blocked`, `http-500`): letters, digits and dashes. */
const CODE = /^[a-z][a-z0-9-]{0,39}$/

export interface ReportFrame {
  function?: string
  file: string
  line?: number
  column?: number
}

/** The whole body sent to Estiva ID. */
export interface ErrorReportBody {
  release: string
  how: ReportHow
  error: { type: string; message: string; frames: ReportFrame[] }
  /** A failure's name from {@link FAILURES}, or a refusal's code; absent on a crash. */
  named?: string
  /** Why a failure happened, from {@link FAILURE_REASONS}; only on a failure, and absent when nothing was heard. */
  reason?: FailureReason
  screen: string
  trail: Array<ReportStep & { at: number }>
}

export interface ErrorReporterOptions {
  /** Estiva ID's report address, e.g. `https://id.estiva.app/report`. */
  endpoint: string
  /** The app's version: the commit it was built from. */
  release: string
  /** The page's origin; a frame's file is kept only under `<origin>/assets/`. */
  origin: string
  /** The current access token, or nothing when signed out (then nothing is sent). */
  token: () => string | undefined | Promise<string | undefined>
  /** The current screen as a route pattern (`/app/teams/:id`). */
  screen: () => string
  /**
   * Every screen the app names, as route patterns. A screen outside it, as
   * the current one or in a step, is sent as `<unknown>`. Estiva ID keeps the
   * same list per app.
   */
  screens: readonly string[]
  /** At most this many crash reports per tab. Default 10. */
  maxPerTab?: number
  /**
   * At most this many failure and refusal reports per tab, counted apart from
   * crashes so a relay that keeps refusing cannot use up the crash budget.
   * Default 10.
   */
  maxHandledPerTab?: number
  /**
   * Why the failure being reported happened, when the caller of `failure`
   * did not say: what the app's requests last heard
   * (`createHeardFailures().recent`). A value outside {@link FAILURE_REASONS}
   * is not sent.
   */
  reason?: () => FailureReason | undefined
  /** Defaults to the global `fetch`. */
  fetch?: FetchLike
  now?: () => number
}

/** The part of `fetch` the reporter uses. */
export type FetchLike = (
  url: string,
  init: { method: 'POST'; keepalive: boolean; headers: Record<string, string>; body: string },
) => Promise<unknown>

/** A window, as far as listening for its errors goes. */
export interface ErrorEventTarget {
  addEventListener(type: 'error' | 'unhandledrejection', listener: (event: { error?: unknown; reason?: unknown }) => void): void
  removeEventListener(type: 'error' | 'unhandledrejection', listener: (event: { error?: unknown; reason?: unknown }) => void): void
}

export interface ErrorReporter {
  /** Report an error, once per kind of error per tab. Never throws. */
  report(error: unknown, how?: 'error' | 'unhandled-rejection' | 'boundary'): void
  /**
   * Report that the app told the person something failed, by what failed
   * (a name outside {@link FAILURES} is sent as `unnamed`), and why when that
   * is known: `reason`, or else what the `reason` option answers. Once per
   * name and reason per screen per tab. Never throws.
   */
  failure(what: Failure, reason?: FailureReason): void
  /**
   * Report a write the relay refused, by its code as the relay client reads it
   * (protocol's `refusalCodeOf`), never its sentence; a code of any other shape
   * is sent as `uncoded`. Once per code per tab, so a relay answering "busy" a
   * hundred times sends one. Records a `write-refused` step. Never throws.
   */
  refused(code: string): void
  /** Record a step for the trail: a screen opened or one of our named actions. */
  step(step: ReportStep): void
  /** Report the window's unhandled errors and rejections; returns the way to stop. */
  listen(target: ErrorEventTarget): () => void
  /** The bodies sent so far, newest last (for a probe). */
  readonly sent: readonly ErrorReportBody[]
}

const MAX_MESSAGE = 200
/** While signed out, a crash is tried again after this long, not on every repeat. */
const SIGNED_OUT_RETRY_MS = 10_000
const MAX_FRAMES = 50
const MAX_TRAIL = 10

const QUOTES = /["'`‘’“”«»]/

/**
 * An error's own wording with what may have been written by a person removed:
 * everything from the first quote mark to the last (an unpaired one to the end;
 * an apostrophe inside a word is wording), the input of wordings that name it
 * unquoted, web addresses to the end, mail addresses, Nostr bech32 ids, and
 * runs of 16 or more letters and digits with a digit in them.
 */
export function scrubMessage(raw: unknown): string {
  if (typeof raw !== 'string') return ''
  // The whole wording is cleaned, never a cut of it: the rules below read its end.
  let text = raw.replace(/\p{Cc}+/gu, ' ')

  const isQuote = (i: number) =>
    QUOTES.test(text[i] as string) &&
    !(/\p{L}/u.test(text[i - 1] ?? '') && /\p{L}/u.test(text[i + 1] ?? ''))
  let first = -1
  for (let i = 0; i < text.length; i++) {
    if (isQuote(i)) {
      first = i
      break
    }
  }
  if (first >= 0) {
    let last = -1
    for (let i = text.length - 1; i > first; i--) {
      if (isQuote(i)) {
        last = i
        break
      }
    }
    text = `${text.slice(0, first)}…${last > first ? text.slice(last + 1) : ''}`
  }

  text = text
    .replace(
      /^(?:(URL constructor|[A-Z][A-Za-z]*\.[A-Za-z]+): )?.* is not a valid URL\.?$/s,
      (_all, api: string | undefined) => (api ? `${api}: … is not a valid URL.` : '… is not a valid URL.'),
    )
    .replace(/\b(Failed to parse URL from|Invalid regular expression:|Invalid URL:)\s.*$/s, '$1 …')
    .replace(
      /^Cannot convert .* to an? (BigInt|Symbol|number|string|object|primitive value)\b.*$/s,
      'Cannot convert … to a $1',
    )
    // Starts only where a run of scheme letters does: from every dot of `a.a.a…` it cost the square of the length.
    .replace(/(?<![a-z0-9+.-])[a-z0-9+.-]*:\/\/.*$/is, '<url>')
    // Starts only where a word does, and no part of it spans an @: `\S+@\S+` tried from every
    // letter of a long word costs the square of its length (614 ms at 32 KB).
    .replace(/(?<!\S)[^\s@]*@\S*\.\S*/g, '<address>')
    .replace(/\b(npub|nsec|note|nevent|naddr|nprofile|nrelay)1[0-9a-z]+/gi, '<id>')
    .replace(/[A-Za-z0-9+/=_-]{16,}/g, (run) => (/\d/.test(run) ? '<id>' : run))
    .replace(/\s+/g, ' ')
    .trim()

  return text.length > MAX_MESSAGE ? `${text.slice(0, MAX_MESSAGE - 1)}…` : text
}

const FUNCTION_NAME = /^(?:new |async )?[A-Za-z_$<][\w$<>]{0,60}(?:\.[A-Za-z_$<][\w$<>]{0,60}){0,4}$/
const TYPE = /^[A-Za-z_$][A-Za-z0-9_$]{0,63}$/

// Chrome, Edge: "    at fn (url:1:2)" or "    at url:1:2". Firefox, Safari: "fn@url:1:2".
const V8_FRAME = /^\s*at (?:(.+?) \()?(\S+?):(\d+):(\d+)\)?$/
const GECKO_FRAME = /^(.*?)@(\S+?):(\d+):(\d+)$/

/**
 * The stack's frames, newest first, each kept only when its file is one of
 * the app's own bundles; a frame anywhere else keeps neither file nor name.
 *
 * A V8 stack opens with the error's name and its wording, all of the
 * wording's lines, unscrubbed. A regex error quoting a person's text would
 * otherwise send their lines as frames, so: a stack with any `at` line is read
 * for `at` lines only, and a line of `wording` is never a frame, however
 * frame-shaped. (A caller that has the error cuts the opening off first.)
 */
export function readFrames(stack: unknown, origin: string, wording = ''): ReportFrame[] {
  if (typeof stack !== 'string') return []
  const lines = stack.split('\n')
  const v8 = lines.some((line) => V8_FRAME.test(line))
  const ownWords = new Set(wording.split('\n').map((line) => line.trim()))
  const frames: ReportFrame[] = []
  for (const line of lines) {
    const text = line.trim()
    if (!text || ownWords.has(text)) continue
    const match = v8 ? line.match(V8_FRAME) : line.match(GECKO_FRAME)
    if (!match) continue
    const [, fn, file, lineNo, column] = match as unknown as [string, string | undefined, string, string, string]
    // Estiva ID's ASSET_PATH keeps the same: a bundle's name, at most 100 characters.
    const own =
      file.startsWith(`${origin}/assets/`) && /^[A-Za-z0-9_.-]{1,100}\.m?js$/.test(file.slice(origin.length + 8))
    if (!own) {
      frames.push({ file: '<other>' })
    } else {
      const name = fn?.trim()
      frames.push({
        ...(name && FUNCTION_NAME.test(name) ? { function: name } : {}),
        file,
        line: Number(lineNo),
        column: Number(column),
      })
    }
    if (frames.length >= MAX_FRAMES) break
  }
  return frames
}

/**
 * The kind of error and its wording. Only an `Error` has wording we send:
 * anything else thrown or rejected (a string, an object) may be anything, so
 * it is reported by its kind alone.
 */
function describe(error: unknown): { type: string; message: string; stack?: string; wording?: string } {
  if (error instanceof Error) {
    const wording = typeof error.message === 'string' ? error.message : ''
    let stack = typeof error.stack === 'string' ? error.stack : undefined
    // V8's opening, `Name: wording`, goes whole, whatever the name.
    const opening = wording ? `${String(error.name)}: ${wording}` : String(error.name)
    if (stack?.startsWith(opening)) stack = stack.slice(opening.length)
    return {
      type: TYPE.test(error.name) ? error.name : 'Error',
      message: scrubMessage(wording),
      ...(stack !== undefined ? { stack } : {}),
      wording,
    }
  }
  return { type: error === null ? 'Null' : typeof error === 'object' ? 'NonErrorObject' : 'NonError', message: '' }
}

export function createErrorReporter(options: ErrorReporterOptions): ErrorReporter {
  const maxPerTab = options.maxPerTab ?? 10
  const now = options.now ?? (() => Date.now())
  const send: FetchLike =
    options.fetch ?? ((url, init) => (globalThis as unknown as { fetch: FetchLike }).fetch(url, init))
  const maxHandledPerTab = options.maxHandledPerTab ?? 10
  const seen = new Set<string>()
  const handled = new Set<string>()
  const trail: Array<ReportStep & { at: number }> = []
  const sent: ErrorReportBody[] = []
  const listed = (screen: unknown): string =>
    typeof screen === 'string' && options.screens.includes(screen) ? screen : '<unknown>'

  let signedOutAt = Number.NEGATIVE_INFINITY

  async function deliver(body: ErrorReportBody, kind: string, kinds: Set<string>): Promise<void> {
    const token = await options.token()
    if (!token) {
      // Not sent, so not spent: the same crash after sign-in in this tab still reports.
      kinds.delete(kind)
      signedOutAt = now()
      return
    }
    signedOutAt = Number.NEGATIVE_INFINITY
    sent.push(body)
    await send(options.endpoint, {
      method: 'POST',
      keepalive: true,
      headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
      body: JSON.stringify(body),
    })
  }

  /**
   * A failure or a refusal: no wording and no frames, only its name; once per
   * name per screen per tab, so the same broad name met on another screen is a
   * second report, and a relay busy a hundred times on one screen is one.
   */
  function reportHandled(how: 'failure' | 'refused', named: string, why?: unknown): void {
    try {
      if (now() - signedOutAt < SIGNED_OUT_RETRY_MS) return
      const screen = listed(options.screen())
      // Only a failure has a reason, and only one from the list: anything else is not sent.
      const inList = (value: unknown): FailureReason | undefined =>
        (FAILURE_REASONS as readonly unknown[]).includes(value) ? (value as FailureReason) : undefined
      const reason = how === 'failure' ? (inList(why) ?? inList(options.reason?.())) : undefined
      const kind = `${how}|${named}|${screen}${reason ? `|${reason}` : ''}`
      if (handled.has(kind) || handled.size >= maxHandledPerTab) return
      handled.add(kind)
      const body: ErrorReportBody = {
        release: options.release,
        how,
        error: { type: how === 'refused' ? 'WriteRefused' : 'Failure', message: named, frames: [] },
        named,
        ...(reason ? { reason } : {}),
        screen,
        trail: [...trail],
      }
      deliver(body, kind, handled).catch(() => {
        // Dropped, as a crash report is.
      })
    } catch {
      // Never break the page while reporting.
    }
  }

  function step(step: ReportStep): void {
    // Rebuilt from the lists, never copied: whatever else the object carries stays here.
    // A screen if it has one, else one of our actions, as Estiva ID's readStep reads it.
    const { screen, action } = step as { screen?: unknown; action?: unknown }
    let next: ReportStep
    if (typeof screen === 'string') next = { screen: listed(screen) }
    else if (typeof action === 'string' && ACTIONS.includes(action)) next = { action: action as ReportAction }
    else return
    const last = trail.at(-1)
    // A screen or an action straight after itself is one step: a refusal storm keeps the screens before it.
    if (last && 'screen' in next && 'screen' in last && last.screen === next.screen) return
    if (last && 'action' in next && 'action' in last && last.action === next.action) return
    trail.push({ ...next, at: now() })
    if (trail.length > MAX_TRAIL) trail.shift()
  }

  function report(error: unknown, how: 'error' | 'unhandled-rejection' | 'boundary' = 'error'): void {
    try {
      // A crash loop while signed out is not read again on every turn.
      if (now() - signedOutAt < SIGNED_OUT_RETRY_MS) return
      const { type, message, stack, wording } = describe(error)
      const frames = readFrames(stack, options.origin, wording)
      const top = frames[0]
      // One kind of error: its type and where it broke (or its wording, with no frame of ours).
      const kind = `${type}|${top?.file ?? ''}:${top?.line ?? ''}:${top?.column ?? ''}|${top ? '' : message}`
      if (seen.has(kind) || seen.size >= maxPerTab) return
      seen.add(kind)
      const body: ErrorReportBody = {
        release: options.release,
        how,
        error: { type, message, frames },
        screen: listed(options.screen()),
        trail: [...trail],
      }
      deliver(body, kind, seen).catch(() => {
        // A report that cannot be sent is dropped: reporting must never break the page.
      })
    } catch {
      // Same: never break the page while reporting it broke.
    }
  }

  return {
    report,
    failure(what, reason) {
      reportHandled('failure', (FAILURES as readonly string[]).includes(what) ? what : 'unnamed', reason)
    },
    refused(code) {
      step({ action: 'write-refused' })
      reportHandled('refused', typeof code === 'string' && CODE.test(code) ? code : 'uncoded')
    },
    step,
    listen(target) {
      const onError = (event: { error?: unknown }) => report(event.error, 'error')
      const onRejection = (event: { reason?: unknown }) => report(event.reason, 'unhandled-rejection')
      target.addEventListener('error', onError)
      target.addEventListener('unhandledrejection', onRejection)
      return () => {
        target.removeEventListener('error', onError)
        target.removeEventListener('unhandledrejection', onRejection)
      }
    },
    sent,
  }
}

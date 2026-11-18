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

export type ReportStep = { screen: string } | { action: ReportAction }

export type ReportHow = 'error' | 'unhandled-rejection' | 'boundary'

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
  /** At most this many reports per tab. Default 10. */
  maxPerTab?: number
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
  report(error: unknown, how?: ReportHow): void
  /** Record a step for the trail: a screen opened or one of our named actions. */
  step(step: ReportStep): void
  /** Report the window's unhandled errors and rejections; returns the way to stop. */
  listen(target: ErrorEventTarget): () => void
  /** The bodies sent so far, newest last (for a probe). */
  readonly sent: readonly ErrorReportBody[]
}

const MAX_MESSAGE = 200
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
    .replace(/\b[a-z][a-z0-9+.-]*:\/\/.*$/is, '<url>')
    .replace(/\S+@\S+\.\S+/g, '<address>')
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
 * The first line of a V8 stack repeats the message, and is never a frame.
 */
export function readFrames(stack: unknown, origin: string): ReportFrame[] {
  if (typeof stack !== 'string') return []
  const frames: ReportFrame[] = []
  for (const line of stack.split('\n')) {
    const match = line.match(V8_FRAME) ?? line.match(GECKO_FRAME)
    if (!match) continue
    const [, fn, file, lineNo, column] = match as unknown as [string, string | undefined, string, string, string]
    const own = file.startsWith(`${origin}/assets/`) && /^[A-Za-z0-9_.-]+\.m?js$/.test(file.slice(origin.length + 8))
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
function describe(error: unknown): { type: string; message: string; stack?: string } {
  if (error instanceof Error) {
    return {
      type: TYPE.test(error.name) ? error.name : 'Error',
      message: scrubMessage(error.message),
      ...(typeof error.stack === 'string' ? { stack: error.stack } : {}),
    }
  }
  return { type: error === null ? 'Null' : typeof error === 'object' ? 'NonErrorObject' : 'NonError', message: '' }
}

export function createErrorReporter(options: ErrorReporterOptions): ErrorReporter {
  const maxPerTab = options.maxPerTab ?? 10
  const now = options.now ?? (() => Date.now())
  const send: FetchLike =
    options.fetch ?? ((url, init) => (globalThis as unknown as { fetch: FetchLike }).fetch(url, init))
  const seen = new Set<string>()
  const trail: Array<ReportStep & { at: number }> = []
  const sent: ErrorReportBody[] = []

  async function deliver(body: ErrorReportBody): Promise<void> {
    const token = await options.token()
    if (!token) return
    sent.push(body)
    await send(options.endpoint, {
      method: 'POST',
      keepalive: true,
      headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
      body: JSON.stringify(body),
    })
  }

  function report(error: unknown, how: ReportHow = 'error'): void {
    try {
      const { type, message, stack } = describe(error)
      const frames = readFrames(stack, options.origin)
      const top = frames[0]
      // One kind of error: its type and where it broke (or its wording, with no frame of ours).
      const kind = `${type}|${top?.file ?? ''}:${top?.line ?? ''}:${top?.column ?? ''}|${top ? '' : message}`
      if (seen.has(kind) || seen.size >= maxPerTab) return
      seen.add(kind)
      const body: ErrorReportBody = {
        release: options.release,
        how,
        error: { type, message, frames },
        screen: options.screen(),
        trail: [...trail],
      }
      deliver(body).catch(() => {
        // A report that cannot be sent is dropped: reporting must never break the page.
      })
    } catch {
      // Same: never break the page while reporting it broke.
    }
  }

  return {
    report,
    step(step) {
      const last = trail.at(-1)
      if (last && 'screen' in step && 'screen' in last && last.screen === step.screen) return
      trail.push({ ...step, at: now() })
      if (trail.length > MAX_TRAIL) trail.shift()
    },
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

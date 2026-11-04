/**
 * refusals, the one set of words every app says when a send, an edit, a
 * reaction or a file is refused (ONE-4).
 *
 * A refusal comes from the relay (`invalid: …`, `restricted: …`, an HTTP body),
 * from Estiva ID, from the builders' own checks (`content is N bytes, max M`),
 * from the network, or from the app itself. Whatever it was, a person reads
 * one plain reason for its cause, the same in Peek, Ship and Leaf, and never
 * the relay's words: those go to the console. The comment box and the cards
 * put the reason in their sentence ("Not sent: <reason>. Your text is back in
 * the box."), so a reason is lower case and ends with no full stop.
 *
 * An app with a cause of its own hands `{ cause }` rather than a sentence, so
 * its words are these too. A file's own words (`uploadRefusal`) are a whole
 * line on its card, and `tooLarge` stops a file over the relay's limit before
 * it uploads (Miky, 4 Nov: the server's limits, checked in every app first).
 */

/** Why something was refused, as far as a person needs to know. */
export type RefusalCause =
  | 'too-long'
  | 'gone'
  | 'no-access'
  | 'archived'
  | 'busy'
  | 'clock'
  | 'signed-out'
  | 'empty'
  | 'unknown'

/**
 * Each cause's reason, put in a sentence by the box or the card. `gone` is
 * what the relay says for an edit or a reaction on a message that was deleted
 * or that you can no longer write beside: it does not say which.
 */
export const REFUSAL_REASONS: Readonly<Record<RefusalCause, string>> = {
  'too-long': 'it is too long',
  gone: 'this message was deleted, or you can no longer write here',
  'no-access': 'you can no longer write here',
  archived: 'this team is archived',
  busy: 'too many at once, try again in a moment',
  clock: 'your computer’s clock is wrong; set it and try again',
  'signed-out': 'you are signed out; sign in again',
  empty: 'a message needs words or a file; Delete removes it',
  unknown: 'something went wrong, try again',
}

/** The text a refusal carries: a string, an `Error`'s message, or `{ error }` / `{ message }` / `{ reason }`, one JSON body deep. */
function textOf(reason: unknown): string {
  if (reason == null) return ''
  if (typeof reason === 'string') {
    const json = reason.trim()
    if (json.startsWith('{')) {
      try {
        return textOf(JSON.parse(json)) || reason
      } catch {
        return reason
      }
    }
    return reason
  }
  if (reason instanceof Error) return textOf(reason.message)
  if (typeof reason === 'object') {
    const r = reason as Record<string, unknown>
    for (const key of ['error', 'message', 'reason']) {
      const value = r[key]
      if (typeof value === 'string') return textOf(value)
      if (value && typeof value === 'object') return textOf(value)
    }
  }
  return String(reason)
}

const CAUSES = new Set<string>(Object.keys(REFUSAL_REASONS))

/*
  In order: the first that matches is the cause. Scope and identity before
  `restricted:`, which also prefixes "insufficient scope"; "archived" before
  the target rules, as an archived team's reaction is refused as not found.
*/
const RULES: readonly [RegExp, RefusalCause][] = [
  [/content (is \d+ bytes, max|exceeds maximum size)|too long/i, 'too-long'],
  [/rate-limited|quota|too many|too busy|relay is busy|admission|\b429\b|concurrency/i, 'busy'],
  [/timestamp too far|clock/i, 'clock'],
  [/auth-required|insufficient scope|does not match authenticated|signed out|sign in|\b401\b|token_rejected|session_expired/i, 'signed-out'],
  [/archived/i, 'archived'],
  [/target (event )?not found|not (editable|deletable) by you|was deleted|no longer on this page/i, 'gone'],
  [/^(restricted|blocked):|not a (channel |relay )?member|only members|no longer (post|write)|banned|timed out until|writes are fenced|\b403\b/i, 'no-access'],
]

/** What a refusal comes to; `{ cause }` is taken as it is. */
export function refusalCause(reason: unknown): RefusalCause {
  if (reason && typeof reason === 'object' && 'cause' in reason) {
    const cause = (reason as { cause: unknown }).cause
    if (typeof cause === 'string' && CAUSES.has(cause)) return cause as RefusalCause
  }
  const text = textOf(reason)
  for (const [rule, cause] of RULES) if (rule.test(text)) return cause
  return 'unknown'
}

/** The plain reason for any refusal, to say after "Not sent:", "Not saved:" or "Not reacted:". */
export function refusalReason(reason: unknown): string {
  return REFUSAL_REASONS[refusalCause(reason)]
}

/** Why a file did not upload, as far as a person needs to know. */
export type UploadCause = 'too-large' | 'type' | 'unreadable' | 'busy' | 'signed-out' | 'no-access' | 'unknown'

const MB = 1024 * 1024

/**
 * The relay's size limits (buzz `BUZZ_MAX_*_BYTES`, read back on production on
 * 4 Nov): a GIF 10 MB, another picture 50 MB, anything else 100 MB, since
 * Cloudflare refuses a larger body before the relay sees it (a video's 500 MB
 * is never reached).
 */
export const UPLOAD_LIMITS = { gif: 10 * MB, image: 50 * MB, other: 100 * MB } as const

/** The most a file of this type may be, in bytes. */
export function uploadLimit(type: string | undefined): number {
  const t = (type ?? '').toLowerCase()
  if (t === 'image/gif') return UPLOAD_LIMITS.gif
  if (t.startsWith('image/')) return UPLOAD_LIMITS.image
  return UPLOAD_LIMITS.other
}

const tooLargeLine = (bytes: number) => `Too large: the most is ${Math.round(bytes / MB)} MB`

/** The line for a file over its limit, said before it uploads; undefined when it fits. */
export function tooLarge(file: { size: number; type?: string }): string | undefined {
  const limit = uploadLimit(file.type)
  return file.size > limit ? tooLargeLine(limit) : undefined
}

const UPLOAD_LINES: Readonly<Record<Exclude<UploadCause, 'too-large'>, string>> = {
  type: 'This type of file can’t be added',
  unreadable: 'This file could not be read',
  busy: 'Too many at once, try again in a moment',
  'signed-out': 'Sign in again',
  'no-access': 'You can no longer add files here',
  unknown: 'Could not upload, try again',
}

/**
 * The line on a file's card when its upload was refused: from protocol's
 * `upload failed: <status> <body>`, any other error, or `{ cause }`. A 413
 * names the limit the relay gave, or the type's own when Cloudflare answered.
 */
export function uploadRefusal(reason: unknown, file?: { type?: string }): string {
  if (reason && typeof reason === 'object' && 'cause' in reason) {
    const cause = (reason as { cause: unknown }).cause
    if (cause === 'too-large') return tooLargeLine(uploadLimit(file?.type))
    if (typeof cause === 'string' && cause in UPLOAD_LINES) return UPLOAD_LINES[cause as keyof typeof UPLOAD_LINES]
  }
  const raw = reason instanceof Error ? reason.message : typeof reason === 'string' ? reason : textOf(reason)
  const status = Number(/upload failed:\s*(\d{3})/i.exec(raw)?.[1] ?? 0)
  const said = textOf(raw.replace(/^.*?upload failed:\s*\d{3}\s*/is, ''))
  if (status === 413 || /file too large/i.test(said)) {
    const max = Number(/max (\d+)\)?/i.exec(said)?.[1] ?? 0)
    if (/dimensions/i.test(said)) return UPLOAD_LINES.unreadable
    return tooLargeLine(max || uploadLimit(file?.type))
  }
  if (status === 415 || /content type|unsupported container/i.test(said)) return UPLOAD_LINES.type
  if (status === 422 || /metadata|invalid image|duration|resolution/i.test(said)) return UPLOAD_LINES.unreadable
  if (status === 429 || /rate limit|concurrency/i.test(said)) return UPLOAD_LINES.busy
  if (status === 401 || /authentication failed|signed out/i.test(said)) return UPLOAD_LINES['signed-out']
  if (status === 403) return UPLOAD_LINES['no-access']
  return UPLOAD_LINES.unknown
}

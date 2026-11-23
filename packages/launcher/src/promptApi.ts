/**
 * The browser's on-device Prompt API, wrapped (PEE-5, PEE-6).
 *
 * **Named for the API, not a vendor.** Nothing here detects a browser: the only
 * gate is `typeof globalThis.LanguageModel`, so any engine exposing the
 * interface gets prefill.
 *
 * ## What the two browsers actually did, 2026-09-02
 *
 * | | `LanguageModel` | `availability()` | `create()` |
 * | --- | --- | --- | --- |
 * | Chrome | `function` | `unavailable` | **works** — prefill confirmed by a person |
 * | Edge | `function` | `unavailable` | throws *"The feature flag gating model execution was disabled"* |
 *
 * Both **expose** the interface; only Chrome would **run** it. Edge's refusal is
 * a browser policy gate rather than anything a consumer can influence, and it
 * arrives as a `create()` throw — which `createSession` already treats as "this
 * browser does not get prefill". So Edge degrading to a plain form is PEE-6
 * behaving correctly, not a defect to chase.
 *
 * Worth knowing when judging output quality: the model differs by browser, so a
 * verdict on a suggestion is a verdict on *whichever model answered*, and should
 * say which. Chrome's is Gemini Nano; Edge ships its own.
 *
 * > **Miky, 2026-08-31** — *"Explore Prompt API as it could allow us cheaply
 * > prefill the form based on the context from the thread."*
 *
 * **On-device is the point, not a detail.** The model runs locally, whichever
 * one the browser ships. A work thread is
 * confidential, and posting one to a cloud model to save somebody typing would
 * be a disclosure. This is the only shape of the feature consistent with how
 * the rest of the suite treats a Folder nobody outside it can read.
 *
 * Nothing here is in `lib.dom` yet, so the surface is declared below — narrowly,
 * covering only what is used. A wider guess at an API this new would be a
 * fiction that typechecks.
 *
 * ## What it deliberately does not do
 *
 * **It never blocks on the download** (PEE-6). First use per origin fetches a
 * multi-gigabyte model; a form that waits for that is broken for the person
 * who just wanted to type a title. `availability()` is consulted first and
 * `'downloadable'` is treated as *not available now* — true, and it keeps the
 * caller from starting a download nobody asked for.
 *
 * **It does offer one, since INT-10.** Treating `'downloadable'` as
 * unavailable and never offering the fetch anywhere left a machine that could
 * run the model waiting on a page that would not ask — see `downloadModel`,
 * which is the one path here a person starts deliberately.
 */

/** What `LanguageModel.availability()` answers. */
export type ModelAvailability = 'unavailable' | 'downloadable' | 'downloading' | 'available'

/**
 * What `prefillAvailability` reports — the browser's four answers, plus the
 * case where it gives none at all.
 *
 * `'unanswered'` is deliberately not folded into `'unavailable'`. The two call
 * for opposite handling: `'unavailable'` is a browser that answered, and the
 * gate attempts a session anyway because Chrome says it while working. A
 * browser that never answers has demonstrated nothing except that awaiting it
 * is unsafe, and attempting a session on that basis is how a launcher ends up
 * showing a row that hangs.
 */
export type PrefillAvailability = ModelAvailability | 'unanswered'

/**
 * How long `availability()` may take before its answer is treated as absent.
 *
 * **Because it can never answer at all.** Measured in Edge 155 on 2026-09-10,
 * on the Peek origin, one call per line with its own deadline:
 *
 * | call | outcome |
 * | --- | --- |
 * | `LanguageModel.availability()`, and all six option spellings | **never settled** |
 * | `Summarizer` / `Writer` / `Rewriter` `.availability()` | **never settled** |
 * | `LanguageDetector.availability()` | `available`, in 0 ms |
 * | `Proofreader` | absent |
 *
 * So the on-device stack is alive and answering — the generative half simply
 * never replies. `prefillAvailability` awaited it with no deadline, so the
 * launcher's model state stayed unresolved for the life of the page: no Ask
 * row, no download offer, and nothing anywhere saying why.
 *
 * This is a change from Edge 154, which *answered* `'unavailable'` and threw
 * *"The feature flag gating model execution was disabled"* from `create()`. A
 * browser that refuses is something an app can reason about; one that never
 * replies is not, which is why the deadline is the fix rather than a guess at
 * what the answer would have been.
 *
 * That is the same failure `promptContextDiagnostic` already carries a limit
 * for, in a place nobody thought to look because this call is metadata rather
 * than generation and is supposed to return in milliseconds.
 *
 * Generous rather than tight: an answer arriving late still lands the rows,
 * since the launcher renders without it and updates when it resolves. This is
 * a floor under a hang, not a latency budget.
 */
export const AVAILABILITY_LIMIT_MS = 5_000

export interface LanguageModelSession {
  prompt: (input: string, options?: { responseConstraint?: object }) => Promise<string>
  /**
   * What an input would cost, without generating anything.
   *
   * Feature-detected rather than assumed: it is the cheap way to measure a
   * thread against `inputQuota` (INT-1), and a build without it has to spend a
   * real `prompt()` to learn the same number.
   */
  measureInputUsage?: (input: string) => Promise<number>
  /** Tokens this session may hold. */
  readonly inputQuota?: number
  /** Tokens used so far. */
  readonly inputUsage?: number
  destroy: () => void
}

/**
 * The download reporter `create()` hands to its `monitor` callback.
 *
 * **The two browsers disagree about what `loaded` means, so `total` decides.**
 *
 * Chrome sends a fraction from 0 to 1 and no `total` — measured in the console
 * on 2026-09-09, which is why the first version of this simply passed `loaded`
 * through. Edge documents the opposite: *"The event is an object with the
 * loaded and total properties"*, and its own sample computes
 * `(event.loaded / event.total) * 100`, so `loaded` there is a byte count.
 *
 * Passing Edge's byte count through as a fraction would have rendered
 * "428000000%" in the launcher row. Found by reading Edge's documentation
 * rather than by running it, since no browser here fires the event at all.
 *
 * @see https://learn.microsoft.com/en-us/microsoft-edge/web-platform/prompt-api
 */
export interface CreateMonitor {
  addEventListener: (
    type: 'downloadprogress',
    listener: (event: { loaded: number; total?: number }) => void,
  ) => void
}

/**
 * One `downloadprogress` event as a fraction from 0 to 1, whichever browser
 * sent it.
 *
 * A `total` of 0 is treated as no denominator rather than divided by, which
 * would be `Infinity` or `NaN` in a percentage somebody is reading.
 */
export function downloadFraction(event: { loaded: number; total?: number }): number {
  const fraction = event.total ? event.loaded / event.total : event.loaded
  // Neither browser is trusted to stay inside the range it documents.
  return Math.min(1, Math.max(0, fraction))
}

/** Session options some builds require rather than default. See `SESSION_OPTIONS`. */
export interface SamplingOptions {
  samplingMode?: 'most-predictable'
  temperature?: number
  topK?: number
  outputLanguage?: string
  expectedOutputs?: { type: string; languages: string[] }[]
}

/**
 * The language the suggestion comes back in.
 *
 * **Both browsers asked for one, and Edge named the set.** Measured 2026-09-02:
 *
 * > *No output language was specified in a LanguageModel API request. An output
 * > language should be specified to ensure optimal output quality and properly
 * > attest to output safety. Please specify a supported output language code:*
 * > `[de, en, es, fr, ja]` *(Edge 154)* — Chrome said `[*]`.
 *
 * **Hardcoding this is a decision, not a detail.** It suits a workspace that
 * writes English, and it is wrong for a conversation held in another language:
 * the thread would be read in Czech and the issue drafted in English. Reading
 * it off the conversation is the better answer and needs a way to know, which
 * nothing here has yet. Stated rather than buried so the next person can find
 * the seam.
 */
export const OUTPUT_LANGUAGE = 'en'

interface LanguageModelStatic {
  availability: (options?: SamplingOptions) => Promise<ModelAvailability>
  create: (
    options?: SamplingOptions & {
      initialPrompts?: { role: string; content: string }[]
      /**
       * Called synchronously with the reporter, before the download starts.
       * Attaching the listener later misses the events, which is why this is a
       * callback rather than something on the returned session.
       */
      monitor?: (m: CreateMonitor) => void
    },
  ) => Promise<LanguageModelSession>
}

declare global {
  var LanguageModel: LanguageModelStatic | undefined
}

/**
 * The sampling configurations to try, in order.
 *
 * **Chrome refuses a session with no sampling options at all**, measured in the
 * browser on 2026-09-02 — `create()` threw:
 *
 * > *The sampling options are incompatible with speculative decoding (MTP).
 * > Prompt API sessions must specify compatible sampling options, i.e.
 * > `samplingMode:'most-predictable'` or `topK:1` or `temperature:0`.*
 *
 * This code passed none, so every `create()` threw, `promptForObject` caught it
 * and returned null, and prefill silently never ran. Nothing failed visibly —
 * which is exactly what PEE-6 makes it look like on a machine with no model, so
 * the bug was indistinguishable from working correctly.
 *
 * `{temperature: 0, topK: 1}` was *also* refused in the same measurement, so
 * the list is ordered by what the browser itself named first and falls back
 * rather than guessing which build wants which. A browser that accepts none of
 * them gets no prefill, which is the honest outcome.
 *
 * **Determinism is right here regardless of the error.** The output is
 * constrained to a schema and drops straight into a form somebody is about to
 * publish from; sampling creatively over a colleague's conversation is not a
 * feature. `most-predictable` is what this would have asked for had the API
 * made it a choice from the start.
 */
export const SESSION_OPTIONS: SamplingOptions[] = [
  { samplingMode: 'most-predictable', outputLanguage: OUTPUT_LANGUAGE },
  { samplingMode: 'most-predictable', expectedOutputs: [{ type: 'text', languages: [OUTPUT_LANGUAGE] }] },
  { samplingMode: 'most-predictable' },
  { temperature: 0, topK: 1, outputLanguage: OUTPUT_LANGUAGE },
  { temperature: 0, topK: 1 },
  { topK: 1 },
]


/**
 * Whether this browser has the Prompt API at all. Firefox, Safari and a phone
 * have none, and no session will ever start there — unlike a Chrome that
 * answers `'unavailable'` and then creates one (see `canPrefill`). The launcher
 * asks this before a person's Enter is spent on an attempt that cannot work.
 */
export function hasPromptApi(): boolean {
  return typeof globalThis.LanguageModel !== 'undefined'
}

/**
 * Whether prefill can run **right now**, without downloading anything.
 *
 * `'downloadable'` is reported as unavailable on purpose. It is honest — the
 * model is not there — and it is what stops Peek starting a 22 GB fetch
 * because somebody opened a form. A person who wants the model gets it by
 * using a browser feature that offers it, not as a side effect of filing an
 * issue.
 *
 * Returns `'unavailable'` rather than throwing anywhere the API is absent —
 * most browsers, every phone, and importantly jsdom, so tests and Storybook
 * take the no-model path without stubbing anything.
 *
 * Note this answer is a hint rather than a verdict: see `canPrefill`, where
 * a browser reporting `'unavailable'` was measured creating working sessions.
 */
export async function prefillAvailability(): Promise<PrefillAvailability> {
  const model = globalThis.LanguageModel
  if (typeof model === 'undefined') return 'unavailable'
  /*
    **Asked with the options a session would actually use.** A bare
    `availability()` made Chrome log two complaints on every launcher open,
    observed in production 2026-09-02:

    > *The sampling options are incompatible with speculative decoding (MTP)…*
    > *No output language was specified in a LanguageModel API request…*

    Both are true of a call carrying no options, and both were mine. Beyond the
    noise it was the wrong question: asking whether a model is available *in
    general* is not asking whether it is available for the session this code
    goes on to create, and only the second is actionable.

    A build that rejects options on `availability` falls back to the bare call,
    since an answer with a warning beats no answer.
  */
  /*
    Both spellings are raced against a deadline, not just awaited. A promise
    that never settles is not caught by `catch`, and this one does not settle
    in Edge 155 — see `AVAILABILITY_LIMIT_MS`. Without the race the fallback
    below is unreachable too, since the first await never returns to try it.
  */
  const answer = await withDeadline(() => model.availability(SESSION_OPTIONS[0]))
  if (answer.kind === 'value') return answer.value
  /*
    **A timeout does not fall back; a throw does.**

    The fallback exists for a build that *rejects* options — an answer with a
    warning beats no answer. A build that never answers is a different thing,
    and measurement says the second call is no better: in Edge 155 on
    2026-09-10 all six option spellings AND the bare call never settled, as did
    Summarizer, Writer and Rewriter. So falling through on a timeout buys
    nothing and costs another whole deadline in the one browser known to need
    it — ten seconds of a launcher with no model rows and no explanation.
  */
  if (answer.kind === 'timeout') return 'unanswered'
  const bare = await withDeadline(() => model.availability())
  if (bare.kind === 'value') return bare.value
  /*
    A throw is the API refusing to answer — indistinguishable, for our
    purposes, from not having it, which is what this has always reported. A
    hang is not that: the browser has told us nothing, including nothing about
    whether a session would work, and calling that `'unavailable'` would send
    the caller down the attempt-anyway path on no evidence at all.
  */
  return bare.kind === 'timeout' ? 'unanswered' : 'unavailable'
}

/** How one bounded `availability()` attempt ended. */
type Attempt = { kind: 'value'; value: ModelAvailability } | { kind: 'threw' } | { kind: 'timeout' }

/**
 * One `availability()` attempt, bounded.
 *
 * **Keeps 'threw' and 'timeout' apart rather than collapsing them**, because
 * the caller treats them differently and folding them lost the distinction
 * this whole change exists to draw. A throw is an answer of a kind; a promise
 * that never settles is not.
 *
 * The timer is cleared on the winning path rather than left to fire, since the
 * launcher opens one of these per open.
 */
async function withDeadline(attempt: () => Promise<ModelAvailability>): Promise<Attempt> {
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    return await Promise.race([
      Promise.resolve()
        .then(attempt)
        .then((value): Attempt => ({ kind: 'value', value }))
        .catch((): Attempt => ({ kind: 'threw' })),
      new Promise<Attempt>((resolve) => {
        timer = setTimeout(() => resolve({ kind: 'timeout' }), AVAILABILITY_LIMIT_MS)
      }),
    ])
  } finally {
    clearTimeout(timer)
  }
}

/**
 * Whether to attempt a session at all.
 *
 * **Not `availability() === 'available'`, which was too strict.** Measured in
 * Chrome on 2026-09-02: `availability()` answered `'unavailable'` while
 * `create()` on the same page succeeded and produced a working session. Gating
 * on `'available'` meant prefill never even tried on a machine that could run
 * it — the exact machine this feature was written for.
 *
 * So the gate is inverted: it refuses only the two answers that mean *touching
 * this starts a download* — the 22 GB fetch nobody asked for, which is the one
 * thing PEE-6 forbids. `'unavailable'` is attempted, because this browser
 * demonstrated that answer is not the last word, and a refusal costs one fast
 * throw that `promptForObject` already swallows.
 */
export async function canPrefill(): Promise<boolean> {
  const availability = await prefillAvailability()
  /*
    Named positively since INT-10. The old spelling refused two answers and
    admitted everything else, so `'unanswered'` — added later — would have been
    admitted by default, and a browser that will not answer would have been
    treated as one that answered encouragingly. A list of what passes cannot
    acquire a new member by accident.
  */
  return availability === 'available' || availability === 'unavailable'
}

/**
 * Ask the model for one object matching `schema`.
 *
 * The schema is the **constraint** where the browser allows it: the API takes a
 * JSON Schema as `responseConstraint` and holds the output to it. Where it does
 * not — see the MTP refusal below — the same schema becomes an instruction. That is the whole
 * reason this feature is cheap — see `formSchema`, which builds the schema from
 * the same declaration that drew the form, so an app nobody here wrote gets
 * prefill on the day it publishes a manifest.
 *
 * Returns null rather than throwing on anything at all. Prefill is an
 * enhancement; a person is looking at a working form either way, and a
 * rejected promise here would turn a nicety into an error they have to read.
 */
export async function promptForObject(
  instruction: string,
  schema: object,
): Promise<Record<string, unknown> | null> {
  if (typeof globalThis.LanguageModel === 'undefined') return null
  let session: LanguageModelSession | null = null
  try {
    const created = await createSession(globalThis.LanguageModel)
    if (!created) return null
    session = created.session
    /*
      The constrained path first, because where it works the schema does the
      work and nothing can come back malformed.

      **It is refused outright on some builds.** Measured in Chrome on
      2026-09-02: `prompt(…, {responseConstraint})` threw *"Constrained
      decoding (responseConstraint) cannot be used with speculative decoding
      (MTP)"* — while the very same build REQUIRES sampling options because MTP
      is on. The two demands are mutually exclusive there, so PEE-5's premise
      that the declaration can always be the constraint does not hold, and a
      consumer that only knows the constrained path gets nothing at all.
    */
    try {
      /*
        Strict here on purpose. Constrained decoding should make a non-object
        impossible, so one means the constraint was NOT applied — and being
        lenient about that would hide a real problem behind values invented for
        a form somebody is about to publish from.
      */
      return strictParse(await session.prompt(instruction, { responseConstraint: schema }))
    } catch {
      /*
        Ask in words instead, and parse leniently. Strictly worse — the model
        may return prose, fences or an extra sentence — which is why it is the
        fallback and not the path. `looseParse` treats anything unusable as no
        answer, so the failure mode stays "no prefill" rather than junk in a
        form somebody is about to publish from.
      */
      return looseParse(await session.prompt(`${instruction}\n\n${jsonHint(schema)}`))
    }
  } catch {
    return null
  } finally {
    // Sessions hold the model's context. Not destroying one leaks it for the
    // life of the page, and the launcher opens a form per capture.
    session?.destroy()
  }
}

/**
 * A session, trying each sampling configuration until one is accepted.
 *
 * Returns null rather than throwing when every one is refused — the caller
 * treats that as "no prefill", which is the same outcome as no model at all.
 *
 * **Deliberately unbounded, unlike `prefillAvailability`.** `downloadModel`
 * goes through here, and a real fetch legitimately takes many minutes; a
 * deadline that made the gate safe would abandon downloads. A `create()` that
 * hangs on a browser with the model already present therefore still hangs the
 * caller — see INT-11, where telling that browser apart is the whole question.
 */
export async function createSession(
  model: LanguageModelStatic = globalThis.LanguageModel as LanguageModelStatic,
  monitor?: (m: CreateMonitor) => void,
): Promise<{ session: LanguageModelSession; options: SamplingOptions } | null> {
  if (!model) return null
  for (const options of SESSION_OPTIONS) {
    try {
      return { session: await model.create(monitor ? { ...options, monitor } : options), options }
    } catch {
      // Refused for these options. Try the next spelling; a browser that
      // refuses all of them simply does not get prefill.
    }
  }
  return null
}

/**
 * Fetch the model, because somebody asked for it (INT-10).
 *
 * ## The deadlock this breaks
 *
 * `canPrefill` refuses `'downloadable'`, so Peek never calls `create()` on a
 * machine that has not fetched the model. The browser, for its part, downloads
 * only when a page calls `create()`. Neither side moves, and the person sees a
 * launcher with no Ask row and no reason given — for ever. Reported by Miky on
 * 2026-09-09 after getting the model only by pasting `create()` into the
 * console himself.
 *
 * **This does not weaken PEE-6.** That ticket forbids a multi-gigabyte fetch
 * starting as a *side effect* — of opening a form, of opening the launcher, of
 * anything a person did for another reason. It never forbade a person asking
 * for the model on purpose. So this is exported and called from exactly one
 * place: a row that says what it will do, which somebody has to select. It is
 * deliberately not wired into `canPrefill`, `promptForObject` or
 * `promptForText`, and a review that adds it there is reintroducing the fetch
 * PEE-6 is about.
 *
 * Resolves true once a session was created — which is to say the model is on
 * the machine and usable — and false where every sampling spelling was
 * refused. Edge 154 answers false immediately without downloading anything,
 * because its refusal is a policy gate rather than a missing file, so
 * `create()` throws before any fetch begins.
 *
 * The session is destroyed on the way out. The download is the point and it
 * outlives it, in the browser's own store, shared by every origin; holding a
 * session open afterwards would just leak the model's context.
 */
export async function downloadModel(onProgress?: (fraction: number) => void): Promise<boolean> {
  const model = globalThis.LanguageModel
  if (typeof model === 'undefined') return false
  const monitor = (m: CreateMonitor) => {
    try {
      m.addEventListener('downloadprogress', (event) => onProgress?.(downloadFraction(event)))
    } catch {
      // A build with no monitor support still downloads; it just does it
      // silently. Losing the progress readout is not a reason to lose the
      // model, so this is swallowed rather than failing the create.
    }
  }
  const created = await createSession(model, monitor)
  if (created) {
    created.session.destroy()
    return true
  }
  /*
    **Then bare, which is the only shape Edge documents.**

    Every sample on Edge's Prompt API page calls `LanguageModel.create()` with
    no options at all; `monitor`, `initialPrompts` and `signal` are the only
    ones it names. `samplingMode`, `outputLanguage`, `expectedOutputs`, `topK`
    and `temperature` — the whole of `SESSION_OPTIONS` — are Chrome's
    vocabulary, and a build that rejects them refuses every rung of the ladder.

    **This is allowed here and nowhere else**, and the reason is worth keeping
    straight: `SESSION_OPTIONS` never contains a bare `{}` on purpose, because
    a session created with default sampling would sample creatively over a
    colleague's conversation and drop the result in a form somebody publishes
    from. Nothing is generated here. This function opens a session so the
    browser fetches the model, destroys it on the next line, and never prompts
    it — so the sampling it would have used does not exist.

    It cannot rescue a browser that *hangs* rather than refuses, since the
    ladder above only advances on a throw. Edge 155 hangs, so this will not fix
    it; it is right for a browser that says no.

    @see https://learn.microsoft.com/en-us/microsoft-edge/web-platform/prompt-api
  */
  try {
    const session = await model.create({ monitor })
    session.destroy()
    return true
  } catch {
    return false
  }
}

/**
 * The instruction that replaces a schema the browser will not honour.
 *
 * Built from the same schema, so the fields asked for cannot drift from the
 * fields drawn — which is the property that made the constrained path worth
 * having, kept as far as words can keep it.
 */
export function jsonHint(schema: object): string {
  const properties = (schema as { properties?: Record<string, unknown> }).properties ?? {}
  const keys = Object.keys(properties)
  return [
    `Reply with only a JSON object, no prose and no code fence.`,
    `It must have exactly these keys, each a string: ${keys.join(', ')}.`,
    `Use "" for a field the conversation does not answer.`,
  ].join(' ')
}

/**
 * The constrained answer, taken at face value or not at all.
 *
 * Catches its own parse error rather than throwing, so a mangled *constrained*
 * reply does not fall through to the unconstrained retry: the constraint was
 * honoured and produced junk, which is a different problem from the browser
 * refusing constraints, and retrying would paper over it.
 */
export function strictParse(answer: string): Record<string, unknown> | null {
  try {
    const parsed: unknown = JSON.parse(answer)
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return null
    return parsed as Record<string, unknown>
  } catch {
    return null
  }
}

/**
 * A JSON object out of whatever came back.
 *
 * Only for the unconstrained fallback, where the reply may carry a fence, a
 * leading sentence, or both. It takes the text between the first `{` and the
 * last `}`, which means a lone object wrapped in an array is unwrapped — a
 * model doing that has still answered, and `usablePrefill` filters the keys
 * either way. Several objects in an array do not survive it, which is correct:
 * that is a different answer, not a wrapped one.
 *
 * Returns null rather than throwing, so a mangled answer is indistinguishable
 * from no model: no prefill, no error to read.
 */
export function looseParse(answer: string | null): Record<string, unknown> | null {
  if (!answer) return null
  const start = answer.indexOf('{')
  const end = answer.lastIndexOf('}')
  if (start < 0 || end <= start) return null
  try {
    const parsed: unknown = JSON.parse(answer.slice(start, end + 1))
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return null
    return parsed as Record<string, unknown>
  } catch {
    return null
  }
}

/**
 * Ask for prose rather than an object (INT-4).
 *
 * `promptForObject` exists because a form needs named fields. A draft is one
 * piece of writing, so there is nothing to constrain and nothing to parse —
 * which also sidesteps the MTP refusal entirely, since no `responseConstraint`
 * is involved.
 *
 * Returns null rather than throwing on anything, like everything else here: a
 * draft that did not arrive is the same to the caller as a browser that cannot
 * write one.
 */
export async function promptForText(instruction: string): Promise<string | null> {
  if (typeof globalThis.LanguageModel === 'undefined') return null
  let session: LanguageModelSession | null = null
  try {
    const created = await createSession(globalThis.LanguageModel)
    if (!created) return null
    session = created.session
    const answer = (await session.prompt(instruction)).trim()
    return answer || null
  } catch {
    return null
  } finally {
    session?.destroy()
  }
}

/**
 * What the launcher asks of a model (KIN-4): whether one is there, fetching
 * it, an answer in words and a form's values as an object.
 *
 * The app hands the launcher one of these, so what answers is the app's to
 * say. Today every app passes {@link onDeviceModel}.
 */
export interface LauncherModel {
  hasPromptApi: () => boolean
  prefillAvailability: () => Promise<PrefillAvailability>
  canPrefill: () => Promise<boolean>
  downloadModel: (onProgress?: (fraction: number) => void) => Promise<boolean>
  promptForText: (instruction: string) => Promise<string | null>
  promptForObject: (instruction: string, schema: object) => Promise<Record<string, unknown> | null>
}

/** The browser's on-device model (Chrome's and Edge's Prompt API). Nothing leaves the device. */
export const onDeviceModel: LauncherModel = { hasPromptApi, prefillAvailability, canPrefill, downloadModel, promptForText, promptForObject }

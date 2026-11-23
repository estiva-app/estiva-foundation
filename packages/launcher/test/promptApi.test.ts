/**
 * PEE-6 — the gate, and the download that must never start by accident.
 *
 * The population that gets prefill is: recent desktop Chrome, with 22 GB free
 * and either >4 GB VRAM or 16 GB RAM, **after a download has completed**.
 * Everyone else gets the form. So the interesting assertions here are the
 * negative ones — what this does *not* do on the machines that cannot run it.
 */
import { afterEach, describe, expect, it, vi } from 'vitest'
import { AVAILABILITY_LIMIT_MS, SESSION_OPTIONS, canPrefill, downloadFraction, downloadModel, jsonHint, looseParse, prefillAvailability, promptForObject, promptForText } from '../src/promptApi.js'

type Stub = {
  availability: () => Promise<string>
  create: () => Promise<{ prompt: () => Promise<string>; destroy: () => void }>
}

function stubModel(stub: Partial<Stub>) {
  ;(globalThis as unknown as { LanguageModel?: unknown }).LanguageModel = stub
}

afterEach(() => {
  delete (globalThis as unknown as { LanguageModel?: unknown }).LanguageModel
})

describe('prefillAvailability', () => {
  it('is unavailable where the API does not exist', async () => {
    /*
      Every browser but recent desktop Chrome — and jsdom, which is why the
      whole suite and Storybook take the no-model path without stubbing
      anything. That is the default this feature is built around, not an edge.
    */
    expect(await prefillAvailability()).toBe('unavailable')
  })

  it('reports what the API says when it exists', async () => {
    stubModel({ availability: async () => 'available' })
    expect(await prefillAvailability()).toBe('available')
  })

  it('does not throw when the API refuses to answer', async () => {
    stubModel({
      availability: () => {
        throw new Error('nope')
      },
    })
    expect(await prefillAvailability()).toBe('unavailable')
  })
})

describe('canPrefill — the gate, loosened on measurement', () => {
  it('is true for a model already on the machine', async () => {
    stubModel({ availability: async () => 'available' })
    expect(await canPrefill()).toBe(true)
  })

  it('is FALSE for "downloadable", so opening a form never starts a 22 GB fetch', async () => {
    /*
      The one thing PEE-6 forbids. A person who wants the model gets it from a
      browser affordance that says so, not as a side effect of filing an issue.
    */
    stubModel({ availability: async () => 'downloadable' })
    expect(await canPrefill()).toBe(false)
  })

  it('is false while a download is already in flight', async () => {
    stubModel({ availability: async () => 'downloading' })
    expect(await canPrefill()).toBe(false)
  })

  it('ATTEMPTS anyway on "unavailable", because that answer proved not to be final', async () => {
    /*
      Measured in Chrome on 2026-09-02: `availability()` answered
      'unavailable' while `create()` on the same page succeeded and produced a
      working session. Gating on === 'available' meant prefill never tried on
      exactly the machine it was written for. A refusal costs one fast throw
      that `promptForObject` already swallows; a wrong refusal costs the
      feature.
    */
    stubModel({ availability: async () => 'unavailable' })
    expect(await canPrefill()).toBe(true)
  })

  it('attempts where the API is absent too, and the prompt path returns null', async () => {
    // No stub at all. Cheap, and it keeps the decision in one place.
    expect(await canPrefill()).toBe(true)
    expect(await promptForObject('go', { type: 'object', properties: {} })).toBeNull()
  })
})

describe('promptForObject', () => {
  const schema = { type: 'object', properties: { title: { type: 'string' } } }

  it('returns the parsed object and passes the schema as the constraint', async () => {
    const prompt = vi.fn(async () => JSON.stringify({ title: 'Build is broken' }))
    const destroy = vi.fn()
    stubModel({ availability: async () => 'available', create: async () => ({ prompt, destroy }) })

    expect(await promptForObject('go', schema)).toEqual({ title: 'Build is broken' })
    expect(prompt).toHaveBeenCalledWith('go', { responseConstraint: schema })
  })

  it('destroys the session, which holds the model context', async () => {
    // The launcher opens a form per capture; a leaked session per form holds
    // context for the life of the page.
    const destroy = vi.fn()
    stubModel({
      availability: async () => 'available',
      create: async () => ({ prompt: async () => '{"title":"x"}', destroy }),
    })
    await promptForObject('go', schema)
    expect(destroy).toHaveBeenCalled()
  })

  it('destroys the session even when the prompt throws', async () => {
    const destroy = vi.fn()
    stubModel({
      availability: async () => 'available',
      create: async () => ({
        prompt: async () => {
          throw new Error('context overflow')
        },
        destroy,
      }),
    })
    expect(await promptForObject('go', schema)).toBeNull()
    expect(destroy).toHaveBeenCalled()
  })

  it('returns null rather than throwing where there is no API', async () => {
    // Prefill is an enhancement. A rejected promise here would turn a nicety
    // into an error somebody has to read.
    expect(await promptForObject('go', schema)).toBeNull()
  })

  it('returns null for unparseable output', async () => {
    stubModel({
      availability: async () => 'available',
      create: async () => ({ prompt: async () => 'not json at all', destroy: () => {} }),
    })
    expect(await promptForObject('go', schema)).toBeNull()
  })

  it('returns null for an array on the CONSTRAINED path, which means the constraint was not applied', async () => {
    /*
      Strict here, deliberately: the constraint was honoured and produced the
      wrong shape, which is a different problem from a browser that refuses
      constraints, and guessing would put invented values in a form somebody is
      about to publish from. The unconstrained fallback is the lenient one.
    */
    stubModel({
      availability: async () => 'available',
      create: async () => ({ prompt: async () => '[{"title":"x"}]', destroy: () => {} }),
    })
    expect(await promptForObject('go', schema)).toBeNull()
  })
})

/**
 * The bug these guard, measured in Chrome on 2026-09-02.
 *
 * `create()` was called with **no options at all** and the browser threw:
 *
 * > *The sampling options are incompatible with speculative decoding (MTP).
 * > Prompt API sessions must specify compatible sampling options, i.e.
 * > `samplingMode:'most-predictable'` or `topK:1` or `temperature:0`.*
 *
 * `promptForObject` caught it and returned null, so prefill silently never ran
 * — indistinguishable from the no-model case PEE-6 deliberately makes silent.
 * The old tests passed throughout, because their stub accepted any `create()`.
 * These assert the argument, which is the thing that was wrong.
 */
describe('sampling options are required, not optional (measured in Chrome)', () => {
  const schema = { type: 'object', properties: { title: { type: 'string' } } }
  const CHROME_REFUSAL =
    'The sampling options are incompatible with speculative decoding (MTP). ' +
    "Prompt API sessions must specify compatible sampling options, i.e. `samplingMode:'most-predictable'`" +
    ' or `topK:1` or `temperature:0`.'

  it('never asks for a session without them', async () => {
    /*
      Typed with `vi.fn<T>`, not `async () => …`: a zero-parameter mock gives
      `mock.calls` the tuple type `[]`, so reading `calls[0][0]` is a type
      error vitest never sees — it strips types. `npm run build` catches it,
      which is exactly what happened here. `CommandLauncher.live.test.tsx`
      documents the same trap.
    */
    const create = vi.fn<(options?: unknown) => Promise<{ prompt: () => Promise<string>; destroy: () => void }>>(
      async () => ({ prompt: async () => '{"title":"x"}', destroy: () => {} }),
    )
    stubModel({ availability: async () => 'available', create: create as unknown as Stub['create'] })

    await promptForObject('go', schema)
    expect(create).toHaveBeenCalled()
    const passed = create.mock.calls[0]?.[0] as Record<string, unknown> | undefined
    expect(passed).toBeDefined()
    // Whichever spelling is first, it must be one the browser named.
    expect(Object.keys(passed ?? {}).length).toBeGreaterThan(0)
    expect(passed).toEqual(SESSION_OPTIONS[0])
  })

  it('asks for the most predictable output, because it fills a form to be published', async () => {
    // Sampling creatively over a colleague's conversation is not a feature.
    expect(SESSION_OPTIONS[0].samplingMode).toBe('most-predictable')
    // Every fallback keeps determinism one way or another; none samples freely.
    for (const options of SESSION_OPTIONS) {
      const deterministic =
        options.samplingMode === 'most-predictable' || options.topK === 1 || options.temperature === 0
      expect(deterministic).toBe(true)
    }
  })

  it('falls back when a build refuses the first spelling', async () => {
    /*
      `{temperature: 0, topK: 1}` was refused in the same measurement that
      refused no-options, so the list is tried in order rather than assumed.
    */
    const create = vi.fn(async (options: unknown) => {
      if (JSON.stringify(options) === JSON.stringify(SESSION_OPTIONS[0])) throw new Error(CHROME_REFUSAL)
      return { prompt: async () => '{"title":"x"}', destroy: () => {} }
    })
    stubModel({ availability: async () => 'available', create: create as unknown as Stub['create'] })

    expect(await promptForObject('go', schema)).toEqual({ title: 'x' })
    expect(create).toHaveBeenCalledTimes(2)
    expect(create.mock.calls[1]?.[0]).toEqual(SESSION_OPTIONS[1])
  })

  it('gives up quietly when every spelling is refused', async () => {
    // A browser that accepts none simply gets no prefill — the same outcome as
    // no model, and never an error a person has to read.
    const create = vi.fn<(options?: unknown) => Promise<never>>(async () => {
      throw new Error(CHROME_REFUSAL)
    })
    stubModel({ availability: async () => 'available', create: create as unknown as Stub['create'] })

    expect(await promptForObject('go', schema)).toBeNull()
    expect(create).toHaveBeenCalledTimes(SESSION_OPTIONS.length)
  })
})

/**
 * The MTP finding, measured in Chrome on 2026-09-02.
 *
 * The same build that REQUIRES sampling options because speculative decoding
 * is on also REFUSES `responseConstraint` for the same reason:
 *
 * > *Failed to execute 'prompt' on 'LanguageModel': Constrained decoding
 * > (responseConstraint) cannot be used with speculative decoding (MTP).*
 *
 * So PEE-5's premise — that a manifest's declaration can always be the
 * constraint — is false on that build, and a consumer that knows only the
 * constrained path gets nothing.
 */
describe('falling back when the browser refuses constrained decoding', () => {
  const schema = { type: 'object', properties: { title: { type: 'string' }, description: { type: 'string' } } }
  const MTP_REFUSAL =
    "Failed to execute 'prompt' on 'LanguageModel': Constrained decoding (responseConstraint) cannot be used with speculative decoding (MTP)."

  /** Refuses any constrained prompt, answers an unconstrained one. */
  function mtpModel(reply: string) {
    const prompt = vi.fn(async (_input: string, options?: { responseConstraint?: object }) => {
      if (options?.responseConstraint) throw new Error(MTP_REFUSAL)
      return reply
    })
    stubModel({
      availability: async () => 'available',
      create: async () => ({ prompt, destroy: () => {} }),
    } as unknown as Partial<Stub>)
    return prompt
  }

  it('asks again in words and still returns the object', async () => {
    const prompt = mtpModel('{"title":"Build is broken","description":"since the interop bump"}')
    expect(await promptForObject('go', schema)).toEqual({
      title: 'Build is broken',
      description: 'since the interop bump',
    })
    expect(prompt).toHaveBeenCalledTimes(2)
    // The retry carries no constraint, and names the same fields in words.
    expect(prompt.mock.calls[1]?.[1]).toBeUndefined()
    expect(prompt.mock.calls[1]?.[0]).toContain('title, description')
  })

  it('survives a code fence, which is what an unconstrained model does', async () => {
    mtpModel('```json\n{"title":"Build is broken"}\n```')
    expect(await promptForObject('go', schema)).toEqual({ title: 'Build is broken' })
  })

  it('survives a leading sentence', async () => {
    mtpModel('Sure! Here is the object: {"title":"Build is broken"} Hope that helps.')
    expect(await promptForObject('go', schema)).toEqual({ title: 'Build is broken' })
  })

  it('returns null for prose with no object, rather than inventing one', async () => {
    mtpModel('The team seems to be discussing a broken build.')
    expect(await promptForObject('go', schema)).toBeNull()
  })

  it('tries the constrained path FIRST, so a capable browser is never degraded', async () => {
    const prompt = vi.fn(async () => '{"title":"x"}')
    stubModel({ availability: async () => 'available', create: async () => ({ prompt, destroy: () => {} }) } as unknown as Partial<Stub>)
    await promptForObject('go', schema)
    expect(prompt).toHaveBeenCalledTimes(1)
    expect((prompt.mock.calls[0] as unknown[])[1]).toEqual({ responseConstraint: schema })
  })
})

describe('looseParse and jsonHint', () => {
  it('names exactly the schema keys, so asked-for cannot drift from drawn', () => {
    expect(jsonHint({ type: 'object', properties: { title: {}, description: {} } })).toContain('title, description')
  })

  it('unwraps a lone object an unconstrained model put in an array', () => {
    // It has still answered. `usablePrefill` filters the keys either way.
    expect(looseParse('[{"title":"x"}]')).toEqual({ title: 'x' })
  })

  it('refuses several objects, which is a different answer rather than a wrapped one', () => {
    expect(looseParse('[{"title":"a"},{"title":"b"}]')).toBeNull()
  })

  it('refuses nothing at all', () => {
    expect(looseParse(null)).toBeNull()
    expect(looseParse('')).toBeNull()
  })
})

/**
 * Two complaints Chrome logged on every launcher open, observed in production
 * on 2026-09-02:
 *
 * > *The sampling options are incompatible with speculative decoding (MTP)…*
 * > *No output language was specified in a LanguageModel API request…*
 *
 * Both were true of a bare `availability()`, and both were ours. The existing
 * tests passed throughout because their stubs ignore arguments — the same
 * blind spot that hid the `create()` bug. These assert the argument.
 */
describe('availability is asked with the options a session would use', () => {
  it('passes them, rather than asking a question it will not act on', async () => {
    const availability = vi.fn<(options?: unknown) => Promise<string>>(async () => 'available')
    stubModel({ availability: availability as unknown as Stub['availability'] })

    await prefillAvailability()
    expect(availability).toHaveBeenCalledWith(SESSION_OPTIONS[0])
  })

  it('falls back to the bare call on a build that rejects options', async () => {
    // An answer with a warning beats no answer.
    const availability = vi.fn<(options?: unknown) => Promise<string>>(async (options) => {
      if (options) throw new TypeError('availability takes no arguments')
      return 'available'
    })
    stubModel({ availability: availability as unknown as Stub['availability'] })

    expect(await prefillAvailability()).toBe('available')
    expect(availability).toHaveBeenCalledTimes(2)
    expect(availability.mock.calls[1]?.[0]).toBeUndefined()
  })

  it('is unavailable when both spellings throw', async () => {
    const availability = vi.fn<(options?: unknown) => Promise<string>>(async () => {
      throw new Error('no')
    })
    stubModel({ availability: availability as unknown as Stub['availability'] })

    expect(await prefillAvailability()).toBe('unavailable')
  })
})

describe('promptForText — prose, deliberately unconstrained (INT-4)', () => {
  it('returns nothing where the API does not exist', async () => {
    // Every browser but recent desktop Chrome. The caller draws no draft
    // surface at all in that case; it must not throw on the way to saying so.
    expect(await promptForText('write a reply')).toBeNull()
  })

  it('returns the answer, trimmed', async () => {
    stubModel({
      availability: async () => 'available',
      create: async () => ({ prompt: async () => '  Sounds good — I can pick it up tomorrow.\n', destroy: () => {} }),
    })
    expect(await promptForText('write a reply')).toBe('Sounds good — I can pick it up tomorrow.')
  })

  it('treats a blank answer as no answer', async () => {
    // An empty string would render as a draft panel with a button that inserts
    // nothing. `null` is the state the caller already draws honestly.
    stubModel({
      availability: async () => 'available',
      create: async () => ({ prompt: async () => '   \n  ', destroy: () => {} }),
    })
    expect(await promptForText('write a reply')).toBeNull()
  })

  it('never passes a responseConstraint', async () => {
    /*
      The measured reason this function exists. Chrome refuses constrained
      decoding outright under multi-token prediction — `promptForObject` carries
      a whole fallback ladder for it — and a reply is prose, so there is nothing
      to constrain. Asserting on the *arguments*, because three bugs in this
      subsystem got through tests that only asserted a call happened.
    */
    const prompt = vi.fn(async () => 'a reply')
    stubModel({ availability: async () => 'available', create: async () => ({ prompt, destroy: () => {} }) })

    await promptForText('write a reply')
    expect(prompt).toHaveBeenCalledWith('write a reply')
    expect(prompt.mock.calls[0]).toHaveLength(1)
  })

  it('still asks for a session with sampling options', async () => {
    // Chrome refuses `create()` with no sampling options under MTP. This path
    // goes through the same ladder rather than around it.
    const create = vi.fn(async () => ({ prompt: async () => 'a reply', destroy: () => {} }))
    stubModel({ availability: async () => 'available', create })

    await promptForText('write a reply')
    expect(create).toHaveBeenCalledWith(SESSION_OPTIONS[0])
  })

  it('destroys the session even when the model throws mid-answer', async () => {
    // A leaked session holds the model resident. The failure is silent, which
    // is why it is asserted rather than reasoned about.
    const destroy = vi.fn()
    stubModel({
      availability: async () => 'available',
      create: async () => ({
        prompt: async () => {
          throw new Error('QuotaExceededError')
        },
        destroy,
      }),
    })

    expect(await promptForText('write a reply')).toBeNull()
    expect(destroy).toHaveBeenCalled()
  })

  it('returns nothing when every session spelling is refused', async () => {
    stubModel({
      availability: async () => 'available',
      create: async () => {
        throw new Error('NotSupportedError')
      },
    })
    expect(await promptForText('write a reply')).toBeNull()
  })
})

/**
 * INT-10 — the download nothing ever offered.
 *
 * `canPrefill` refuses 'downloadable' so a form never starts a 22 GB fetch,
 * and the browser starts one only when a page calls `create()`. Both correct;
 * together a deadlock. Miky ran a week on a machine that could have run the
 * model and got it only by pasting `create()` into the console on 2026-09-09.
 *
 * The assertions that matter are the ones separating this from the thing
 * PEE-6 forbids: a fetch nobody asked for. So this suite checks both that
 * `downloadModel` downloads **and** that no other export in this file reaches
 * it.
 */
describe('downloadModel — the only path that starts a fetch (INT-10)', () => {
  it('does nothing where the API is absent', async () => {
    // Every phone, Safari, and jsdom. Nothing to download and nothing to say.
    expect(await downloadModel()).toBe(false)
  })

  it('creates a session, which is what makes the browser fetch the model', async () => {
    const create = vi.fn<(options?: unknown) => Promise<{ prompt: () => Promise<string>; destroy: () => void }>>(
      async () => ({ prompt: async () => '', destroy: () => {} }),
    )
    stubModel({ availability: async () => 'downloadable', create: create as unknown as Stub['create'] })

    expect(await downloadModel()).toBe(true)
    // The sampling options still matter: a create the browser refuses over MTP
    // downloads nothing, so the same list is tried here as everywhere else.
    const passed = create.mock.calls[0]?.[0] as Record<string, unknown> | undefined
    expect(passed).toMatchObject(SESSION_OPTIONS[0])
  })

  it('reports progress as a fraction, which is what the browser sends', async () => {
    /*
      Measured in the console on 2026-09-09 — the snippet on INT-10 renders it
      as `Math.round(e.loaded * 100) + '%'`, so `loaded` is 0…1 and the percent
      belongs to the caller. Getting this backwards would show "10000%".
    */
    const seen: number[] = []
    stubModel({
      availability: async () => 'downloadable',
      create: (async (options: { monitor?: (m: unknown) => void }) => {
        options.monitor?.({
          addEventListener: (_type: string, listener: (event: { loaded: number }) => void) => {
            listener({ loaded: 0 })
            listener({ loaded: 0.5 })
            listener({ loaded: 1 })
          },
        })
        return { prompt: async () => '', destroy: () => {} }
      }) as unknown as Stub['create'],
    })

    expect(await downloadModel((fraction) => seen.push(fraction))).toBe(true)
    expect(seen).toEqual([0, 0.5, 1])
  })

  it('destroys the session, because the download outlives it', async () => {
    // The model lands in the browser's own store, shared by every origin. A
    // session held open past that just leaks the model's context.
    const destroy = vi.fn()
    stubModel({
      availability: async () => 'downloadable',
      create: (async () => ({ prompt: async () => '', destroy })) as unknown as Stub['create'],
    })

    await downloadModel()
    expect(destroy).toHaveBeenCalledTimes(1)
  })

  it('downloads even where the build has no monitor to attach', async () => {
    // Losing the progress readout is not a reason to lose the model.
    stubModel({
      availability: async () => 'downloadable',
      create: (async (options: { monitor?: (m: unknown) => void }) => {
        options.monitor?.({
          addEventListener: () => {
            throw new Error('no such event')
          },
        })
        return { prompt: async () => '', destroy: () => {} }
      }) as unknown as Stub['create'],
    })

    expect(await downloadModel(() => {})).toBe(true)
  })

  it('answers false on Edge, whose refusal is a policy gate and fetches nothing', async () => {
    /*
      Measured 2026-09-02: every `create()` shape throws *"The feature flag
      gating model execution was disabled"*, and `edge://on-device-internals`
      names the one failing criterion as `enabled by feature: false` — with the
      hardware passing. So the honest answer here is false, and offering the
      download again would be a row that can never succeed.
    */
    stubModel({
      availability: async () => 'unavailable',
      create: (async () => {
        throw new Error('The feature flag gating model execution was disabled.')
      }) as unknown as Stub['create'],
    })

    expect(await downloadModel()).toBe(false)
  })

  it('is NOT reached by the gate, so opening a form still downloads nothing', async () => {
    /*
      The PEE-6 guarantee, asserted rather than assumed. `canPrefill` is what
      every automatic path consults, and it must answer without creating
      anything — a create() here is a multi-gigabyte fetch on somebody who just
      opened a launcher.
    */
    const create = vi.fn<(options?: unknown) => Promise<never>>(async () => {
      throw new Error('should never be called')
    })
    stubModel({ availability: async () => 'downloadable', create: create as unknown as Stub['create'] })

    expect(await canPrefill()).toBe(false)
    expect(create).not.toHaveBeenCalled()
  })

  it('is NOT reached by the prompt paths either', async () => {
    // `promptForObject` and `promptForText` create sessions, but never with a
    // monitor: they run only where the caller already established a model.
    const create = vi.fn<(options?: { monitor?: unknown }) => Promise<{ prompt: () => Promise<string>; destroy: () => void }>>(
      async () => ({ prompt: async () => '{"title":"x"}', destroy: () => {} }),
    )
    stubModel({ availability: async () => 'available', create: create as unknown as Stub['create'] })

    await promptForObject('go', { type: 'object', properties: { title: { type: 'string' } } })
    await promptForText('go')
    expect(create).toHaveBeenCalled()
    for (const call of create.mock.calls) expect(call[0]?.monitor).toBeUndefined()
  })
})

/**
 * Edge 155 — `availability()` that never settles, measured 2026-09-10.
 *
 * A probe awaiting it printed the browser's output-language warning and then
 * nothing: no value, no throw, no rejection. `prefillAvailability` awaited it
 * with no deadline, so the launcher's model state never resolved — no Ask row,
 * no download offer, no error, for the life of the page. Indistinguishable
 * from PEE-6 degrading correctly, which is what made it cost a week.
 *
 * A `catch` does not catch a promise that never settles, so these are the only
 * assertions in this file that need fake timers.
 */
describe('availability that never answers (Edge 155)', () => {
  afterEach(() => {
    vi.useRealTimers()
  })

  /**
   * Runs `work` with every deadline elapsed.
   *
   * Twice the limit, so it stays correct whether or not a hang falls through
   * to a second call. It no longer does — see the bare-call test — but a
   * helper that only just clears the deadline turns any future fallback into
   * a mystery test timeout rather than a failed assertion.
   */
  async function pastTheDeadline<T>(work: Promise<T>): Promise<T> {
    await vi.advanceTimersByTimeAsync(AVAILABILITY_LIMIT_MS * 2)
    return await work
  }

  it('reports "unanswered" rather than hanging for ever', async () => {
    vi.useFakeTimers()
    stubModel({ availability: () => new Promise<string>(() => {}) as Promise<string> })

    expect(await pastTheDeadline(prefillAvailability())).toBe('unanswered')
  })

  it('does not spend a second deadline on the bare call', async () => {
    /*
      Measured, not assumed: in Edge 155 the bare call never settles either,
      along with every option spelling and Summarizer, Writer and Rewriter. So
      the fallback — which exists for a build that *rejects* options — buys
      nothing here and would double the wait in the one browser known to need
      it. A throw still falls back; a hang does not.
    */
    vi.useFakeTimers()
    const availability = vi.fn(() => new Promise<string>(() => {}))
    stubModel({ availability: availability as unknown as Stub['availability'] })

    expect(await pastTheDeadline(prefillAvailability())).toBe('unanswered')
    expect(availability).toHaveBeenCalledTimes(1)
  })

  it('still falls back when the options call THROWS, which is a different thing', async () => {
    // The original reason the fallback exists, unchanged.
    const availability = vi.fn((options?: unknown) => {
      if (options !== undefined) throw new Error('options rejected')
      return Promise.resolve('available')
    })
    stubModel({ availability: availability as unknown as Stub['availability'] })

    expect(await prefillAvailability()).toBe('available')
    expect(availability).toHaveBeenCalledTimes(2)
  })

  it('answers immediately where the browser does, without waiting out the deadline', async () => {
    // The deadline is a floor under a hang, not a delay on every launcher open.
    stubModel({ availability: async () => 'available' })
    expect(await prefillAvailability()).toBe('available')
  })

  it('does NOT let the gate through, which "not downloadable" once would have', async () => {
    /*
      The old `canPrefill` refused two answers and admitted everything else, so
      'unanswered' would have been admitted the day it was added — and a
      browser that will not say whether it has a model would have had a session
      opened against it, and the Ask row would sit on "Reading the thread…".
    */
    vi.useFakeTimers()
    stubModel({ availability: () => new Promise<string>(() => {}) as Promise<string> })

    expect(await pastTheDeadline(canPrefill())).toBe(false)
  })
})

/**
 * `downloadprogress` means different things in the two browsers.
 *
 * Chrome sends `{loaded}` as a fraction 0…1. Edge documents `{loaded, total}`
 * with `loaded` a byte count, and its own sample divides one by the other:
 *
 * > *The event is an object with the loaded and total properties.*
 * > `const percentageComplete = (event.loaded / event.total) * 100;`
 *
 * Found by reading Edge's documentation, not by running it — no browser here
 * fires the event at all, and the launcher row would have said "428000000%".
 */
describe('downloadFraction — one number out of two conventions', () => {
  it('divides where Edge sends a total', () => {
    expect(downloadFraction({ loaded: 2_000_000, total: 8_000_000 })).toBe(0.25)
  })

  it('passes Chrome\'s fraction through untouched', () => {
    expect(downloadFraction({ loaded: 0.25 })).toBe(0.25)
  })

  it('does not divide by a zero total, which is a percentage nobody can read', () => {
    // Infinity and NaN both render as garbage in the row. 0 bytes of 0 is 0.
    expect(downloadFraction({ loaded: 0, total: 0 })).toBe(0)
  })

  it('clamps, because neither browser is trusted to stay in its own range', () => {
    expect(downloadFraction({ loaded: 9, total: 8 })).toBe(1)
    expect(downloadFraction({ loaded: -1 })).toBe(0)
  })

  it('is what downloadModel reports, so a byte count never reaches the row', async () => {
    const seen: number[] = []
    stubModel({
      availability: async () => 'downloadable',
      create: (async (options: { monitor?: (m: unknown) => void }) => {
        options.monitor?.({
          addEventListener: (_t: string, listener: (e: { loaded: number; total?: number }) => void) => {
            listener({ loaded: 4_000_000, total: 8_000_000 })
          },
        })
        return { prompt: async () => '', destroy: () => {} }
      }) as unknown as Stub['create'],
    })

    await downloadModel((fraction) => seen.push(fraction))
    expect(seen).toEqual([0.5])
  })
})

/**
 * Edge documents one shape and it is not in `SESSION_OPTIONS`.
 *
 * Every sample on Edge's Prompt API page calls `LanguageModel.create()` bare;
 * `monitor`, `initialPrompts` and `signal` are the only options it names. So a
 * ladder built entirely from Chrome's sampling vocabulary can be refused at
 * every rung by a browser that would have accepted no options at all.
 */
describe('downloadModel falls back to the bare create Edge documents', () => {
  it('tries it after every sampling shape is refused', async () => {
    const create = vi.fn(async (options: { samplingMode?: string; topK?: number; temperature?: number }) => {
      if (options.samplingMode || options.topK !== undefined || options.temperature !== undefined) {
        throw new Error('unknown option')
      }
      return { prompt: async () => '', destroy: () => {} }
    })
    stubModel({ availability: async () => 'downloadable', create: create as unknown as Stub['create'] })

    expect(await downloadModel()).toBe(true)
    expect(create).toHaveBeenCalledTimes(SESSION_OPTIONS.length + 1)
    // Still monitored, or a several-gigabyte fetch reports nothing at all.
    expect(create.mock.calls.at(-1)?.[0]).toHaveProperty('monitor')
  })

  it('still answers false where even bare is refused, as on Edge 154', async () => {
    const create = vi.fn<(o?: unknown) => Promise<never>>(async () => {
      throw new Error('The feature flag gating model execution was disabled.')
    })
    stubModel({ availability: async () => 'downloadable', create: create as unknown as Stub['create'] })

    expect(await downloadModel()).toBe(false)
    expect(create).toHaveBeenCalledTimes(SESSION_OPTIONS.length + 1)
  })
})

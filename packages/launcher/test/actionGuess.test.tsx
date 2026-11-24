/**
 * KIN-7 — where the browser's on-device Decisions API passes the box's check,
 * a sentence puts the suggested action it wants first; everywhere else the
 * Suggested rows keep their usual order, and typing never starts a download.
 *
 * `DecisionModel` is a stand-in with the shape Chrome 160 and Edge Dev 160
 * answered with on 24 Nov 2026 (`{ action: { label, confidence } }`). What is
 * asserted is the order a person sees and whether a download began.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { ToastProvider } from '@estiva-app/ui'
import { CommandLauncher } from '../src/CommandLauncher.js'
import type { LauncherHost } from '../src/host.js'
import { forgetGuessers } from '../src/actionGuess.js'

const ADD_ISSUE = 'suggested-own-add-issue'
const NEW_PROJECT = 'suggested-own-new-project'

type Answer = { label: string; confidence: number }
type Answers = (sentence: string) => Answer | Promise<Answer>

/** A browser's Decisions API: what `availability()` says, and the answer to each sentence. */
function stubDecisionModel(answers: Answers, availability = 'available') {
  const decide = vi.fn(async (sentence: string) => ({ action: await answers(sentence) }))
  const model = {
    availability: vi.fn(async () => availability),
    create: vi.fn(async () => ({ decide, destroy: () => {} })),
  }
  vi.stubGlobal('DecisionModel', model)
  return { model, decide }
}

/** A model that passes the check: it moves nothing for a sentence about an existing issue. */
const passing =
  (rest: Answers): Answers =>
  (sentence) =>
    /assign this issue|issues are still open/.test(sentence) ? { label: 'x-change', confidence: 0.9 } : rest(sentence)

function host(): LauncherHost {
  return {
    apps: [],
    mark: () => null,
    words: {
      anywhere: 'Anywhere in Ship',
      inOpen: 'On this issue',
      search: 'Search Ship',
      searchOrAsk: 'Search, or ask about this issue',
      openGroup: 'This issue',
      nothingOpen: 'Open an issue to ask about it.',
      nothingYet: 'This issue is empty.',
      reading: 'Reading the issue…',
      downloadModel: 'Download the on-device model',
    },
    path: { pathname: '/issues', search: '' },
    navigate: () => {},
    people: [],
    openPerson: () => {},
    file: { glyph: () => 'topic', open: () => {}, isOpen: () => false },
    useFileSearch: () => ({ state: { kind: 'idle' }, hits: [] }),
    plain: (body) => body,
    manifests: { creatableUnder: async () => null, applyAction: async () => ({ ok: true }), resolveObject: async () => null },
    model: {
      hasPromptApi: () => true,
      prefillAvailability: async () => 'available',
      canPrefill: async () => true,
      downloadModel: async () => true,
      promptForText: async () => null,
      promptForObject: async () => null,
    },
    showSource: () => true,
    form: { references: {} as LauncherHost['form']['references'], mentions: {} as LauncherHost['form']['mentions'], referenceView: () => null, personField: () => null },
    useReportFailure: () => {},
    ownActions: [
      { id: 'add-issue', label: 'Add issue', guessAs: 'Add a new issue, bug or ticket', run: () => {} },
      { id: 'new-project', label: 'New project', guessAs: 'Create a new project', run: () => {} },
    ],
  }
}

async function mount() {
  render(
    <ToastProvider>
      <CommandLauncher host={host()} context={{}} onClose={() => {}} />
    </ToastProvider>,
  )
  await act(() => vi.advanceTimersByTimeAsync(0))
  const field = () => document.querySelector<HTMLTextAreaElement>('[data-command-palette-field]')!
  const type = async (text: string) => {
    fireEvent.change(field(), { target: { value: text } })
    await act(() => vi.advanceTimersByTimeAsync(0))
  }
  return { field, type }
}

/** The Suggested rows as the person reads them, top to bottom. */
const suggested = () =>
  screen
    .queryAllByRole('option')
    .map((o) => o.textContent ?? '')
    .filter((text) => text.includes('Add issue') || text.includes('New project'))
    .map((text) => (text.includes('Add issue') ? 'Add issue' : 'New project'))

/** The typing pause, then the model's answer. */
const settle = () => act(() => vi.advanceTimersByTimeAsync(1000))

beforeEach(() => {
  vi.useFakeTimers()
})
afterEach(() => {
  cleanup()
  forgetGuessers()
  vi.unstubAllGlobals()
  vi.useRealTimers()
})

describe('a sure guess puts the action the sentence wants first', () => {
  it('moves New project above Add issue for "create a project for the website launch"', async () => {
    stubDecisionModel(passing((s) => (s.includes('project') ? { label: NEW_PROJECT, confidence: 0.98 } : { label: 'x-ask', confidence: 0.5 })))
    const { type } = await mount()
    await type('create a project for the website launch')
    expect(suggested()).toEqual(['Add issue', 'New project'])
    await settle()
    expect(suggested()).toEqual(['New project', 'Add issue'])
  })

  it('goes back to the usual order when the next sentence wants none of the rows', async () => {
    stubDecisionModel(passing((s) => (s.includes('create a project') ? { label: NEW_PROJECT, confidence: 0.98 } : { label: 'x-ask', confidence: 0.9 })))
    const { type } = await mount()
    await type('create a project for the website launch')
    await settle()
    await type('what did we decide about folders in the sidebar')
    await settle()
    expect(suggested()).toEqual(['Add issue', 'New project'])
  })
})

describe('anything short of a sure guess leaves the usual order', () => {
  it('keeps the order when the answer is below the bar', async () => {
    stubDecisionModel(passing(() => ({ label: NEW_PROJECT, confidence: 0.55 })))
    const { type } = await mount()
    await type('create a project for the website launch')
    await settle()
    expect(suggested()).toEqual(['Add issue', 'New project'])
  })

  it('keeps the order when a hidden "something else" option wins, however sure', async () => {
    stubDecisionModel(passing(() => ({ label: 'x-ask', confidence: 0.99 })))
    const { type } = await mount()
    await type('who is working on the relay speed work')
    await settle()
    expect(suggested()).toEqual(['Add issue', 'New project'])
  })

  it('never uses a model that moves a row for a sentence about an existing issue (Chrome 160, 24 Nov)', async () => {
    // Chrome's answers on 24 Nov: Create issue first for "assign this issue to me" at 1.00.
    stubDecisionModel((s) => (s.includes('project') ? { label: NEW_PROJECT, confidence: 0.98 } : { label: ADD_ISSUE, confidence: 1 }))
    const { type } = await mount()
    await type('create a project for the website launch')
    await settle()
    expect(suggested()).toEqual(['Add issue', 'New project'])
  })

  it('keeps the order in a browser with no Decisions API', async () => {
    const { type } = await mount()
    await type('create a project for the website launch')
    await settle()
    expect(suggested()).toEqual(['Add issue', 'New project'])
  })

  it('drops the answer for a sentence that has changed since it was asked', async () => {
    let release: (answer: Answer) => void = () => {}
    stubDecisionModel(
      passing((s) => (s.startsWith('create a project') ? new Promise<Answer>((resolve) => (release = resolve)) : { label: 'x-ask', confidence: 0.9 })),
    )
    const { type } = await mount()
    await type('create a project for the website launch')
    await act(() => vi.advanceTimersByTimeAsync(200))
    await type('what did we decide about folders in the sidebar')
    // The old sentence's answer lands before the new one is asked: it must not move anything.
    await act(async () => release({ label: NEW_PROJECT, confidence: 0.98 }))
    expect(suggested()).toEqual(['Add issue', 'New project'])
  })
})

describe('a row does not move under the hand reaching for it', () => {
  it('holds the order once the pointer moves, until the next key', async () => {
    stubDecisionModel(passing((s) => (s.includes('project') ? { label: NEW_PROJECT, confidence: 0.98 } : { label: 'x-ask', confidence: 0.9 })))
    const { type } = await mount()
    await type('create a project for the website launch')
    fireEvent.pointerMove(screen.getAllByRole('option')[0]!)
    await settle()
    expect(suggested()).toEqual(['Add issue', 'New project'])
    await type('create a project for the website launch now')
    await settle()
    expect(suggested()).toEqual(['New project', 'Add issue'])
  })
})

describe('only the Download row starts a download', () => {
  it('typing a sentence never creates a session where the model is still to download', async () => {
    const { model } = stubDecisionModel(passing(() => ({ label: NEW_PROJECT, confidence: 0.98 })), 'downloadable')
    const { type } = await mount()
    await type('create a project for the website launch')
    await settle()
    expect(model.create).not.toHaveBeenCalled()
    expect(suggested()).toEqual(['Add issue', 'New project'])
  })

  it('offers the row under a prompt, and choosing it fetches the guess’s model', async () => {
    const { model } = stubDecisionModel(passing(() => ({ label: NEW_PROJECT, confidence: 0.98 })), 'downloadable')
    const { type } = await mount()
    await type('create a project for the website launch')
    await settle()
    const row = screen.getAllByRole('option').find((o) => o.textContent?.includes('Download the on-device model'))
    expect(row).toBeDefined()
    fireEvent.click(row!)
    await settle()
    expect(model.create).toHaveBeenCalledTimes(1)
  })
})

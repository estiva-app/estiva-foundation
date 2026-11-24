/**
 * KIN-5 — the box about a page, as Leaf mounts it.
 *
 * What is open is a page: its text in passages, then every comment on it,
 * resolved ones marked (Miky, KIN-5 kickoff). An answer can be turned into what
 * the app offers (a comment, a block in the page); the app's own actions sit
 * beside the declared ones; and an action whose event the app may not sign is
 * never offered.
 */
import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { ToastProvider } from '@estiva-app/ui'
import type { ResolvedAction } from '@estiva-app/interop'
import { CommandLauncher } from '../src/CommandLauncher.js'
import type { LauncherContext, LauncherHost } from '../src/host.js'
import { launcherApps } from '../src/launcherActions.js'

afterEach(cleanup)

const WORDS: LauncherHost['words'] = {
  anywhere: 'Anywhere in Leaf',
  inOpen: 'On this page',
  search: 'Search Leaf, or choose an app',
  searchOrAsk: 'Search, or ask about this page',
  openGroup: 'This page',
  nothingOpen: 'Open a page to ask about it.',
  nothingYet: 'Nothing has been written here yet.',
  reading: 'Reading the page…',
  downloadModel: 'Download the on-device model to ask about pages',
  part: { one: 'passage', many: 'passages' },
}

function leafHost(over: Partial<LauncherHost> = {}): LauncherHost {
  return {
    apps: launcherApps('leaf'),
    mark: () => null,
    words: WORDS,
    path: { pathname: '/document/launch-plan', search: '' },
    navigate: () => {},
    people: [],
    openPerson: () => {},
    file: { glyph: () => 'file', open: () => {}, isOpen: () => false },
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
    ...over,
  }
}

const PAGE: LauncherContext = {
  open: {
    kind: 'page',
    title: 'Launch plan',
    references: [],
    messages: [
      { id: 'block-1', author: '', timestamp: '', where: 'In the page', body: 'Launch date: to be confirmed.' },
      { id: 'comment-1', author: 'Ravi Mehta', timestamp: '9:41 AM', where: 'Comment on the whole document', body: 'Who writes the FAQ?' },
      { id: 'comment-2', author: 'Katerina Novak', timestamp: '9:50 AM', resolved: true, body: 'The launch date moved to Friday.' },
    ],
  },
}

function mount(host: LauncherHost, context: LauncherContext = PAGE) {
  const onClose = vi.fn()
  render(
    <ToastProvider>
      <CommandLauncher host={host} context={context} onClose={onClose} />
    </ToastProvider>,
  )
  const field = () => document.querySelector<HTMLInputElement | HTMLTextAreaElement>('[data-command-palette-field]')!
  const type = (text: string) => fireEvent.change(field(), { target: { value: text } })
  const ask = (text: string) => {
    type(text)
    fireEvent.keyDown(field(), { key: 'Enter' })
  }
  return { onClose, type, ask }
}

const optionNamed = (title: string) => screen.queryAllByRole('option').find((o) => o.textContent?.includes(title))
const withModel = (promptForText: (instruction: string) => Promise<string | null>, over: Partial<LauncherHost> = {}) => {
  const host = leafHost(over)
  return { ...host, model: { ...host.model, promptForText } }
}

describe('a sentence asks about the open page: its text and every comment on it', () => {
  it('gives the model the page by name, its passages and its comments, a resolved one marked', async () => {
    const promptForText = vi.fn<(instruction: string) => Promise<string | null>>(async () => 'The date is open [1].')
    const { ask } = mount(withModel(promptForText))

    ask('what is still open about the launch date')

    await waitFor(() => expect(promptForText).toHaveBeenCalledTimes(1))
    const instruction = promptForText.mock.calls[0][0]
    expect(instruction).toContain('page called "Launch plan"')
    expect(instruction).toContain('Launch date: to be confirmed.')
    expect(instruction).toContain('Comment by Katerina Novak (resolved): The launch date moved to Friday.')
    expect(instruction).not.toContain('team conversation')
  })

  it('cites a passage of the page by where it is, not by an author', async () => {
    const { ask } = mount(withModel(async () => 'The date is open [1].'))

    ask('what is still open about the launch date')

    await waitFor(() => expect(optionNamed('Launch date: to be confirmed.')).toBeTruthy())
    expect(optionNamed('Launch date: to be confirmed.')!.textContent).toContain('[1] In the page')
  })
})

describe('an answer about a page can be turned into what the app offers', () => {
  it('offers the app’s answer actions, hands each the answer without its marks and what it cites, and closes once done', async () => {
    const run = vi.fn(() => true)
    const answerActions = vi.fn<NonNullable<LauncherHost['answerActions']>>(() => [{ id: 'comment', label: 'Draft a comment', run }])
    const { ask, onClose } = mount(withModel(async () => 'Ravi asked who writes the FAQ [2].', { answerActions }))

    ask('what is still open on this page')
    await waitFor(() => expect(optionNamed('Draft a comment')).toBeTruthy())
    fireEvent.click(optionNamed('Draft a comment')!)

    const answer = answerActions.mock.calls.at(-1)![0]
    expect(answer.text).toBe('Ravi asked who writes the FAQ.')
    expect(answer.cited.map((m) => m.id)).toEqual(['comment-1'])
    await waitFor(() => expect(onClose).toHaveBeenCalledTimes(1))
  })

  it('hands the cited parts in the order the answer first cites them, not by their numbers', async () => {
    const answerActions = vi.fn<NonNullable<LauncherHost['answerActions']>>(() => [{ id: 'insert', label: 'Insert into the page', run: () => true }])
    const { ask } = mount(withModel(async () => 'Ravi asked who writes the FAQ [2]. The date is open [1][2].', { answerActions }))

    ask('what is still open on this page')
    await waitFor(() => expect(optionNamed('Insert into the page')).toBeTruthy())

    expect(answerActions.mock.calls.at(-1)![0].cited.map((m) => m.id)).toEqual(['comment-1', 'block-1'])
  })

  it('hands no cited part when the answer cites none, so the app does not act on a part it did not use', async () => {
    const answerActions = vi.fn<NonNullable<LauncherHost['answerActions']>>(() => [{ id: 'insert', label: 'Insert into the page', run: () => true }])
    const { ask } = mount(withModel(async () => 'The page does not say.', { answerActions }))

    ask('what is still open on this page')
    await waitFor(() => expect(optionNamed('Insert into the page')).toBeTruthy())

    expect(answerActions.mock.calls.at(-1)![0].cited).toEqual([])
  })

  it('keeps the box and says so when the app’s action throws', async () => {
    const { ask, onClose } = mount(
      withModel(async () => 'The date is open [1].', {
        answerActions: () => [
          {
            id: 'insert',
            label: 'Insert into the page',
            run: () => {
              throw new Error('editor gone')
            },
          },
        ],
      }),
    )

    ask('what is still open on this page')
    await waitFor(() => expect(optionNamed('Insert into the page')).toBeTruthy())
    fireEvent.click(optionNamed('Insert into the page')!)

    await waitFor(() => expect(screen.getByTestId('answer').textContent).toContain('Insert into the page did not work.'))
    expect(onClose).not.toHaveBeenCalled()
  })

  it('keeps the box and the answer, and says so, when the app could not do it', async () => {
    const { ask, onClose } = mount(
      withModel(async () => 'The date is open [1].', { answerActions: () => [{ id: 'insert', label: 'Insert into the page', run: () => false }] }),
    )

    ask('what is still open on this page')
    await waitFor(() => expect(optionNamed('Insert into the page')).toBeTruthy())
    fireEvent.click(optionNamed('Insert into the page')!)

    await waitFor(() => expect(screen.getByTestId('answer').textContent).toContain('Insert into the page did not work. The answer is still here.'))
    expect(onClose).not.toHaveBeenCalled()
  })
})

describe('the app’s own actions sit beside the declared ones', () => {
  it('lists New document before anything is typed, finds it by name, and does it', async () => {
    const run = vi.fn()
    const { type, onClose } = mount(leafHost({ ownActions: [{ id: 'new-document', label: 'New document', description: 'In Launch team', run }] }))

    expect(optionNamed('New document')).toBeTruthy()
    type('new doc')
    await waitFor(() => expect(optionNamed('New document')).toBeTruthy())
    fireEvent.click(optionNamed('New document')!)

    expect(run).toHaveBeenCalledTimes(1)
    expect(onClose).toHaveBeenCalledTimes(1)
  })
})

describe('the box never offers an action whose event the app may not sign', () => {
  // Ship's manifest, as the relay resolves it under a project: Create issue, which emits Ship's issue kind (30851).
  const addIssue = { id: 'add-issue', label: 'Create issue', control: 'form', fields: [{ name: 'title', type: 'string', required: true }], createsUnder: 'self' } as unknown as ResolvedAction
  const shipRead: LauncherHost['manifests']['creatableUnder'] = async (kind) =>
    kind === 30850 ? { actions: [addIssue], parents: [{ address: '30850:aa:web', title: 'Website launch' }], manifest: '31990:aa:ship' } : null

  it('offers Create issue where the app may sign an issue', async () => {
    const { type } = mount(leafHost({ maySign: () => true, manifests: { ...leafHost().manifests, creatableUnder: shipRead } }))

    type('create')

    await waitFor(() => expect(optionNamed('Create issue')).toBeTruthy())
  })

  it('leaves Create issue out where the app may not sign an issue, and says where it is made', async () => {
    const { type } = mount(leafHost({ maySign: (kind) => kind !== 30851, manifests: { ...leafHost().manifests, creatableUnder: shipRead } }))

    type('ship')
    await waitFor(() => expect(optionNamed('Ship')).toBeTruthy())
    fireEvent.click(optionNamed('Ship')!)

    await waitFor(() => expect(screen.getByText('What Ship creates is made in Ship, not here.')).toBeTruthy())
    expect(optionNamed('Create issue')).toBeUndefined()
  })
})

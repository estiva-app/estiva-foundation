/**
 * KIN-4 — the box runs on what an app hands it, and on nothing else.
 *
 * Peek's own suite drives this component through Peek's host, with Peek's
 * data. These tests mount it with a stand-in app that has no conversation
 * registry, no composer and no message search — what Leaf and Ship look like
 * to it — and check what a person sees: the app's words, the app's results,
 * the app's model answering, and nothing offered that this app could not do.
 */
import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { ToastProvider } from '@estiva-app/ui'
import { CommandLauncher, type LauncherState } from '../src/CommandLauncher.js'
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
  nothingYet: 'This page is empty.',
  reading: 'Reading the page…',
  downloadModel: 'Download the on-device model to ask about pages',
}

const PLAN = { id: '30023:aa:plan', title: 'Launch plan' }

function standIn(over: Partial<LauncherHost> = {}): LauncherHost {
  return {
    // An app the registry does not list: none of the apps is the one the box runs in.
    apps: launcherApps('leaf'),
    mark: () => null,
    words: WORDS,
    path: { pathname: '/page/plan', search: '' },
    navigate: () => {},
    people: [{ id: 'p1', name: 'Katerina Novak', role: 'Designer' }],
    openPerson: () => {},
    file: { glyph: () => 'topic', open: () => {}, isOpen: () => false },
    useFileSearch: (query) => (query.trim() ? { state: { kind: 'done', count: 1 }, hits: [PLAN] } : { state: { kind: 'idle' }, hits: [] }),
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
    // No form is opened here: the fields are drawn in Peek's suite, through Peek's host.
    form: { references: {} as LauncherHost['form']['references'], mentions: {} as LauncherHost['form']['mentions'], referenceView: () => null, personField: () => null },
    useReportFailure: () => {},
    ...over,
  }
}

const PAGE: LauncherContext = {
  conversation: {
    references: [],
    messages: [
      { id: 'b1', author: 'Miky', timestamp: '9:41 AM', body: 'We ship the launcher on Friday.' },
      { id: 'b2', author: 'Katerina', timestamp: '9:43 AM', body: 'The dot stays orange.' },
    ],
  },
}

function mount(host: LauncherHost, context: LauncherContext = {}, props: { onHide?: () => void; onState?: (state: LauncherState) => void } = {}) {
  const onClose = vi.fn()
  render(
    <ToastProvider>
      <CommandLauncher host={host} context={context} onClose={onClose} {...props} />
    </ToastProvider>,
  )
  const field = () => document.querySelector<HTMLInputElement | HTMLTextAreaElement>('[data-command-palette-field]')!
  const type = (text: string) => fireEvent.change(field(), { target: { value: text } })
  return { onClose, field, type }
}

const optionNamed = (title: string) => screen.queryAllByRole('option').find((o) => o.textContent?.includes(title))

describe('the box says the app’s own words', () => {
  it('names the app in the empty field and the footer when nothing is open', () => {
    mount(standIn())

    expect(screen.getByPlaceholderText('Search Leaf, or choose an app')).toBeTruthy()
    expect(screen.getByText('Anywhere in Leaf')).toBeTruthy()
  })

  it('offers to ask about what is open when the app hands something over', () => {
    mount(standIn(), PAGE)

    expect(screen.getByPlaceholderText('Search, or ask about this page')).toBeTruthy()
  })
})

describe('a name finds what the app’s search finds', () => {
  it('lists the app’s file hits, and choosing one opens it through the app and closes the box', async () => {
    const open = vi.fn()
    const { onClose, type } = mount(standIn({ file: { glyph: () => 'topic', open, isOpen: () => false } }))

    type('launch plan')
    await waitFor(() => expect(optionNamed('Launch plan')).toBeTruthy())
    fireEvent.click(optionNamed('Launch plan')!)

    expect(open).toHaveBeenCalledWith(PLAN.id, PLAN.title)
    expect(onClose).toHaveBeenCalledTimes(1)
  })

  it('never lists the file that is already open', async () => {
    const { type } = mount(standIn({ file: { glyph: () => 'topic', open: () => {}, isOpen: (id) => id === PLAN.id } }))

    type('launch plan')

    // The search found it, and the box has nothing to list: the one hit is where the person already is.
    await waitFor(() => expect(screen.getByText(/Nothing is called “launch plan”/)).toBeTruthy())
    expect(optionNamed('Launch plan')).toBeUndefined()
  })

  it('finds a person by role and opens them through the app', async () => {
    const openPerson = vi.fn()
    const { type } = mount(standIn({ openPerson }))

    type('designer')
    await waitFor(() => expect(optionNamed('Katerina Novak')).toBeTruthy())
    fireEvent.click(optionNamed('Katerina Novak')!)

    expect(openPerson).toHaveBeenCalledWith('p1')
  })

  it('says nothing about messages in an app that cannot open one', async () => {
    const { type } = mount(standIn({ useFileSearch: () => ({ state: { kind: 'done', count: 0 }, hits: [] }) }))

    type('zzz')

    await waitFor(() => expect(screen.getByText(/Nothing is called “zzz”/)).toBeTruthy())
    expect(screen.queryByText(/message/i)).toBeNull()
  })

  it('lists the message rows of an app that can open one, and opens the chosen one through the app', async () => {
    const openMessage = vi.fn()
    const useMessageSearch: LauncherHost['useMessageSearch'] = (query) =>
      query.trim()
        ? { state: { kind: 'done', count: 3 }, rows: [{ id: 'm1', label: 'the launch slipped a week', description: 'Miky · Launch', open: openMessage }], unroutable: 2 }
        : { state: { kind: 'idle' }, rows: [], unroutable: 0 }
    const { onClose, type } = mount(standIn({ useMessageSearch }))

    type('launch')
    await waitFor(() => expect(optionNamed('the launch slipped a week')).toBeTruthy())
    // The hits with nowhere to open are counted, not dropped in silence.
    expect(screen.getByText('2 more in conversations not in your sidebar.')).toBeTruthy()
    fireEvent.click(optionNamed('the launch slipped a week')!)

    expect(openMessage).toHaveBeenCalledTimes(1)
    expect(onClose).toHaveBeenCalledTimes(1)
  })
})

describe('a sentence asks the app’s model about what is open', () => {
  it('sends what is open to the model the app handed over, and shows its answer', async () => {
    const promptForText = vi.fn<(instruction: string) => Promise<string | null>>(async () => 'On Friday [1].')
    const host = standIn()
    const { field, type } = mount({ ...host, model: { ...host.model, promptForText } }, PAGE)

    type('when do we ship')
    fireEvent.keyDown(field(), { key: 'Enter' })

    await waitFor(() => expect(screen.getByTestId('answer').textContent).toContain('On Friday'))
    expect(promptForText).toHaveBeenCalledTimes(1)
    expect(promptForText.mock.calls[0][0]).toContain('We ship the launcher on Friday.')
    expect(promptForText.mock.calls[0][0]).toContain('when do we ship')
    // The message the answer cites is offered as its source.
    expect(optionNamed('We ship the launcher on Friday.')).toBeTruthy()
  })

  it('does not offer to put the answer anywhere in an app with no composer', async () => {
    const host = standIn()
    const { field, type } = mount({ ...host, model: { ...host.model, promptForText: async () => 'On Friday [1].' } }, PAGE)

    type('when do we ship')
    fireEvent.keyDown(field(), { key: 'Enter' })

    await waitFor(() => expect(screen.getByTestId('answer')).toBeTruthy())
    expect(screen.queryByText('Put the answer in the composer')).toBeNull()
    expect(screen.queryByText('Draft a reply')).toBeNull()
  })

  it('says the app’s own sentence, and asks nothing, when nothing is open', async () => {
    const promptForText = vi.fn(async () => 'never')
    const host = standIn()
    const { field, type } = mount({ ...host, model: { ...host.model, promptForText } })

    type('when do we ship')
    fireEvent.keyDown(field(), { key: 'Enter' })

    await waitFor(() => expect(screen.getByText('Open a page to ask about it.')).toBeTruthy())
    expect(promptForText).not.toHaveBeenCalled()
  })

  it('shows the cited message through the app, and says so when the app cannot reach it', async () => {
    const showSource = vi.fn(() => false)
    const host = standIn({ showSource })
    const { onClose, field, type } = mount({ ...host, model: { ...host.model, promptForText: async () => 'On Friday [1].' } }, PAGE)

    type('when do we ship')
    fireEvent.keyDown(field(), { key: 'Enter' })
    await waitFor(() => expect(optionNamed('We ship the launcher on Friday.')).toBeTruthy())
    fireEvent.click(optionNamed('We ship the launcher on Friday.')!)

    expect(showSource).toHaveBeenCalledWith(expect.objectContaining({ id: 'b1' }))
    // Not reached, so the box stays and says why.
    expect(onClose).not.toHaveBeenCalled()
    await waitFor(() => expect(screen.getByTestId('answer').textContent).toContain('That message is not loaded'))
  })
})

describe('what the frame is told, so Escape can keep the box', () => {
  it('holds nothing when empty and holds the words once something is typed', async () => {
    const onState = vi.fn<(state: LauncherState) => void>()
    const { type } = mount(standIn(), {}, { onState })

    await waitFor(() => expect(onState).toHaveBeenLastCalledWith({ holds: false, status: null }))
    type('launch')

    await waitFor(() => expect(onState).toHaveBeenLastCalledWith({ holds: true, status: null }))
  })

  it('reports an answer the person is looking at as seen, with no dot to show', async () => {
    const onState = vi.fn<(state: LauncherState) => void>()
    const host = standIn()
    const { field, type } = mount({ ...host, model: { ...host.model, promptForText: async () => 'On Friday [1].' } }, PAGE, { onState })

    type('when do we ship')
    fireEvent.keyDown(field(), { key: 'Enter' })

    await waitFor(() => expect(screen.getByTestId('answer')).toBeTruthy())
    await waitFor(() => expect(onState).toHaveBeenLastCalledWith({ holds: true, status: null }))
    // On its way, the search would have said "working".
    expect(onState).toHaveBeenCalledWith({ holds: true, status: 'working' })
  })
})

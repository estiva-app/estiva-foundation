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
import { PLAN, standIn } from './standIn.js'

afterEach(cleanup)

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
    // The sentence is kept, named by where it was asked (KIN-12).
    const ask = { text: 'when do we ship', where: 'a conversation', here: true }
    await waitFor(() => expect(onState).toHaveBeenLastCalledWith({ holds: true, status: null, ask }))
    // On its way, the search would have said "working".
    expect(onState).toHaveBeenCalledWith({ holds: true, status: 'working', ask })
  })
})

describe('another app’s creation on a team, where the app whose kind a team is is not listed (KIN-11)', () => {
  const SHIP_MANIFEST = '31990:bb:estiva-ship'
  const field = (name: string) => ({ name, type: 'string', required: true })
  const reads = {
    30850: {
      actions: [{ id: 'add-issue', label: 'Add issue', control: 'form', fields: [field('title')] }],
      manifest: SHIP_MANIFEST,
      parents: [{ address: '30850:bb:website', title: 'Website' }],
    },
    39000: {
      actions: [{ id: 'add-project', label: 'New project', control: 'form', fields: [field('name')], declaredBy: { address: SHIP_MANIFEST } }],
      parents: [],
      parentsFor: { 'add-project': [{ address: '39000:rr:ops', title: 'Ops' }] },
    },
  } as unknown as Record<number, Awaited<ReturnType<LauncherHost['manifests']['creatableUnder']>>>

  it('offers Ship’s New project in a box that lists Leaf and Ship but not Peek, as Leaf’s does', async () => {
    const host = standIn({
      // As Leaf lists them: itself, and Ship, whose issue and project it may make.
      apps: launcherApps('leaf').filter((app) => app.isHost || app.id === 'ship'),
      maySign: (kind) => [30023, 30850, 30851].includes(kind),
      manifests: { creatableUnder: async (kind) => reads[kind] ?? null, applyAction: async () => ({ ok: true }), resolveObject: async () => null },
    })
    const { type } = mount(host)

    type('create a project for the website launch')

    await waitFor(() => expect(optionNamed('Add issue')).toBeTruthy())
    expect(optionNamed('New project')).toBeTruthy()
  })
})

describe("Leaf's New document in Ship's and Peek's ⌘K (KIN-9)", () => {
  const LEAF = '31990:9b0ff001e909e0c6eb9165b81118b0c580db2584c87e1c794a2ec9339f7541ec:estiva-leaf'
  const declared = (id: string, label: string, address: string) => ({
    id,
    label,
    control: 'form',
    fields: [{ name: 'title', type: 'string', required: true }],
    declaredBy: { address },
  })
  // With no `maySign`, the box offers every action read, as Peek's does.
  const box = (declaredBy: string, maySign?: (kind: number) => boolean) => {
    const ops = [{ address: '39000:rr:ops', title: 'Ops' }]
    const reads = {
      39000: {
        // Leaf's own key also declares a New page, so a box that has read the team shows it either way.
        actions: [declared('add-document', 'New document', declaredBy), declared('add-page', 'New page', LEAF)],
        parents: [],
        parentsFor: { 'add-document': ops, 'add-page': ops },
      },
    } as unknown as Record<number, Awaited<ReturnType<LauncherHost['manifests']['creatableUnder']>>>
    return standIn({
      apps: launcherApps('ship'),
      ...(maySign ? { maySign } : {}),
      manifests: { creatableUnder: async (kind) => reads[kind] ?? null, applyAction: async () => ({ ok: true }), resolveObject: async () => null },
    })
  }

  it("suggests Leaf's New document, marked Leaf, in Ship's box when Ship may sign a document", async () => {
    const { type } = mount(box(LEAF, (kind) => [30850, 30851, 30842].includes(kind)))

    type('write a document for the launch plan')

    await waitFor(() => expect(optionNamed('New document')).toBeTruthy())
    expect(optionNamed('New document')!.textContent).toContain('Leaf')
  })

  it("does not suggest a New document that another key's manifest declares as Leaf's", async () => {
    const { type } = mount(box('31990:ee11:estiva-leaf'))

    type('write a document for the launch plan')

    await waitFor(() => expect(optionNamed('New page')).toBeTruthy())
    expect(optionNamed('New document')).toBeUndefined()
  })
})

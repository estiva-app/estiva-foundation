/**
 * KIN-12 — the asks you made in this tab wait under Recent.
 *
 * The box is held as every app holds it (`useKeptLauncher` around its own
 * `CommandLauncher`), in a stand-in app with two conversations to move between.
 * Each test drives what Miky does on production: ask in one place, move, press
 * ⌘K, and read what the box and the search's dot say.
 */
import { useCallback, useState } from 'react'
import { afterEach, describe, expect, it } from 'vitest'
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { ToastProvider } from '@estiva-app/ui'
import { CommandLauncher } from '../src/CommandLauncher.js'
import type { LauncherContext } from '../src/host.js'
import { useKeptLauncher } from '../src/useKeptLauncher.js'
import { standIn } from './standIn.js'

afterEach(cleanup)

const WEEKLY = 'Weekly sync'
const DESIGN = 'Design review'

function place(name: string): LauncherContext {
  return {
    composer: { label: name },
    conversation: { references: [], messages: [{ id: `${name}-1`, author: 'Miky', timestamp: '9:41 AM', body: `We decided it in ${name}.` }] },
  }
}

/** The model's answers, given by the test when it wants them to arrive. */
function model() {
  const waiting: ((text: string) => void)[] = []
  return {
    promptForText: () => new Promise<string | null>((resolve) => waiting.push(resolve)),
    answer: (n: number, text: string) => act(() => waiting[n](text)),
    asked: () => waiting.length,
  }
}

function mountApp() {
  const m = model()
  const put: string[] = []
  function App() {
    const [at, setAt] = useState(WEEKLY)
    const capture = useCallback(() => place(at), [at])
    const base = standIn()
    const host = {
      ...base,
      path: { pathname: `/t/${at.replace(' ', '-').toLowerCase()}`, search: '' },
      model: { ...base.model, promptForText: m.promptForText },
      answerActions: () => [{ id: 'put', label: 'Put the answer in the message box', run: () => (put.push(at), true) }],
    }
    const kept = useKeptLauncher(capture, (box) => <CommandLauncher host={host} {...box} />)
    return (
      <ToastProvider>
        <button onClick={kept.toggle}>Search</button>
        <button onClick={() => setAt(at === WEEKLY ? DESIGN : WEEKLY)}>Move</button>
        <output data-testid="dot">{kept.searchStatus ?? 'none'}</output>
        {kept.launcher}
      </ToastProvider>
    )
  }
  render(<App />)
  const field = () => document.querySelector<HTMLInputElement | HTMLTextAreaElement>('[data-command-palette-field]')
  return {
    ...m,
    put,
    field,
    /** ⌘K, or the bar's search. */
    search: () => fireEvent.click(screen.getByText('Search')),
    move: () => fireEvent.click(screen.getByText('Move')),
    dot: () => screen.getByTestId('dot').textContent,
    ask: (sentence: string) => {
      fireEvent.change(field()!, { target: { value: sentence } })
      fireEvent.keyDown(field()!, { key: 'Enter' })
    },
  }
}

const options = () => screen.queryAllByRole('option')
const row = (text: string) => options().find((o) => o.textContent?.includes(text))

describe('an ask waits under Recent wherever the person goes', () => {
  it('opens fresh about the new place, lists the ask "in" where it was asked, and picking it brings its answer back', async () => {
    const app = mountApp()
    app.search()
    app.ask('when do we ship the launcher')
    await waitFor(() => expect(app.asked()).toBe(1))
    app.answer(0, 'On Friday [1].')
    await waitFor(() => expect(screen.getByTestId('answer').textContent).toContain('On Friday'))

    app.search()
    app.move()
    app.search()

    expect(app.field()!.value).toBe('')
    expect(screen.getByText(DESIGN)).toBeTruthy()
    expect(row('when do we ship the launcher')?.textContent).toContain(`in ${WEEKLY}`)

    fireEvent.click(row('when do we ship the launcher')!)

    await waitFor(() => expect(app.field()!.value).toBe('when do we ship the launcher'))
    expect(screen.getByTestId('answer').textContent).toContain('On Friday')
  })

  it('shows the ask as it was where it was asked', async () => {
    const app = mountApp()
    app.search()
    app.ask('when do we ship the launcher')
    await waitFor(() => expect(app.asked()).toBe(1))
    app.answer(0, 'On Friday [1].')
    await waitFor(() => expect(screen.getByTestId('answer')).toBeTruthy())

    app.search()
    app.search()

    expect(app.field()!.value).toBe('when do we ship the launcher')
    expect(screen.getByTestId('answer').textContent).toContain('On Friday')
  })
})

describe('the dot says what a kept ask is doing', () => {
  it('works while hidden and moved away, then lights the answer first in a fresh box until it is seen', async () => {
    const app = mountApp()
    app.search()
    app.ask('when do we ship the launcher')
    await waitFor(() => expect(app.asked()).toBe(1))

    app.search()
    expect(app.dot()).toBe('working')
    app.move()
    app.answer(0, 'On Friday [1].')
    await waitFor(() => expect(app.dot()).toBe('waiting'))

    app.search()
    // Recent comes first while an answer waits, so the ask is the lit row and Enter opens it.
    expect(options()[0].textContent).toContain('when do we ship the launcher')
    expect(options()[0].textContent).toContain('an answer is waiting')
    fireEvent.keyDown(app.field()!, { key: 'Enter' })
    await waitFor(() => expect(screen.getByTestId('answer').textContent).toContain('On Friday'))

    app.search()
    expect(app.dot()).toBe('none')
    app.search()
    expect(app.field()!.value).toBe('')
    expect(row('when do we ship the launcher')?.textContent).toBeTruthy()
    expect(row('when do we ship the launcher')?.textContent).not.toMatch(/an answer is waiting|working on what you asked/)
  })

  it('keeps two asks working at once, each answered about where it was asked', async () => {
    const app = mountApp()
    app.search()
    app.ask('when do we ship the launcher')
    await waitFor(() => expect(app.asked()).toBe(1))
    app.search()
    app.move()
    app.search()
    app.ask('who reviews the new colours')
    await waitFor(() => expect(app.asked()).toBe(2))
    app.search()

    app.answer(0, 'On Friday [1].')
    app.answer(1, 'Katerina does [1].')
    await waitFor(() => expect(app.dot()).toBe('waiting'))

    app.move()
    app.search()
    expect(row('when do we ship the launcher')?.textContent).toContain(`in ${WEEKLY}`)
    expect(row('who reviews the new colours')?.textContent).toContain(`in ${DESIGN}`)
    fireEvent.click(row('who reviews the new colours')!)
    await waitFor(() => expect(screen.getByTestId('answer').textContent).toContain('Katerina does'))
  })
})

describe('only the person forgets an ask', () => {
  it('keeps the ask after its answer is used, and forgets it on Ctrl+Backspace and on Clear recent', async () => {
    const app = mountApp()
    app.search()
    app.ask('when do we ship the launcher')
    await waitFor(() => expect(app.asked()).toBe(1))
    app.answer(0, 'On Friday [1].')
    await waitFor(() => expect(row('Put the answer in the message box')).toBeTruthy())

    fireEvent.click(row('Put the answer in the message box')!)
    await waitFor(() => expect(app.field()).toBeNull())
    expect(app.put).toEqual([WEEKLY])

    app.search()
    expect(app.field()!.value).toBe('')
    expect(row('when do we ship the launcher')).toBeTruthy()

    // Light the ask's row and forget it.
    const at = options().indexOf(row('when do we ship the launcher')!)
    for (let i = 0; i < at; i++) fireEvent.keyDown(app.field()!, { key: 'ArrowDown' })
    fireEvent.keyDown(app.field()!, { key: 'Backspace', ctrlKey: true })
    await waitFor(() => expect(row('when do we ship the launcher')).toBeUndefined())

    app.search()
    app.search()
    app.ask('who reviews the new colours')
    await waitFor(() => expect(app.asked()).toBe(2))
    app.search()
    app.move()
    app.search()
    expect(row('who reviews the new colours')).toBeTruthy()
    fireEvent.click(row('Clear recent')!)
    await waitFor(() => expect(row('who reviews the new colours')).toBeUndefined())
    app.search()
    expect(app.dot()).toBe('none')
  })
})

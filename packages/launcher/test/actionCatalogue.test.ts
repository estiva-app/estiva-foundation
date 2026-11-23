/**
 * INT-5 — the selection, and the reason it is safe.
 *
 * The property under test is not "the model picks well". It is that **whatever
 * the model says, only a real declared action can come out** — because
 * structured output is refused on some builds, so this answer arrives through
 * the lenient path and can be anything at all.
 *
 * There is a second property these tests are written to keep, and it is the
 * one that would be easiest to lose in a later edit: **nothing here names an
 * app or an object.** The fixtures below are deliberately an app nobody has
 * written, declaring an action nobody has declared. If a future change makes
 * these tests need Ship, or an issue, the change is the bug.
 */
import { describe, expect, it } from 'vitest'
import type { ResolvedAction } from '@estiva-app/interop'
import type { CatalogueEntry } from '../src/actionCatalogue.js'
import { NO_PROPOSAL, PROPOSAL_SCHEMA, isProposable, probeable, proposalInstruction, readProposal } from '../src/actionCatalogue.js'
import type { LauncherApp } from '../src/launcherActions.js'

const action = (id: string, over: Partial<ResolvedAction> = {}): ResolvedAction => ({
  id,
  label: 'Log a sighting',
  description: 'Record that a bird was seen, with the species and where it was.',
  control: 'form',
  fields: [{ name: 'species', type: 'string', required: true }],
  ...over,
})

const entry = (id: string, over: Partial<CatalogueEntry> = {}): CatalogueEntry => ({
  appId: 'aviary',
  appLabel: 'Aviary',
  action: action(id),
  launcher: { id, label: 'Log a sighting', fields: [], submitLabel: 'Log' } as CatalogueEntry['launcher'],
  vocabularies: {},
  parents: [],
  ...over,
})

describe('what may be proposed', () => {
  it('proposes an action that writes', () => {
    // Safe by construction: nothing here invokes anything. A proposal opens a
    // form and a person submits it.
    expect(isProposable(action('a', { effect: 'writes' }))).toBe(true)
  })

  it('proposes an action whose manifest said nothing', () => {
    /*
      Absent means *unknown* per the interop layer, and unknown cannot
      self-invoke either. Excluding it would make this do nothing for every app
      that has not adopted the field — which is most of them.
    */
    expect(isProposable(action('a'))).toBe(true)
  })

  it('never proposes a destructive action', () => {
    // A judgement, not an RFC rule: a model reading a thread and offering to
    // delete something is a footgun a form in between does not defuse.
    expect(isProposable(action('a', { effect: 'destructive' }))).toBe(false)
  })
})

describe('the prompt', () => {
  const entries = [entry('log-sighting'), entry('ring-bird', { appLabel: 'Ringing', appId: 'ringing' })]

  it('offers the id, the app and the declared description', () => {
    // The description is the matching material — RFC 0.4 §13.4 took the seam
    // for exactly this consumer.
    const instruction = proposalInstruction('we saw a kingfisher by the weir', entries)

    expect(instruction).toContain('log-sighting — Aviary: Log a sighting — Record that a bird was seen')
    expect(instruction).toContain('ring-bird — Ringing: Log a sighting')
  })

  it('names the app on every line, because a label alone is ambiguous', () => {
    // Two apps declaring the same label is not hypothetical; it is the fixture.
    const instruction = proposalInstruction('...', entries)
    expect(instruction).toContain('Aviary:')
    expect(instruction).toContain('Ringing:')
  })

  it('survives an action that declared no description', () => {
    const bare = entry('bare', { action: action('bare', { description: undefined }) })
    expect(proposalInstruction('...', [bare])).toContain('bare — Aviary: Log a sighting')
  })

  it('lets the model decline', () => {
    /*
      Given a lunch thread and a list of actions a model will otherwise pick
      one, and a confident irrelevant proposal is worse than none.
    */
    expect(proposalInstruction('...', entries)).toContain(NO_PROPOSAL)
  })

  it('carries the conversation as the material', () => {
    expect(proposalInstruction('we saw a kingfisher by the weir', entries)).toContain('we saw a kingfisher by the weir')
  })

  it('asks only for an id and a sentence', () => {
    // Not the field values. Those are PEE-5's job and come from the action's
    // own declared schema; asking for them here would mean inventing a shape
    // that has to match every app's fields.
    expect(Object.keys(PROPOSAL_SCHEMA.properties)).toEqual(['action', 'preview'])
  })
})

describe('readProposal — only a real action comes out', () => {
  const entries = [entry('log-sighting'), entry('ring-bird')]

  it('resolves an id that was declared', () => {
    const proposal = readProposal({ action: 'log-sighting', preview: 'A kingfisher at the weir' }, entries)

    expect(proposal?.entry.action.id).toBe('log-sighting')
    expect(proposal?.preview).toBe('A kingfisher at the weir')
  })

  it('drops an id nothing declared', () => {
    // The whole reason this is safe. The lenient path can return anything.
    expect(readProposal({ action: 'delete-everything', preview: 'go on' }, entries)).toBeNull()
  })

  it('drops the decline word, which is not an action', () => {
    expect(readProposal({ action: NO_PROPOSAL, preview: 'nothing fits' }, entries)).toBeNull()
  })

  it('drops a non-string id rather than coercing it', () => {
    // `promptForObject` is typed `unknown` because it is: a number or an object
    // where a string was asked for is a real outcome of the lenient path.
    expect(readProposal({ action: 3 } as unknown as Record<string, unknown>, entries)).toBeNull()
    expect(readProposal({ action: { id: 'log-sighting' } } as unknown as Record<string, unknown>, entries)).toBeNull()
  })

  it('drops nothing at all', () => {
    expect(readProposal(null, entries)).toBeNull()
    expect(readProposal({}, entries)).toBeNull()
  })

  it('falls back to the action label when no preview came back', () => {
    // An empty preview would render as a proposal with no words in it.
    expect(readProposal({ action: 'log-sighting' }, entries)?.preview).toBe('Log a sighting')
  })

  it('ignores surrounding whitespace on the id', () => {
    expect(readProposal({ action: '  log-sighting \n' }, entries)?.entry.appId).toBe('aviary')
  })
})

describe('probeable', () => {
  const app = (id: string, parentKind?: number) =>
    ({ id, label: id, description: '', placeholder: '', vocabularies: {}, actions: [], parentKind }) as LauncherApp

  it('asks only apps that say what to query', () => {
    // A projection is per kind, so finding a manifest means querying one of the
    // app's records — an app that names no kind cannot be probed at all.
    expect(probeable([app('a', 30850), app('b')]).map((x) => x.id)).toEqual(['a'])
  })

  it('is empty rather than throwing when nothing declares one', () => {
    expect(probeable([app('b')])).toEqual([])
  })
})

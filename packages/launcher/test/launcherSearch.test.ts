/**
 * PEE-4 — matching, and the empty state that has to tell two silences apart.
 *
 * The wording assertions here look fussy and are the ticket's done-when: *"the
 * empty state distinguishes 'nothing matched' from 'nothing you can read'"*.
 * Those were one sentence before, and one sentence is what made a refused read
 * indistinguishable from an empty one everywhere else in this app (PEE-10).
 */
import { describe, expect, it } from 'vitest'
import type { LauncherPerson as Person } from '../src/host.js'
import { isPrompt, snippetAround, matchPeople, messageEmptyState, type MessageSearchState } from '../src/launcherSearch.js'

describe('isPrompt — when the words stop being a search (a77dd5e3)', () => {
  it('is a search up to two words, and a prompt from the third', () => {
    expect(isPrompt('')).toBe(false)
    expect(isPrompt('launch')).toBe(false)
    expect(isPrompt('launch plan ')).toBe(false)
    expect(isPrompt('launch plan review')).toBe(true)
    expect(isPrompt('  what did   we decide  ')).toBe(true)
  })

  it('keeps search syntax a search at any length: a quoted phrase, a word left out', () => {
    expect(isPrompt('"launch plan" review draft')).toBe(false)
    expect(isPrompt('launch plan -draft')).toBe(false)
  })

  it('reads a hyphen inside a word, or a dash on its own, as part of a sentence', () => {
    expect(isPrompt('follow-up on pricing')).toBe(true)
    expect(isPrompt('pricing - what changed')).toBe(true)
  })
})

const PEOPLE: Person[] = [
  { id: 'alice', name: 'Alice Johnson', role: 'Product Designer' },
  { id: 'daniel', name: 'Daniel Stanton', role: 'Backend Engineer' },
  { id: 'juan', name: 'Juan Foley', role: 'Frontend Engineer' },
]

describe('matchPeople', () => {
  it('matches the start of a name word', () => {
    expect(matchPeople(PEOPLE, 'john').map((p) => p.id)).toEqual(['alice'])
  })

  it('matches a role, because that is where "designer" is written down', () => {
    expect(matchPeople(PEOPLE, 'designer').map((p) => p.id)).toEqual(['alice'])
    expect(matchPeople(PEOPLE, 'engineer').map((p) => p.id)).toEqual(['daniel', 'juan'])
  })

  it('matches words of a name and a role in any order, and leaves out a minus word', () => {
    expect(matchPeople(PEOPLE, 'eng juan').map((p) => p.id)).toEqual(['juan'])
    expect(matchPeople(PEOPLE, 'engineer -back').map((p) => p.id)).toEqual(['juan'])
  })

  it('never matches the middle of a word', () => {
    expect(matchPeople(PEOPLE, 'ohnson')).toEqual([])
    expect(matchPeople(PEOPLE, 'gineer')).toEqual([])
  })
})

describe('the panel’s one rule (SPEC §5.2), on the people it holds', () => {
  const claude: Person[] = [{ id: 'claude', name: 'Claude', role: 'Product agent' }]

  it('a word start in any order, an exact phrase in quotes', () => {
    expect(matchPeople(claude, 'ag prod')).toEqual(claude)
    expect(matchPeople(claude, '"product agent"')).toEqual(claude)
    expect(matchPeople(claude, '"agent product"')).toEqual([])
  })

  it('not the middle of a word: "aud" does not find Claude', () => {
    expect(matchPeople(claude, 'aud')).toEqual([])
    expect(matchPeople(claude, 'cla')).toEqual(claude)
  })
})

describe('messageEmptyState', () => {
  const done = (count: number): MessageSearchState => ({ kind: 'done', count })

  it('says nothing when there are results to show', () => {
    expect(messageEmptyState(done(3))).toBeNull()
  })

  it('says nothing before anything is typed', () => {
    expect(messageEmptyState({ kind: 'idle' })).toBeNull()
  })

  it('states it plainly when a fragment found nothing — the relay matches word starts (SPEC §5.2)', () => {
    expect(messageEmptyState(done(0))).toBe('No messages matched.')
  })

  it('distinguishes "nothing you can read" from "nothing matched"', () => {
    // The done-when, in one assertion. `not_a_member` is an answer arrived at
    // successfully, not an outage.
    expect(messageEmptyState({ kind: 'failed', failure: 'not_a_member' })).toBe(
      'No messages you can read match — some conversations are not yours to see.',
    )
  })

  it('does not report a refusal as an empty result', () => {
    expect(messageEmptyState({ kind: 'failed', failure: 'refused' })).toBe(
      'The relay refused the search, so this list is incomplete.',
    )
  })

  it('does not report an outage as a refusal', () => {
    // Retrying may work for one of these and not the other, which is why
    // RelayReadError classifies them rather than flattening them.
    expect(messageEmptyState({ kind: 'failed', failure: 'unreachable' })).toBe(
      'Could not reach the relay, so messages are not included.',
    )
  })

  it('says there was nothing to ask with when signed out', () => {
    // Not "no messages matched": that would be a claim about a corpus nobody
    // searched.
    expect(messageEmptyState({ kind: 'signed-out' })).toBe('Sign in to search messages.')
  })

  it('says it is working while it is working', () => {
    expect(messageEmptyState({ kind: 'searching' })).toBe('Searching messages…')
  })
})

describe('snippetAround', () => {
  const long =
    'We shipped the read-state cutover on Monday and then, much later in a very long ' +
    'message that nobody wants to read all of, mentioned the pipeline exactly once.'

  it('centres the window on the match rather than truncating the start', () => {
    // The reason this is worth keeping from the dead prototype module: a hit
    // whose term is late in a long message shows none of it under a plain
    // `slice(0, 80)`.
    const snippet = snippetAround(long, 'pipeline')
    expect(snippet).toContain('pipeline')
    expect(snippet.startsWith('…')).toBe(true)
  })

  it('centres on the first word asked for in a multi-word query, at a word start, never on a left-out word', () => {
    const draft = 'We redrafted the opening paragraph twice. ' + long
    for (const query of ['pipeline monday', '"pipeline exactly"', '-draft pipel']) {
      const snippet = snippetAround(draft, query)
      expect(snippet, query).toContain('pipeline')
      expect(snippet, query).not.toContain('redrafted')
    }
  })

  it('collapses whitespace, so a multi-line body stays one row', () => {
    expect(snippetAround('one\n\ntwo   three', 'two')).toBe('one two three')
  })

  it('falls back to the head of the text when the term is not in it', () => {
    // The `a` tag / stored-reference path can hand over a hit whose match is
    // not in the visible body; showing the opening beats showing nothing.
    expect(snippetAround('a short body', 'absent')).toBe('a short body')
  })
})

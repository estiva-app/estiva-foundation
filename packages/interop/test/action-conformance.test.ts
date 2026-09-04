/**
 * `actionProblems` — the producer half of action selection (PRO-16).
 *
 * The failure this guards is silent, and that is the only reason it is worth a
 * file. An app whose action `description` restates its label is rejected
 * nowhere: `resolveManifest` accepts it, every consumer renders it, and a
 * caller matching on that prose simply never picks it. There is no error to
 * find and no log to read.
 *
 * So the assertions are about **what a producer is told**, not about a boolean.
 * A check that says "invalid description" has not helped anybody.
 *
 * Ship has enforced these three rules privately since PRO-5. Nothing was wrong
 * with the rules; the problem was that they protected one manifest.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { ACTION_EFFECTS, MIN_ACTION_DESCRIPTION, actionProblems } from '../dist/index.js'

/** An action nobody here wrote, declared as it should be. */
const good = {
  id: 'log-sighting',
  label: 'Log a sighting',
  description: 'Record that a bird was seen, with the species, the place and who saw it.',
  effect: 'writes',
}

test('a well-declared action has nothing to say about it', () => {
  assert.deepEqual(actionProblems(good), [])
})

test('the label restated is named as such, not called short', () => {
  /*
    The common failure and the most useful message. Reporting "too short" for a
    description that is exactly the label sends the producer to pad it out
    rather than to write a different sentence.
  */
  const [problem, ...rest] = actionProblems({ ...good, description: good.label })

  assert.deepEqual(rest, [], 'one problem per declaration, not two')
  assert.match(problem, /gives its label/)
  assert.match(problem, /button caption/)
  assert.doesNotMatch(problem, /characters/)
})

test('it does not care about the case of a restated label', () => {
  // "Add issue" and "add issue" are the same mistake.
  assert.match(actionProblems({ ...good, description: 'log a sighting' })[0], /gives its label/)
})

test('a caption is told what it is and what the threshold is', () => {
  const [problem] = actionProblems({ ...good, description: 'Logs a bird' })

  assert.match(problem, /caption, not prose/)
  assert.match(problem, new RegExp(String(MIN_ACTION_DESCRIPTION)))
  // The offending text, so the producer does not have to go and find it.
  assert.match(problem, /Logs a bird/)
})

test('a missing description says what to write instead', () => {
  /*
    `widgetChainProblem`'s standard, and the reason both return sentences: the
    reader is a person about to sign a manifest, and a problem that does not say
    what good looks like leaves them guessing.
  */
  const [problem] = actionProblems({ id: 'log-sighting', label: 'Log a sighting', effect: 'writes' })

  assert.match(problem, /never pick/)
  assert.match(problem, /what the action makes, for whom, and when it applies/)
})

test('it names the action, every time', () => {
  // A manifest declares several. "A description is too short" is unactionable.
  for (const problem of actionProblems({ id: 'ring-bird', label: 'Ring', description: 'Ring' })) {
    assert.match(problem, /"ring-bird"/)
  }
})

test('an absent effect is reported with its consequence, not just its absence', () => {
  /*
    Absent is *legal* — the type is explicit that absent, unrecognised and
    pre-dating the field all mean unknown. It is still worth telling a producer,
    because unknown is read cautiously in both directions: a consumer offering
    only safe actions skips this one, and one avoiding destructive ones may
    offer it.
  */
  const problems = actionProblems({ id: 'log-sighting', label: 'Log a sighting', description: good.description })

  assert.equal(problems.length, 1)
  assert.match(problems[0], /no effect/)
  assert.match(problems[0], /unknown/)
  for (const effect of ACTION_EFFECTS) assert.match(problems[0], new RegExp(effect))
})

test('a typo in effect is called invisible, because it is', () => {
  // `withKnownEffect` drops what it does not recognise, so "write" for "writes"
  // publishes an action that silently declares nothing.
  const [problem] = actionProblems({ ...good, effect: 'write' })

  assert.match(problem, /not one of/)
  assert.match(problem, /invisible/)
  assert.match(problem, /"write"/)
})

test('it reports a bad description and a bad effect together', () => {
  // One round-trip per action, not one per rule.
  const problems = actionProblems({ id: 'ring-bird', label: 'Ring', description: 'Ring', effect: 'nope' })

  assert.equal(problems.length, 2)
  assert.match(problems[0], /gives its label/)
  assert.match(problems[1], /not one of/)
})

test('an action with no id says so, since that is what a caller names', () => {
  const problems = actionProblems({ label: 'Log a sighting', description: good.description, effect: 'safe' })
  assert.match(problems[0], /must declare an id/)
})

test('it survives anything a producer could hand it', () => {
  /*
    A manifest is JSON somebody wrote by hand. This is run *before* signing, so
    it is exactly where a malformed action turns up — throwing here would be a
    checker that only works on manifests that did not need checking.
  */
  for (const input of [null, undefined, 42, 'add-issue', [], [{ id: 'a' }], {}]) {
    const problems = actionProblems(input)
    assert.ok(Array.isArray(problems), `${JSON.stringify(input)} should return a list`)
    assert.ok(problems.length > 0, `${JSON.stringify(input)} is not publishable`)
    for (const problem of problems) assert.equal(typeof problem, 'string')
  }
})

test('nothing in resolution calls it', async () => {
  /*
    PRO-16's boundary, and the objection it had to answer. A weak description is
    a worse match, not an invalid manifest — a consumer that refused to render
    an app over its prose would be specifying the UI of every app that installed
    this package, which is the objection that rules out iframes.

    Asserted against the source rather than by reasoning: the only mention of
    this function outside its own definition and the exports would be a caller.
  */
  const { readFileSync } = await import('node:fs')
  const source = readFileSync(new URL('../src/projection.ts', import.meta.url), 'utf8')
  const callSites = source.match(/actionProblems\(/g) ?? []

  assert.equal(callSites.length, 1, 'actionProblems should be declared once and called nowhere')
})

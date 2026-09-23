/*
  Nesting drawn from one team listing — SPEC §6.7, FOL-4.

  The property every test comes back to: **every file in the listing is
  reachable, and nothing loops** — whatever parents people have written,
  including ones that point outside the listing or round in a circle.
*/
import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { nestingOf, type Nestable } from '../dist/index.js'

const file = (name: string, parent?: string): Nestable => ({
  ref: `30840:${'a'.repeat(64)}:${name}`,
  address: `30840:${'a'.repeat(64)}:${name}`,
  ...(parent ? { parentRef: `30840:${'a'.repeat(64)}:${parent}` } : {}),
})
const names = (files: (Nestable | undefined)[]) => files.map((f) => (f ? f.ref.split(':')[2] : 'top'))

/** Every file, reached from the roots by `childrenOf`, exactly once. */
function reachable(nesting: ReturnType<typeof nestingOf<Nestable>>): string[] {
  const out: string[] = []
  const walk = (f: Nestable) => {
    out.push(f.ref.split(':')[2])
    nesting.childrenOf(f).forEach(walk)
  }
  nesting.roots.forEach(walk)
  return out
}

describe('a file three levels deep', () => {
  const project = file('project')
  const brief = file('brief', 'project')
  const notes = file('notes', 'brief')
  const transcript = file('transcript', 'notes')
  const listing = [transcript, notes, project, brief]
  const nesting = nestingOf(listing)

  it('is drawn under its parent, which is drawn under its own', () => {
    assert.deepEqual(names(nesting.roots), ['project'])
    assert.deepEqual(names(nesting.childrenOf(project)), ['brief'])
    assert.deepEqual(names(nesting.childrenOf(notes)), ['transcript'])
    assert.deepEqual(reachable(nesting).sort(), ['brief', 'notes', 'project', 'transcript'])
  })

  it('has its breadcrumb outermost first, from the listing alone', () => {
    assert.deepEqual(names(nesting.ancestorsOf(transcript)), ['project', 'brief', 'notes'])
    assert.deepEqual(names(nesting.ancestorsOf(project)), [])
    assert.equal(nesting.parentOf(transcript), notes)
  })

  it('may move anywhere but under itself, and back to the top', () => {
    // Under `transcript` would be a cycle, and `brief` is where it already is.
    assert.deepEqual(names(nesting.moveTargetsOf(notes)), ['top', 'project'])
    assert.deepEqual(names(nesting.moveTargetsOf(transcript)), ['top', 'project', 'brief'])
    // A root is already at the top.
    assert.deepEqual(names(nesting.moveTargetsOf(project)), [])
  })
})

describe('a parent outside the listing', () => {
  it('draws the file at the top and names nothing above it', () => {
    // Another team's file, or one the reader cannot see: absent, not "unavailable".
    const orphan = file('orphan', 'elsewhere')
    const nesting = nestingOf([orphan])
    assert.deepEqual(names(nesting.roots), ['orphan'])
    assert.deepEqual(nesting.ancestorsOf(orphan), [])
  })

  it('draws a file naming itself at the top', () => {
    const selfish = file('selfish', 'selfish')
    assert.deepEqual(names(nestingOf([selfish]).roots), ['selfish'])
  })
})

describe('a cycle', () => {
  const a = file('a', 'b')
  const b = file('b', 'a')
  const under = file('under', 'a')
  const nesting = nestingOf([a, b, under])

  it('draws every member at the top rather than losing them', () => {
    // Before FOL-4 Peek's `peersOf` hid both: each named a listed parent.
    assert.deepEqual(names(nesting.roots), ['a', 'b'])
    assert.deepEqual(reachable(nesting).sort(), ['a', 'b', 'under'])
  })

  it('keeps a file merely under the cycle where it was put', () => {
    assert.deepEqual(names(nesting.childrenOf(a)), ['under'])
    assert.deepEqual(names(nesting.ancestorsOf(under)), ['a'])
  })

  it('never walks round it', () => {
    assert.deepEqual(nesting.ancestorsOf(a), [])
    assert.deepEqual(nesting.childrenOf(b), [])
  })
})

describe('a file with no address', () => {
  it('is never offered as a place to move to', () => {
    // A `parent` change names an address; a regular event has none.
    const message: Nestable = { ref: 'f'.repeat(64) }
    const topic = file('topic')
    const loose = file('loose', 'topic')
    assert.deepEqual(names(nestingOf([message, topic, loose]).moveTargetsOf(loose)), ['top'])
  })
})

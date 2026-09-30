/**
 * FOL-50 — the parent of each file in a set, for the price of the roots.
 *
 * Peek's Folder dots place an issue's talk under its project, and needed only
 * the parent of the 110 issues they name. `resolveForeignObjects` answered it
 * with every comment and child besides: 20 POSTs and a megabyte on production.
 * `resolveParents` reads the roots and, only where a kind can be moved, the
 * changes — and has to agree with the object readers on every answer, or a
 * moved issue would light one Folder and be drawn under another.
 */
import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import { resolveForeignObjects, resolveParents } from '../dist/index.js'

const AUTHOR = 'a'.repeat(64)
const OTHER = 'b'.repeat(64)
const PROJECT = 30850
const ISSUE = 30851
const CHANGE = 1851
const P1 = `${PROJECT}:${AUTHOR}:p1`
const P2 = `${PROJECT}:${AUTHOR}:p2`
const I = (d, pubkey = AUTHOR) => `${ISSUE}:${pubkey}:${d}`

let seq = 0
const event = (partial) => ({
  id: String(++seq).padStart(64, '0'),
  sig: '',
  pubkey: AUTHOR,
  created_at: 1_700_000_000 + seq,
  tags: [],
  content: '',
  ...partial,
})

/** Honours `limit` per filter and concatenates, as buzz does; counts every POST. */
function countingRelay(events, { fail } = {}) {
  const calls = []
  const matches = (f, e) => {
    if (f.kinds && !f.kinds.includes(e.kind)) return false
    if (f.authors && !f.authors.includes(e.pubkey)) return false
    for (const [key, want] of Object.entries(f)) {
      if (!key.startsWith('#')) continue
      const held = e.tags.filter((t) => t[0] === key.slice(1)).map((t) => t[1])
      if (!want.some((v) => held.includes(v))) return false
    }
    return true
  }
  const query = async (filters) => {
    calls.push(filters)
    if (fail?.(filters)) throw new Error('rate_limited')
    return filters.flatMap((f) =>
      events
        .filter((e) => matches(f, e))
        .sort((a, b) => b.created_at - a.created_at)
        .slice(0, f.limit ?? Infinity),
    )
  }
  // A read of anything but a manifest or a handler — what the set itself costs.
  const own = () => calls.filter((filters) => !filters.some((f) => f.kinds?.some((k) => k === 31990 || k === 31989)))
  return { query, calls, own }
}

const shipManifest = ({ movedBy = 'project' } = {}) =>
  event({
    kind: 31990,
    tags: [['d', 'ship'], ['k', String(PROJECT)], ['k', String(ISSUE)]],
    content: JSON.stringify({
      name: 'Ship',
      records: { changeKind: CHANGE, targetTag: 'a', fieldTag: 'field', valueTag: 'value' },
      projections: {
        [PROJECT]: {
          widget: 'card',
          slots: { title: { tag: 'title' }, list: { children: { kind: ISSUE, via: 'a', ...(movedBy ? { movedBy } : {}) } } },
        },
        [ISSUE]: { widget: 'row', slots: { title: { tag: 'title' } } },
      },
    }),
  })

const issue = (d, parent, pubkey = AUTHOR) =>
  event({ kind: ISSUE, pubkey, tags: [['d', d], ['title', d], ...(parent ? [['a', parent]] : [])] })
const move = (address, value) =>
  event({ kind: CHANGE, pubkey: OTHER, tags: [['a', address], ['field', 'project'], ['value', value]] })
const status = (address) => event({ kind: CHANGE, tags: [['a', address], ['field', 'status'], ['value', 'done']] })

describe('resolveParents', () => {
  test('each file’s parent: the root tag, a move over it, a move to the top', async () => {
    const relay = countingRelay([
      shipManifest(),
      issue('stays', P1),
      issue('moved', P1),
      move(I('moved'), P2),
      issue('detached', P1),
      move(I('detached'), ''),
      issue('orphan'),
      status(I('stays')),
    ])
    const parents = await resolveParents([I('stays'), I('moved'), I('detached'), I('orphan')], relay.query)
    assert.deepEqual(parents, { [I('stays')]: P1, [I('moved')]: P2, [I('detached')]: null, [I('orphan')]: null })
  })

  test('the latest move wins, whoever wrote it', async () => {
    const relay = countingRelay([shipManifest(), issue('twice', P1), move(I('twice'), P2), move(I('twice'), P1)])
    assert.deepEqual(await resolveParents([I('twice')], relay.query), { [I('twice')]: P1 })
  })

  test('absent when there is nothing to tell: not an address, no root, no app', async () => {
    const relay = countingRelay([shipManifest(), issue('here', P1)])
    const parents = await resolveParents(
      ['not an address', I('gone'), `31337:${AUTHOR}:nobody-draws-this`, I('here')],
      relay.query,
    )
    assert.deepEqual(parents, { [I('here')]: P1 })
  })

  test('agrees with the object readers on every file', async () => {
    const events = [
      shipManifest(),
      issue('stays', P1),
      issue('moved', P1),
      move(I('moved'), P2),
      issue('detached', P1),
      move(I('detached'), ''),
      issue('theirs', P2, OTHER),
      move(I('theirs', OTHER), P1),
    ]
    const refs = [I('stays'), I('moved'), I('detached'), I('theirs', OTHER)]
    const parents = await resolveParents(refs, countingRelay(events).query)
    const objects = await resolveForeignObjects(refs, countingRelay(events).query, async () => ({}))
    for (const ref of refs) assert.equal(parents[ref], objects[ref]?.parentRef ?? null, ref)
  })

  test('a hundred files are one read, with no comment or child filter in it', async () => {
    const events = [shipManifest()]
    const refs = []
    for (let n = 0; n < 100; n++) {
      events.push(issue(`i${n}`, P1))
      if (n % 3 === 0) events.push(move(I(`i${n}`), P2))
      refs.push(I(`i${n}`))
    }
    const relay = countingRelay(events)
    const parents = await resolveParents(refs, relay.query)
    assert.equal(relay.own().length, 1, 'one POST for the set')
    const kinds = new Set(relay.own()[0].flatMap((f) => f.kinds))
    assert.deepEqual([...kinds].sort(), [CHANGE, ISSUE], 'roots and changes, nothing else')
    for (let n = 0; n < 100; n++) assert.equal(parents[I(`i${n}`)], n % 3 === 0 ? P2 : P1)
  })

  test('an old move is not paged out behind a busy neighbour’s changes', async () => {
    const events = [shipManifest(), issue('moved-early', P1), move(I('moved-early'), P2), issue('busy', P1)]
    for (let n = 0; n < 1100; n++) events.push(status(I('busy')))
    const parents = await resolveParents([I('moved-early'), I('busy')], countingRelay(events).query)
    assert.deepEqual(parents, { [I('moved-early')]: P2, [I('busy')]: P1 })
  })

  test('a kind no list moves asks for no changes, and its root tag is the answer', async () => {
    const relay = countingRelay([shipManifest({ movedBy: null }), issue('stays', P1), move(I('stays'), P2)])
    assert.deepEqual(await resolveParents([I('stays')], relay.query), { [I('stays')]: P1 })
    assert.ok(!relay.own().flat().some((f) => f.kinds.includes(CHANGE)))
  })

  test('nothing to ask is no read', async () => {
    const relay = countingRelay([])
    assert.deepEqual(await resolveParents(['nope', ''], relay.query), {})
    assert.equal(relay.calls.length, 0)
  })

  test('a refused read rejects the whole call', async () => {
    const relay = countingRelay([shipManifest(), issue('stays', P1)], {
      fail: (filters) => filters.some((f) => f.kinds?.includes(ISSUE)),
    })
    await assert.rejects(resolveParents([I('stays')], relay.query), /rate_limited/)
  })
})

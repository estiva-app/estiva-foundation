/*
  A file's threads: read by `#e`, written per NIP-22's table — PRO-20.

  Moved down from Peek (FOL-19, `fileThreads.test.ts`), where the fold was
  measured on production first: every comment on a Ship issue carries `A/K/P`
  and `a/k/p` naming the issue plus `h`, the kinds off Ship's manifest are
  `[1111, 9]`, and no reply anywhere in the Folder carries a lowercase `a`. So
  the `#a` read that brings comments back with the file can never bring a
  reply, and the reply a consumer writes must not carry one either.
*/
import { beforeEach, describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { buildActionEvent, conversationsOf, threadsOf, type QueryFn } from '../dist/index.js'
import type { SignedEvent } from '@estiva-app/protocol'

const SHIP = 'b38fd2687b17bbde2e8079577cba601936acfe1b731d2d2ba7cdef29a063db46'
const CATH = 'a8a7d739dda599143ec2e88a1c3b2d69808cd2a50001179c786f51d00dc3c697'
const FOLDER = '85db5b59-9e49-4ea1-8e93-3d2a2d78c048'
const ISSUE = 30851
const COMMENT = 1111
const ADDRESS = `${ISSUE}:${SHIP}:d68a8c78-5ec7-4652-b236-89ab57ac5b1e`

let seq = 0
const event = (partial: Partial<SignedEvent> & { kind: number }): SignedEvent => ({
  id: String(++seq).padStart(64, '0'),
  sig: '',
  pubkey: SHIP,
  created_at: 1_700_000_000 + seq,
  tags: [],
  content: '',
  ...partial,
})

/** Ship's manifest as production declares it for an issue: 1111, also reading 9. */
const shipManifest = {
  name: 'Estiva Ship',
  records: { changeKind: 1851, targetTag: 'a', fieldTag: 'field', valueTag: 'value' },
  projections: { [ISSUE]: { widget: 'card', slots: { title: { tag: 'title' } } } },
  actions: [
    {
      id: 'comment',
      label: 'Comment',
      appliesTo: String(ISSUE),
      emits: { kind: COMMENT, scope: 'address', alsoRead: [9] },
      input: { type: 'string' },
    },
    {
      id: 'set-status',
      label: 'Set status',
      appliesTo: String(ISSUE),
      emits: { kind: 1851, field: 'status' },
      input: { type: 'string' },
    },
  ],
}
const manifest = event({
  kind: 31990,
  tags: [['d', 'estiva-ship'], ['k', String(ISSUE)]],
  content: JSON.stringify(shipManifest),
})

/** A top-level comment, in the shape production carries. */
const root = event({
  kind: COMMENT,
  content: 'First',
  tags: [['A', ADDRESS], ['K', String(ISSUE)], ['P', SHIP], ['a', ADDRESS], ['k', String(ISSUE)], ['p', SHIP], ['h', FOLDER]],
})
const other = event({ kind: COMMENT, content: 'Second', tags: [['a', ADDRESS], ['h', FOLDER]] })
/** Ship's own reply: `kind:9`, `['e', root, '', 'reply']`, no `a`. */
const shipReply = event({ kind: 9, content: 'From Ship', tags: [['e', root.id, '', 'reply'], ['h', FOLDER]] })
/** A NIP-22 reply: uppercase names the file, lowercase names the comment. */
const nipReply = event({
  kind: COMMENT,
  content: 'Per the NIP',
  pubkey: CATH,
  tags: [['A', ADDRESS], ['K', String(ISSUE)], ['P', SHIP], ['e', root.id], ['k', String(COMMENT)], ['p', SHIP], ['h', FOLDER]],
})
/** A reply to the reply: hangs off the reply's id, not the root's. */
const nested = event({ kind: COMMENT, content: 'Deeper', tags: [['A', ADDRESS], ['e', nipReply.id], ['k', String(COMMENT)], ['h', FOLDER]] })

let calls: Record<string, unknown>[][] = []
function relayOver(world: SignedEvent[]): QueryFn {
  return async (filters) => {
    calls.push(filters)
    return world.filter((e) =>
      filters.some((f) => {
        if (f.ids && !(f.ids as string[]).includes(e.id)) return false
        if (f.kinds && !(f.kinds as number[]).includes(e.kind)) return false
        if (f.authors && !(f.authors as string[]).includes(e.pubkey)) return false
        for (const [key, want] of Object.entries(f)) {
          if (!key.startsWith('#')) continue
          const held = e.tags.filter((t) => t[0] === key.slice(1)).map((t) => t[1])
          if (!(want as string[]).some((v) => held.includes(v))) return false
        }
        return true
      }),
    )
  }
}
const query = () => relayOver([manifest, root, other, shipReply, nipReply, nested])

beforeEach(() => {
  calls = []
})

describe('threadsOf reads every thread of a file in one request', () => {
  it('returns the roots as events, and the direct replies under each', async () => {
    const threads = await threadsOf(ADDRESS, [root.id, other.id], query())
    assert.equal(threads.roots[root.id]?.content, 'First')
    assert.equal(threads.roots[other.id]?.kind, COMMENT)
    assert.deepEqual(threads.replies[root.id]?.map((r) => r.content), ['From Ship', 'Per the NIP'])
    // Absent, not `[]`: a root with no replies has no entry to draw a "0" from.
    assert.equal(threads.replies[other.id], undefined)
  })

  it('takes both kinds off the manifest, so a Ship kind:9 reply and a NIP-22 one both arrive', async () => {
    const threads = await threadsOf(ADDRESS, [root.id], query())
    assert.deepEqual(threads.replies[root.id]?.map((r) => r.kind), [9, COMMENT])
  })

  it('reads one level: a reply to a reply hangs off the reply and is not counted here', async () => {
    const threads = await threadsOf(ADDRESS, [root.id], query())
    assert.ok(!threads.replies[root.id]?.some((r) => r.content === 'Deeper'))
  })

  it('asks once, with the ids and the #e filter in one POST', async () => {
    await threadsOf(ADDRESS, [root.id, other.id], query())
    // The manifest resolve is its own reads; the thread read is the last call.
    assert.deepEqual(calls.at(-1), [
      { ids: [root.id, other.id], limit: 2 },
      { kinds: [COMMENT, 9], '#e': [root.id, other.id], limit: 200 },
    ])
  })

  it('answers empty for no roots without asking, and for a reference that does not decode', async () => {
    assert.deepEqual(await threadsOf(ADDRESS, [], query()), { roots: {}, replies: {} })
    assert.equal(calls.length, 0)
    assert.deepEqual(await threadsOf('not a reference', [root.id], query()), { roots: {}, replies: {} })
  })

  it('answers empty where no app claims the kind, rather than guessing 1111', async () => {
    const threads = await threadsOf(ADDRESS, [root.id], relayOver([root, nipReply]))
    assert.deepEqual(threads, { roots: {}, replies: {} })
  })
})

describe('buildActionEvent({ replyTo }) writes NIP-22’s reply, not a second top-level comment', () => {
  const base = {
    manifest: shipManifest as never,
    kind: ISSUE,
    address: ADDRESS,
    objectAuthor: SHIP,
    folder: FOLDER,
    actionId: 'comment',
    value: 'Agreed.',
    pubkey: CATH,
    createdAtMs: 1_700_000_500_000,
  }

  it('keeps the uppercase trio on the file and points the lowercase trio at the parent', () => {
    const built = buildActionEvent({ ...base, replyTo: { id: root.id, kind: COMMENT, author: SHIP } })
    assert.ok(typeof built !== 'string', String(built))
    assert.equal(built.kind, COMMENT)
    assert.equal(built.content, 'Agreed.')
    assert.deepEqual(built.tags, [
      // The thread root is still the file — a reader scoping by `#A` finds it.
      ['A', ADDRESS],
      ['K', String(ISSUE)],
      ['P', SHIP],
      // The immediate parent is the comment: its id, its kind, its author.
      ['e', root.id],
      ['k', String(COMMENT)],
      ['p', SHIP],
      // The Folder still gates it.
      ['h', FOLDER],
    ])
  })

  it('names the parent’s kind, which for a Ship reply is 9 and not the comment kind', () => {
    const built = buildActionEvent({ ...base, replyTo: { id: shipReply.id, kind: 9, author: SHIP } })
    assert.ok(typeof built !== 'string')
    assert.ok(built.tags.some((t) => t[0] === 'k' && t[1] === '9'))
    assert.ok(built.tags.some((t) => t[0] === 'e' && t[1] === shipReply.id))
  })

  it('without replyTo is the top-level comment, unchanged', () => {
    const built = buildActionEvent(base)
    assert.ok(typeof built !== 'string')
    assert.deepEqual(built.tags, [
      ['A', ADDRESS], ['K', String(ISSUE)], ['P', SHIP],
      ['a', ADDRESS], ['k', String(ISSUE)], ['p', SHIP],
      ['h', FOLDER],
    ])
  })

  it('is refused on an action that is not a comment', () => {
    const built = buildActionEvent({ ...base, actionId: 'set-status', value: 'done', replyTo: { id: root.id, kind: COMMENT, author: SHIP } })
    assert.equal(typeof built, 'string')
  })

  it('round-trips: the reply it builds is on threadsOf and not on the #a read', async () => {
    const built = buildActionEvent({ ...base, replyTo: { id: root.id, kind: COMMENT, author: SHIP } })
    assert.ok(typeof built !== 'string')
    const reply = event({ ...built, pubkey: CATH })
    const world = relayOver([manifest, root, reply])
    const file = { ref: 'issue', address: ADDRESS } as never
    const onA = (await conversationsOf([file], world))['issue'] ?? []
    assert.deepEqual(onA.map((m) => m.id), [root.id])
    const threads = await threadsOf(ADDRESS, [root.id], world)
    assert.deepEqual(threads.replies[root.id]?.map((r) => r.id), [reply.id])
  })
})

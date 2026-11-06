/*
  A topic's All — the conversations of every file on its list, read in one go
  and kept live (SPEC §11.8, §6.4, §6.6).

  The list holds a Leaf page, a Ship issue and a Ship project, each in a team
  other than the topic's. Only what is said on those three files is the
  topic's: never a comment on an issue under the listed project, never a
  comment whose `A` and `O` name different files.
*/
import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import {
  foldThreads,
  KIND_ASSERTION,
  KIND_COMMENT,
  KIND_DELETION,
  KIND_EDIT,
  KIND_REACTION,
} from '@estiva-app/conversation'
import {
  listedConversations,
  listedConversationsOf,
  planListInTopic,
  watchListedConversations,
  type ListedConversations,
  type ListedFile,
} from '../dist/index.js'
import type { SignedEvent, UnsignedEvent } from '@estiva-app/protocol'

const QA1 = 'a'.repeat(64)
const QA2 = 'b'.repeat(64)
const SHIP = 'c'.repeat(64)
const TOPIC_TEAM = '7b32200c-e4c0-4216-b79a-8490fc05e0bd'
const LEAF_TEAM = '0e2f4c1a-5b6d-4e7f-8a9b-0c1d2e3f4a5b'
const SHIP_TEAM = '85db5b59-9e49-4ea1-8e93-3d2a2d78c048'
const MS = 1_787_142_018_561

const TOPIC_D = '3c9d1e2f-4a5b-4c6d-8e7f-901a2b3c4d5e'
const TOPIC = `30840:${QA1}:${TOPIC_D}`
const PAGE_D = '9e8d7c6b-5a49-4382-9716-05f4e3d2c1b0'
const PAGE = `30842:${QA1}:${PAGE_D}`
const ISSUE_D = 'd68a8c78-5ec7-4652-b236-89ab57ac5b1e'
const ISSUE = `30851:${SHIP}:${ISSUE_D}`
const PROJECT_D = '5d6e7f80-9a1b-4c2d-8e3f-4a5b6c7d8e9f'
const PROJECT = `30850:${SHIP}:${PROJECT_D}`
/** An issue under the listed project: not on the topic's list. */
const CHILD_D = '11111111-2222-4333-8444-555555555555'
const CHILD = `30851:${SHIP}:${CHILD_D}`

let seq = 0
const event = (partial: Partial<SignedEvent> & { kind: number }): SignedEvent => ({
  id: (++seq).toString(16).padStart(64, '0'),
  sig: '',
  pubkey: QA2,
  created_at: 1_787_000_000 + seq,
  tags: [],
  content: '',
  ...partial,
})
const signed = (unsigned: UnsignedEvent): SignedEvent => event({ ...unsigned })

const root = (kind: number, pubkey: string, d: string, team: string) => event({ kind, pubkey, tags: [['d', d], ['title', d.slice(0, 4)], ['h', team]] })
const listing = (file: string) => signed(planListInTopic(QA1, MS + seq, { topic: { address: TOPIC, folder: TOPIC_TEAM }, file })[0])

/** Ship's manifest as production declares it: comments are 1111, and it also reads its older kind:9. */
const shipManifest = event({
  kind: 31990,
  pubkey: SHIP,
  tags: [['d', 'estiva-ship'], ['k', '30850'], ['k', '30851']],
  content: JSON.stringify({
    name: 'Estiva Ship',
    records: { changeKind: 1851, targetTag: 'a', fieldTag: 'field', valueTag: 'value' },
    projections: { 30851: { widget: 'card', slots: { title: { tag: 'title' } } }, 30850: { widget: 'card', slots: { title: { tag: 'title' } } } },
    actions: [{ id: 'comment', label: 'Comment', appliesTo: '30851', emits: { kind: KIND_COMMENT, scope: 'address', alsoRead: [9] }, input: { type: 'string' } }],
  }),
})

const comment = (address: string, team: string, body: string, extra: string[][] = []) =>
  event({ kind: KIND_COMMENT, content: body, tags: [['A', address], ['K', address.split(':')[0]], ['a', address], ['h', team], ...extra] })
const reply = (address: string, parent: SignedEvent, team: string, body: string) =>
  event({ kind: KIND_COMMENT, content: body, pubkey: QA1, tags: [['A', address], ['e', parent.id], ['k', '1111'], ['p', parent.pubkey], ['h', team]] })
const reaction = (target: SignedEvent, by = QA1) => event({ kind: KIND_REACTION, pubkey: by, content: '+', tags: [['e', target.id], ['p', target.pubkey]] })

// The world on the relay.
const topicRoot = root(30840, QA1, TOPIC_D, TOPIC_TEAM)
const pageRoot = root(30842, QA1, PAGE_D, LEAF_TEAM)
const issueRoot = root(30851, SHIP, ISSUE_D, SHIP_TEAM)
const projectRoot = root(30850, SHIP, PROJECT_D, SHIP_TEAM)
const childRoot = root(30851, SHIP, CHILD_D, SHIP_TEAM)
const lists = [listing(PAGE_D), listing(ISSUE_D), listing(PROJECT_D)]

const onPage = comment(PAGE, LEAF_TEAM, 'On the page')
/** Written by id alone (§6.4's `O` form), and filed in the topic's team. */
const onPageById = event({ kind: KIND_COMMENT, content: 'By id', tags: [['O', PAGE_D], ['h', TOPIC_TEAM]] })
const replyOnPage = reply(PAGE, onPage, LEAF_TEAM, 'A reply')
const edit = event({ kind: KIND_EDIT, content: 'On the page, edited', tags: [['e', onPage.id], ['h', LEAF_TEAM]] })
const liked = reaction(replyOnPage)
const resolved = event({ kind: KIND_ASSERTION, pubkey: QA1, tags: [['e', onPage.id], ['t', 'resolution'], ['action', 'resolved'], ['h', LEAF_TEAM]] })
const onIssue = comment(ISSUE, SHIP_TEAM, 'On the issue')
/** Ship's own older reply: kind:9, the comment named by `e`, no `A`. */
const shipReply = event({ kind: 9, pubkey: SHIP, content: 'From Ship', tags: [['e', onIssue.id, '', 'reply'], ['h', SHIP_TEAM]] })
const onProject = comment(PROJECT, SHIP_TEAM, 'On the project')
const onChild = comment(CHILD, SHIP_TEAM, 'On an issue under the project')
/** `A` names the page and `O` the issue: about neither (§6.4). */
const crossed = event({ kind: KIND_COMMENT, content: 'Crossed', tags: [['A', PAGE], ['O', ISSUE_D], ['h', LEAF_TEAM]] })
const deleted = reply(PAGE, onPage, LEAF_TEAM, 'Taken back')
const deletion = event({ kind: KIND_DELETION, pubkey: QA1, tags: [['e', deleted.id]] })

const world = [
  topicRoot, pageRoot, issueRoot, projectRoot, childRoot, ...lists, shipManifest,
  onPage, onPageById, replyOnPage, edit, liked, resolved, onIssue, shipReply, onProject, onChild, crossed, deleted, deletion,
]

type Filter = Record<string, unknown>
/** NIP-01 matching: ids, kinds, authors, since, and single-letter tags, any tag of the name matching. */
const matches = (e: SignedEvent, f: Filter) => {
  if (f.ids && !(f.ids as string[]).includes(e.id)) return false
  if (f.kinds && !(f.kinds as number[]).includes(e.kind)) return false
  if (f.authors && !(f.authors as string[]).includes(e.pubkey)) return false
  if (typeof f.since === 'number' && e.created_at < f.since) return false
  for (const [key, want] of Object.entries(f)) {
    if (!key.startsWith('#')) continue
    const held = e.tags.filter((t) => t[0] === key.slice(1)).map((t) => t[1])
    if (!(want as string[]).some((v) => held.includes(v))) return false
  }
  return true
}
function relayOver(events: SignedEvent[]) {
  const calls: Filter[][] = []
  const query = async (filters: Filter[]) => {
    calls.push(filters)
    return events.filter((e) => filters.some((f) => matches(e, f)))
  }
  return { query, calls }
}

const fileOf = (read: ListedConversations, file: string) => read.files.find((f) => f.file === file)
const bodies = (read: ListedConversations, file: string) =>
  foldThreads(fileOf(read, file)?.events ?? []).map((t) => [t.root?.body, ...t.replies.map((r) => r.body)])

describe("a topic's All, read cold", () => {
  it('returns every thread on each listed file — by address and by id, with replies, edits, reactions and resolutions', async () => {
    const { query } = relayOver(world)
    const read = await listedConversations(query, TOPIC)
    assert.deepEqual(read.files.map((f) => f.file).sort(), [PAGE_D, ISSUE_D, PROJECT_D].sort())
    assert.deepEqual(bodies(read, PAGE_D), [['On the page, edited', 'A reply'], ['By id']])
    const threads = foldThreads(fileOf(read, PAGE_D)!.events)
    assert.equal(threads[0].replies[0].reactions.length, 1, 'the reaction on the reply')
    assert.equal(threads[0].resolution?.action, 'resolved')
    assert.deepEqual(bodies(read, PROJECT_D), [['On the project']])
  })

  it("reads an owner's older reply kind from its manifest: Ship's kind:9 under an issue's comment", async () => {
    const read = await listedConversations(relayOver(world).query, TOPIC)
    assert.deepEqual(bodies(read, ISSUE_D), [['On the issue', 'From Ship']])
  })

  it("still reads a file's kind:1111 comments when its owner's manifest cannot be read", async () => {
    const read = await listedConversations(relayOver(world.filter((e) => e !== shipManifest)).query, TOPIC)
    assert.deepEqual(bodies(read, ISSUE_D), [['On the issue']])
  })

  it('holds nothing from the issues under a listed project, and never asks for them', async () => {
    const { query, calls } = relayOver(world)
    const read = await listedConversations(query, TOPIC)
    for (const f of read.files) assert.ok(!f.events.some((e) => e.id === onChild.id), `not under ${f.file}`)
    assert.ok(!JSON.stringify(calls).includes(CHILD_D), 'no filter names the issue under the project')
  })

  it("drops a comment whose A and O name different files, under both, and a reply its author deleted", async () => {
    const read = await listedConversations(relayOver(world).query, TOPIC)
    for (const f of read.files) assert.ok(!f.events.some((e) => e.id === crossed.id), `crossed comment under ${f.file}`)
    assert.ok(!bodies(read, PAGE_D).flat().includes('Taken back'))
  })

  it('leaves out a listed id the reader cannot resolve, rather than returning it unreachable', async () => {
    const read = await listedConversations(relayOver(world.filter((e) => e !== projectRoot)).query, TOPIC)
    assert.deepEqual(read.files.map((f) => f.file).sort(), [PAGE_D, ISSUE_D].sort())
  })

  it('answers an empty list with no read past the list', async () => {
    const { query, calls } = relayOver(world)
    assert.deepEqual(await listedConversationsOf(query, []), { files: [] })
    assert.equal(calls.length, 0)
  })

  it('reads eight listed files in two requests: the comments, then what names them', async () => {
    const pages = Array.from({ length: 8 }, (_, i) => {
      const d = `00000000-0000-4000-8000-00000000000${i}`
      const address = `30840:${QA1}:${d}`
      const c = comment(address, LEAF_TEAM, `page ${i}`)
      return { listed: { file: d, address, folder: LEAF_TEAM, entry: undefined as never } satisfies ListedFile, events: [c, reaction(c)] }
    })
    const { query, calls } = relayOver(pages.flatMap((p) => p.events))
    const read = await listedConversationsOf(query, pages.map((p) => p.listed))
    assert.equal(calls.length, 2)
    assert.deepEqual(read.files.map((f) => f.events.length), new Array(8).fill(2))
  })

  it("applies the reaction horizon per file: a busy file's cut is its own and never starves another's reactions", async () => {
    const busyD = '00000000-0000-4000-8000-0000000000aa'
    const quietD = '00000000-0000-4000-8000-0000000000bb'
    const busy = `30840:${QA1}:${busyD}`
    const quiet = `30840:${QA1}:${quietD}`
    const busyComments = Array.from({ length: 101 }, (_, i) => comment(busy, LEAF_TEAM, `busy ${i}`))
    const quietComment = comment(quiet, LEAF_TEAM, 'quiet')
    const quietReaction = reaction(quietComment)
    const { query } = relayOver([...busyComments, quietComment, quietReaction])
    const read = await listedConversationsOf(query, [
      { file: busyD, address: busy, folder: LEAF_TEAM, entry: undefined as never },
      { file: quietD, address: quiet, folder: LEAF_TEAM, entry: undefined as never },
    ])
    assert.equal(fileOf(read, busyD)!.reactionTargetsOmitted, 1)
    assert.equal(fileOf(read, quietD)!.reactionTargetsOmitted, 0)
    assert.ok(fileOf(read, quietD)!.events.some((e) => e.id === quietReaction.id))
  })
})

/**
 * A live relay: holds every REQ, delivers each new event to the open ones whose
 * filters match it. As ours does, an event with no `h` (a reaction, a deletion)
 * is filed under the team of the event it names, and matches `#h` by that.
 */
function liveRelay(stored: SignedEvent[] = world) {
  const open = new Map<number, { filters: Filter[]; onEvent: (e: SignedEvent) => void }>()
  const reqs: Filter[][] = []
  const held = new Map<string, SignedEvent>(stored.map((e) => [e.id, e]))
  const filed = (e: SignedEvent): SignedEvent => {
    if (e.tags.some((t) => t[0] === 'h')) return e
    const h = e.tags.filter((t) => t[0] === 'e').map((t) => held.get(t[1]))
      .map((target) => target && filed(target).tags.find((t) => t[0] === 'h'))
      .find(Boolean)
    return h ? { ...e, tags: [...e.tags, h] } : e
  }
  let next = 0
  return {
    reqs,
    open,
    subscribe(filters: Filter[], onEvent: (e: SignedEvent) => void) {
      const id = next++
      reqs.push(filters)
      open.set(id, { filters, onEvent })
      return { close: () => void open.delete(id) }
    },
    publish(e: SignedEvent) {
      held.set(e.id, e)
      for (const sub of [...open.values()]) if (sub.filters.some((f) => matches(filed(e), f))) sub.onEvent(e)
    },
  }
}

/** A clock only the test moves. */
function manualTimers() {
  let pending: (() => void) | null = null
  return {
    setTimer: (run: () => void) => ((pending = run), 1),
    clearTimer: () => void (pending = null),
    fire: () => {
      const run = pending
      pending = null
      run?.()
    },
  }
}

describe("a topic's All, live", () => {
  const cold = async () => listedConversations(relayOver(world).query, TOPIC)

  it("hands a new comment on a listed page, written in another team than the topic's, to that page", async () => {
    const relay = liveRelay()
    const heard: [string, string][] = []
    watchListedConversations(relay, await cold(), (file, e) => heard.push([file, e.content]), manualTimers())
    relay.publish(comment(PAGE, LEAF_TEAM, 'New, live'))
    assert.deepEqual(heard, [[PAGE_D, 'New, live']])
  })

  it('asks by file, and names the teams of the files and of their comments until the relay delivers by file', async () => {
    const relay = liveRelay()
    watchListedConversations(relay, await cold(), () => {}, manualTimers())
    const [filters] = relay.reqs
    assert.ok(filters.some((f) => (f['#A'] as string[] | undefined)?.includes(PAGE)))
    assert.ok(filters.some((f) => (f['#O'] as string[] | undefined)?.includes(PAGE_D)))
    for (const f of filters) assert.deepEqual(new Set(f['#h'] as string[]), new Set([LEAF_TEAM, SHIP_TEAM, TOPIC_TEAM]))
  })

  it('names no team once told the relay delivers by file', async () => {
    const relay = liveRelay()
    watchListedConversations(relay, await cold(), () => {}, { ...manualTimers(), namesTeams: false })
    for (const f of relay.reqs[0]) assert.equal(f['#h'], undefined)
  })

  it('hears a reaction on a comment that itself arrived live, once the watch has asked again', async () => {
    const relay = liveRelay()
    const timers = manualTimers()
    const heard: string[] = []
    watchListedConversations(relay, await cold(), (_file, e) => heard.push(e.id), timers)
    const fresh = comment(PAGE, LEAF_TEAM, 'Fresh')
    relay.publish(fresh)
    timers.fire()
    const like = reaction(fresh)
    relay.publish(like)
    assert.deepEqual(heard, [fresh.id, like.id])
    assert.equal(relay.open.size, 1, 'the old REQ is closed when the new one opens')
  })

  it('hands over nothing the cold read already held, and nothing about a file off the list', async () => {
    const relay = liveRelay()
    const heard: string[] = []
    watchListedConversations(relay, await cold(), (_file, e) => heard.push(e.id), { ...manualTimers(), since: 0 })
    relay.publish(onPage)
    relay.publish(comment(CHILD, SHIP_TEAM, 'Under the project'))
    relay.publish(reaction(onChild))
    assert.deepEqual(heard, [])
  })

  it("never sends the relay a REQ of more than 10 filters, and still hears a reaction on a busy page's last comment", async () => {
    const busyD = '00000000-0000-4000-8000-0000000000cc'
    const busy = `30840:${QA1}:${busyD}`
    const comments = Array.from({ length: 999 }, (_, i) => comment(busy, LEAF_TEAM, `busy ${i}`))
    const read = await listedConversationsOf(relayOver(comments).query, [{ file: busyD, address: busy, folder: LEAF_TEAM, entry: undefined as never }])
    const relay = liveRelay(comments)
    const heard: string[] = []
    watchListedConversations(relay, read, (_file, e) => heard.push(e.id), manualTimers())
    for (const filters of relay.reqs) assert.ok(filters.length <= 10, `a REQ of ${filters.length} filters`)
    const like = reaction(comments[998])
    relay.publish(like)
    assert.deepEqual(heard, [like.id])
  })

  it('hears a take-back of a reaction the cold read held, and stops on stop', async () => {
    const relay = liveRelay()
    const heard: string[] = []
    const watch = watchListedConversations(relay, await cold(), (file, e) => heard.push(`${file}:${e.kind}`), manualTimers())
    relay.publish(event({ kind: KIND_DELETION, pubkey: QA1, tags: [['e', liked.id]] }))
    assert.deepEqual(heard, [`${PAGE_D}:${KIND_DELETION}`])
    watch.stop()
    assert.equal(relay.open.size, 0)
  })
})

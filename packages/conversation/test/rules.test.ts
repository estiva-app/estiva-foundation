/*
  The rules beside §9's table: threading edge cases, ordering, the comment
  builder's bytes, reference and mention tags, and drafts.
*/
import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { decodeNevent, encodeNaddr, encodeNpub, type SignedEvent } from '@estiva-app/protocol'
import {
  anchorsOf,
  buildComment,
  byOrder,
  CONVERSATION_VERSION,
  createDraftStore,
  draftKeys,
  DRAFT_MAX_AGE_MS,
  DRAFT_MAX_CHARS,
  foldAttachments,
  groupReactions,
  mentionTagsFor,
  mentionText,
  messageReference,
  parentOf,
  reactionEventsOf,
  referenceTagsFor,
  groupThreads,
  threadStrength,
  trustedTs,
  URGENT_TAG,
  urgentTagsFor,
  type DraftStorage,
} from '../dist/index.js'

const ALICE = 'a'.repeat(64)
const BOB = 'b'.repeat(64)
const FOLDER = '85db5b59-9e49-4ea1-8e93-3d2a2d78c048'
const ISSUE = `30851:${ALICE}:d68a8c78-5ec7-4652-b236-89ab57ac5b1e`
const OTHER = `30851:${ALICE}:0b7e2a4c-1111-4c3e-9d2f-2a1f0c9e8b7d`
const naddrOf = (address: string) => {
  const [kind, pubkey, identifier] = address.split(':')
  return `nostr:${encodeNaddr({ kind: Number(kind), pubkey, identifier, relays: [] })}`
}

let seq = 0
const event = (partial: Partial<SignedEvent> & { kind: number }): SignedEvent => ({
  id: (++seq).toString(16).padStart(64, '0'),
  sig: '',
  pubkey: ALICE,
  created_at: 1_700_000_000 + seq,
  tags: [],
  content: '',
  ...partial,
})

describe('threading', () => {
  it('a nested chat reply files under its root-marked e, not its parent', () => {
    const root = event({ kind: 9, tags: [['h', FOLDER]] })
    const reply = event({ kind: 9, tags: [['h', FOLDER], ['e', root.id, '', 'reply']] })
    const nested = event({ kind: 9, tags: [['h', FOLDER], ['e', root.id, '', 'root'], ['e', reply.id, '', 'reply']] })
    assert.equal(parentOf(nested), root.id)
    const threaded = groupThreads([nested, reply, root])
    assert.deepEqual(threaded.roots.map((e) => e.id), [root.id])
    assert.deepEqual(threaded.replies[root.id].map((e) => e.id), [reply.id, nested.id])
  })

  it('a 1111 reply to a reply walks its parents to the top-level comment', () => {
    const top = event({ kind: 1111, tags: [['A', ISSUE], ['a', ISSUE], ['h', FOLDER]] })
    const reply = event({ kind: 1111, tags: [['A', ISSUE], ['e', top.id], ['h', FOLDER]] })
    const deeper = event({ kind: 1111, tags: [['A', ISSUE], ['e', reply.id], ['h', FOLDER]] })
    const threaded = groupThreads([deeper, top, reply])
    assert.deepEqual(threaded.roots.map((e) => e.id), [top.id])
    assert.deepEqual(threaded.replies[top.id].map((e) => e.id), [reply.id, deeper.id])
    assert.deepEqual(threaded.missingRoots, [])
  })

  it('replies whose root is not in the read are filed under it and the root is reported missing', () => {
    const deleted = 'f'.repeat(64)
    const orphan = event({ kind: 1111, tags: [['A', ISSUE], ['e', deleted], ['h', FOLDER]] })
    const threaded = groupThreads([orphan])
    assert.deepEqual(threaded.roots, [])
    assert.deepEqual(threaded.missingRoots, [deleted])
    assert.deepEqual(threaded.replies[deleted].map((e) => e.id), [orphan.id])
  })

  it("a reply's anchors are its thread's object, though it is no comment itself", () => {
    const reply = event({ kind: 1111, tags: [['A', ISSUE], ['e', 'c'.repeat(64)], ['h', FOLDER]] })
    assert.deepEqual(anchorsOf(reply), [ISSUE])
  })

  it('a thread naming an object halfway through is a mention of it, whole', () => {
    const root = event({ kind: 9, content: 'start', tags: [['h', FOLDER]] })
    const later = event({ kind: 9, content: `about ${naddrOf(ISSUE)}`, tags: [['h', FOLDER], ['e', root.id, '', 'reply'], ['a', ISSUE]] })
    assert.equal(threadStrength(root, [later], ISSUE), 'mention')
    assert.equal(threadStrength(root, [later], OTHER), null)
  })
})

describe('ordering', () => {
  it('trusts ts only inside its own second', () => {
    assert.equal(trustedTs({ created_at: 1_700_000_000, tags: [['ts', '1700000000999']] }), 1_700_000_000_999)
    assert.equal(trustedTs({ created_at: 1_700_000_000, tags: [['ts', '1700000001000']] }), undefined)
    assert.equal(trustedTs({ created_at: 1_700_000_000, tags: [['ts', '1699999999999']] }), undefined)
    assert.equal(trustedTs({ created_at: 1_700_000_000, tags: [['ts', 'soon']] }), undefined)
  })

  it('breaks a tie on the lower id', () => {
    const a = { id: '1'.repeat(64), created_at: 5, tags: [] }
    const b = { id: '2'.repeat(64), created_at: 5, tags: [] }
    assert.deepEqual([b, a].sort(byOrder), [a, b])
  })
})

describe('writing a comment', () => {
  it("is Ship's bytes: A K P a k p [block] h ts [imeta] then the body's tags", () => {
    const unsigned = buildComment(BOB, 1_700_500_000_042, { about: ISSUE, folder: FOLDER, body: 'hi', blockId: 'blk-1', tags: [['p', ALICE]] })
    assert.equal(unsigned.kind, 1111)
    assert.equal(unsigned.created_at, 1_700_500_000)
    assert.deepEqual(unsigned.tags, [
      ['A', ISSUE],
      ['K', '30851'],
      ['P', ALICE],
      ['a', ISSUE],
      ['k', '30851'],
      ['p', ALICE],
      ['block', 'blk-1'],
      ['h', FOLDER],
      ['ts', '1700500000042'],
      ['p', ALICE],
    ])
  })

  it('refuses a Folder that is not a lowercase UUID v4 — a 1111 with no valid h is world-readable', () => {
    assert.throws(() => buildComment(BOB, 0, { about: ISSUE, folder: FOLDER.toUpperCase(), body: 'x' }))
    assert.throws(() => buildComment(BOB, 0, { about: ISSUE, folder: '', body: 'x' }))
  })

  it('earns an a for every address the body names except its own, and a p per npub', () => {
    const body = `${naddrOf(ISSUE)} and ${naddrOf(OTHER)} and nostr:naddr1broken, cc nostr:${encodeNpub(BOB)}`
    assert.deepEqual(referenceTagsFor(body, ISSUE), [['a', OTHER]])
    assert.deepEqual(mentionTagsFor(body), [['p', BOB]])
  })
})

describe('what a composer pick writes (§13.1)', () => {
  it('names a person by key, and by name only when there is none', () => {
    assert.equal(mentionText({ pubkey: BOB, label: 'Bob' }), `nostr:${encodeNpub(BOB)}`)
    assert.equal(mentionText({ pubkey: BOB, label: 'Bob' }, true), `nostr:${encodeNpub(BOB)}`)
    assert.equal(mentionText({ pubkey: null, label: 'Bob' }), '@Bob')
    assert.equal(mentionText({ label: 'Bob' }, true), '!@Bob')
  })

  it('references a message exactly as Peek wrote one on production', () => {
    // QA-1's `[` pick on the QA file, 2026-10-02, before CON-27.
    const sent = 'nostr:nevent1qqsds8wuep0d8vya3nnj3l32d5wcm7kza3kcsmhx0juzpgggrwn3fhcrqsqqqqqfcqncpp'
    const pointer = decodeNevent(sent.slice('nostr:'.length))
    assert.equal(pointer.kind, 9)
    assert.deepEqual(pointer.relays, [])
    assert.equal(messageReference(pointer.id, 9), sent)
  })

  it('tags each urgent person the body names, once, and drops one it no longer names', () => {
    const body = `nostr:${encodeNpub(BOB)} and nostr:${encodeNpub(ALICE)}`
    assert.deepEqual(urgentTagsFor(body, [BOB, BOB, 'c'.repeat(64)]), [[URGENT_TAG, BOB]])
    assert.deepEqual(urgentTagsFor(body, undefined), [])
    assert.deepEqual(urgentTagsFor(body, []), [])
  })
})

describe('reactions and attachments, beyond the table', () => {
  it('fills mine with the earliest of the viewer’s reactions, and keeps first-reaction order', () => {
    const target = event({ kind: 1111, tags: [['A', ISSUE]] })
    const r1 = event({ kind: 7, pubkey: BOB, content: '🚀', tags: [['e', target.id]] })
    const r2 = event({ kind: 7, pubkey: ALICE, content: '👍', tags: [['e', target.id]] })
    const r3 = event({ kind: 7, pubkey: ALICE, content: '🚀', tags: [['e', target.id]] })
    const grouped = groupReactions(reactionEventsOf([r3, r2, r1]), ALICE)[target.id]
    assert.deepEqual(grouped.map((r) => [r.emoji, r.count, r.mine]), [['🚀', 2, r3.id], ['👍', 1, r2.id]])
  })

  it('reads a message’s own attachments when no edit carries any', () => {
    const tag = ['imeta', 'url https://relay.example/x', 'm image/png', `x ${'1'.repeat(64)}`, 'size 3']
    const message = event({ kind: 9, tags: [['h', FOLDER], tag] })
    assert.equal(foldAttachments([message])[message.id].length, 1)
  })
})

describe('the package', () => {
  it('reports the version package.json carries', () => {
    const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')) as { version: string }
    assert.equal(CONVERSATION_VERSION, pkg.version)
  })

  it('a mention-marked e threads nothing', () => {
    const quoting = event({ kind: 9, tags: [['h', FOLDER], ['e', 'c'.repeat(64), '', 'mention']] })
    assert.equal(parentOf(quoting), null)
    assert.deepEqual(groupThreads([quoting]).roots.map((e) => e.id), [quoting.id])
  })
})

describe('drafts', () => {
  const memory = (): DraftStorage & { map: Map<string, string> } => {
    const map = new Map<string, string>()
    return { map, getItem: (k) => map.get(k) ?? null, setItem: (k, v) => void map.set(k, v), removeItem: (k) => void map.delete(k) }
  }

  it('keeps a draft per destination, and forgets whitespace, oversize and old ones', () => {
    let now = 1_000
    const storage = memory()
    const drafts = createDraftStore(storage, () => now)
    drafts.write(draftKeys.thread('t1'), 'half a reply')
    drafts.write(draftKeys.object(ISSUE), 'starting')
    drafts.write(draftKeys.container('c1'), 'in a topic')
    assert.equal(drafts.read(draftKeys.thread('t1')), 'half a reply')
    assert.equal(drafts.read(draftKeys.thread('t2')), undefined)

    drafts.write(draftKeys.thread('t1'), '   ')
    assert.equal(drafts.read(draftKeys.thread('t1')), undefined)
    drafts.write(draftKeys.object(ISSUE), 'x'.repeat(DRAFT_MAX_CHARS + 1))
    assert.equal(drafts.read(draftKeys.object(ISSUE)), undefined)

    now += DRAFT_MAX_AGE_MS + 1
    assert.equal(drafts.read(draftKeys.container('c1')), undefined)
    assert.equal(storage.map.size, 0)
  })

  it('treats storage that throws, or none, as no draft', () => {
    const broken: DraftStorage = {
      getItem: () => {
        throw new Error('blocked')
      },
      setItem: () => {
        throw new Error('quota')
      },
      removeItem: () => {
        throw new Error('blocked')
      },
    }
    const drafts = createDraftStore(broken)
    drafts.write('k', 'text')
    assert.equal(drafts.read('k'), undefined)
    drafts.clear('k')
    assert.equal(createDraftStore(undefined).read('k'), undefined)
  })
})

/**
 * Creating a file with its text as its first change, deleting and restoring
 * any file, and the relay's refusals by their codes — SPEC §6.1, §6.5, §3.3
 * (ISS-3).
 *
 * The relay here holds one new issue and refuses as buzz does on a team that
 * keeps issues in order (buzz#65): a first record carrying text with
 * `invalid: text-is-a-change:`, a change naming no `prev` with
 * `invalid: requires-prev:`, a stale `prev` with `conflict: <field> follows
 * <id>`. Every write is asserted on the event that reached it.
 */
import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { computeEventId, serializeBlockDocument, type SignedEvent, type UnsignedEvent } from '@estiva-app/protocol'
// By namespace, so on a build without the helpers only their assertions fail.
import * as interop from '../dist/index.js'

const { buildActionEvent, changedAt, fieldsSetBy } = interop
const missing = (name: string) => () => assert.fail(`${name} is not exported`)
const createFile: typeof interop.createFile = interop.createFile ?? missing('createFile')
const finishCreating: typeof interop.finishCreating = interop.finishCreating ?? missing('finishCreating')
const setDeleted: typeof interop.setDeleted = interop.setDeleted ?? missing('setDeleted')

const OWNER = 'a'.repeat(64)
const QA2 = 'e'.repeat(64)
const FOLDER = '4a279f9d-9247-4479-8aea-dd15ffe86297'
const ISSUE = 30851
const D = 'i1'
const ADDRESS = `${ISSUE}:${OWNER}:${D}`
const PROJECT_ADDRESS = `30850:${OWNER}:p1`
const T0 = 1_800_000_000_000
const BLOCKS = 'estiva-blocks-1'

const manifest = {
  records: { changeKind: 1851, targetTag: 'a', fieldTag: 'field', valueTag: 'value', order: ['ts', 'created_at', 'id'], rule: 'last-write-wins-per-field' },
  vocabularies: {
    status: [
      { value: 'todo', label: 'To do', colour: 'grey', stage: 'open' },
      { value: 'in_progress', label: 'In progress', colour: 'blue', stage: 'started' },
    ],
  },
  actions: [
    { id: 'set-status', label: 'Set status', appliesTo: String(ISSUE), emits: { kind: 1851, field: 'status' }, input: { type: 'string', enum: 'status' } },
    { id: 'assign', label: 'Assign', appliesTo: String(ISSUE), emits: { kind: 1851, field: 'assignee' }, input: { type: 'string' } },
    { id: 'describe', label: 'Describe', appliesTo: String(ISSUE), emits: { kind: 1851, field: 'description' }, input: { type: 'string', format: BLOCKS } },
    { id: 'delete', label: 'Delete', appliesTo: String(ISSUE), emits: { kind: 1851, field: 'deleted' }, input: { type: 'string' } },
  ],
}
const ACTION_OF: Record<string, string> = { status: 'set-status', assignee: 'assign', description: 'describe', deleted: 'delete' }

const sign = (unsigned: UnsignedEvent): SignedEvent => ({ ...unsigned, id: computeEventId(unsigned), sig: '' })
const tag = (e: { tags: string[][] }, name: string) => e.tags.find((t) => t[0] === name)?.[1]

const p = (id: string, text: string) => ({ type: 'paragraph', id, content: [{ type: 'text' as const, text }] })
const blocks = (...content: ReturnType<typeof p>[]) => serializeBlockDocument({ type: 'doc', content })

/** A new issue's first record, as an app builds it: what it is, and no text. */
const firstRecord = (content = '', extra: string[][] = []): UnsignedEvent => ({
  pubkey: OWNER,
  created_at: T0 / 1000,
  kind: ISSUE,
  tags: [['d', D], ['title', 'Sign-in loops'], ['ref', 'ISS-9'], ['a', PROJECT_ADDRESS], ['h', FOLDER], ...extra],
  content,
})

function change(pubkey: string, input: { field: string; value: string; format?: string; prev: string; createdAtMs: number }): UnsignedEvent | string {
  return buildActionEvent({
    manifest,
    kind: ISSUE,
    address: ADDRESS,
    objectAuthor: OWNER,
    folder: FOLDER,
    actionId: ACTION_OF[input.field],
    value: input.value,
    ...(input.format ? { contentFormat: input.format } : {}),
    prev: input.prev,
    pubkey,
    createdAtMs: input.createdAtMs,
  })
}

/** A relay keeping one new issue's fields in order, as buzz does on a team switched for issues. */
function issueRelay() {
  const events = new Map<string, SignedEvent>()
  const heads = new Map<string, string>()
  const published: SignedEvent[] = []
  let root: SignedEvent | undefined
  /** The next sends that fail before the relay judges them, as a dropped connection or a busy relay does. */
  let failing = 0
  const accept = (e: SignedEvent) => {
    events.set(e.id, e)
    for (const { field } of fieldsSetBy(e)) heads.set(field, e.id)
  }
  const publish = async (e: SignedEvent) => {
    published.push(e)
    if (failing > 0) {
      failing--
      return { ok: false, reason: 'error: the relay is busy; try again' }
    }
    if (e.kind !== 1851) {
      if (e.content !== '' || e.tags.some((t) => t[0] === 'description')) {
        return { ok: false, reason: "invalid: text-is-a-change: an issue's first record carries no text; write it as its first change" }
      }
      root = e
      events.set(e.id, e)
      return { ok: true, eventId: e.id }
    }
    if (!root) return { ok: false, reason: 'invalid: no such file' }
    const sets = e.tags.filter((t) => t[0] === 'set')
    const fields = sets.length ? sets.map((t) => ({ field: t[1], prev: t[3] })) : [{ field: fieldsSetBy(e)[0].field, prev: tag(e, 'prev') }]
    for (const { field, prev } of fields) {
      if (!prev) return { ok: false, reason: 'invalid: requires-prev: an issue change names the change it follows in prev; update the app' }
      const head = heads.get(field) ?? root.id
      if (prev !== head) return { ok: false, reason: `conflict: ${field} follows ${head}` }
      if (changedAt(e) <= changedAt(events.get(prev)!)) return { ok: false, reason: `conflict: ${field} does not sort after its prev ${prev}` }
    }
    accept(e)
    return { ok: true, eventId: e.id }
  }
  const query: interop.QueryFn = async (asked) =>
    asked.flatMap((f) => (Array.isArray(f.ids) ? (f.ids as string[]).map((id) => events.get(id)).filter((e): e is SignedEvent => !!e) : []))
  const current = async (field: string) => events.get(heads.get(field) ?? root!.id)
  return {
    publish,
    query,
    current,
    published,
    failNext: (n = 1) => (failing = n),
    /** Someone else's change, straight onto the relay. */
    theirs: (pubkey: string, field: string, value: string, at: number, format?: string) => {
      const built = change(pubkey, { field, value, ...(format ? { format } : {}), prev: heads.get(field) ?? root!.id, createdAtMs: at })
      if (typeof built === 'string') throw new Error(built)
      accept(sign(built))
    },
    head: (field: string) => events.get(heads.get(field) ?? '')!,
  }
}

const creating = (relay: ReturnType<typeof issueRelay>, extra: Partial<interop.CreateFileArgs> = {}): interop.CreateFileArgs => ({
  root: firstRecord(),
  text: { value: blocks(p('b1', 'Steps to reproduce')), format: BLOCKS },
  build: (input) => change(OWNER, input),
  sign: async (e) => sign(e),
  publish: relay.publish,
  query: relay.query,
  current: relay.current,
  now: () => T0 + 1_000,
  ...extra,
})

describe('a new file’s text is its first change — §6.1', () => {
  it('sends the first record with no text, then the text alone following it, then the other first values with no text', async () => {
    const relay = issueRelay()
    const result = await createFile(creating(relay, { others: [{ field: 'status', value: 'todo' }, { field: 'assignee', value: QA2 }] }))
    assert.equal(result.ok, true)
    const [root, text, others, ...more] = relay.published
    assert.equal(more.length, 0, 'three writes')
    assert.equal(root.kind, ISSUE)
    assert.equal(root.content, '', 'the first record carries no text')
    assert.equal(tag(root, 'description'), undefined)
    assert.deepEqual(fieldsSetBy(text), [{ field: 'description', value: blocks(p('b1', 'Steps to reproduce')), format: BLOCKS }], 'the text is a one-field change')
    assert.equal(tag(text, 'prev'), root.id, 'following the first record')
    assert.deepEqual(fieldsSetBy(others).map((f) => f.field), ['status', 'assignee'], 'the other values in one change')
    assert.ok(others.tags.filter((t) => t[0] === 'set').every((t) => t[3] === root.id), 'each following the first record')
    assert.ok(!fieldsSetBy(others).some((f) => f.field === 'description'), 'with no text')
    assert.ok(result.ok && result.heads.description === text.id && result.heads.status === others.id)
  })

  it('refuses a first record carrying text before sending anything', async () => {
    for (const root of [firstRecord('Steps to reproduce'), firstRecord('', [['description', 'Steps']])]) {
      const relay = issueRelay()
      const result = await createFile(creating(relay, { root }))
      assert.equal(result.ok, false)
      assert.ok(!result.ok && !result.created)
      assert.equal(relay.published.length, 0, 'nothing reached the relay')
    }
  })

  it('a text that fails leaves the file created without it, and sending it again sends only the change', async () => {
    const relay = issueRelay()
    const args = creating(relay)
    const send = relay.publish
    let sends = 0
    // The first record lands; the text's first send does not.
    args.publish = async (e) => (++sends === 2 ? (relay.failNext(1), send(e)) : send(e))
    const first = await createFile(args)
    assert.ok(!first.ok && first.created, 'the file exists, not finished')
    assert.equal(first.field, 'description')
    assert.equal(relay.head('description'), undefined, 'no text on the relay yet')

    const again = await finishCreating(args, first.root)
    assert.equal(again.ok, true)
    const roots = relay.published.filter((e) => e.kind === ISSUE)
    assert.equal(roots.length, 1, 'the first record was sent once')
    assert.equal(tag(relay.head('description'), 'prev'), first.root.id)
    assert.equal(fieldsSetBy(relay.head('description'))[0].value, blocks(p('b1', 'Steps to reproduce')))
  })

  it('sent again after someone’s text landed first, the creator’s words are merged onto theirs, not lost', async () => {
    const relay = issueRelay()
    const args = creating(relay)
    const send = relay.publish
    let sends = 0
    args.publish = async (e) => (++sends === 2 ? (relay.failNext(1), send(e)) : send(e))
    const first = await createFile(args)
    assert.ok(!first.ok && first.created)
    relay.theirs(QA2, 'description', blocks(p('q1', 'Seen on Safari too')), T0 + 1_500, BLOCKS)

    const again = await finishCreating({ ...args, now: () => T0 + 2_000 }, first.root)
    assert.equal(again.ok, true)
    const text = fieldsSetBy(relay.head('description'))[0].value
    assert.ok(text.includes('Steps to reproduce') && text.includes('Seen on Safari too'), text)
  })

  it('a text the creator’s lost answer already landed is not written twice', async () => {
    const relay = issueRelay()
    const args = creating(relay)
    const first = await createFile(args)
    assert.equal(first.ok, true)
    const before = relay.published.length
    const again = await finishCreating(args, relay.published[0])
    assert.equal(again.ok, true)
    assert.equal(relay.published.length - before, 1, 'one send, refused as stale, and nothing after it: the words are already there')
  })
})

describe('delete and restore any file — §6.5', () => {
  it('deletes by the deleted field after its current change, and restores by emptying it', async () => {
    const relay = issueRelay()
    const made = await createFile(creating(relay))
    assert.ok(made.ok)
    const write = { build: (input: { value: string; prev: string; createdAtMs: number }) => change(QA2, { field: 'deleted', ...input }), sign: async (e: UnsignedEvent) => sign(e), publish: relay.publish, query: relay.query, current: relay.current }
    const deleted = await setDeleted({ ...write, deleted: true, prev: made.root.id, now: () => T0 + 5_000 })
    assert.ok(deleted.ok)
    const del = relay.published.at(-1)!
    assert.equal(del.kind, 1851, 'a change, never a kind:5')
    assert.deepEqual(fieldsSetBy(del), [{ field: 'deleted', value: 'true' }])
    assert.equal(del.pubkey, QA2, 'by someone other than its author')

    const restored = await setDeleted({ ...write, deleted: false, prev: deleted.id, now: () => T0 + 6_000 })
    assert.ok(restored.ok)
    assert.deepEqual(fieldsSetBy(relay.published.at(-1)!), [{ field: 'deleted', value: '' }])
    assert.equal(tag(relay.published.at(-1)!, 'prev'), deleted.id)
    assert.ok(!relay.published.some((e) => e.kind === 5))
  })
})

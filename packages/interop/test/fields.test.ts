/**
 * A file as its fields, kept in order by the relay — SPEC §6.2, §6.13, §13.3
 * (ALO-7).
 *
 * The relay here keeps each field's current change and refuses as buzz does
 * (`buzz-core/src/fields.rs`): a stale `prev` with `conflict: <field> follows
 * <id>` (or a bare `conflict: <field>` to a signer outside the file's home), a
 * change that does not sort after its `prev`, and a missing `prev` with
 * `invalid:`. Every write is asserted on the event that reached it.
 */
import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { computeEventId, serializeBlockDocument, type SignedEvent, type UnsignedEvent } from '@estiva-app/protocol'
import { buildActionEvent, changedAt, combineChanges, fieldsSetBy, listFiles, openFile, textOf, writeChange, writeChanges, type QueryFn } from '../dist/index.js'

const OWNER = 'a'.repeat(64)
const AGENT = 'c'.repeat(64)
const QA1 = 'e'.repeat(64)
const FOLDER = '7b32200c-e4c0-4216-b79a-8490fc05e0bd'
const ELSEWHERE = '11111111-2222-4333-8444-555555555555'
const PROJECT = 30850
const D = 'p1'
const ADDRESS = `${PROJECT}:${OWNER}:${D}`
const T0 = 1_800_000_000_000

const manifest = {
  records: { changeKind: 1851, targetTag: 'a', fieldTag: 'field', valueTag: 'value', order: ['ts', 'created_at', 'id'], rule: 'last-write-wins-per-field' },
  vocabularies: {
    status: [
      { value: 'todo', label: 'To do', colour: 'grey', stage: 'open' },
      { value: 'in_progress', label: 'In progress', colour: 'blue', stage: 'started' },
      { value: 'done', label: 'Done', colour: 'green', stage: 'done' },
    ],
  },
  actions: [
    { id: 'set-status', label: 'Set status', appliesTo: String(PROJECT), emits: { kind: 1851, field: 'status' }, input: { type: 'string', enum: 'status' } },
    { id: 'rename', label: 'Rename', appliesTo: String(PROJECT), emits: { kind: 1851, field: 'title' }, input: { type: 'string' } },
    { id: 'describe', label: 'Describe', appliesTo: String(PROJECT), emits: { kind: 1851, field: 'description' }, input: { type: 'string', format: 'estiva-blocks-1' } },
    { id: 'comment', label: 'Comment', appliesTo: String(PROJECT), emits: { kind: 1111 }, input: { type: 'string' } },
  ],
}

const sign = (unsigned: UnsignedEvent): SignedEvent => ({ ...unsigned, id: computeEventId(unsigned), sig: '' })
const tag = (e: { tags: string[][] }, name: string) => e.tags.find((t) => t[0] === name)?.[1]

const root = sign({
  pubkey: OWNER,
  created_at: T0 / 1000,
  kind: PROJECT,
  tags: [['d', D], ['name', 'Launch'], ['buzz-channel', FOLDER]],
  content: '',
})

const ACTION_OF: Record<string, string> = { status: 'set-status', title: 'rename', description: 'describe' }

function change(pubkey: string, field: string, value: string, prev: string, createdAtMs: number) {
  const built = buildActionEvent({
    manifest,
    kind: PROJECT,
    address: ADDRESS,
    objectAuthor: OWNER,
    folder: FOLDER,
    actionId: ACTION_OF[field],
    value,
    ...(field === 'description' ? { contentFormat: 'estiva-blocks-1' } : {}),
    prev,
    pubkey,
    createdAtMs,
  })
  if (typeof built === 'string') throw new Error(built)
  return built
}

/** A relay keeping one project's fields in order, as buzz does. */
function keptRelay(options: { readerOfHome?: boolean } = {}) {
  const events = new Map<string, SignedEvent>([[root.id, root]])
  const heads = new Map<string, string>()
  const published: SignedEvent[] = []
  const filters: Record<string, unknown>[] = []
  const query: QueryFn = async (asked) => {
    filters.push(...asked)
    return asked.flatMap((f) => (Array.isArray(f.ids) ? (f.ids as string[]).map((id) => events.get(id)).filter((e): e is SignedEvent => !!e) : []))
  }
  const accept = (e: SignedEvent) => {
    events.set(e.id, e)
    for (const { field } of fieldsSetBy(e)) heads.set(field, e.id)
  }
  const publish = async (e: SignedEvent) => {
    published.push(e)
    // Every field the change sets, by either form: whole or not at all.
    const sets = e.tags.filter((t) => t[0] === 'set')
    const fields = sets.length ? sets.map((t) => ({ field: t[1], prev: t[3] })) : [{ field: fieldsSetBy(e)[0].field, prev: tag(e, 'prev') }]
    for (const { field, prev } of fields) {
      if (!prev) return { ok: false, reason: 'invalid: a change to a project needs prev' }
      const head = heads.get(field) ?? root.id
      if (prev !== head) return { ok: false, reason: options.readerOfHome === false ? `conflict: ${field}` : `conflict: ${field} follows ${head}` }
      if (changedAt(e) <= changedAt(events.get(prev)!)) {
        return { ok: false, reason: `conflict: ${field} does not sort after its prev ${prev}; stamp it at least 1 ms later, ts and created_at agreeing` }
      }
    }
    accept(e)
    return { ok: true, eventId: e.id }
  }
  /** Someone else's change, straight onto the relay. */
  const theirs = (pubkey: string, field: string, value: string, at: number) => {
    const e = sign(change(pubkey, field, value, heads.get(field) ?? root.id, at))
    accept(e)
    return e
  }
  const current = async (field: string) => events.get(heads.get(field) ?? root.id)
  return { query, publish, theirs, current, published, filters, head: (field: string) => events.get(heads.get(field) ?? root.id)! }
}

const agentWrite = (relay: ReturnType<typeof keptRelay>, field: string, value: string, prev: string, now = T0 + 60_000) =>
  writeChange({
    field,
    value,
    ...(field === 'description' ? { format: 'estiva-blocks-1' } : {}),
    prev,
    build: (input) => change(AGENT, field, input.value, input.prev, input.createdAtMs),
    sign: async (e) => sign(e),
    publish: relay.publish,
    query: relay.query,
    current: relay.current,
    now: () => now,
  })

const p = (id: string, text: string) => ({ type: 'paragraph', id, content: [{ type: 'text' as const, text }] })
const blocks = (...content: ReturnType<typeof p>[]) => serializeBlockDocument({ type: 'doc', content })

describe('the change writer — §6.2', () => {
  it('a status change names its file in O, the change it follows in prev, and its stage last', () => {
    const built = change(AGENT, 'status', 'in_progress', root.id, T0 + 1)
    assert.deepEqual(built.tags, [
      ['a', ADDRESS],
      ['O', D],
      ['field', 'status'],
      ['value', 'in_progress'],
      ['h', FOLDER],
      ['ts', String(T0 + 1)],
      ['prev', root.id],
      ['stage', 'status', 'started'],
    ])
  })

  it('a change to a field whose options carry no stage writes none', () => {
    assert.equal(change(AGENT, 'title', 'Launch 2', root.id, T0 + 1).tags.some((t) => t[0] === 'stage'), false)
  })

  it('a comment follows no change, so prev is refused rather than dropped', () => {
    const built = buildActionEvent({
      manifest, kind: PROJECT, address: ADDRESS, objectAuthor: OWNER, folder: FOLDER,
      actionId: 'comment', value: 'hi', prev: root.id, pubkey: AGENT, createdAtMs: T0,
    })
    assert.match(String(built), /follows no change/)
  })
})

describe('reading files by their fields — §6.13', () => {
  const title = sign(change(QA1, 'title', 'Launch, renamed', root.id, T0 + 1000))
  const oldTitle = sign(change(OWNER, 'title', 'Launch, first', root.id, T0 + 500))
  const text = sign(change(QA1, 'description', blocks(p('b1', 'the plan')), root.id, T0 + 2000))
  const stray = sign({ ...change(QA1, 'title', 'From another Folder', root.id, T0 + 3000), tags: change(QA1, 'title', 'x', root.id, T0 + 3000).tags.map((t) => (t[0] === 'h' ? ['h', ELSEWHERE] : t)) })

  it('a list asks the relay for newest fields and draws each file from its current changes, never its text', async () => {
    const asked: Record<string, unknown>[] = []
    const files = await listFiles(async (f) => (asked.push(...f), [root, oldTitle, title, text, stray]), { kinds: [PROJECT] })
    assert.deepEqual(asked, [{ kinds: [PROJECT], fields: 'newest' }])
    assert.equal(files.length, 1)
    assert.equal(files[0].fields.title.value, 'Launch, renamed', 'the newest title, not one from another Folder')
    assert.equal(files[0].fields.title.id, title.id, 'its id is the next prev')
    assert.equal(files[0].fields.description, undefined)
  })

  it('a change from another Folder that leaves out O is not folded in either', async () => {
    const bare = sign({ ...stray, tags: stray.tags.filter((t) => t[0] !== 'O') })
    const files = await listFiles(async () => [root, title, bare], { kinds: [PROJECT] })
    assert.equal(files[0].fields.title.value, 'Launch, renamed')
    assert.equal(files[0].fields.title.id, title.id)
  })

  it('opening a file asks for its text by #d and takes the current text with the id the next save follows', async () => {
    const asked: Record<string, unknown>[] = []
    const file = await openFile(async (f) => (asked.push(...f), [root, title, text]), { kind: PROJECT, pubkey: OWNER, d: D }, { text: true })
    assert.deepEqual(asked, [{ fields: 'newest', kinds: [PROJECT], '#d': [D], text: true }])
    assert.equal(file?.fields.description.id, text.id)
    assert.equal(file?.fields.description.format, 'estiva-blocks-1')
    assert.deepEqual(file?.events.map((e) => e.id).sort(), [root.id, title.id, text.id].sort())
  })

  it('a project whose text was never changed reads its description tag as the text a merge starts from', () => {
    const seeded = sign({ ...root, tags: [...root.tags, ['description', 'the plan, as created']], content: 'older body' })
    assert.deepEqual(textOf(seeded), { value: 'the plan, as created' })
  })

  it('a relay without the text read is never sent "text"', async () => {
    const asked: Record<string, unknown>[] = []
    await openFile(async (f) => (asked.push(...f), [root]), { kind: PROJECT, pubkey: OWNER, d: D }, { text: false })
    assert.equal('text' in asked[0], false)
  })
})

describe('answering conflict: — §6.2, §13.3', () => {
  it('a status set after QA-1\'s, from an older copy, is set again after theirs and stands', async () => {
    const relay = keptRelay()
    const qa = relay.theirs(QA1, 'status', 'done', T0 + 10_000)
    const result = await agentWrite(relay, 'status', 'in_progress', root.id)
    assert.equal(result.ok, true)
    const [refused, sent] = relay.published
    assert.equal(tag(refused, 'prev'), root.id)
    assert.equal(tag(sent, 'prev'), qa.id, 'the second send follows QA-1\'s change')
    assert.equal(tag(sent, 'value'), 'in_progress')
    assert.equal(relay.head('status').id, sent.id)
  })

  it('a text whose other block QA-1 changed is merged onto theirs, names them, and keeps their words', async () => {
    const relay = keptRelay()
    const base = relay.theirs(OWNER, 'description', blocks(p('b1', 'one'), p('b2', 'two')), T0 + 1000)
    const qa = relay.theirs(QA1, 'description', blocks(p('b1', 'one, by QA-1'), p('b2', 'two')), T0 + 10_000)
    const result = await agentWrite(relay, 'description', blocks(p('b1', 'one'), p('b2', 'two, by the agent')), base.id)
    assert.equal(result.ok, true)
    assert.equal(result.ok && 'mergedOnto' in result ? result.mergedOnto?.pubkey : undefined, QA1)
    const sent = relay.published.at(-1)!
    assert.equal(tag(sent, 'prev'), qa.id)
    assert.equal(tag(sent, 'content-format'), 'estiva-blocks-1')
    const words = JSON.parse(tag(sent, 'value')!).content.map((b: { content: { text: string }[] }) => b.content[0].text)
    assert.deepEqual(words, ['one, by QA-1', 'two, by the agent'])
  })

  it('a block both changed asks, names theirs, and nothing is sent after the refusal', async () => {
    const relay = keptRelay()
    const base = relay.theirs(OWNER, 'description', blocks(p('b1', 'one')), T0 + 1000)
    const qa = relay.theirs(QA1, 'description', blocks(p('b1', 'one, by QA-1')), T0 + 10_000)
    const result = await agentWrite(relay, 'description', blocks(p('b1', 'one, by the agent')), base.id)
    assert.equal(result.ok, false)
    assert.ok(!result.ok && 'asks' in result)
    if (!result.ok && 'asks' in result) {
      assert.equal(result.theirs.id, qa.id)
      assert.deepEqual(result.asks.map((a) => [a.block, a.why, a.theirs, a.mine]), [['b1', 'changed-by-both', 'one, by QA-1', 'one, by the agent']])
    }
    assert.equal(relay.published.length, 1, 'only the refused save reached the relay')
    assert.equal(relay.head('description').id, qa.id)
  })

  it('a block QA-1 deleted and the agent edited asks', async () => {
    const relay = keptRelay()
    const base = relay.theirs(OWNER, 'description', blocks(p('b1', 'one'), p('b2', 'two')), T0 + 1000)
    relay.theirs(QA1, 'description', blocks(p('b1', 'one')), T0 + 10_000)
    const result = await agentWrite(relay, 'description', blocks(p('b1', 'one'), p('b2', 'two, by the agent')), base.id)
    assert.ok(!result.ok && 'asks' in result && result.asks[0].why === 'edited-and-deleted')
    assert.equal(relay.published.length, 1)
  })

  it('a change stamped before its prev is sent again 1 ms after it, ts and created_at agreeing', async () => {
    const relay = keptRelay()
    const qa = relay.theirs(QA1, 'title', 'Launch, renamed', T0 + 90_000)
    const result = await agentWrite(relay, 'title', 'Launch, by the agent', qa.id, T0 + 60_000)
    assert.equal(result.ok, true)
    const sent = relay.published.at(-1)!
    assert.equal(tag(sent, 'ts'), String(T0 + 90_001))
    assert.equal(sent.created_at, Math.floor((T0 + 90_001) / 1000))
  })

  it('a refusal naming no change reads the field again, for a signer outside the file\'s home', async () => {
    const relay = keptRelay({ readerOfHome: false })
    const qa = relay.theirs(QA1, 'title', 'Launch, renamed', T0 + 10_000)
    const result = await agentWrite(relay, 'title', 'Launch, by the agent', root.id)
    assert.equal(result.ok, true)
    assert.equal(tag(relay.published.at(-1)!, 'prev'), qa.id)
  })

  it('an invalid: refusal is never sent again', async () => {
    const relay = keptRelay()
    const result = await writeChange({
      field: 'title', value: 'x', prev: root.id,
      build: (input) => ({ ...change(AGENT, 'title', input.value, input.prev, input.createdAtMs), tags: [['a', ADDRESS], ['field', 'title'], ['value', 'x'], ['h', FOLDER]] }),
      sign: async (e) => sign(e), publish: relay.publish, query: relay.query, current: relay.current, now: () => T0 + 60_000,
    })
    assert.deepEqual(result, { ok: false, refused: 'invalid: a change to a project needs prev' })
    assert.equal(relay.published.length, 1)
  })
})

const agentWriteMany = (relay: ReturnType<typeof keptRelay>, fields: { field: string; value: string; prev: string }[], now = T0 + 60_000) =>
  writeChanges({
    fields: fields.map((f) => (f.field === 'description' ? { ...f, format: 'estiva-blocks-1' } : f)),
    build: (input) => change(AGENT, input.field, input.value, input.prev, input.createdAtMs),
    sign: async (e) => sign(e),
    publish: relay.publish,
    query: relay.query,
    current: relay.current,
    now: () => now,
  })

describe('a change setting several fields — §6.2, ALO-4', () => {
  it('is one event: a, O, h, ts, one set per field with its prev, then each staged field\'s stage', () => {
    const built = combineChanges([change(AGENT, 'status', 'done', root.id, T0 + 1), change(AGENT, 'title', 'Launch 2', root.id, T0 + 1)])
    assert.ok(typeof built !== 'string')
    assert.deepEqual(built.tags, [
      ['a', ADDRESS],
      ['O', D],
      ['h', FOLDER],
      ['ts', String(T0 + 1)],
      ['set', 'status', 'done', root.id],
      ['set', 'title', 'Launch 2', root.id],
      ['stage', 'status', 'done'],
    ])
    assert.equal(built.created_at, Math.floor((T0 + 1) / 1000))
  })

  it('keeps the text\'s content-format beside its set, and names a field once', () => {
    const built = combineChanges([change(AGENT, 'title', 'x', root.id, T0), change(AGENT, 'description', blocks(p('b1', 'one')), root.id, T0)])
    assert.ok(typeof built !== 'string')
    assert.deepEqual(built.tags.filter((t) => t[0] === 'content-format'), [['content-format', 'estiva-blocks-1']])
    assert.match(String(combineChanges([change(AGENT, 'title', 'x', root.id, T0), change(AGENT, 'title', 'y', root.id, T0)])), /names title once/)
  })

  it('refuses changes to two files, or one that follows no change', () => {
    const other = change(AGENT, 'title', 'x', root.id, T0)
    const elsewhere = { ...other, tags: other.tags.map((t) => (t[0] === 'a' ? ['a', `${PROJECT}:${OWNER}:p2`] : t[0] === 'O' ? ['O', 'p2'] : t)) }
    assert.equal(typeof combineChanges([change(AGENT, 'status', 'done', root.id, T0), elsewhere]), 'string')
    const unfollowed = { ...other, tags: other.tags.filter((t) => t[0] !== 'prev') }
    assert.equal(typeof combineChanges([unfollowed]), 'string')
  })

  it('both land from one copy: QA-1 renamed it meanwhile, so the whole change is sent again with title after QA-1\'s and stands', async () => {
    const relay = keptRelay()
    const qa = relay.theirs(QA1, 'title', 'Launch, by QA-1', T0 + 10_000)
    const result = await agentWriteMany(relay, [
      { field: 'status', value: 'done', prev: root.id },
      { field: 'title', value: 'Launch, by the agent', prev: root.id },
    ])
    assert.equal(result.ok, true)
    assert.equal(relay.published.length, 2, 'refused whole, then sent again whole')
    const sent = relay.published[1]
    assert.deepEqual(sent.tags.filter((t) => t[0] === 'set'), [
      ['set', 'status', 'done', root.id],
      ['set', 'title', 'Launch, by the agent', qa.id],
    ])
    assert.equal(relay.head('status').id, sent.id)
    assert.equal(relay.head('title').id, sent.id, 'the later title stands')
  })

  it('merges a text QA-1 changed in another block, inside the same several-field change', async () => {
    const relay = keptRelay()
    const base = relay.theirs(OWNER, 'description', blocks(p('b1', 'one'), p('b2', 'two')), T0 + 1000)
    relay.theirs(QA1, 'description', blocks(p('b1', 'one, by QA-1'), p('b2', 'two')), T0 + 10_000)
    const result = await agentWriteMany(relay, [
      { field: 'title', value: 'Launch 2', prev: root.id },
      { field: 'description', value: blocks(p('b1', 'one'), p('b2', 'two, by the agent')), prev: base.id },
    ])
    assert.equal(result.ok, true)
    const sent = relay.published.at(-1)!
    const text = sent.tags.find((t) => t[0] === 'set' && t[1] === 'description')!
    assert.deepEqual(JSON.parse(text[2]).content.map((b: { content: { text: string }[] }) => b.content[0].text), ['one, by QA-1', 'two, by the agent'])
    assert.equal(relay.head('title').id, sent.id)
  })

  it('asks when a block both changed, and saves none of its fields', async () => {
    const relay = keptRelay()
    const base = relay.theirs(OWNER, 'description', blocks(p('b1', 'one')), T0 + 1000)
    relay.theirs(QA1, 'description', blocks(p('b1', 'one, by QA-1')), T0 + 10_000)
    const result = await agentWriteMany(relay, [
      { field: 'title', value: 'Launch 2', prev: root.id },
      { field: 'description', value: blocks(p('b1', 'one, by the agent')), prev: base.id },
    ])
    assert.ok(!result.ok && 'asks' in result && result.asks[0].block === 'b1')
    assert.equal(relay.published.length, 1)
    assert.equal(relay.head('title').id, root.id, 'the title waits with the text')
  })
})

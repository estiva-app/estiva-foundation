/**
 * A Folder and a chat message belong to no app — SPEC §3.2 and §7.8.
 *
 * Until interop 0.58 every app learned both from Peek's manifest, which claimed
 * `kind:39000` and `kind:9` with `k` tags. Now the runtime draws them from the
 * specification, as it draws the bare file and the comment, and opens them in
 * the app declaring the conversation aspect. A manifest still claiming either
 * — Peek's, until its republish — is not read for it.
 *
 * why: https://github.com/estiva-app/estiva-docs/blob/main/decisions/folders-belong-to-the-protocol.md
 * why: https://github.com/estiva-app/estiva-docs/blob/main/decisions/a-chat-message-belongs-to-the-protocol.md
 */
import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import {
  FOLDER_ACTIONS_ADDRESS,
  KIND_CHANNEL_METADATA,
  createProjectionCache,
  resolveForeignEvent,
  resolveForeignObject,
  resolveForeignObjects,
} from '../dist/index.js'
import type { SignedEvent } from '@estiva-app/protocol'

// NIP-29's chat message: the number, not the runtime's constant, so this file
// runs against a runtime from before it was built in.
const KIND_MESSAGE = 9
const RELAY = 'f'.repeat(64)
const PEEK = 'e'.repeat(64)
const PERSON = 'b'.repeat(64)
const FOLDER = '7b32200c-e4c0-4216-b79a-8490fc05e0bd'
const FOLDER_ADDRESS = `${KIND_CHANNEL_METADATA}:${RELAY}:${FOLDER}`

let seq = 0
function event(partial: Partial<SignedEvent> & { kind: number }): SignedEvent {
  seq += 1
  return {
    id: String(seq).padStart(64, '0'),
    sig: '',
    pubkey: RELAY,
    created_at: 1_700_000_000 + seq,
    tags: [],
    content: '',
    ...partial,
  }
}

type Filter = { ids?: string[]; kinds?: number[]; authors?: string[] } & Record<string, unknown>

function relay(events: SignedEvent[]) {
  const asked: Filter[] = []
  const matches = (e: SignedEvent, filter: Filter) => {
    if (filter.ids && !filter.ids.includes(e.id)) return false
    if (filter.kinds && !filter.kinds.includes(e.kind)) return false
    if (filter.authors && !filter.authors.includes(e.pubkey)) return false
    for (const [key, values] of Object.entries(filter)) {
      if (!key.startsWith('#')) continue
      const held = e.tags.filter((t) => t[0] === key.slice(1)).map((t) => t[1])
      if (!held.some((v) => (values as string[]).includes(v))) return false
    }
    return true
  }
  const query = async (filters: Record<string, unknown>[]) => {
    asked.push(...(filters as Filter[]))
    return events.filter((e) => filters.some((f) => matches(e, f as Filter)))
  }
  return { query, asked }
}

const folder = () =>
  event({ kind: KIND_CHANNEL_METADATA, tags: [['d', FOLDER], ['name', 'Accounts'], ['about', 'Closing the books, every quarter']] })

const message = (body: string) => event({ kind: KIND_MESSAGE, pubkey: PERSON, tags: [['h', FOLDER]], content: body })

/** Peek after its republish: the conversation aspect, and no claim on any kind. */
const peek = () =>
  event({
    kind: 31990,
    pubkey: PEEK,
    tags: [
      ['d', 'estiva-peek'],
      ['web', 'https://peek.example/o/<bech32>', 'naddr'],
      ['web', 'https://peek.example/e/<bech32>', 'nevent'],
    ],
    content: JSON.stringify({ name: 'Peek', aspect: 'conversation', fileNoun: 'topic', projections: {} }),
  })

/**
 * Peek before it: claiming both kinds, and drawing them in ways the
 * specification does not, so a resolve that read the claim would show it.
 */
const stalePeek = () =>
  event({
    kind: 31990,
    pubkey: PEEK,
    tags: [
      ['d', 'estiva-peek'],
      ['k', String(KIND_CHANNEL_METADATA)],
      ['k', String(KIND_MESSAGE)],
      ['web', 'https://peek.example/o/<bech32>', 'naddr'],
      ['web', 'https://peek.example/e/<bech32>', 'nevent'],
    ],
    content: JSON.stringify({
      name: 'Peek',
      aspect: 'conversation',
      projections: {
        [KIND_CHANNEL_METADATA]: {
          widget: 'row',
          noun: 'topic',
          slots: {
            title: { field: 'pubkey' },
            list: { children: { kind: KIND_MESSAGE, via: 'h', match: 'identifier', limit: 50 } },
          },
        },
        [KIND_MESSAGE]: { widget: 'row', noun: 'chat', slots: { title: { field: 'content' } } },
      },
    }),
  })

describe('a Folder is drawn from the specification', () => {
  it('has its name, its about, the noun folder, and opens where conversations open', async () => {
    const found = await resolveForeignObject(FOLDER_ADDRESS, relay([peek(), folder()]).query)
    assert.ok(found)
    assert.equal(found.slots.title.value, 'Accounts')
    assert.equal(found.slots.subtitle?.value, 'Closing the books, every quarter')
    assert.equal(found.noun, 'folder')
    assert.equal(found.appName, 'Peek', 'named only by where its link goes')
    assert.ok(found.openUrl?.startsWith('https://peek.example/o/naddr1'), found.openUrl)
  })

  it('cuts a long one-liner at 120 characters, as Peek’s claim did, so no card grows when the claim goes', async () => {
    const about = 'Closing the books every quarter, with the receipts, the bank exports and the questions for the accountant, '.repeat(2)
    const long = event({ kind: KIND_CHANNEL_METADATA, tags: [['d', FOLDER], ['name', 'Accounts'], ['about', about]] })
    const found = await resolveForeignObject(FOLDER_ADDRESS, relay([peek(), long]).query)
    const shown = found?.slots.subtitle?.value
    assert.ok(typeof shown === 'string' && shown.length <= 121, `cut, not ${String(shown).length} characters`)
    assert.ok(shown.startsWith('Closing the books every quarter'), shown)
  })

  it('reads no claim on it, and no messages as its contents', async () => {
    const { query, asked } = relay([stalePeek(), folder(), message('one'), message('two')])
    const found = await resolveForeignObject(FOLDER_ADDRESS, query)
    assert.equal(found?.slots.title.value, 'Accounts', 'the name, not the claim’s title')
    assert.equal(found?.noun, 'folder')
    assert.equal(found?.widget, 'card')
    assert.equal(found?.children, undefined)
    assert.equal(found?.listsChildren, false)
    assert.ok(!asked.some((f) => (f['#k'] as string[] | undefined)?.includes(String(KIND_CHANNEL_METADATA))), 'nobody is asked who owns it')
    assert.ok(!asked.some((f) => f.kinds?.includes(KIND_MESSAGE)), 'a Folder chip pays for no messages')
  })

  it('still has its name, with nowhere to open, when no app declares conversations', async () => {
    const found = await resolveForeignObject(FOLDER_ADDRESS, relay([folder()]).query)
    assert.equal(found?.slots.title.value, 'Accounts')
    assert.equal(found?.openUrl, undefined)
    assert.deepEqual(
      found?.actions.map((a) => [a.id, a.declaredBy?.address]),
      [
        ['create-file', FOLDER_ACTIONS_ADDRESS],
        ['start-a-conversation', FOLDER_ACTIONS_ADDRESS],
      ],
      'what every app may do in it needs no app',
    )
  })

  it('is the unreachable stub, called a Folder, when this reader cannot see it', async () => {
    const found = await resolveForeignObject(FOLDER_ADDRESS, relay([peek()]).query)
    assert.equal(found?.unreachable, true)
    assert.equal(found?.noun, 'folder')
    assert.deepEqual(found?.actions, [])
  })

  it('resolves the same in a set as alone', async () => {
    const { query } = relay([stalePeek(), folder()])
    const set = await resolveForeignObjects([FOLDER_ADDRESS], query, undefined, createProjectionCache())
    assert.equal(set[FOLDER_ADDRESS]?.slots.title.value, 'Accounts')
    assert.equal(set[FOLDER_ADDRESS]?.noun, 'folder')
  })
})

/*
  A Folder's card lists the files in it this reader can open (Miky, 2026-10-16):
  what its relay-signed `30890` names, never its chat messages and never a count
  of what the reader cannot open. A chip asks for nothing of it.
*/
const KIND_BARE_FILE = 30840
const KIND_FOLDER_STATE = 30890
const topic = (d: string, title: string) =>
  event({ kind: KIND_BARE_FILE, pubkey: PERSON, tags: [['d', d], ['title', title], ['h', FOLDER]] })
const addressOf = (file: SignedEvent) => `${file.kind}:${file.pubkey}:${file.tags.find((t) => t[0] === 'd')?.[1]}`
/** The relay's listing of the Folder, naming each address given. */
const state = (...addresses: string[]) =>
  event({ kind: KIND_FOLDER_STATE, tags: [['d', FOLDER], ...addresses.map((a) => ['a', a])] })

describe('a Folder card lists its files', () => {
  it('lists the files its listing names that this reader can open, and nothing of the rest', async () => {
    const quarter = topic('quarter', 'Q3 close')
    const receipts = topic('receipts', 'Receipts to chase')
    // Named by the listing, and not readable here: absent, and not counted.
    const hidden = `${KIND_BARE_FILE}:${PERSON}:payroll`
    const { query } = relay([stalePeek(), folder(), message('one'), quarter, receipts, state(addressOf(quarter), hidden, addressOf(receipts))])
    const found = await resolveForeignObject(FOLDER_ADDRESS, query, undefined, 0, undefined, { folderFiles: true })
    assert.deepEqual(
      found?.children?.map((c) => c.slots.title.value),
      ['Q3 close', 'Receipts to chase'],
      'its files, in the listing’s order — no messages, no stand-in for the one this reader cannot open',
    )
    assert.equal(found?.slots.title.value, 'Accounts')
  })

  it('says it holds nothing when its listing names nothing', async () => {
    const { query } = relay([peek(), folder(), message('one'), state()])
    const found = await resolveForeignObject(FOLDER_ADDRESS, query, undefined, 0, undefined, { folderFiles: true })
    assert.deepEqual(found?.children, [])
  })

  it('lists nothing a file claims by naming the Folder itself, when the relay keeps no listing for it', async () => {
    // A DM is such a Folder: no list under it, rather than "nothing in it".
    const claimed = topic('claimed', 'Filed by its own h')
    const found = await resolveForeignObject(FOLDER_ADDRESS, relay([peek(), folder(), claimed]).query, undefined, 0, undefined, {
      folderFiles: true,
    })
    assert.equal(found?.slots.title.value, 'Accounts')
    assert.equal(found?.children, undefined)
  })

  it('still draws, with no list rather than an empty one, when its listing cannot be read', async () => {
    const { query: answer } = relay([peek(), folder()])
    const query = async (filters: Record<string, unknown>[]) => {
      if (filters.some((f) => (f.kinds as number[] | undefined)?.includes(KIND_FOLDER_STATE))) throw new Error('rate-limited')
      return answer(filters)
    }
    const found = await resolveForeignObject(FOLDER_ADDRESS, query, undefined, 0, undefined, { folderFiles: true })
    assert.equal(found?.slots.title.value, 'Accounts')
    assert.equal(found?.children, undefined)
  })

  it('a chip reads no listing', async () => {
    const quarter = topic('quarter', 'Q3 close')
    const { query, asked } = relay([peek(), folder(), quarter, state(addressOf(quarter))])
    const found = await resolveForeignObject(FOLDER_ADDRESS, query)
    assert.equal(found?.slots.title.value, 'Accounts')
    assert.equal(found?.children, undefined)
    assert.ok(!asked.some((f) => f.kinds?.includes(KIND_FOLDER_STATE)), 'a Folder chip pays for no list it does not draw')
  })

  it('lists nothing for a Folder this reader cannot see, though its listing is public', async () => {
    const quarter = topic('quarter', 'Q3 close')
    const { query } = relay([peek(), quarter, state(addressOf(quarter))])
    const found = await resolveForeignObject(FOLDER_ADDRESS, query, undefined, 0, undefined, { folderFiles: true })
    assert.equal(found?.unreachable, true)
    assert.equal(found?.children, undefined)
  })

  it('lists the same files in a set as alone', async () => {
    const quarter = topic('quarter', 'Q3 close')
    const { query } = relay([stalePeek(), folder(), message('one'), quarter, state(addressOf(quarter))])
    const set = await resolveForeignObjects([FOLDER_ADDRESS], query, undefined, createProjectionCache(), { folderFiles: true })
    assert.deepEqual(set[FOLDER_ADDRESS]?.children?.map((c) => c.slots.title.value), ['Q3 close'])
  })
})

describe('a chat message is drawn from the specification', () => {
  it('draws as a message: its author as the title, its text as the body, called a message', async () => {
    const said = message('Shall we close on Friday?')
    const found = await resolveForeignEvent(said.id, relay([peek(), said]).query)
    assert.ok(found)
    assert.deepEqual(found.widget, ['message', 'card'])
    assert.equal(found.slots.title.value, PERSON)
    assert.equal(found.slots.title.isPubkey, true)
    assert.equal(found.slots.body?.value, 'Shall we close on Friday?')
    assert.equal(found.noun, 'message', 'the protocol’s word, not the opener’s word for a file')
    assert.equal(found.appName, 'Peek')
    assert.ok(found.openUrl?.startsWith('https://peek.example/e/nevent1'), found.openUrl)
  })

  it('reads no claim on it', async () => {
    const said = message('hello')
    const { query, asked } = relay([stalePeek(), said])
    const found = await resolveForeignEvent(said.id, query)
    assert.equal(found?.slots.title.value, PERSON, 'the author, not the claim’s title')
    assert.equal(found?.noun, 'message')
    assert.ok(!asked.some((f) => (f['#k'] as string[] | undefined)?.includes(String(KIND_MESSAGE))), 'nobody is asked who owns it')
  })

  it('still draws, with nowhere to open, when no app declares conversations', async () => {
    const said = message('hello')
    const found = await resolveForeignEvent(said.id, relay([said]).query)
    assert.equal(found?.slots.body?.value, 'hello')
    assert.equal(found?.noun, 'message')
    assert.equal(found?.openUrl, undefined)
  })
})

/**
 * THE-5 — the client side of NIP-77 set reconciliation.
 *
 * The relay runs the Rust `negentropy` crate; the production probe checks the
 * client against it. Here the relay's side is this module's own (a set that
 * never initiates), and nostr-tools' client, a separate port of the same
 * reference, is run against it too, so the wire format is not checked only
 * against itself.
 */
import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import { dirname, join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { Negentropy, NegentropySet } from '../dist/index.js'

const require = createRequire(import.meta.url)
const nip77Path = join(dirname(require.resolve('nostr-tools')), '..', 'esm', 'nip77.js')
const other = (await import(pathToFileURL(nip77Path).href)) as {
  NegentropyStorageVector: new () => { insert(t: number, id: string): void; seal(): void }
  Negentropy: new (
    storage: unknown,
    frameSizeLimit?: number,
  ) => {
    initiate(): string
    reconcile(msg: string, onhave?: (id: string) => void, onneed?: (id: string) => void): string | null
  }
}

let seed = 7
function random(): number {
  seed = (seed * 1103515245 + 12345) % 2 ** 31
  return seed / 2 ** 31
}
function randomId(): string {
  let out = ''
  for (let i = 0; i < 64; i++) out += Math.floor(random() * 16).toString(16)
  return out
}

type Item = { id: string; t: number }
type Client = {
  initiate(): string
  reconcile(msg: string, onhave: (id: string) => void, onneed: (id: string) => void): string | null
}

function ourClient(items: Item[], frameSizeLimit: number): Client {
  const set = new NegentropySet()
  for (const item of items) set.insert(item.t, item.id)
  return new Negentropy(set, frameSizeLimit)
}

function theirClient(items: Item[]): Client {
  const storage = new other.NegentropyStorageVector()
  for (const item of items) storage.insert(item.t, item.id)
  storage.seal()
  return new other.Negentropy(storage, 60_000)
}

/** Run a whole reconciliation: a client against this module playing the relay. */
function reconcile(client: Client, relay: Item[], relayFrameLimit = 0) {
  const set = new NegentropySet()
  for (const item of relay) set.insert(item.t, item.id)
  const relaySide = new Negentropy(set, relayFrameLimit)
  const need: string[] = []
  const have: string[] = []
  let message: string | null = client.initiate()
  let rounds = 0
  while (message !== null) {
    const answer = relaySide.reconcile(message, () => {}, () => {})!
    message = client.reconcile(answer, (id) => have.push(id), (id) => need.push(id))
    rounds += 1
    assert.ok(rounds < 100, 'a reconciliation ends')
  }
  return { need: need.sort(), have: have.sort(), rounds }
}

function items(n: number, from = 1_700_000_000): Item[] {
  return Array.from({ length: n }, (_, i) => ({ id: randomId(), t: from + Math.floor(i / 3) }))
}

const ids = (list: Item[]) => list.map((item) => item.id).sort()

describe('negentropy reconciliation', () => {
  it('finds nothing to do when both sides hold the same set', () => {
    const both = items(500)
    const result = reconcile(ourClient(both, 60_000), both)
    assert.deepEqual(result.need, [])
    assert.deepEqual(result.have, [])
  })

  it('names exactly what the copy is missing and what the relay no longer has', () => {
    const shared = items(3_000)
    const added = items(40, 1_800_000_000)
    const gone = shared.filter((_, i) => i % 97 === 0)
    const relay = [...shared.filter((item) => !gone.includes(item)), ...added]
    const result = reconcile(ourClient(shared, 60_000), relay)
    assert.deepEqual(result.need, ids(added))
    assert.deepEqual(result.have, ids(gone))
  })

  it('an empty copy learns the whole set, and an empty relay drops every held one', () => {
    const set = items(200)
    assert.deepEqual(reconcile(ourClient([], 60_000), set).need, ids(set))
    assert.deepEqual(reconcile(ourClient(set, 60_000), []).have, ids(set))
  })

  it('still ends exact when messages must stay small and it takes several rounds', () => {
    const shared = items(20_000)
    const added = items(1_000, 1_900_000_000)
    const relay = shared.slice(1_000).concat(added)
    const result = reconcile(ourClient(shared, 4_096), relay, 4_096)
    assert.deepEqual(result.need, ids(added))
    assert.deepEqual(result.have, ids(shared.slice(0, 1_000)))
    assert.ok(result.rounds > 1, `took ${result.rounds} rounds`)
  })

  it('reads and writes the same messages as nostr-tools, an independent port', () => {
    const shared = items(2_000)
    const added = items(25, 1_800_000_000)
    const relay = shared.slice(30).concat(added)
    const ours = reconcile(ourClient(shared, 60_000), relay)
    const theirs = reconcile(theirClient(shared), relay)
    assert.deepEqual(ours, theirs)
    assert.deepEqual(ours.need, ids(added))
    assert.deepEqual(ours.have, ids(shared.slice(0, 30)))
  })
})

/**
 * A card's children are folded — MAN-7.
 *
 * A card's inline `list` used to build each child from its root alone. So once
 * an app declared `movedBy` (SPEC §7.2), a child moved to another parent was
 * still drawn under the one it was created in, and every folded slot on a child
 * showed what the root said at creation. The Folder listing folded both; only
 * the card did not.
 *
 * The claims under test:
 *
 * - a child whose folded `movedBy` names another parent is not on the card,
 *   and one moved back is; a move to no parent is a move away too;
 * - a child's folded slots are its fold, not its root;
 * - hidden and archived children are left out, as the listing leaves them out;
 * - the fold costs one more read only when there is one to read, and one for a
 *   whole batched set rather than one per card.
 *
 * The app is one nobody wrote — a garden whose beds hold plants — for the
 * reason `folder-contents` gives: a rule that only held for Ship would be
 * measuring an integration.
 */
import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import { resolveForeignObject, resolveForeignObjects, createProjectionCache } from '../dist/index.js'

const GARDENER = 'a'.repeat(64)
const HELPER = 'c'.repeat(64)
const BED = 30881
const PLANT = 30882
const MESSAGE = 9

let seq = 0
const event = (partial) => ({
  id: String(++seq).padStart(64, '0'),
  sig: '',
  pubkey: GARDENER,
  created_at: 1_700_000_000 + seq,
  tags: [],
  content: '',
  ...partial,
})

/** The fake relay, plus every set of filters it was asked. */
function countingRelay(events) {
  const calls = []
  const query = async (filters) => {
    calls.push(filters)
    return events.filter((e) =>
      filters.some((f) => {
        if (f.kinds && !f.kinds.includes(e.kind)) return false
        if (f.authors && !f.authors.includes(e.pubkey)) return false
        for (const [key, want] of Object.entries(f)) {
          if (!key.startsWith('#')) continue
          const held = e.tags.filter((t) => t[0] === key.slice(1)).map((t) => t[1])
          if (!want.some((v) => held.includes(v))) return false
        }
        return true
      }),
    )
  }
  return { query, calls }
}

const manifestOf = (content) =>
  event({
    kind: 31990,
    tags: [['d', 'garden'], ['k', String(BED)], ['k', String(PLANT)], ['k', String(MESSAGE)]],
    content: JSON.stringify(content),
  })

const GARDEN = {
  name: 'Garden',
  records: {
    changeKind: 1851,
    targetTag: 'a',
    fieldTag: 'f',
    valueTag: 'v',
    hiddenWhen: { field: 'pulled', equals: 'true' },
  },
  projections: {
    [BED]: {
      widget: 'card',
      slots: {
        title: { tag: 'title' },
        list: { children: { kind: PLANT, via: 'a', limit: 200, movedBy: 'bed' } },
      },
    },
    [PLANT]: {
      widget: 'row',
      slots: { title: { tag: 'title', fold: 'title' }, stage: { fold: 'stage', default: 'seedling' } },
    },
  },
}

const bedAddress = (d) => `${BED}:${GARDENER}:${d}`
const plantAddress = (d) => `${PLANT}:${GARDENER}:${d}`
const bed = (d) => event({ kind: BED, tags: [['d', d], ['title', d]] })
const plant = (d, inBed) => event({ kind: PLANT, tags: [['d', d], ['title', d], ['a', bedAddress(inBed)]] })
const change = (target, field, value, by = GARDENER) =>
  event({ kind: 1851, pubkey: by, tags: [['a', target], ['f', field], ['v', value]] })

const titles = (card) => card.children.map((c) => c.slots.title.value)

describe('a child moved to another parent', () => {
  test('is not on its old parent’s card, and is on neither card once moved to none', async () => {
    const events = [manifestOf(GARDEN), bed('east'), bed('west'), plant('tomato', 'east'), plant('basil', 'east')]
    events.push(change(plantAddress('basil'), 'bed', bedAddress('west'), HELPER))
    const { query } = countingRelay(events)

    const east = await resolveForeignObject(bedAddress('east'), query)
    assert.deepEqual(titles(east), ['tomato'], 'basil was moved to the west bed')

    /*
      Not found under the new parent either: a `#via` read cannot see a move
      *in*, because the new parent is in a `value`. A move carrying no
      `MOVED_TO_TAG` — one written before SPEC §7.2 asked for it — stays
      invisible there; see "a child moved in" below for one that carries it.
    */
    const west = await resolveForeignObject(bedAddress('west'), query)
    assert.deepEqual(titles(west), [])

    events.push(change(plantAddress('tomato'), 'bed', ''))
    const emptied = await resolveForeignObject(bedAddress('east'), query)
    assert.deepEqual(titles(emptied), [], 'an empty value is a move to no parent, not an absence')
  })

  test('is back once moved back — the latest move wins', async () => {
    const events = [manifestOf(GARDEN), bed('east'), plant('basil', 'east')]
    events.push(change(plantAddress('basil'), 'bed', bedAddress('west')))
    events.push(change(plantAddress('basil'), 'bed', bedAddress('east')))
    const { query } = countingRelay(events)

    const east = await resolveForeignObject(bedAddress('east'), query)
    assert.deepEqual(titles(east), ['basil'])
    assert.equal(east.children[0].parentRef, bedAddress('east'))
  })

  test('a value naming no bed is treated as empty — gone, not kept on its old tag', async () => {
    const events = [manifestOf(GARDEN), bed('east'), plant('basil', 'east')]
    events.push(change(plantAddress('basil'), 'bed', 'not-an-address'))
    const { query } = countingRelay(events)
    assert.deepEqual(titles(await resolveForeignObject(bedAddress('east'), query)), [])
  })

  test('without movedBy declared, a change to that field moves nothing', async () => {
    const undeclared = structuredClone(GARDEN)
    delete undeclared.projections[BED].slots.list.children.movedBy
    const events = [manifestOf(undeclared), bed('east'), plant('basil', 'east')]
    events.push(change(plantAddress('basil'), 'bed', bedAddress('west')))
    const { query } = countingRelay(events)
    assert.deepEqual(titles(await resolveForeignObject(bedAddress('east'), query)), ['basil'])
  })

  test('a card reads its own list’s movedBy — not another projection’s, and never on an identifier list', async () => {
    /*
      A plot lists plants by its `d` (`match: 'identifier'`) while a bed lists
      the same kind by address, with `movedBy`. SPEC §7.2: `movedBy` is ignored
      where the child tag is not an address, so moving a plant between beds
      says nothing about which plot lists it.
    */
    const PLOT = 30883
    const two = structuredClone(GARDEN)
    two.projections[PLOT] = {
      widget: 'card',
      slots: { title: { tag: 'title' }, list: { children: { kind: PLANT, via: 'h', match: 'identifier' } } },
    }
    const manifest = manifestOf(two)
    manifest.tags.push(['k', String(PLOT)])
    const events = [manifest, bed('east'), event({ kind: PLOT, tags: [['d', 'north'], ['title', 'north']] })]
    events.push(event({ kind: PLANT, tags: [['d', 'basil'], ['title', 'basil'], ['h', 'north'], ['a', bedAddress('east')]] }))
    events.push(change(plantAddress('basil'), 'bed', bedAddress('west')))
    const { query } = countingRelay(events)

    assert.deepEqual(titles(await resolveForeignObject(`${PLOT}:${GARDENER}:north`, query)), ['basil'])
    assert.deepEqual(titles(await resolveForeignObject(bedAddress('east'), query)), [], 'the bed’s list still moves it')
  })
})

/** A move as SPEC §7.2 writes it since FOL-45: the new parent again, as `A`, where a relay indexes it. */
const move = (target, toBed, by = GARDENER) =>
  event({ kind: 1851, pubkey: by, tags: [['a', target], ['f', 'bed'], ['v', toBed], ['A', toBed]] })

describe('a child moved in (FOL-45)', () => {
  test('is on its new parent’s card, found by its move, and folded like any child', async () => {
    const events = [manifestOf(GARDEN), bed('east'), bed('west'), plant('tomato', 'west'), plant('basil', 'east')]
    events.push(move(plantAddress('basil'), bedAddress('west'), HELPER))
    events.push(change(plantAddress('basil'), 'stage', 'flowering'))
    const { query } = countingRelay(events)

    const west = await resolveForeignObject(bedAddress('west'), query)
    assert.deepEqual(titles(west), ['tomato', 'basil'])
    const basil = west.children.find((c) => c.slots.title.value === 'basil')
    assert.equal(basil.parentRef, bedAddress('west'))
    assert.equal(basil.slots.stage.value, 'flowering', 'its fold, read with its move')
    assert.deepEqual(titles(await resolveForeignObject(bedAddress('east'), query)), [])
  })

  test('is gone again once moved on — the tag found it, the fold decides', async () => {
    const events = [manifestOf(GARDEN), bed('east'), bed('west'), bed('north'), plant('basil', 'east')]
    events.push(move(plantAddress('basil'), bedAddress('west')))
    events.push(move(plantAddress('basil'), bedAddress('north')))
    const { query } = countingRelay(events)

    assert.deepEqual(titles(await resolveForeignObject(bedAddress('west'), query)), [], 'the west move is stale')
    assert.deepEqual(titles(await resolveForeignObject(bedAddress('north'), query)), ['basil'])
  })

  test('is drawn once when it was created here, moved away and moved back', async () => {
    const events = [manifestOf(GARDEN), bed('east'), plant('basil', 'east')]
    events.push(move(plantAddress('basil'), bedAddress('west')))
    events.push(move(plantAddress('basil'), bedAddress('east')))
    const { query } = countingRelay(events)
    assert.deepEqual(titles(await resolveForeignObject(bedAddress('east'), query)), ['basil'])
  })

  test('is left out when hidden, as a child created here would be', async () => {
    const events = [manifestOf(GARDEN), bed('east'), bed('west'), plant('basil', 'east')]
    events.push(move(plantAddress('basil'), bedAddress('west')))
    events.push(change(plantAddress('basil'), 'pulled', 'true'))
    const { query } = countingRelay(events)
    assert.deepEqual(titles(await resolveForeignObject(bedAddress('west'), query)), [])
  })

  test('is found when its identifier holds a colon', async () => {
    const events = [manifestOf(GARDEN), bed('east'), bed('west'), plant('row:3', 'east')]
    events.push(move(plantAddress('row:3'), bedAddress('west')))
    const { query } = countingRelay(events)
    assert.deepEqual(titles(await resolveForeignObject(bedAddress('west'), query)), ['row:3'])
  })

  test('is not a child of another kind: a move naming this parent for another kind is ignored', async () => {
    const events = [manifestOf(GARDEN), bed('east'), bed('west')]
    events.push(move(bedAddress('east'), bedAddress('west')))
    const { query } = countingRelay(events)
    assert.deepEqual(titles(await resolveForeignObject(bedAddress('west'), query)), [])
  })

  test('costs no request of its own: its moves ride the card’s read, its root the fold’s', async () => {
    const events = [manifestOf(GARDEN), bed('east'), bed('west'), plant('basil', 'east')]
    events.push(move(plantAddress('basil'), bedAddress('west')))
    const relay = countingRelay(events)
    const cache = createProjectionCache()
    await resolveForeignObject(bedAddress('west'), relay.query, undefined, 0, cache)
    const cold = relay.calls.length
    await resolveForeignObject(bedAddress('west'), relay.query, undefined, 0, cache)
    const calls = relay.calls.slice(cold)
    assert.equal(calls.length, 2)
    assert.ok(calls[0].some((f) => f['#A']?.[0] === bedAddress('west')), 'the moves are in the card’s own read')
    assert.ok(calls[1].some((f) => f['#d']?.[0] === 'basil' && f.kinds[0] === PLANT), 'the root is read with the changes')
  })

  test('in a batched set too', async () => {
    const events = [manifestOf(GARDEN), bed('east'), bed('west'), plant('basil', 'east')]
    events.push(move(plantAddress('basil'), bedAddress('west')))
    const { query } = countingRelay(events)
    const cards = await resolveForeignObjects([bedAddress('east'), bedAddress('west')], query)
    assert.deepEqual(titles(cards[bedAddress('east')]), [])
    assert.deepEqual(titles(cards[bedAddress('west')]), ['basil'])
  })
})

describe('a child’s own fold', () => {
  test('its folded slots are its fold, not its root', async () => {
    const events = [manifestOf(GARDEN), bed('east'), plant('basil', 'east')]
    events.push(change(plantAddress('basil'), 'stage', 'flowering'))
    events.push(change(plantAddress('basil'), 'title', 'Thai basil'))
    const { query } = countingRelay(events)

    const [basil] = (await resolveForeignObject(bedAddress('east'), query)).children
    assert.equal(basil.slots.stage.value, 'flowering')
    assert.equal(basil.slots.title.value, 'Thai basil')
  })

  test('a change naming the child second is not the child’s', async () => {
    // The target is the first target tag, as every other fold reads it.
    const events = [manifestOf(GARDEN), bed('east'), plant('basil', 'east'), plant('mint', 'east')]
    events.push(
      event({ kind: 1851, tags: [['a', plantAddress('mint')], ['a', plantAddress('basil')], ['f', 'stage'], ['v', 'wilted']] }),
    )
    const { query } = countingRelay(events)

    const children = (await resolveForeignObject(bedAddress('east'), query)).children
    const stage = Object.fromEntries(children.map((c) => [c.slots.title.value, c.slots.stage.value]))
    assert.deepEqual(stage, { basil: 'seedling', mint: 'wilted' })
  })

  test('hidden and archived children are left out, as the Folder listing leaves them out', async () => {
    const events = [manifestOf(GARDEN), bed('east'), plant('basil', 'east'), plant('mint', 'east'), plant('dill', 'east')]
    events.push(change(plantAddress('mint'), 'pulled', 'true'))
    events.push(change(plantAddress('dill'), 'archived', 'true'))
    const { query } = countingRelay(events)
    assert.deepEqual(titles(await resolveForeignObject(bedAddress('east'), query)), ['basil'])
  })
})

describe('what the fold costs', () => {
  const warm = async (events, resolve) => {
    const relay = countingRelay(events)
    const cache = createProjectionCache()
    await resolve(relay.query, cache)
    const cold = relay.calls.length
    await resolve(relay.query, cache)
    return { requests: relay.calls.length - cold, calls: relay.calls.slice(cold) }
  }

  test('a card with addressable children is two requests warm, the second asking only for their changes', async () => {
    const events = [manifestOf(GARDEN), bed('east'), plant('basil', 'east'), plant('mint', 'east')]
    const { requests, calls } = await warm(events, (q, cache) => resolveForeignObject(bedAddress('east'), q, undefined, 0, cache))
    assert.equal(requests, 2)
    assert.deepEqual(calls[1], [{ kinds: [1851], '#a': [plantAddress('basil'), plantAddress('mint')], limit: 1000 }])
  })

  test('a card with no children, or an app with no change events, stays one request', async () => {
    const empty = await warm([manifestOf(GARDEN), bed('east')], (q, cache) =>
      resolveForeignObject(bedAddress('east'), q, undefined, 0, cache),
    )
    assert.equal(empty.requests, 1, 'no children, nothing to fold')

    const folding = structuredClone(GARDEN)
    delete folding.records
    const unfolded = await warm([manifestOf(folding), bed('east'), plant('basil', 'east')], (q, cache) =>
      resolveForeignObject(bedAddress('east'), q, undefined, 0, cache),
    )
    assert.equal(unfolded.requests, 1, 'an app that declares no change events has no fold to read')
  })

  test('a list of regular events stays one request — nothing changes a message by address', async () => {
    const topics = structuredClone(GARDEN)
    topics.projections[BED].slots.list = { children: { kind: MESSAGE, via: 'a' } }
    topics.projections[MESSAGE] = { widget: 'message', slots: { body: { field: 'content' } } }
    const events = [manifestOf(topics), bed('east'), event({ kind: MESSAGE, content: 'watered', tags: [['a', bedAddress('east')]] })]
    const { requests } = await warm(events, (q, cache) => resolveForeignObject(bedAddress('east'), q, undefined, 0, cache))
    assert.equal(requests, 1)
  })

  test('a batched set folds every card’s children in one more read, not one per card', async () => {
    const events = [manifestOf(GARDEN)]
    const beds = ['b1', 'b2', 'b3', 'b4']
    for (const d of beds) events.push(bed(d), plant(`${d}-a`, d), plant(`${d}-b`, d))
    events.push(change(plantAddress('b3-b'), 'bed', bedAddress('b1')))
    const addresses = beds.map(bedAddress)

    const { requests } = await warm(events, (q, cache) => resolveForeignObjects(addresses, q, undefined, cache))
    assert.equal(requests, 2)

    const { query } = countingRelay(events)
    const cards = await resolveForeignObjects(addresses, query)
    assert.deepEqual(titles(cards[bedAddress('b3')]), ['b3-a'])
    // Every card is what the single resolve gives for it.
    for (const address of addresses) {
      assert.deepEqual(titles(cards[address]), titles(await resolveForeignObject(address, query)))
    }
  })
})

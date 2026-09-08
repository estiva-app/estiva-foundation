/**
 * PRO-18 — the two things that made a conversation undeclarable.
 *
 * Peek's manifest says `actions: []` and explains itself: the obvious action is
 * a reply, and *"declaring it with the tags that exist would tell a consumer to
 * publish a malformed reply."* That was right, and the ticket's diagnosis of
 * why was only half right. It said an action could not name a Folder — but
 * `buildCreationEvent` has written `["h", folder]` on every created event since
 * PRO-4. The consumer already puts the event in a Folder.
 *
 * What actually blocked it, measured against the code rather than the ticket:
 *
 * 1. **A message's body cannot be a tag.** Every property becomes one, and a
 *    `kind:9` carrying its text in a tag is not a message. So a property may
 *    now declare `target: "content"`.
 * 2. **An object that *is* a Folder names none.** A Peek topic is a
 *    `kind:39000` whose identifier is the channel, so the `h`/`buzz-channel`
 *    read that serves every Ship record finds nothing on it and the write is
 *    refused for having nowhere to go.
 *
 * The second was answered in 0.13.0 with `records.folder: "identifier"` and
 * **withdrawn in 0.14.0**, before any manifest declared it. RFC 0.5 §1 retires
 * the shape it served: a Folder holds several files of the same kind — three
 * topics and two projects — so a topic becomes a file inside a Folder and
 * carries an `h` like everything else. What remains of it here is `folderOf`,
 * which consolidates the two tag spellings and is worth having on its own.
 *
 * The fixtures below are an app nobody wrote, for the same reason
 * `action-conformance` uses one: the test of a vocabulary is that it works for
 * an app this team has never seen.
 */
import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import {
  buildActionEvent,
  folderOf,
  actionProblems,
  resolveForeignObject,
  KIND_CHANNEL_METADATA,
} from '../dist/index.js'

const AUTHOR = 'a'.repeat(64)
const COLONY = 39701
const SIGHTING = 9
const FOLDER = '7b32200c-e4c0-4216-b79a-8490fc05e0bd'
const ADDRESS = `${COLONY}:${AUTHOR}:weir`

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

const relay = (events) => async (filters) =>
  events.filter((e) =>
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

/** A sighting: a species on a tag, and the note as the event's body. */
const logSighting = {
  id: 'log-sighting',
  label: 'Log a sighting',
  description: 'Record that a bird was seen in this colony, with the species and a note about it.',
  effect: 'writes',
  appliesTo: [String(COLONY)],
  emits: { kind: SIGHTING },
  input: {
    type: 'object',
    properties: { species: { type: 'string' }, note: { type: 'string', target: 'content' } },
    required: ['species'],
  },
}

const content = (actions, records = {}) => ({
  name: 'Ringing log',
  records: { changeKind: 1851, targetTag: 'a', fieldTag: 'f', valueTag: 'v', ...records },
  projections: { [COLONY]: { widget: 'card', slots: { title: { tag: 'title' } } } },
  actions,
})

const manifest = (actions, records) =>
  event({
    kind: 31990,
    tags: [['d', 'ringing-log'], ['k', String(COLONY)]],
    content: JSON.stringify(content(actions, records)),
  })

const colony = event({ kind: COLONY, tags: [['d', 'weir'], ['title', 'Weir colony']] })

const build = (values, over = {}) =>
  buildActionEvent({
    manifest: content([logSighting]),
    kind: COLONY,
    address: ADDRESS,
    objectAuthor: AUTHOR,
    folder: FOLDER,
    actionId: 'log-sighting',
    value: values,
    pubkey: AUTHOR,
    createdAtMs: 1_700_000_000_000,
    ...over,
  })

const tag = (e, name) => e.tags.find((t) => t[0] === name)?.[1]

describe('a property may be the event’s body', () => {
  test('it becomes the content, and not a tag', () => {
    const built = build({ species: 'Kingfisher', note: 'By the weir, fishing.' })

    assert.equal(built.content, 'By the weir, fishing.')
    assert.equal(tag(built, 'note'), undefined, 'the body must not also be a tag')
    // Every other property is unaffected: a name is still a tag.
    assert.equal(tag(built, 'species'), 'Kingfisher')
  })

  test('the event still lands in a Folder — that part always worked', () => {
    // The ticket's own premise, checked. `h` has been written since PRO-4, so
    // "an action cannot name a Folder" was never the blocker.
    assert.equal(tag(build({ species: 'Kingfisher' }), 'h'), FOLDER)
  })

  test('an omitted body is an empty content, not a missing field', () => {
    const built = build({ species: 'Kingfisher' })
    assert.equal(built.content, '')
  })

  test('a consumer is told which field is the body, so it can draw prose', async () => {
    const found = await resolveForeignObject(ADDRESS, relay([manifest([logSighting]), colony]))
    const action = found.actions.find((a) => a.id === 'log-sighting')
    const field = (name) => action.fields.find((f) => f.name === name)

    assert.equal(field('note').target, 'content')
    // Absent rather than false on every other field: a consumer that has never
    // heard of this still draws them exactly as before.
    assert.equal(field('species').target, undefined)
  })

  test('two bodies are refused rather than one silently winning', () => {
    const twoBodies = {
      ...logSighting,
      input: {
        type: 'object',
        properties: {
          note: { type: 'string', target: 'content' },
          detail: { type: 'string', target: 'content' },
        },
      },
    }
    const refused = build({ note: 'a', detail: 'b' }, { manifest: content([twoBodies]) })

    assert.equal(typeof refused, 'string')
    assert.match(refused, /fields writing to content/)
  })
})

describe('the producer check catches it before the manifest is signed', () => {
  test('two content fields are a problem a person can read', () => {
    const problems = actionProblems({
      ...logSighting,
      input: {
        type: 'object',
        properties: {
          note: { type: 'string', target: 'content' },
          detail: { type: 'string', target: 'content' },
        },
      },
    })
    assert.equal(problems.length, 1)
    assert.match(problems[0], /writes 2 properties to content/)
  })

  test('a target nobody recognises is a problem, because it publishes anyway', () => {
    // The dangerous one: an unrecognised target is ignored, so the value goes
    // to a tag named after the property. That is a valid event in the wrong
    // shape, which no error anywhere would report.
    const problems = actionProblems({
      ...logSighting,
      input: { type: 'object', properties: { note: { type: 'string', target: 'body' } } },
    })
    assert.equal(problems.length, 1)
    assert.match(problems[0], /the only target is "content"/)
  })

  test('a well-formed action still has nothing wrong with it', () => {
    assert.deepEqual(actionProblems(logSighting), [])
  })
})

describe('finding the Folder to write into', () => {
  const record = event({ kind: 30851, tags: [['d', 'i1'], ['h', FOLDER]] })
  const global = event({ kind: 30850, tags: [['d', 'p1'], ['buzz-channel', FOLDER]] })

  test('reads the two tag spellings, which is what Peek had to learn twice', () => {
    // Reading only `h` made five of Ship's fifteen projects unactionable: a
    // record published globally names its Folder with the relay's own tag.
    assert.equal(folderOf(record), FOLDER)
    assert.equal(folderOf(global), FOLDER)
  })

  test('an object carrying neither tag has no Folder, and that is the answer', () => {
    /*
      0.13.0 let an app declare its way out of this with
      `records.folder: "identifier"`, for an object that *is* a container.
      0.14.0 withdrew it: RFC 0.5 §1 makes a topic a file inside a Folder
      rather than the Folder, so the one instance it served stops existing.
      INT-9 brought the *channel record* back as protocol below, which is a
      narrower statement and asks nothing of any manifest.

      Null stays a real answer rather than a gap for everything else. An object
      with nowhere to write is not one to guess a channel for — that publishes
      into somebody else's.
    */
    assert.equal(folderOf(event({ kind: 31337, tags: [['d', 'note']] })), null)
  })

  test('`h` wins over `buzz-channel` when an object carries both', () => {
    const both = event({ kind: 30850, tags: [['d', 'p1'], ['h', FOLDER], ['buzz-channel', 'other']] })
    assert.equal(folderOf(both), FOLDER)
  })

  /*
    INT-9 — the case 0.14.0 took out with the vocabulary, and the reason it is
    back as protocol instead.

    A channel record carries neither tag: measured on production 2026-09-08,
    0 of 40 `kind:39000` events have `h` or `buzz-channel` and 40 of 40 have
    `d`. So every write aimed at a topic was refused for having nowhere to go,
    which is why Peek could declare no action on one. `d` on a `39000` is the
    channel id by the relay's definition — buzz's NOSTR.md states it and
    `h_grammar` is the same uuid — so nothing is declared and no producer can
    opt out.
  */
  describe('a channel record names the Folder it is', () => {
    const topic = event({ kind: KIND_CHANNEL_METADATA, tags: [['d', FOLDER], ['name', 'Weir sightings']] })

    test('resolves to its own identifier, so an action on a topic has somewhere to go', () => {
      assert.equal(folderOf(topic), FOLDER)
    })

    test('an addressable kind that is not the relay’s channel record still has no Folder', () => {
      /*
        The whole point of keying on 39000 rather than on "addressable". A rule
        reading `d` off any 30000-39999 record would hand a consumer a Folder
        for every one of them, and a write would land in a channel that may not
        exist. COLONY is 39701 — addressable, container-shaped, and not the
        relay's — and it stays null.
      */
      assert.equal(folderOf(event({ kind: COLONY, tags: [['d', 'weir']] })), null)
    })

    test('still resolves once FOL-3 gives a topic an `h`, and answers with the `h`', () => {
      /*
        The clause has to decay into dead code rather than into a wrong answer.
        When a topic becomes a file inside a Folder it carries an `h` naming
        that Folder, and its `d` is then its own file identifier — reading the
        `d` in preference would put the write in the topic instead of in the
        Folder holding it. `h` first is what makes the retirement a no-op.
      */
      const filed = event({
        kind: KIND_CHANNEL_METADATA,
        tags: [['d', 'a1b2c3d4-0000-4000-8000-000000000001'], ['h', FOLDER]],
      })
      assert.equal(folderOf(filed), FOLDER)
    })

    test('a channel record with no `d` at all is still null rather than a crash', () => {
      // The relay always writes one. A malformed event is another app's
      // problem to have, not this layer's to throw on.
      assert.equal(folderOf(event({ kind: KIND_CHANNEL_METADATA, tags: [['name', 'nameless']] })), null)
    })
  })
})

/**
 * The projection runtime's behaviour suite — manifest discovery, containment,
 * folding, the active-issue rule, widget chains.
 *
 * **It lived in Peek until now**, because the code moved to this package (PRO-9)
 * and these did not: they were vitest and the foundation packages are
 * `node:test`. Deleting them with the directory would have dropped the shared
 * runtime from 76 cases to the 9 the package carried, so they stayed, pointed
 * at the published package.
 *
 * That was the right call and the wrong resting place. ADR 0002 §10 constraint
 * 3: *its tests run with no app; untested code does not travel.* These need no
 * app — the relay is an array — so nothing excused them living in the consumer
 * that happened to be first (PRO-13).
 *
 * **Converted from vitest by a codemod that was itself tested**, because an
 * earlier regex attempt produced assertions that had silently lost their
 * assert — `expect(found?.openCount, 2)` reads fine and tests nothing. The
 * codemod parses balanced parentheses rather than matching text, refuses any
 * matcher it does not know instead of leaving it, and the run is checked
 * against the counted total: 113 in, 113 out, none surviving.
 *
 * Written against a fake relay rather than a deployment, which is the point of
 * the runtime taking a query function: this exercises the real resolution path
 * with nothing running. It ran under vitest's `node` environment for the same
 * reason — a test that had grown a `document` dependency would have passed in
 * Peek and failed here. It has no such dependency, and now there is no browser
 * to hide one.
 *
 * The manifest below is shaped like Ship's because that is the app in the
 * ecosystem, but nothing in the resolver may depend on it. The last case
 * asserts exactly that: rename every kind and field and the sidebar still
 * fills, which is the claim the whole projection layer exists to make.
 */
import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import {
  commentKindsOf,
  resolveFolderProject,
  resolveForeignObject,
  pickWidget,
  widgetChainProblem,
  CLOSED_WIDGETS,
} from '../dist/index.js'
import type { SignedEvent } from '@estiva-app/protocol'

const FOLDER = '7b32200c-e4c0-4216-b79a-8490fc05e0bd'
const AUTHOR = 'a'.repeat(64)
const PROJECT_KIND = 30850
const ISSUE_KIND = 30851
const CHANGE_KIND = 1851

let seq = 0
function event(partial: Partial<SignedEvent> & { kind: number }): SignedEvent {
  seq += 1
  return {
    id: String(seq).padStart(64, '0'),
    sig: '',
    pubkey: AUTHOR,
    created_at: 1_700_000_000 + seq,
    tags: [],
    content: '',
    ...partial,
  }
}

/** Linear-lite's manifest content, trimmed to what this resolver reads. */
function manifestContent(kinds = { project: PROJECT_KIND, issue: ISSUE_KIND, change: CHANGE_KIND }) {
  return JSON.stringify({
    name: 'Linear-lite',
    records: {
      changeKind: kinds.change,
      targetTag: 'a',
      fieldTag: 'field',
      valueTag: 'value',
      order: ['ts', 'created_at', 'id'],
      rule: 'last-write-wins-per-field',
      hiddenWhen: { field: 'archived', equals: 'true' },
    },
    projections: {
      [kinds.project]: {
        widget: 'card',
        slots: {
          title: { tag: 'title' },
          subtitle: { field: 'content', truncate: 120 },
          status: { fold: 'status', map: 'statuses', default: 'planned' },
          meta: [{ label: 'Lead', fold: 'lead', tag: 'lead', as: 'pubkey' }],
        },
      },
      [kinds.issue]: {
        widget: 'row',
        slots: {
          title: { tag: 'title' },
          status: { fold: 'status', map: 'issueStatuses', default: 'todo' },
        },
      },
    },
    vocabularies: {
      statuses: [
        { value: 'planned', label: 'Planned', colour: 'neutral' },
        { value: 'in_progress', label: 'In Progress', colour: 'blue' },
      ],
      issueStatuses: [
        { value: 'todo', label: 'Todo', colour: 'neutral' },
        { value: 'in_progress', label: 'In Progress', colour: 'blue' },
        { value: 'done', label: 'Done', colour: 'green' },
        { value: 'cancelled', label: 'Cancelled', colour: 'muted' },
      ],
    },
    actions: [
      {
        id: 'add-issue',
        label: 'Add issue',
        appliesTo: String(kinds.project),
        emits: { kind: kinds.issue, setTag: 'a', toAddressOf: 'self' },
      },
      {
        id: 'assign-project',
        label: 'Assign',
        appliesTo: String(kinds.project),
        emits: { kind: kinds.change, field: 'lead' },
        input: { type: 'pubkey' },
      },
    ],
  })
}

const manifest = (kinds = { project: PROJECT_KIND, issue: ISSUE_KIND, change: CHANGE_KIND }) =>
  event({
    kind: 31990,
    // NIP-89's `k` tags are how a handler is found for a kind, and the
    // resolver's second pass filters on them. A manifest without them is
    // discoverable by nobody.
    tags: [['d', 'app'], ['k', String(kinds.project)], ['k', String(kinds.issue)]],
    content: manifestContent(kinds),
  })

const project = (id: string, overrides: Partial<SignedEvent> = {}) =>
  event({
    kind: PROJECT_KIND,
    tags: [['d', id], ['title', 'Payment integration'], ['h', FOLDER], ['lead', 'b'.repeat(64)]],
    content: 'Stripe Checkout for workspace billing — redirect flow.',
    ...overrides,
  })

const issue = (id: string, title: string, overrides: Partial<SignedEvent> = {}) =>
  event({
    kind: ISSUE_KIND,
    tags: [['d', id], ['title', title], ['h', FOLDER], ['a', `${PROJECT_KIND}:${AUTHOR}:p1`]],
    ...overrides,
  })

const change = (target: string, field: string, value: string, overrides: Partial<SignedEvent> = {}) =>
  event({
    kind: CHANGE_KIND,
    tags: [['a', target], ['field', field], ['value', value], ['h', FOLDER]],
    ...overrides,
  })

const issueAddr = (id: string) => `${ISSUE_KIND}:${AUTHOR}:${id}`

/**
 * A relay that answers the filters this resolver actually sends. Deliberately
 * literal — a smarter fake would start hiding filter bugs.
 */
interface Filter {
  kinds?: number[]
  authors?: string[]
  limit?: number
  /** Tag filters: `#d`, `#h`, `#a`, `#k`. */
  [tag: string]: unknown
}

function relay(events: SignedEvent[]) {
  const matches = (e: SignedEvent, filter: Filter) => {
    if (filter.kinds && !filter.kinds.includes(e.kind)) return false
    if (filter.authors && !filter.authors.includes(e.pubkey)) return false
    for (const [key, values] of Object.entries(filter)) {
      if (!key.startsWith('#')) continue
      const held = e.tags.filter((t) => t[0] === key.slice(1)).map((t) => t[1])
      /*
        **A channel's own `kind:39000` answers an `#h` query for that channel**,
        even though it carries no `h` tag — the relay scopes a discovery event to
        the channel it describes. Measured on production 2026-08-31: an `#h`
        query for a folder returns `{"9":8,"30851":6,"39000":1}`, and that
        `39000`'s tags are `[["d","<folder>"],["name",…]]` with no `h` anywhere.

        This fake had no such rule, so the bug that reached production — the
        Folder's own record beating the project it holds — was **invisible
        here**. A fixture that is easier than the real thing tests something
        nobody runs. Removing the fix now fails a test, which it did not before.
      */
      if (key === '#h' && e.kind === 39000) {
        const d = e.tags.find((t) => t[0] === 'd')?.[1]
        if (d !== undefined && (values as string[]).includes(d)) continue
      }
      if (!held.some((v) => (values as string[]).includes(v))) return false
    }
    return true
  }
  return async (filters: Record<string, unknown>[]) =>
    events.filter((e) => filters.some((f) => matches(e, f as Filter)))
}

describe('resolveFolderProject', () => {
  it('renders the project through its manifest projection', async () => {
    const found = await resolveFolderProject(
      FOLDER,
      relay([manifest(), project('p1'), change(`${PROJECT_KIND}:${AUTHOR}:p1`, 'status', 'in_progress')]),
    )

    assert.equal(found?.project.appName, 'Linear-lite')
    assert.equal(found?.project.slots.title.value, 'Payment integration')
    assert.ok((found?.project.slots.subtitle.value).includes('Stripe Checkout'))
    // Status is not on the root event at all — it only exists as a folded change.
    assert.partialDeepStrictEqual(found?.project.slots.status, { value: 'In Progress', colour: 'blue' })
    // `field` names the tag or folded field behind the slot, so a renderer can
    // tell that a slot and an action are two views of one value (PEEK-18).
    assert.deepEqual(found?.project.meta, [
      { label: 'Lead', value: 'b'.repeat(64), colour: undefined, isPubkey: true, field: 'lead' },
    ])
  })

  it('lets a change override a field the root event seeded with a tag', async () => {
    // The project's lead is a tag on the root *and* a folded field. Reading the
    // tag first would show the original lead forever — which is exactly what
    // somebody sees right after reassigning the project from Peek.
    const found = await resolveFolderProject(
      FOLDER,
      relay([
        manifest(),
        project('p1'),
        change(`${PROJECT_KIND}:${AUTHOR}:p1`, 'lead', 'c'.repeat(64)),
      ]),
    )

    assert.deepEqual(found?.project.meta, [
      { label: 'Lead', value: 'c'.repeat(64), colour: undefined, isPubkey: true, field: 'lead' },
    ])
  })

  it('ignores a project its owning app has archived', async () => {
    // Archiving is a folded field, not a deletion, so an archived project comes
    // back from every query and renders perfectly well. Found in the wild: a
    // paired topic whose Folder held three archived projects showed one of them.
    const found = await resolveFolderProject(
      FOLDER,
      relay([
        manifest(),
        project('p1'),
        project('p2', { tags: [['d', 'p2'], ['title', 'Archived attempt'], ['h', FOLDER]] }),
        change(`${PROJECT_KIND}:${AUTHOR}:p2`, 'archived', 'true'),
      ]),
    )

    assert.equal(found?.project.slots.title.value, 'Payment integration')
  })

  it('shows nothing when every project in the Folder is archived', async () => {
    const found = await resolveFolderProject(
      FOLDER,
      relay([
        manifest(),
        project('p1'),
        change(`${PROJECT_KIND}:${AUTHOR}:p1`, 'archived', 'true'),
      ]),
    )

    assert.equal(found, null)
  })

  it('leaves an archived ticket out of the counts', async () => {
    const found = await resolveFolderProject(
      FOLDER,
      relay([
        manifest(),
        project('p1'),
        issue('i1', 'Live'),
        issue('i2', 'Filed then archived'),
        change(issueAddr('i2'), 'archived', 'true'),
      ]),
    )

    assert.deepEqual(found?.tickets.map((t) => t.slots.title.value), ['Live'])
    assert.equal(found?.openCount, 1)
  })

  it('picks the project the Folder’s work belongs to, not the newest', async () => {
    // Pairing accumulates a project per attempt, so a Folder holding several is
    // ordinary rather than exotic. Age alone picked whichever stray was created
    // last; the tickets say which project the Folder is actually about.
    const stray = project('p9', {
      tags: [['d', 'p9'], ['title', 'Newer, and empty'], ['h', FOLDER]],
      created_at: 1_800_000_000,
    })

    const found = await resolveFolderProject(
      FOLDER,
      relay([manifest(), project('p1'), issue('i1', 'Real work'), stray]),
    )

    assert.equal(found?.project.slots.title.value, 'Payment integration')
  })

  it('lists the whole project, started first, then the queue, then the done', async () => {
    const events = [
      manifest(),
      project('p1'),
      issue('i1', 'Untouched, so still Todo'),
      issue('i2', 'Retry copy'),
      issue('i3', 'Webhook signature check'),
      issue('i4', 'Billing entry'),
      change(issueAddr('i2'), 'status', 'done'),
      change(issueAddr('i3'), 'status', 'cancelled'),
      change(issueAddr('i4'), 'status', 'in_progress'),
    ]

    const found = await resolveFolderProject(FOLDER, relay(events))

    // Everything the project holds, in the order that makes it scannable:
    // what is moving, what is waiting, what is behind you.
    assert.deepEqual(found?.tickets.map((t) => t.slots.title.value), [
      'Billing entry',
      'Untouched, so still Todo',
      'Webhook signature check',
      'Retry copy',
    ])
    assert.partialDeepStrictEqual(found?.tickets[0].slots.status, { value: 'In Progress' })
    // The counts still divide the work; the table no longer does.
    assert.equal(found?.openCount, 2)
    assert.equal(found?.doneCount, 2)
  })

  it('lists a parked or unknown status but counts it in neither half', async () => {
    // "Backlog" is real work nobody is doing, and a status this consumer has
    // never seen is not evidence of anything. Both are still tickets, and still
    // listed — they just cannot claim to be progress in either direction.
    const events = [
      manifest(),
      project('p1'),
      issue('i1', 'Parked'),
      issue('i2', 'Something another app invented'),
      change(issueAddr('i1'), 'status', 'backlog'),
      change(issueAddr('i2'), 'status', 'percolating'),
    ]

    const found = await resolveFolderProject(FOLDER, relay(events))

    assert.deepEqual(found?.tickets.map((t) => t.slots.title.value), [
      'Something another app invented',
      'Parked',
    ])
    assert.equal(found?.openCount, 0)
    assert.equal(found?.doneCount, 0)
  })

  it('follows the fold rather than the first change', async () => {
    // The seed path: an issue moved to in_progress and later closed. Reading the
    // changes in any order but the manifest's would count it as open.
    const events = [
      manifest(),
      project('p1'),
      issue('i1', 'Billing entry'),
      change(issueAddr('i1'), 'status', 'in_progress', { created_at: 1_700_000_100 }),
      change(issueAddr('i1'), 'status', 'done', { created_at: 1_700_000_200 }),
    ]

    const found = await resolveFolderProject(FOLDER, relay(events))

    assert.equal(found?.openCount, 0)
    assert.equal(found?.doneCount, 1)
    assert.partialDeepStrictEqual(found?.tickets[0].slots.status, { value: 'Done' })
  })

  it('lists every ticket, however many there are', async () => {
    const events = [manifest(), project('p1')]
    for (let i = 0; i < 10; i += 1) {
      events.push(issue(`i${i}`, `Live work ${i}`))
      events.push(change(issueAddr(`i${i}`), 'status', 'in_progress'))
    }

    const found = await resolveFolderProject(FOLDER, relay(events))

    assert.equal(found?.tickets.length, 10)
    assert.equal(found?.openCount, 10)
  })

  it('orders by when work last moved', async () => {
    const events = [
      manifest(),
      project('p1'),
      issue('old', 'Moved a while ago'),
      issue('new', 'Moved just now'),
      change(issueAddr('old'), 'status', 'in_progress', { created_at: 1_700_000_100 }),
      change(issueAddr('new'), 'status', 'in_progress', { created_at: 1_700_009_000 }),
    ]

    const found = await resolveFolderProject(FOLDER, relay(events))

    assert.deepEqual(found?.tickets.map((t) => t.slots.title.value), ['Moved just now', 'Moved a while ago'])
  })

  it('keeps an issue that names no project — the Folder is the project', async () => {
    const loose = issue('i1', 'Filed without a link')
    loose.tags = loose.tags.filter((t) => t[0] !== 'a')

    const found = await resolveFolderProject(
      FOLDER,
      relay([manifest(), project('p1'), loose, change(issueAddr('i1'), 'status', 'in_progress')]),
    )

    assert.deepEqual(found?.tickets.map((t) => t.slots.title.value), ['Filed without a link'])
  })

  it('drops an issue belonging to a different project in the same Folder', async () => {
    const other = issue('i1', 'Somebody else’s issue')
    other.tags = other.tags.map((t) => (t[0] === 'a' ? ['a', `${PROJECT_KIND}:${AUTHOR}:other`] : t))

    const found = await resolveFolderProject(
      FOLDER,
      relay([manifest(), project('p1'), other, change(issueAddr('i1'), 'status', 'in_progress')]),
    )

    assert.deepEqual(found?.tickets, [])
  })

  /**
   * Pairing after the fact, which is how both of the topics that broke were made
   * (PEEK-24): the project was created in Estiva Ship's own Folder, then paired
   * with a Peek topic afterwards. An event cannot change its own `h`, so the
   * project record stayed where it was born and so did the change expressing the
   * pairing — while every issue filed afterwards landed in the topic's Folder.
   *
   * Measured on production before the fix: the two paired Folders held ten and
   * eleven issues respectively and no project event at all, and the panel read
   * that as "no project linked to this topic".
   */
  describe('a project paired with the Folder after it was created', () => {
    const ELSEWHERE = 'd9359c46-edf0-4f64-93f2-a0cb4e90a0fc'

    /** The project record, still in the Folder it was created in. */
    const paired = () =>
      project('p1', {
        tags: [
          ['d', 'p1'],
          ['title', 'Payment integration'],
          ['h', ELSEWHERE],
          ['lead', 'b'.repeat(64)],
        ],
      })

    /** A change on the project, published where the project record lives. */
    const changeElsewhere = (field: string, value: string) =>
      change(`${PROJECT_KIND}:${AUTHOR}:p1`, field, value, {
        tags: [
          ['a', `${PROJECT_KIND}:${AUTHOR}:p1`],
          ['field', field],
          ['value', value],
          ['h', ELSEWHERE],
        ],
      })

    it('is found through the tickets that name it', async () => {
      // `folder` is in the fixture because production has it, and is deliberately
      // not what finds the project: nothing here knows the word. The tickets do
      // the work, through the link tag the manifest already declares.
      const found = await resolveFolderProject(
        FOLDER,
        relay([manifest(), paired(), issue('i1', 'Retry copy'), changeElsewhere('folder', FOLDER)]),
      )

      assert.equal(found?.project.slots.title.value, 'Payment integration')
      assert.deepEqual(found?.tickets.map((t) => t.slots.title.value), ['Retry copy'])
      assert.equal(found?.openCount, 1)
    })

    it('folds the changes that stayed behind with the record', async () => {
      // Fetched by address, not by `h`. A Folder query alone finds none of these
      // and shows the manifest's defaults as though they were the project's state.
      const found = await resolveFolderProject(
        FOLDER,
        relay([
          manifest(),
          paired(),
          issue('i1', 'Retry copy'),
          changeElsewhere('status', 'in_progress'),
          changeElsewhere('lead', 'c'.repeat(64)),
        ]),
      )

      assert.partialDeepStrictEqual(found?.project.slots.status, { value: 'In Progress' })
      assert.deepEqual(found?.project.meta, [
        { label: 'Lead', value: 'c'.repeat(64), colour: undefined, isPubkey: true, field: 'lead' },
      ])
    })

    it('is found from the pairing statement alone, with no ticket in the Folder', async () => {
      // What Ship now publishes into the Folder being paired: the same `folder`
      // change again, this time carrying the topic's own `h`. It is the only
      // thing here naming the project — no ticket has been filed yet — which is
      // exactly the case the tickets cannot cover.
      const announcement = change(`${PROJECT_KIND}:${AUTHOR}:p1`, 'folder', FOLDER)

      const found = await resolveFolderProject(
        FOLDER,
        relay([manifest(), paired(), announcement]),
      )

      assert.equal(found?.project.slots.title.value, 'Payment integration')
      assert.deepEqual(found?.tickets, [])
      assert.equal(found?.openCount, 0)
    })

    it('prefers the project the Folder’s work belongs to over one merely named', async () => {
      // A change naming some other project got written into this Folder. The
      // tickets are the stronger claim and the existing sort already says so —
      // reading changes as candidates must not overturn that.
      const stray = change(`${PROJECT_KIND}:${AUTHOR}:p9`, 'status', 'in_progress')
      const other = project('p9', {
        tags: [['d', 'p9'], ['title', 'Somebody else’s project'], ['h', ELSEWHERE]],
        created_at: 1_800_000_000,
      })

      const found = await resolveFolderProject(
        FOLDER,
        relay([manifest(), paired(), other, issue('i1', 'Real work'), stray]),
      )

      assert.equal(found?.project.slots.title.value, 'Payment integration')
    })

    it('stays hidden when the record it points at is archived', async () => {
      const found = await resolveFolderProject(
        FOLDER,
        relay([
          manifest(),
          paired(),
          issue('i1', 'Retry copy'),
          changeElsewhere('archived', 'true'),
        ]),
      )

      assert.equal(found, null)
    })

    it('does not adopt a link that is not a container', async () => {
      const blocked = issue('i1', 'Blocked by another ticket')
      blocked.tags = blocked.tags.map((t) => (t[0] === 'a' ? ['a', issueAddr('i2')] : t))
      const blocker = issue('i2', 'The blocker')
      blocker.tags = blocker.tags.filter((t) => t[0] !== 'a')

      assert.equal(await resolveFolderProject(FOLDER, relay([manifest(), blocked, blocker])), null)
    })

    it('costs no extra round trip when the Folder holds its own project', async () => {
      const sent: Record<string, unknown>[] = []
      const answer = relay([manifest(), project('p1'), issue('i1', 'Retry copy')])

      await resolveFolderProject(FOLDER, async (filters) => {
        sent.push(...filters)
        return answer(filters)
      })

      // The ordinary case must not pay for this. Nothing asks the relay for the
      // project by its own `d` — that filter only exists on the adoption path.
      assert.equal(sent.some((f) => JSON.stringify((f as { '#d'?: string[] })['#d']) === '["p1"]'), false,)
    })
  })

  it('returns nothing for a Folder with no project in it', async () => {
    assert.equal(await resolveFolderProject(FOLDER, relay([manifest()])), null)
  })

  it('returns nothing when no app declares a container', async () => {
    const withoutContainment = event({
      kind: 31990,
      tags: [['d', 'other-app']],
      content: JSON.stringify({
        name: 'Some app',
        projections: { [PROJECT_KIND]: { widget: 'card', slots: { title: { tag: 'title' } } } },
      }),
    })

    assert.equal(await resolveFolderProject(FOLDER, relay([withoutContainment, project('p1')])), null)
  })

  it('works for an app Peek has never heard of', async () => {
    // Same shapes, different numbers and a different live-status spelling. If
    // any Linear-lite constant had leaked into the resolver, this returns null.
    const kinds = { project: 31500, issue: 31501, change: 1900 }
    const container = event({
      kind: kinds.project,
      tags: [['d', 'w1'], ['title', 'Field survey'], ['h', FOLDER]],
      content: 'Quarterly site visits.',
    })
    const task = event({
      kind: kinds.issue,
      tags: [['d', 't1'], ['title', 'Visit the north site'], ['h', FOLDER], ['a', `${kinds.project}:${AUTHOR}:w1`]],
    })
    const moved = event({
      kind: kinds.change,
      tags: [
        ['a', `${kinds.issue}:${AUTHOR}:t1`],
        ['field', 'status'],
        ['value', 'started'],
        ['h', FOLDER],
      ],
    })

    const found = await resolveFolderProject(
      FOLDER,
      relay([manifest(kinds), container, task, moved]),
    )

    assert.equal(found?.project.slots.title.value, 'Field survey')
    assert.deepEqual(found?.tickets.map((t) => t.slots.title.value), ['Visit the north site'])
  })
})

/**
 * Who the people on another app's objects actually are (FEE-1).
 *
 * A manifest says a slot holds a pubkey; it never says whose. The name and face
 * come from kind:0 — the same place the message list gets them — and are
 * resolved *with* the object rather than after it, so a renderer never has a
 * key on screen while it waits for a lookup.
 */
describe('resolveFolderProject — people', () => {
  const LEAD = 'b'.repeat(64)

  const profile = (pubkey: string, fields: Record<string, string>) =>
    event({ kind: 0, pubkey, content: JSON.stringify(fields) })

  it('names the lead from their kind:0', async () => {
    const found = await resolveFolderProject(
      FOLDER,
      relay([
        manifest(),
        project('p1'),
        profile(LEAD, { display_name: 'Jan Miky', picture: 'https://example.com/j.png' }),
      ]),
    )

    assert.deepEqual(found?.project.people?.[LEAD], {
      displayName: 'Jan Miky',
      picture: 'https://example.com/j.png',
    })
  })

  it('reads `name` as well as `display_name`, because both are published', async () => {
    const found = await resolveFolderProject(
      FOLDER,
      relay([manifest(), project('p1'), profile(LEAD, { name: 'Jan Miky' })]),
    )

    assert.equal(found?.project.people?.[LEAD]?.displayName, 'Jan Miky')
  })

  it('leaves someone unknown rather than inventing a name for them', async () => {
    // Nobody published a profile. The object still resolves — a missing name
    // costs a name, never the panel.
    const found = await resolveFolderProject(FOLDER, relay([manifest(), project('p1')]))

    assert.equal(found?.project.slots.title.value, 'Payment integration')
    assert.equal(found?.project.people?.[LEAD]?.displayName, undefined)
  })

  it('asks about the lead even though only an action holds them', async () => {
    /*
     * The sidebar renders the lead *inside* the assign control, so `current` is
     * the only place that pubkey appears once a viewer can act. Collecting
     * pubkeys from slots alone would leave exactly the control FEE-1 was filed
     * about still showing a key.
     */
    const asked: string[][] = []
    await resolveFolderProject(FOLDER, relay([manifest(), project('p1')]), async (pubkeys) => {
      asked.push(pubkeys)
      return {}
    })

    assert.ok((asked.flat()).includes(LEAD))
  })

  it('shares one lookup across the project and its tickets', async () => {
    // One round trip, not one per object — and every object carries the answer,
    // so a renderer that starts naming assignees needs no second trip.
    const calls: string[][] = []
    const found = await resolveFolderProject(
      FOLDER,
      relay([manifest(), project('p1'), issue('t1', 'Billing entry')]),
      async (pubkeys) => {
        calls.push(pubkeys)
        return { [LEAD]: { displayName: 'Jan Miky' } }
      },
    )

    assert.equal((calls).length, 1)
    assert.equal(found?.tickets[0].people?.[LEAD]?.displayName, 'Jan Miky')
  })
})


/*
  A manifest declares one comment kind, and an app that *changes* which kind it
  emits leaves its old comments behind — a kind:9 message is not replaceable at
  all, so they stay under the old kind permanently. Reading only the declared
  kind shows an object's newest comments and silently drops the rest: a thread
  that begins in the middle, with nothing anywhere reporting a problem.
*/
describe('comment kinds an app has ever emitted', () => {
  const withComment = (emits: Record<string, unknown>) =>
    ({ actions: [{ id: 'comment', label: 'Comment', appliesTo: '30851', emits }] }) as never

  it('falls back to NIP-22 when the app declares nothing', () => {
    assert.deepEqual(commentKindsOf({} as never), [1111])
  })

  it('uses the declared kind when there is only one', () => {
    assert.deepEqual(commentKindsOf(withComment({ kind: 9, scope: 'address' })), [9])
  })

  it('reads superseded kinds alongside the current one', () => {
    assert.deepEqual(commentKindsOf(withComment({ kind: 1111, scope: 'address', alsoRead: [9] })), [
      1111, 9,
    ])
  })

  it('puts the current kind first, because that is the one publishing uses', () => {
    assert.equal(commentKindsOf(withComment({ kind: 1111, alsoRead: [9] }))[0], 1111)
  })

  it('does not duplicate a kind listed in both places', () => {
    assert.deepEqual(commentKindsOf(withComment({ kind: 9, alsoRead: [9] })), [9])
  })

  it('behaves exactly as before for a manifest written without the field', () => {
    // The compatibility claim: absent `alsoRead`, nothing changes.
    assert.deepEqual(commentKindsOf(withComment({ kind: 30023 })), [30023])
  })
})

/*
  A slot whose tag was renamed. Ship moved a project's title from `title` to
  `name` (REW-11) and could not rename it on the records it had already
  published, so both spellings are live permanently. Without a fallback one
  half of the workspace renders blank — and which half depends only on which
  spelling the manifest names.

  Note this is a single slot with several places to look, which is not the same
  as a `SlotSpec[]` — the array form means "render all of these as meta", and
  using it here would empty `slots.title` instead of filling it.
*/
describe('a slot whose tag was renamed', () => {
  /*
    Read through the public API rather than the internal slot resolver.

    These used `resolveFolderProjectSlotsForTest`, which the package
    deliberately does not export — a test helper in a public API is a promise
    nobody meant to make. Going through `resolveForeignObject` costs a manifest
    and a relay of two events, and buys a test of the path a consumer actually
    takes.
  */
  const read = async (tags: string[][], spec: unknown) => {
    const manifestEvent = event({
      kind: 31990,
      tags: [['d', 'app'], ['k', String(PROJECT_KIND)]],
      content: JSON.stringify({
        name: 'Linear-lite',
        projections: { [PROJECT_KIND]: { widget: 'card', slots: { title: spec } } },
      }),
    })
    const root = event({ kind: PROJECT_KIND, tags: [['d', 'r1'], ...tags] })
    const found = await resolveForeignObject(
      `${PROJECT_KIND}:${AUTHOR}:r1`,
      relay([manifestEvent, root]),
    )
    return found?.slots.title?.value
  }

  it('reads the new spelling when the record carries it', async () => {
    assert.equal(await read([['name', 'Agent / Steer']], { tag: ['name', 'title'] }), 'Agent / Steer')
  })

  it('falls back to the old spelling for a record written before the rename', async () => {
    assert.equal(await read([['title', 'Payment integration']], { tag: ['name', 'title'] }), 'Payment integration',)
  })

  it('prefers the first that resolves when a record somehow carries both', async () => {
    assert.equal(await read([['title', 'old'], ['name', 'new']], { tag: ['name', 'title'] }), 'new')
  })

  it('skips an empty tag rather than stopping at it', async () => {
    // An empty value is not an answer; it is the absence of one, and stopping
    // there would render blank while a perfectly good fallback sat behind it.
    assert.equal(await read([['name', ''], ['title', 'Payment integration']], { tag: ['name', 'title'] }), 'Payment integration',)
  })

  it('behaves exactly as before for a plain string tag', async () => {
    assert.equal(await read([['title', 'Payment integration']], { tag: 'title' }), 'Payment integration')
    assert.equal(await read([['name', 'Agent / Steer']], { tag: 'title' }), undefined)
  })
})

/**
 * The declared `list` slot and the declared `stage` — PRO-2.
 *
 * Both replace a deduction the consumer used to make. Containment was inferred
 * from an action that *creates* a child, which is a write declaration answering
 * a read question; and open-versus-done was matched against a hardcoded set of
 * English words, whose own comment admitted an app spelling its statuses
 * differently would render an empty section.
 *
 * The tests that matter here are the ones where the two disagree, because a
 * test where both give the same answer cannot tell you which one ran.
 */
describe('a manifest that declares its own containment and stages', () => {
  const KINDS = { project: PROJECT_KIND, issue: ISSUE_KIND, change: CHANGE_KIND }

  /** Like `manifest()`, but declaring `list` and `stage`, and with knobs. */
  const declaring = (opts: {
    list?: { kind: number; via: string; limit?: number }
    stages?: Record<string, string>
    /** Drop the create-action, so only the `list` slot can answer. */
    withoutAction?: boolean
    issueStatuses?: { value: string; label: string; colour: string; stage?: string }[]
  }) => {
    const content = JSON.parse(manifestContent(KINDS))
    if (opts.list) content.projections[KINDS.project].slots.list = { children: opts.list }
    if (opts.withoutAction) content.actions = content.actions.filter((a: { id: string }) => a.id !== 'add-issue')
    if (opts.issueStatuses) content.vocabularies.issueStatuses = opts.issueStatuses
    else if (opts.stages) {
      content.vocabularies.issueStatuses = content.vocabularies.issueStatuses.map(
        (v: { value: string }) => ({ ...v, stage: opts.stages![v.value] }),
      )
    }
    return event({
      kind: 31990,
      tags: [['d', 'app'], ['k', String(KINDS.project)], ['k', String(KINDS.issue)]],
      content: JSON.stringify(content),
    })
  }

  const ticket = (id: string, status?: string) => [
    event({
      kind: ISSUE_KIND,
      tags: [['d', id], ['title', id], ['h', FOLDER], ['a', `${PROJECT_KIND}:${AUTHOR}:p1`]],
    }),
    ...(status
      ? [event({ kind: CHANGE_KIND, tags: [['a', `${ISSUE_KIND}:${AUTHOR}:${id}`], ['field', 'status'], ['value', status], ['h', FOLDER]] })]
      : []),
  ]

  it('finds children through the list slot when no action declares containment', async () => {
    // The inference has nothing to read here: without `list` this is the
    // "no app declares a container" case and resolves to null.
    const found = await resolveFolderProject(
      FOLDER,
      relay([
        declaring({ list: { kind: ISSUE_KIND, via: 'a' }, withoutAction: true }),
        project('p1'),
        ...ticket('t1'),
      ]),
    )
    assert.deepEqual(found?.tickets.map((t) => t.slots.title.value), ['t1'])
  })

  it('prefers the declared list over the action, when the two disagree', async () => {
    // The action still says issues are the children; the `list` slot says a
    // kind nothing writes. The declaration must win, which shows as an empty
    // list rather than the action's answer.
    const found = await resolveFolderProject(
      FOLDER,
      relay([
        declaring({ list: { kind: 39999, via: 'a' } }),
        project('p1'),
        ...ticket('t1'),
      ]),
    )
    assert.equal(found?.project.slots.title.value, 'Payment integration')
    assert.deepEqual(found?.tickets, [])
  })

  it('reads the child tag the list names, not the one the action named', async () => {
    const parent = `${PROJECT_KIND}:${AUTHOR}:p1`
    const viaOwner = event({
      kind: ISSUE_KIND,
      tags: [['d', 'owned'], ['title', 'owned'], ['h', FOLDER], ['belongs-to', parent]],
    })
    const found = await resolveFolderProject(
      FOLDER,
      relay([
        declaring({ list: { kind: ISSUE_KIND, via: 'belongs-to' } }),
        project('p1'),
        viaOwner,
      ]),
    )
    assert.deepEqual(found?.tickets.map((t) => t.slots.title.value), ['owned'])
  })

  it('counts by the declared stage even when the label means nothing to Peek', async () => {
    // The third-app case, and the whole point. None of these words is in the
    // consumer's old sets, so the label guess counts every one of them as
    // neither open nor done and reports 0/0.
    const found = await resolveFolderProject(
      FOLDER,
      relay([
        declaring({
          list: { kind: ISSUE_KIND, via: 'a' },
          issueStatuses: [
            { value: 'ontvangen', label: 'Ontvangen', colour: 'neutral', stage: 'open' },
            { value: 'afgerond', label: 'Afgerond', colour: 'green', stage: 'done' },
          ],
        }),
        project('p1'),
        ...ticket('t1', 'ontvangen'),
        ...ticket('t2', 'afgerond'),
      ]),
    )
    assert.deepEqual({ open: found?.openCount, done: found?.doneCount }, { open: 1, done: 1 })
  })

  it('treats a dropped status as done, so a finished project can reach its total', async () => {
    const found = await resolveFolderProject(
      FOLDER,
      relay([
        declaring({ stages: { todo: 'open', in_progress: 'started', done: 'done', cancelled: 'dropped' }, list: { kind: ISSUE_KIND, via: 'a' } }),
        project('p1'),
        ...ticket('t1', 'done'),
        ...ticket('t2', 'cancelled'),
      ]),
    )
    // 2/2 rather than 1/2: the cancelled one is never going to become done, so
    // leaving it outstanding pins the project below its total for ever.
    assert.deepEqual({ open: found?.openCount, done: found?.doneCount }, { open: 0, done: 2 })
  })

  it('ignores a stage outside the four and falls back to the label', async () => {
    // Validation is an honour system; an unrecognised stage is treated as
    // undeclared rather than trusted into a fifth category.
    const found = await resolveFolderProject(
      FOLDER,
      relay([
        declaring({
          list: { kind: ISSUE_KIND, via: 'a' },
          issueStatuses: [{ value: 'done', label: 'Done', colour: 'green', stage: 'finished-ish' }],
        }),
        project('p1'),
        ...ticket('t1', 'done'),
      ]),
    )
    assert.deepEqual({ open: found?.openCount, done: found?.doneCount }, { open: 0, done: 1 })
  })

  it('applies the declared limit to what is rendered, never to what is counted', async () => {
    const found = await resolveFolderProject(
      FOLDER,
      relay([
        declaring({ list: { kind: ISSUE_KIND, via: 'a', limit: 2 }, stages: { todo: 'open', in_progress: 'started', done: 'done', cancelled: 'dropped' } }),
        project('p1'),
        ...ticket('t1', 'todo'),
        ...ticket('t2', 'todo'),
        ...ticket('t3', 'todo'),
        ...ticket('t4', 'todo'),
      ]),
    )
    assert.equal(found?.tickets.length, 2)
    // "2 of 4" would be a lie about the project; the budget is about drawing.
    assert.equal(found?.openCount, 4)
  })

  it('refuses to follow a list past the depth budget', async () => {
    const events = [declaring({ list: { kind: ISSUE_KIND, via: 'a' } }), project('p1'), ...ticket('t1')]
    assert.notEqual(await resolveFolderProject(FOLDER, relay(events), undefined, 0), null)
    assert.equal(await resolveFolderProject(FOLDER, relay(events), undefined, 2), null)
  })
})

/**
 * The two things declaring Peek's own manifest turned out to need — PRO-6.
 *
 * Both were found by writing a projection for a Topic and a Message rather than
 * by reading §13, which is the argument §13.5 makes for requiring a second
 * consumer before the layer is published as a package.
 */
describe('a child that names its parent by identifier, not address', () => {
  const CHANNEL = '39000'
  const RELAY_KEY = 'c'.repeat(64)

  // A Peek-shaped manifest: a topic holding messages, linked by `h`, which
  // carries the bare channel uuid.
  const peekManifest = (match?: 'address' | 'identifier') =>
    event({
      kind: 31990,
      tags: [['d', 'peek'], ['k', CHANNEL], ['k', '9']],
      content: JSON.stringify({
        name: 'Peek',
        projections: {
          [CHANNEL]: {
            widget: 'card',
            slots: {
              title: { tag: 'name' },
              list: { children: { kind: 9, via: 'h', ...(match ? { match } : {}), limit: 50 } },
            },
          },
          9: { widget: ['message', 'card'], slots: { title: { field: 'pubkey', as: 'pubkey' } } },
        },
      }),
    })

  const topic = event({
    kind: Number(CHANNEL),
    pubkey: RELAY_KEY,
    tags: [['d', FOLDER], ['name', 'design'], ['h', FOLDER]],
  })
  const message = (id: string) =>
    event({ kind: 9, tags: [['d', id], ['h', FOLDER]], content: `msg ${id}` })

  /*
    Reached by address, never through `resolveFolderProject` — and that is not
    an implementation detail of the test.

    `via: 'h'` with `match: 'identifier'` compares a message's `h` to the
    topic's `d`, and those are equal only when the topic *is* the folder. A
    Folder is not a file inside itself, so `resolveFolderProject` excludes its
    own discovery record — which means Peek's Topic list is resolvable on the
    by-address path and nowhere else.
  */
  const TOPIC_ADDRESS = `${CHANNEL}:${RELAY_KEY}:${FOLDER}`

  it('finds children when the manifest says the tag holds an identifier', async () => {
    const found = await resolveForeignObject(
      TOPIC_ADDRESS,
      relay([peekManifest('identifier'), topic, message('m1'), message('m2')]),
    )
    assert.equal(found?.slots.title.value, 'design')
    assert.equal(found?.children?.length, 2)
  })

  it('finds none when it defaults to address, which is why match exists', async () => {
    // `h` holds the uuid, never `39000:<relay>:<uuid>`. Without `match` the
    // comparison is against the address and every topic lists zero messages —
    // silently, because an empty list is what a quiet topic looks like too.
    const found = await resolveForeignObject(
      TOPIC_ADDRESS,
      relay([peekManifest(), topic, message('m1'), message('m2')]),
    )
    assert.equal(found?.children?.length, 0)
  })

  it('keeps address matching the default, so Ship’s manifest is unchanged', async () => {
    const found = await resolveFolderProject(FOLDER, relay([manifest(), project('p1'), issue('t1', 't1')]))
    assert.deepEqual(found?.tickets.map((t) => t.slots.title.value), ['t1'])
  })
})

describe('a slot whose value is the event’s author', () => {
  it('renders the pubkey as a person, which is the only title a message has', async () => {
    const AUTHOR_B = 'd'.repeat(64)
    const m = event({
      kind: 39000,
      pubkey: AUTHOR_B,
      tags: [['d', FOLDER], ['name', 'design'], ['h', FOLDER]],
    })
    const withPubkeyTitle = event({
      kind: 31990,
      tags: [['d', 'peek'], ['k', '39000']],
      content: JSON.stringify({
        name: 'Peek',
        projections: {
          39000: {
            widget: 'card',
            slots: {
              title: { field: 'pubkey', as: 'pubkey' },
              // A container relation, or the resolver never discovers the kind.
              list: { children: { kind: 9, via: 'h', match: 'identifier' } },
            },
          },
        },
      }),
    })
    const found = await resolveForeignObject(`39000:${AUTHOR_B}:${FOLDER}`, relay([withPubkeyTitle, m]))
    assert.equal(found?.slots.title.value, AUTHOR_B)
    assert.equal(found?.slots.title.isPubkey, true)
  })
})

describe('an app whose records never change', () => {
  /**
   * Peek is that app: a topic's name is a tag the relay wrote and a message is
   * immutable, so there is nothing to fold and its manifest declares no
   * `records`. The resolver used to require one and returned null for the whole
   * projection — the object rendering as *nothing*, which §13.3 spends several
   * paragraphs establishing is the worst available outcome.
   *
   * It was never caught because Ship is the only app that had ever published a
   * manifest, and Ship folds.
   */
  const noRecords = event({
    kind: 31990,
    tags: [['d', 'peek'], ['k', '39000']],
    content: JSON.stringify({
      name: 'Peek',
      // no `records` key at all
      projections: {
        39000: {
          widget: 'card',
          slots: {
            title: { tag: 'name' },
            status: { fold: 'status', default: 'open' },
            list: { children: { kind: 9, via: 'h', match: 'identifier' } },
          },
        },
      },
    }),
  })
  const topic = event({ kind: 39000, tags: [['d', FOLDER], ['name', 'design'], ['h', FOLDER]] })

  const ADDRESS = `39000:${AUTHOR}:${FOLDER}`

  it('renders rather than returning nothing', async () => {
    const found = await resolveForeignObject(ADDRESS, relay([noRecords, topic]))
    assert.equal(found?.slots.title.value, 'design')
  })

  it('falls a fold slot through to its declared default', async () => {
    const found = await resolveForeignObject(ADDRESS, relay([noRecords, topic]))
    assert.equal(found?.slots.status.value, 'open')
  })
})

/**
 * The `list` slot for an object reached by address, and children that have no
 * address of their own — PRO-7.
 *
 * PRO-2 built `list` down the folder path only. An object resolved by naddr
 * dropped the slot silently, which on production rendered a Peek Topic with a
 * title and no messages — indistinguishable from a quiet topic, so nothing
 * reported a problem.
 */
describe('resolveForeignObject — the list slot', () => {
  const RELAY_KEY = 'c'.repeat(64)
  const UUID = '925897ad-796e-4bc6-999c-ca19df26c4aa'
  const TOPIC_ADDR = `39000:${RELAY_KEY}:${UUID}`

  const peekManifest = (opts: { list?: boolean; childProjection?: boolean } = {}) =>
    event({
      kind: 31990,
      tags: [['d', 'peek'], ['k', '39000'], ['k', '9']],
      content: JSON.stringify({
        name: 'Peek',
        projections: {
          39000: {
            widget: 'card',
            slots: {
              title: { tag: 'name' },
              ...(opts.list === false
                ? {}
                : { list: { children: { kind: 9, via: 'h', match: 'identifier', limit: 50 } } }),
            },
          },
          ...(opts.childProjection === false
            ? {}
            : {
                9: {
                  widget: ['message', 'card'],
                  slots: { title: { field: 'pubkey', as: 'pubkey' }, body: { field: 'content' } },
                },
              }),
        },
      }),
    })

  const topic = event({ kind: 39000, pubkey: RELAY_KEY, tags: [['d', UUID], ['name', 'design']] })
  const message = (body: string) => event({ kind: 9, tags: [['h', UUID]], content: body })

  it('resolves children for an object reached by address', async () => {
    const found = await resolveForeignObject(
      TOPIC_ADDR,
      relay([peekManifest(), topic, message('one'), message('two')]),
    )
    assert.equal(found?.slots.title.value, 'design')
    assert.deepEqual(found?.children?.map((c) => c.slots.body.value), ['one', 'two'])
  })

  it('gives a child with no `d` its event id as its ref, and no address', async () => {
    const found = await resolveForeignObject(TOPIC_ADDR, relay([peekManifest(), topic, message('one')]))
    const child = found!.children![0]
    assert.equal(child.address, undefined)
    assert.equal(child.naddr, undefined)
    assert.equal(child.ref, child.eventId)
    assert.notEqual(child.ref, '')
  })

  it('offers no actions on a child that cannot be addressed', async () => {
    // Not a limitation: a change carries an `a` tag naming its target, and a
    // regular event cannot be named that way.
    const found = await resolveForeignObject(TOPIC_ADDR, relay([peekManifest(), topic, message('one')]))
    assert.deepEqual(found!.children![0].actions, [])
  })

  it('carries the declared widget chain through to the child', async () => {
    const found = await resolveForeignObject(TOPIC_ADDR, relay([peekManifest(), topic, message('one')]))
    assert.deepEqual(found!.children![0].widget, ['message', 'card'])
  })

  it('distinguishes "declared and empty" from "no list declared"', async () => {
    const empty = await resolveForeignObject(TOPIC_ADDR, relay([peekManifest(), topic]))
    assert.deepEqual(empty?.children, [])

    const none = await resolveForeignObject(TOPIC_ADDR, relay([peekManifest({ list: false }), topic]))
    assert.equal(none?.children, undefined)
  })

  it('renders an empty list rather than nothing when the child kind has no projection', async () => {
    const found = await resolveForeignObject(
      TOPIC_ADDR,
      relay([peekManifest({ childProjection: false }), topic, message('one')]),
    )
    // The objects exist; this app has not said how to draw them. A title and an
    // empty list beats refusing the whole projection.
    assert.equal(found?.slots.title.value, 'design')
    assert.deepEqual(found?.children, [])
  })

  it('stops at the depth budget rather than following a child’s own list', async () => {
    const events = [peekManifest(), topic, message('one')]
    assert.equal((await resolveForeignObject(TOPIC_ADDR, relay(events), undefined, 0))?.children?.length, 1)
    assert.deepEqual((await resolveForeignObject(TOPIC_ADDR, relay(events), undefined, 1))?.children, [])
  })

  it('keeps an addressable child’s address, so Ship’s issues are unaffected', async () => {
    const shipish = event({
      kind: 31990,
      tags: [['d', 'ship'], ['k', String(PROJECT_KIND)]],
      content: JSON.stringify({
        name: 'Linear-lite',
        projections: {
          [PROJECT_KIND]: {
            widget: 'card',
            slots: {
              title: { tag: 'title' },
              list: { children: { kind: ISSUE_KIND, via: 'a', limit: 50 } },
            },
          },
          [ISSUE_KIND]: { widget: 'row', slots: { title: { tag: 'title' } } },
        },
      }),
    })
    const found = await resolveForeignObject(
      `${PROJECT_KIND}:${AUTHOR}:p1`,
      relay([shipish, project('p1'), issue('t1', 'Billing')]),
    )
    const child = found!.children![0]
    assert.equal(child.slots.title.value, 'Billing')
    assert.equal(child.address, `${ISSUE_KIND}:${AUTHOR}:t1`)
    assert.equal(child.ref, child.address)
  })
})

/**
 * The widget fallback chain — RFC 0.4 §13.3, found live by PRO-7.
 *
 * `ForeignObject.widget` was typed `string` while Peek's own manifest declares
 * `["message","card"]`, so the type said one thing and the wire said another.
 * A consumer writing `widget === 'card'` compared a string to an array and
 * silently drew the wrong layout — Peek's own card did, and it had never bitten
 * because Peek only consumes Ship, whose widgets are bare strings.
 */
describe('pickWidget', () => {
  const CLOSED = ['card', 'row', 'table', 'stat'] as const

  it('takes the first type the consumer implements', () => {
    assert.equal(pickWidget(['message', 'card'], CLOSED, 'card'), 'card')
    assert.equal(pickWidget(['message', 'card'], ['message', ...CLOSED] as const, 'card'), 'message')
  })

  it('honours the whole chain, not only its first entry', () => {
    assert.equal(pickWidget(['gantt', 'burndown', 'row'], CLOSED, 'card'), 'row')
  })

  it('accepts a bare string, which is the older form and a chain of one', () => {
    assert.equal(pickWidget('row', CLOSED, 'card'), 'row')
  })

  it('falls back rather than returning nothing, even for an unterminated chain', () => {
    // A producer must terminate its chain in a closed type. This is what
    // happens when one does not, and drawing a card beats drawing a blank:
    // §13.3's whole argument is that blank reads as "that app is broken".
    assert.equal(pickWidget(['kanban', 'gantt'], CLOSED, 'card'), 'card')
    assert.equal(pickWidget([], CLOSED, 'card'), 'card')
  })
})

/**
 * A Folder is not a file inside itself.
 *
 * A channel's own `kind:39000` comes back from an `#h` query for that channel
 * — it carries no `h` tag, but the relay scopes a discovery event to the
 * channel it describes. Its `d` is the folder uuid, which is what marks it out.
 *
 * This reached production. PRO-6 declared Topic a container (it holds
 * messages), so the Folder's own `39000` became a candidate for "which project
 * is in this Folder", beat the actual Ship project, and the sidebar listed the
 * folder's *messages* as tickets — each titled with its author's pubkey,
 * because a message resolved through Peek's own projection has
 * `title: {field: "pubkey"}`.
 */
describe('a Folder’s own discovery record', () => {
  const RELAY_KEY = 'c'.repeat(64)

  const peekManifest = event({
    kind: 31990,
    tags: [['d', 'peek'], ['k', '39000'], ['k', '9']],
    content: JSON.stringify({
      name: 'Peek',
      projections: {
        39000: {
          widget: 'card',
          slots: {
            title: { tag: 'name' },
            list: { children: { kind: 9, via: 'h', match: 'identifier' } },
          },
        },
        9: { widget: ['message', 'card'], slots: { title: { field: 'pubkey', as: 'pubkey' } } },
      },
    }),
  })

  /** The channel's own record: `d` IS the folder, and it carries no `h`. */
  const folderRecord = event({
    kind: 39000,
    pubkey: RELAY_KEY,
    tags: [['d', FOLDER], ['name', 'Peek’s Intelligence']],
  })
  const chatter = event({ kind: 9, tags: [['h', FOLDER]], content: 'unrelated talk' })

  /*
    **The project is global and carries no `h`** — REW-11 made a Ship project a
    global record, so an `#h` read of its Folder does not return it. It is found
    by adoption, from the `a` tag its issues carry.

    That is not incidental to this bug, it *is* the bug: with the project absent
    from the Folder read, the Folder's own `39000` was the only candidate left,
    so it won by default. The fixture used elsewhere in this file gives a project
    an `h`, which is why nothing here caught it.
  */
  const globalProject = project('p1', { tags: [['d', 'p1'], ['title', 'Peek’s Intelligence'], ['buzz-channel', FOLDER]] })

  it('is not mistaken for the project whose work the Folder holds', async () => {
    const found = await resolveFolderProject(
      FOLDER,
      relay([manifest(), peekManifest, folderRecord, chatter, globalProject, issue('t1', 'Billing')]),
    )
    assert.equal(found?.project.kind, PROJECT_KIND)
    assert.deepEqual(found?.tickets.map((t) => t.slots.title.value), ['Billing'])
    // The failure this replaces: kind:9 messages listed as tickets, each titled
    // with its author's pubkey because they resolved through Peek's Message
    // projection rather than Ship's Issue one.
    assert.equal(found?.tickets.every((t) => t.kind === ISSUE_KIND), true)
    assert.equal(found?.tickets.some((t) => t.slots.title.isPubkey), false)
  })

  it('does not stop the Folder resolving at all', async () => {
    // The subtle half: `holdsContainer` and `roots` must agree about what the
    // Folder holds. Excluding the record from one and not the other makes the
    // panel resolve to nothing — a different bug, not a fix.
    const found = await resolveFolderProject(
      FOLDER,
      relay([manifest(), peekManifest, folderRecord, chatter, globalProject, issue('t1', 'Billing')]),
    )
    assert.notEqual(found, null)
  })
})

/**
 * The producer half of the fallback chain — PRO-3.
 *
 * `pickWidget` makes a consumer safe against a chain it does not fully
 * understand. This stops the unrenderable chain being published at all, and the
 * two fail differently: without the consumer half an unknown widget renders
 * blank; without this one a *conformant* consumer renders blank through no
 * fault of its own, having done exactly what it was told.
 */
describe('widgetChainProblem', () => {
  const ok = (declared: unknown) => assert.equal(widgetChainProblem(declared), null)
  // `expect.any(String)` in the original: an asymmetric matcher with no
  // `node:assert` equivalent, so it says the same thing directly. What matters
  // is that a refusal *explains itself* — the chain's whole purpose is telling a
  // manifest author what to fix — so the type is the assertion, not the text.
  const bad = (declared: unknown) => assert.equal(typeof widgetChainProblem(declared), 'string')

  it('accepts a bare closed type, which is the older form', () => {
    for (const w of CLOSED_WIDGETS) ok(w)
  })

  it('accepts a chain ending in a closed type', () => {
    ok(['message', 'card'])
    ok(['profile', 'kanban', 'row'])
  })

  it('rejects a chain that ends in a type nobody must implement', () => {
    // The whole point. This is valid JSON, publishes fine, and renders as
    // nothing in every consumer that has not heard of `profile`.
    bad(['profile'])
    bad(['message', 'profile'])
  })

  it('rejects a bare unknown type and says how to fix it', () => {
    const problem = widgetChainProblem('profile')
    assert.ok(problem?.includes('"profile", "card"'))
  })

  it('names the offending entry rather than saying "invalid"', () => {
    // Read by a person publishing a manifest. "invalid widget" tells them
    // neither which one nor what to do about it.
    assert.ok(widgetChainProblem(['gantt'])?.includes('gantt'))
  })

  it('rejects the shapes that are not chains at all', () => {
    bad([])
    bad(undefined)
    bad(42)
    bad(['card', ''])
  })

  it('agrees with pickWidget about what is safe', () => {
    // The two halves must not drift: anything this accepts must leave
    // pickWidget something to draw for a consumer implementing only the
    // closed set.
    const safe: (string | string[])[] = [['message', 'card'], ['profile', 'kanban', 'row'], 'stat']
    for (const declared of safe) {
      ok(declared)
      assert.ok((CLOSED_WIDGETS).includes(pickWidget(declared, CLOSED_WIDGETS, 'card')))
    }
  })
})

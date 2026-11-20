/**
 * Plain reads asked together go out as one request (SHI-61).
 *
 * The relay meters requests, 300 a minute per person across every app, and one
 * Ship or Leaf open sent 74–110 of them. These tests hold `Relay.query` with
 * `mergeReadsMs` to what each caller must still get: exactly the answer it
 * would have got alone, in fewer requests, and never a guessed one.
 */
import test, { mock } from 'node:test'
import assert from 'node:assert/strict'
import * as protocol from '../dist/index.js'

const { Relay, secretKeySigner } = protocol
// Read off the module, not imported by name: run against a build without merging, these fail on what reaches the relay.
const MERGE_READS_MS = protocol.MERGE_READS_MS ?? 25

const SECRET = '0000000000000000000000000000000000000000000000000000000000000001'
const hex = (n) => String(n).padStart(64, '0')

const event = (id, createdAt, kind, tags = [], pubkey = hex(1)) => ({
  id: hex(id),
  pubkey,
  kind,
  created_at: createdAt,
  tags,
  content: `e${id}`,
  sig: hex(2),
})

const EVENTS = [
  event(1, 300, 0, [], hex(7)),
  event(2, 290, 0, [], hex(8)),
  event(3, 280, 31990, [['k', '30851']]),
  event(4, 270, 31990, [['k', '30850']]),
  event(5, 260, 1851, [['a', 'x:1'], ['a', 'x:2']]),
  event(6, 250, 1851, [['a', 'x:2']]),
  event(7, 240, 9, [['h', 'f1']]),
]

/** A relay as measured: each filter answered alone, NIP-01 matching, newest first, runs end to end in filter order. */
function fakeRelay({ status = 200, text } = {}) {
  const calls = []
  const fetch = async (_url, init) => {
    const filters = JSON.parse(init.body)
    calls.push(filters)
    if (status !== 200) return { status, text: async () => text }
    const out = []
    for (const filter of filters) {
      const matched = EVENTS.filter(
        (e) =>
          (!filter.kinds || filter.kinds.includes(e.kind)) &&
          (!filter.authors || filter.authors.includes(e.pubkey)) &&
          Object.entries(filter).every(([key, values]) => !key.startsWith('#') || e.tags.some((t) => t[0] === key[1] && values.includes(t[1]))),
      ).sort((a, b) => b.created_at - a.created_at)
      out.push(...matched.slice(0, filter.limit ?? 500))
    }
    return { status: 200, text: async () => JSON.stringify(out) }
  }
  return {
    calls,
    merging: new Relay('https://r', secretKeySigner(SECRET), { fetch, mergeReadsMs: MERGE_READS_MS, busyRetryDelaysMs: [] }),
    alone: new Relay('https://r', secretKeySigner(SECRET), { fetch, busyRetryDelaysMs: [] }),
  }
}

/** Ask every read at once, let the merge window pass, and wait for every answer. */
async function together(relay, reads) {
  mock.timers.enable({ apis: ['setTimeout'] })
  try {
    const answers = reads.map((filters) => relay.query(filters))
    mock.timers.tick(MERGE_READS_MS)
    return await Promise.all(answers)
  } finally {
    mock.timers.reset()
  }
}

const ids = (events) => events.map((e) => e.content)

test('reads of different kinds asked together go out as one request, and each gets what it would alone', async () => {
  const reads = [
    [{ kinds: [0], authors: [hex(7)], limit: 1 }],
    [{ kinds: [31990], '#k': ['30851'], limit: 20 }],
    [{ kinds: [1851], '#a': ['x:2'], limit: 1000 }],
  ]
  const { calls, merging, alone } = fakeRelay()
  const merged = await together(merging, reads)
  assert.equal(calls.length, 1)
  assert.equal(calls[0].length, 3)
  const separately = []
  for (const filters of reads) separately.push(await alone.query(filters))
  assert.deepEqual(merged.map(ids), separately.map(ids))
  assert.deepEqual(merged.map(ids), [['e1'], ['e3'], ['e5', 'e6']])
})

test('the same read asked twice at once goes out once, and each caller gets its own copy of the answer', async () => {
  const read = [{ kinds: [31990], '#k': ['30850'], limit: 20 }]
  const { calls, merging } = fakeRelay()
  const [first, second] = await together(merging, [read, read])
  assert.equal(calls.length, 1)
  assert.deepEqual(ids(first), ['e4'])
  assert.deepEqual(ids(second), ['e4'])
  first.pop()
  assert.deepEqual(ids(second), ['e4'])
})

test('reads whose answers could not be told apart go out separately, never guessed', async () => {
  // Same kind, and one author in both: an event of that author would belong to either.
  const reads = [[{ kinds: [0], authors: [hex(7), hex(8)] }], [{ kinds: [0], authors: [hex(7)] }]]
  const { calls, merging } = fakeRelay()
  const merged = await together(merging, reads)
  assert.equal(calls.length, 2)
  assert.deepEqual(merged.map(ids), [['e1', 'e2'], ['e1']])
})

test('a batch with an event two of its reads ask for is asked again read by read, with the right answers', async () => {
  // Disjoint `#a` values, but e5 carries both: the batch's answer cannot be cut for certain.
  const reads = [[{ kinds: [1851], '#a': ['x:1'] }], [{ kinds: [1851], '#a': ['x:2'] }]]
  const { calls, merging } = fakeRelay()
  const merged = await together(merging, reads)
  assert.deepEqual(
    calls.map((c) => c.length),
    [2, 1, 1],
  )
  assert.deepEqual(merged.map(ids), [['e5'], ['e5', 'e6']])
})

test('a read of a team (#h) is never held: it goes out at once, alone', async () => {
  const { calls, merging } = fakeRelay()
  mock.timers.enable({ apis: ['setTimeout'] })
  try {
    // No tick: a held read would never answer.
    const answer = await merging.query([{ kinds: [9], '#h': ['f1'] }])
    assert.deepEqual(ids(answer), ['e7'])
    assert.equal(calls.length, 1)
  } finally {
    mock.timers.reset()
  }
})

test('a refused batch fails each of its reads with the relay’s words, in one request', async () => {
  const { calls, merging } = fakeRelay({ status: 429, text: JSON.stringify({ error: 'rate-limited: quota exceeded; retry in 9s' }) })
  mock.timers.enable({ apis: ['setTimeout'] })
  try {
    const answers = [merging.query([{ kinds: [0], authors: [hex(7)] }]), merging.query([{ kinds: [31990], '#k': ['30851'] }])]
    mock.timers.tick(MERGE_READS_MS)
    const results = await Promise.allSettled(answers)
    assert.equal(calls.length, 1)
    for (const result of results) {
      assert.equal(result.status, 'rejected')
      assert.match(String(result.reason?.message), /rate-limited: quota exceeded/)
    }
  } finally {
    mock.timers.reset()
  }
})

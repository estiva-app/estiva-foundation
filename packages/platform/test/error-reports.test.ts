/**
 * The error reporter, read at the wire: every assertion is on the request body
 * that would leave the browser, so text a person wrote that leaks anywhere on
 * the way fails here.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createErrorReporter, scrubMessage, type ErrorReporterOptions } from '../dist/index.js'

const ORIGIN = 'https://peek.estiva.app'
const PLANTED_MESSAGE = 'plantedmessage quarterly numbers'
const PLANTED_TITLE = 'plantedtitle board offsite'
const PLANTED_ADDRESS = 'plantedaddress-5a1c9e'

/** One turn of the event loop: the reporter reads the token before it sends. */
const flush = () => new Promise<void>((resolve) => setImmediate(resolve))

function harness(overrides: Partial<ErrorReporterOptions> = {}) {
  const requests: Array<{ url: string; headers: Record<string, string>; body: string }> = []
  const reporter = createErrorReporter({
    endpoint: 'https://id.estiva.app/report',
    release: 'ded93b9c',
    origin: ORIGIN,
    token: () => 'qa-1-token',
    screen: () => '/app/teams/:id',
    screens: ['/app/desk', '/app/dms', '/app/teams/:id'],
    now: () => 1_700_000_000_000,
    fetch: async (url, init) => {
      requests.push({ url, headers: init.headers, body: init.body })
      return {}
    },
    ...overrides,
  })
  return { reporter, requests }
}

/** A crash as Chrome words it, its stack's first line repeating the message. */
function chromeCrash(message: string, topLine = 1) {
  const error = new SyntaxError(message)
  error.stack = [
    `SyntaxError: ${message}`,
    `    at parseBody (${ORIGIN}/assets/index-Ab12.js:${topLine}:4567)`,
    `    at render (${ORIGIN}/app/teams/${PLANTED_ADDRESS}:3:9)`,
    `    at ${ORIGIN}/assets/vendor-Cd34.js:2:10`,
    '    at inject (chrome-extension://abcdef/content.js:1:1)',
  ].join('\n')
  return error
}

/** Text a decrypted message would hold, failing to parse as JSON in this runtime. */
function parseFailure(): Error {
  try {
    JSON.parse(PLANTED_MESSAGE)
  } catch (error) {
    return error as Error
  }
  throw new Error('JSON.parse accepted the planted text')
}

test('a crash is sent to Estiva ID with the sign-in, and nothing planted leaves the browser', async () => {
  const { reporter, requests } = harness()
  reporter.step({ screen: '/app/desk' })
  reporter.step({ action: 'sent-message' })
  reporter.report(chromeCrash(`Unexpected token 'p', "${PLANTED_MESSAGE}" is not valid JSON`), 'boundary')
  await flush()

  assert.equal(requests.length, 1)
  const [request] = requests
  assert.equal(request?.url, 'https://id.estiva.app/report')
  assert.equal(request?.headers.authorization, 'Bearer qa-1-token')
  for (const planted of ['plantedmessage', 'quarterly', 'plantedtitle', 'plantedaddress', 'chrome-extension']) {
    assert.ok(!request?.body.includes(planted), `${planted} left the browser`)
  }
  assert.deepEqual(JSON.parse(request?.body ?? ''), {
    release: 'ded93b9c',
    how: 'boundary',
    error: {
      type: 'SyntaxError',
      message: 'Unexpected token … is not valid JSON',
      frames: [
        { function: 'parseBody', file: `${ORIGIN}/assets/index-Ab12.js`, line: 1, column: 4567 },
        { file: '<other>' },
        { file: `${ORIGIN}/assets/vendor-Cd34.js`, line: 2, column: 10 },
        { file: '<other>' },
      ],
    },
    screen: '/app/teams/:id',
    trail: [
      { screen: '/app/desk', at: 1_700_000_000_000 },
      { action: 'sent-message', at: 1_700_000_000_000 },
    ],
  })
})

test("this runtime's own JSON parse error of a decrypted message sends none of its text", async () => {
  const { reporter, requests } = harness()
  reporter.report(parseFailure())
  await flush()
  assert.equal(requests.length, 1)
  assert.ok(!requests[0]?.body.includes('plantedmessage'))
  assert.ok(!requests[0]?.body.includes('quarterly'))
})

test('a stack as Firefox and Safari write it keeps the frames in our bundles', async () => {
  const { reporter, requests } = harness()
  const error = new TypeError(`can't access property "${PLANTED_TITLE}", e is undefined`)
  error.stack = [
    `render@${ORIGIN}/assets/index-Ab12.js:1:200`,
    `@${ORIGIN}/t/${PLANTED_ADDRESS}:1:1`,
  ].join('\n')
  reporter.report(error)
  await flush()
  const body = JSON.parse(requests[0]?.body ?? '')
  assert.equal(body.error.message, "can't access property …, e is undefined")
  assert.deepEqual(body.error.frames, [
    { function: 'render', file: `${ORIGIN}/assets/index-Ab12.js`, line: 1, column: 200 },
    { file: '<other>' },
  ])
})

test("frame-shaped lines in an error's own wording never leave as frames", async () => {
  const { reporter, requests } = harness()
  // A person's text, quoted whole by an error such as a regex one; Chrome repeats it atop the stack.
  const planted = [
    'Launch@https://peek.estiva.app/assets/plantedmessage.js:1:2',
    `    at Plantedtitle.board (${ORIGIN}/assets/quarterly.js:1:2)`,
  ].join('\n')
  const error = new Error(`Peek could not open ${planted}`)
  error.stack = [`Error: Peek could not open ${planted}`, `    at parseBody (${ORIGIN}/assets/index-Ab12.js:1:4567)`].join(
    '\n',
  )
  reporter.report(error)
  await flush()
  for (const word of ['plantedmessage', 'quarterly', 'Plantedtitle']) {
    assert.ok(!requests[0]?.body.includes(word), `${word} left the browser`)
  }
  assert.deepEqual(JSON.parse(requests[0]?.body ?? '').error.frames, [
    { function: 'parseBody', file: `${ORIGIN}/assets/index-Ab12.js`, line: 1, column: 4567 },
  ])
})

test('an opening that no longer matches the error, under a name with a space, still sends no line of it as a frame', async () => {
  const { reporter, requests } = harness()
  const error = new Error('Peek could not open')
  error.name = 'Peek Error'
  // The stack was taken before a library rewrote the wording.
  error.stack = [
    `Peek Error: Launch@${ORIGIN}/assets/plantedmessage.js:1:2`,
    `    at parseBody (${ORIGIN}/assets/index-Ab12.js:1:4567)`,
  ].join('\n')
  reporter.report(error)
  await flush()
  assert.ok(!requests[0]?.body.includes('plantedmessage'), 'plantedmessage left the browser')
  assert.deepEqual(JSON.parse(requests[0]?.body ?? '').error.frames, [
    { function: 'parseBody', file: `${ORIGIN}/assets/index-Ab12.js`, line: 1, column: 4567 },
  ])
})

test('a screen or a step outside the lists goes as <unknown> or not at all, and nothing else on it is sent', async () => {
  let current = `/app/teams/${PLANTED_ADDRESS}`
  const { reporter, requests } = harness({ screen: () => current })
  const fromRouter = { screen: '/app/dms', params: { id: PLANTED_ADDRESS }, pathname: `/app/dms/${PLANTED_ADDRESS}` }
  reporter.step(fromRouter)
  reporter.step({ screen: `/t/${PLANTED_TITLE}` })
  reporter.step({ action: PLANTED_MESSAGE } as unknown as { action: 'sent-message' })
  reporter.report(chromeCrash('x is not a function'))
  current = '/app/desk'
  reporter.report(chromeCrash('x is not a function', 2))
  await flush()
  assert.equal(JSON.parse(requests[1]?.body ?? '').screen, '/app/desk')
  const body = requests[0]?.body ?? ''
  assert.ok(!body.includes('planted'), 'planted text left the browser')
  const sent = JSON.parse(body)
  assert.equal(sent.screen, '<unknown>')
  assert.deepEqual(sent.trail, [
    { screen: '/app/dms', at: 1_700_000_000_000 },
    { screen: '<unknown>', at: 1_700_000_000_000 },
  ])
})

test('a 100 KB wording is cleaned without freezing the tab, whatever it is made of', () => {
  // Quadratic before: 449 ms at 30 KB. The bound leaves a wide margin for a loaded runner.
  for (const unit of ['a', 'a@', 'a.']) {
    const started = performance.now()
    scrubMessage(unit.repeat(100_000 / unit.length))
    assert.ok(performance.now() - started < 200, `${unit} took ${performance.now() - started} ms`)
  }
})

test('a wording far past the 200 sent is still cleaned whole, by its end', () => {
  const long = 'planted words a person wrote '.repeat(40)
  for (const [raw, expected] of [
    [`URL constructor: ${long} is not a valid URL.`, 'URL constructor: … is not a valid URL.'],
    [`Cannot convert ${long} to a number`, 'Cannot convert … to a number'],
    [`Topic "general" missing in "${long}"`, 'Topic …'],
    [`Cannot read "${long.slice(0, 500)} 5' tall ${long}"`, 'Cannot read …'],
  ]) {
    assert.equal(scrubMessage(raw), expected)
  }
})

test('a web or mail address is removed in the shapes the slower patterns caught', () => {
  for (const [raw, expected] of [
    ['Load failed -https://peek.estiva.app/t/planted-visit', 'Load failed <url>'],
    ['see .http://planted.example/x y', 'see <url>'],
    ['+ftp://planted/notes', '<url>'],
    ['mail planted@@example.com now', 'mail <address> now'],
    ['to planted@corp@example.com now', 'to <address> now'],
    ['Expected @ at line 3.', 'Expected @ at line 3.'],
  ]) {
    assert.equal(scrubMessage(raw), expected)
  }
})

test('the same crash 1,000 times in one tab sends one report', async () => {
  const { reporter, requests } = harness()
  for (let i = 0; i < 1000; i++) reporter.report(chromeCrash('x is not a function'))
  await flush()
  assert.equal(requests.length, 1)
})

test('a tab sends at most ten reports, however many kinds of error it hits', async () => {
  const { reporter, requests } = harness()
  for (let line = 1; line <= 25; line++) reporter.report(chromeCrash('x is not a function', line))
  await flush()
  assert.equal(requests.length, 10)
})

test('nothing is sent while signed out, a crash loop then asks for the sign-in rarely, and the same crash after sign-in still reports', async () => {
  let token: string | undefined
  let tokenReads = 0
  let clock = 1_700_000_000_000
  const { reporter, requests } = harness({
    token: () => {
      tokenReads++
      return token
    },
    now: () => clock,
  })
  for (let burst = 0; burst < 2; burst++) {
    for (let i = 0; i < 500; i++) reporter.report(chromeCrash('x is not a function'))
    await flush()
  }
  assert.equal(requests.length, 0)
  assert.equal(tokenReads, 1)

  token = 'qa-1-token'
  clock += 10_000
  reporter.report(chromeCrash('x is not a function'))
  await flush()
  assert.equal(requests.length, 1)
})

test('a rejection that is not an Error is reported by its kind alone, never its text', async () => {
  const { reporter, requests } = harness()
  reporter.report(PLANTED_MESSAGE, 'unhandled-rejection')
  reporter.report({ title: PLANTED_TITLE }, 'unhandled-rejection')
  await flush()
  assert.equal(requests.length, 2)
  assert.deepEqual(
    requests.map((r) => JSON.parse(r.body).error),
    [
      { type: 'NonError', message: '', frames: [] },
      { type: 'NonErrorObject', message: '', frames: [] },
    ],
  )
})

test("the window's unhandled errors and rejections are reported until it stops listening", async () => {
  const { reporter, requests } = harness()
  const listeners = new Map<string, (event: { error?: unknown; reason?: unknown }) => void>()
  const stop = reporter.listen({
    addEventListener: (type, listener) => listeners.set(type, listener),
    removeEventListener: (type) => listeners.delete(type),
  })
  listeners.get('error')?.({ error: chromeCrash('a is not a function') })
  listeners.get('unhandledrejection')?.({ reason: new RangeError('Invalid array length') })
  await flush()
  assert.deepEqual(
    requests.map((r) => [JSON.parse(r.body).how, JSON.parse(r.body).error.type]),
    [
      ['error', 'SyntaxError'],
      ['unhandled-rejection', 'RangeError'],
    ],
  )
  stop()
  assert.equal(listeners.size, 0)
})

test('the trail keeps the last ten steps, and a screen opened twice in a row once', async () => {
  const { reporter, requests } = harness()
  reporter.step({ screen: '/app/desk' })
  reporter.step({ screen: '/app/desk' })
  for (let i = 0; i < 12; i++) reporter.step({ screen: i % 2 ? '/app/dms' : '/app/teams/:id' })
  reporter.report(chromeCrash('x is not a function'))
  await flush()
  const trail = JSON.parse(requests[0]?.body ?? '').trail
  assert.equal(trail.length, 10)
  assert.ok(!trail.some((step: { screen?: string }) => step.screen === '/app/desk'))
})

test('a failed send is dropped and never throws into the page', async () => {
  const { reporter } = harness({
    fetch: async () => {
      throw new TypeError('Failed to fetch')
    },
  })
  assert.doesNotThrow(() => reporter.report(chromeCrash('x is not a function')))
  await flush()
})

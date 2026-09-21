/**
 * RFC 0.5 §7's URL grammar.
 *
 * `slugify`, `objectRef` and `identifierFromRef` are Peek's (PEE-14), moved
 * here rather than rewritten — so Peek's own cases come with them, and an
 * extraction that quietly changed behaviour would fail here rather than in a
 * link somebody had already shared.
 *
 * `matchObjectUrl` is new, and the cases that matter most are the refusals.
 * §7.2 as originally written told a consumer to ignore everything before the
 * final uuid, which resolves any host's URL as the app's object. The amendment
 * makes the host and the `<type>` segment significant, and the tests below are
 * what hold it there.
 */
import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { slugify, objectRef, identifierFromRef, matchObjectUrl, urlPatternsOf } from '../dist/index.js'

const UUID = '9c69f247-be6a-4ae7-9703-71cb971f5f93'
const SHIP = [
  { pattern: 'https://ship.estiva.app/project/<slug>-<d>', kind: 30850 },
  { pattern: 'https://ship.estiva.app/issue/<slug>-<d>', kind: 30851 },
]

describe('slugify', () => {
  it('reduces a title to url-safe words', () => {
    assert.equal(slugify("Peek's Intelligence"), 'peek-s-intelligence')
  })

  it('folds accents rather than dropping the word', () => {
    assert.equal(slugify('Café Münster'), 'cafe-munster')
  })

  it('collapses runs and trims the ends, so a ref never has a double hyphen', () => {
    assert.equal(slugify('  —— Ship // Feedback ——  '), 'ship-feedback')
  })

  it('is empty when a title carries no url-safe characters at all', () => {
    // Not a failure: `objectRef` falls back to the bare identifier, which still
    // resolves. A slug is decoration and may legitimately be absent.
    assert.equal(slugify('日本語'), '')
  })

  it('never ends in a hyphen after truncation', () => {
    // The cut lands mid-word, and a trailing hyphen would put `--` in the ref.
    const long = `${'a'.repeat(59)} tail`
    assert.ok(!slugify(long).endsWith('-'))
  })
})

describe('objectRef', () => {
  it('joins the slug to the identity', () => {
    assert.equal(objectRef(UUID, 'Design review'), `design-review-${UUID}`)
  })

  it('falls back to the bare identity when the title slugs to nothing', () => {
    assert.equal(objectRef(UUID, '日本語'), UUID)
    assert.equal(objectRef(UUID), UUID)
  })
})

describe('identifierFromRef', () => {
  it('reads the identity off the tail, whatever the slug contains', () => {
    // The slug has hyphens, digits and hex in it — everything that would break
    // a parser trying to split the ref into parts rather than read its end.
    assert.equal(identifierFromRef(`ric-7-abc123-def-${UUID}`), UUID)
  })

  it('accepts a bare identity', () => {
    assert.equal(identifierFromRef(UUID), UUID)
  })

  it('lowercases, so a link an email client capitalised still resolves', () => {
    assert.equal(identifierFromRef(UUID.toUpperCase()), UUID)
  })

  it('is null for a ref that carries no identity', () => {
    assert.equal(identifierFromRef('projects'), null)
    assert.equal(identifierFromRef(''), null)
  })
})

describe('matchObjectUrl', () => {
  it('recovers the identity and the kind from a declared shape', () => {
    const found = matchObjectUrl(`https://ship.estiva.app/issue/billing-entry-${UUID}`, SHIP)
    assert.deepEqual(found, { identifier: UUID, by: 'd', kind: 30851 })
  })

  it('reads the kind from the segment that was matched, not from the uuid', () => {
    const found = matchObjectUrl(`https://ship.estiva.app/project/payments-${UUID}`, SHIP)
    assert.equal(found?.kind, 30850)
  })

  it('refuses another host, which is the amendment §7.2 needed', () => {
    // The original wording — ignore everything before the final uuid — resolves
    // this as a Ship issue. It is the reason the sentence was changed.
    assert.equal(matchObjectUrl(`https://evil.example.com/issue/x-${UUID}`, SHIP), null)
  })

  it('refuses a path shape the app never declared', () => {
    assert.equal(matchObjectUrl(`https://ship.estiva.app/person/ana-${UUID}`, SHIP), null)
  })

  it('refuses a directory URL, which names no object', () => {
    assert.equal(matchObjectUrl('https://ship.estiva.app/issues', SHIP), null)
  })

  it('refuses a deeper path that merely starts the same way', () => {
    assert.equal(matchObjectUrl(`https://ship.estiva.app/issue/nested/x-${UUID}`, SHIP), null)
  })

  it('refuses a scheme that is not the web', () => {
    // A `javascript:` URL ending in something uuid-shaped must never reach a
    // relay query, let alone a renderer.
    assert.equal(matchObjectUrl(`javascript:alert(1)//ship.estiva.app/issue/x-${UUID}`, SHIP), null)
    assert.equal(matchObjectUrl(`data:text/html,/issue/x-${UUID}`, SHIP), null)
    // Worth knowing *why* each of these is refused, because it is not the same
    // reason and a control showed it. The two above carry no `://` authority,
    // so they never parse. This one parses and is refused by the scheme
    // comparison against the declared pattern — every pattern an app publishes
    // is `https`. Relaxing the parser's own `https?` restriction fails no test;
    // it is defence in depth, not the rule.
    assert.equal(matchObjectUrl(`ftp://ship.estiva.app/issue/x-${UUID}`, SHIP), null)
  })

  it('refuses a matching shape that carries no identity', () => {
    assert.equal(matchObjectUrl('https://ship.estiva.app/issue/no-uuid-here', SHIP), null)
  })

  it('ignores the slug entirely, so a renamed object still resolves', () => {
    const renamed = matchObjectUrl(`https://ship.estiva.app/issue/a-completely-different-title-${UUID}`, SHIP)
    assert.equal(renamed?.identifier, UUID)
  })

  it('matches a fragment route, which is how a pre-SHI-16 link still resolves', () => {
    // Ship served `#/issue/<d>` until it moved to paths, and declares both
    // shapes so links already in other people's messages keep working. A
    // production probe caught this: the parser stopped at the `#`, so every one
    // of those matched nothing.
    const withHash = [{ pattern: 'https://ship.estiva.app/#/issue/<d>', kind: 30851 }]
    assert.deepEqual(matchObjectUrl(`https://ship.estiva.app/#/issue/${UUID}`, withHash), {
      identifier: UUID,
      by: 'd',
      kind: 30851,
    })
  })

  it('keeps a fragment route and a path route apart', () => {
    // Otherwise a pattern for one claims the other, and an app that means
    // different things by them resolves the wrong object.
    assert.equal(matchObjectUrl(`https://ship.estiva.app/#/issue/x-${UUID}`, SHIP), null)
    const withHash = [{ pattern: 'https://ship.estiva.app/#/issue/<d>', kind: 30851 }]
    assert.equal(matchObjectUrl(`https://ship.estiva.app/issue/x-${UUID}`, withHash), null)
  })

  it('counts a sub-path and a fragment together, as a dev deploy has both', () => {
    // Ship's own dev URL is `localhost:5190/ship/#/…`, where both halves carry
    // meaning — dropping either would match the wrong app or nothing at all.
    const dev = [{ pattern: 'http://localhost:5190/ship/#/issue/<d>', kind: 30851 }]
    assert.equal(matchObjectUrl(`http://localhost:5190/ship/#/issue/${UUID}`, dev)?.identifier, UUID)
    assert.equal(matchObjectUrl(`http://localhost:5190/#/issue/${UUID}`, dev), null)
  })

  it('carries no kind when the app declared none', () => {
    // §7.5's example declares bare patterns. A consumer then falls back to the
    // kinds the manifest handles, which is sound because no `d` is reused
    // under two kinds.
    const bare = [{ pattern: 'https://peek.estiva.app/topic/<slug>-<d>' }]
    assert.deepEqual(matchObjectUrl(`https://peek.estiva.app/topic/design-${UUID}`, bare), {
      identifier: UUID,
      by: 'd',
    })
  })
})

describe('urlPatternsOf', () => {
  it('reads the shapes off the manifest event, with the kind when given', () => {
    const event = {
      tags: [
        ['d', 'app'],
        ['urls', 'https://ship.estiva.app/issue/<slug>-<d>', '30851'],
        ['urls', 'https://ship.estiva.app/project/<slug>-<d>'],
        ['web', 'https://ship.estiva.app/o/<bech32>', 'naddr'],
      ],
    }
    assert.deepEqual(urlPatternsOf(event), [
      { pattern: 'https://ship.estiva.app/issue/<slug>-<d>', kind: 30851 },
      { pattern: 'https://ship.estiva.app/project/<slug>-<d>' },
    ])
  })

  it('is empty for a manifest that declares none, which is most of them today', () => {
    assert.deepEqual(urlPatternsOf({ tags: [['d', 'app']] }), [])
  })
})

describe('an event id as the identity', () => {
  // A `kind:9` message has no `d`, so its event id is the whole of it. §7.6
  // recorded that as outside this grammar until PEE-17 needed a message link.
  const EVENT = 'a3f1'.repeat(16)
  const PEEK = [{ pattern: 'https://peek.estiva.app/message/<id>', kind: 9 }]

  it('reads an event id when the pattern declares one', () => {
    assert.deepEqual(matchObjectUrl(`https://peek.estiva.app/message/${EVENT}`, PEEK), {
      identifier: EVENT,
      by: 'id',
      kind: 9,
    })
  })

  it('says how to resolve it, rather than leaving the consumer to guess', () => {
    // `by` is the difference between `{ids: [...]}` and `{"#d": [...]}`, and a
    // consumer inferring it from the string would be deciding an app's
    // addressing model from a character class.
    const found = matchObjectUrl(`https://peek.estiva.app/message/${EVENT}`, PEEK)
    assert.equal(found?.by, 'id')
    assert.equal(matchObjectUrl(`https://ship.estiva.app/issue/x-${UUID}`, SHIP)?.by, 'd')
  })

  it('does not read a uuid where an event id was declared', () => {
    assert.equal(matchObjectUrl(`https://peek.estiva.app/message/${UUID}`, PEEK), null)
  })

  it('does not read an event id where a uuid was declared', () => {
    assert.equal(matchObjectUrl(`https://ship.estiva.app/issue/x-${EVENT}`, SHIP), null)
  })

  it('ignores a slug in front of the event id, like any other identity', () => {
    assert.equal(matchObjectUrl(`https://peek.estiva.app/message/re-the-build-${EVENT}`, PEEK)?.identifier, EVENT)
  })

  it('refuses a hex run that is not 64 characters', () => {
    // Truncation is the failure worth catching: a short id resolves to nothing
    // or, worse, to a prefix match somebody did not intend.
    assert.equal(matchObjectUrl(`https://peek.estiva.app/message/${EVENT.slice(0, 63)}`, PEEK), null)
    assert.equal(matchObjectUrl(`https://peek.estiva.app/message/${EVENT}ab`, PEEK), null)
  })
})

describe('an event id in the query string', () => {
  // Peek opens a thread as `/topic/<slug>-<d>?thread=<id>`: the path names the
  // topic, the query names the root comment, and the link is about the
  // comment (FOL-38). Declared as its own `urls` tag beside the topic shape.
  const EVENT = 'b7c2'.repeat(16)
  const TOPIC = { pattern: 'https://peek.estiva.app/topic/<slug>-<d>', kind: 30840 }
  const THREAD = { pattern: 'https://peek.estiva.app/topic/<slug>-<d>?thread=<id>', kind: 1111 }

  it('reads the identity off the query and the container off the path', () => {
    assert.deepEqual(matchObjectUrl(`https://peek.estiva.app/topic/design-${UUID}?thread=${EVENT}`, [THREAD]), {
      identifier: EVENT,
      by: 'id',
      kind: 1111,
      within: { identifier: UUID, by: 'd' },
    })
  })

  it('prefers the shape whose query it satisfies, in either declaration order', () => {
    const url = `https://peek.estiva.app/topic/design-${UUID}?thread=${EVENT}`
    assert.equal(matchObjectUrl(url, [TOPIC, THREAD])?.kind, 1111)
    assert.equal(matchObjectUrl(url, [THREAD, TOPIC])?.kind, 1111)
  })

  it('falls back to the topic shape when the query names no thread', () => {
    const plain = matchObjectUrl(`https://peek.estiva.app/topic/design-${UUID}`, [THREAD, TOPIC])
    assert.deepEqual(plain, { identifier: UUID, by: 'd', kind: 30840 })
    // A tracker's parameter is not a thread, and neither is a truncated id.
    assert.equal(matchObjectUrl(`https://peek.estiva.app/topic/design-${UUID}?utm_source=x`, [THREAD, TOPIC])?.kind, 30840)
    assert.equal(matchObjectUrl(`https://peek.estiva.app/topic/design-${UUID}?thread=${EVENT.slice(0, 63)}`, [THREAD, TOPIC])?.kind, 30840)
  })

  it('names nothing when only the thread shape is declared and the query is missing', () => {
    assert.equal(matchObjectUrl(`https://peek.estiva.app/topic/design-${UUID}`, [THREAD]), null)
  })

  it('still requires the path to parse as its own placeholder', () => {
    // `?thread=` alone must not turn any path under /topic/ into a match.
    assert.equal(matchObjectUrl(`https://peek.estiva.app/topic/not-a-uuid?thread=${EVENT}`, [THREAD]), null)
  })

  it('reads a percent-encoded value and ignores other parameters', () => {
    const url = `https://peek.estiva.app/topic/design-${UUID}?from=desk&thread=${encodeURIComponent(EVENT.toUpperCase())}`
    assert.equal(matchObjectUrl(url, [THREAD])?.identifier, EVENT)
  })

  it('leaves a path-only shape unchanged', () => {
    // No `within`, no query read: the existing grammar is exactly as it was.
    assert.deepEqual(matchObjectUrl(`https://ship.estiva.app/issue/x-${UUID}?thread=${EVENT}`, SHIP), {
      identifier: UUID,
      by: 'd',
      kind: 30851,
    })
  })
})

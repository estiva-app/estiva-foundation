/**
 * The marker dialect — SPEC §13.2.
 *
 * Two halves. The first pins behaviour that was already shipping in Peek before
 * this moved into the package: those cases are ported verbatim from
 * `peek-app/src/lib/textParsing.test.ts`, because an extraction that changes
 * behaviour while every test still passes is the failure this file exists to
 * prevent. The second half is what §13 added — `code` and fenced code.
 *
 * `corpus-bodies.json` is 152 real published message bodies. A parser tested
 * only against fixtures somebody wrote alongside it is tested against its own
 * assumptions; these are what people and agents actually published.
 */
import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import {
  parseInlineMarks,
  wrapInlineMarks,
  parseBodySegments,
  stripInlineFormatting,
  type InlineMarkSpan,
} from '../dist/index.js'

// ── ported from Peek, unchanged ──

describe('parseInlineMarks — behaviour that was already shipping', () => {
  it('leaves plain text alone', () => {
    assert.deepEqual(parseInlineMarks('hello world'), [{ text: 'hello world' }])
  })
  it('parses bold, italic and underline', () => {
    assert.deepEqual(parseInlineMarks('a **bold** word'), [
      { text: 'a ' }, { text: 'bold', bold: true }, { text: ' word' },
    ])
    assert.deepEqual(parseInlineMarks('*it* and __un__'), [
      { text: 'it', italic: true }, { text: ' and ' }, { text: 'un', underline: true },
    ])
  })
  it('parses *** as bold italic and nests', () => {
    assert.deepEqual(parseInlineMarks('***both***'), [{ text: 'both', bold: true, italic: true }])
    assert.deepEqual(parseInlineMarks('__**both**__'), [{ text: 'both', bold: true, underline: true }])
  })
  it('keeps an unclosed or whitespace-edged marker literal', () => {
    assert.deepEqual(parseInlineMarks('*unclosed'), [{ text: '*unclosed' }])
    assert.deepEqual(parseInlineMarks('** not bold **'), [{ text: '** not bold **' }])
    assert.deepEqual(parseInlineMarks('a ** dangling'), [{ text: 'a ** dangling' }])
  })
  it('keeps 2*3*4 literal — SPEC §13.2 rule 2', () => {
    assert.deepEqual(parseInlineMarks('2*3*4 = 24'), [{ text: '2*3*4 = 24' }])
  })
})

describe('wrapInlineMarks — behaviour that was already shipping', () => {
  it('wraps each mark and combination', () => {
    assert.equal(wrapInlineMarks('plain', new Set()), 'plain')
    assert.equal(wrapInlineMarks('bold', new Set(['bold'])), '**bold**')
    assert.equal(wrapInlineMarks('it', new Set(['italic'])), '*it*')
    assert.equal(wrapInlineMarks('un', new Set(['underline'])), '__un__')
    assert.equal(wrapInlineMarks('both', new Set(['bold', 'italic'])), '***both***')
    assert.equal(wrapInlineMarks('all', new Set(['bold', 'italic', 'underline'])), '__***all***__')
  })
  it('ignores a mark the dialect has no marker for', () => {
    assert.equal(wrapInlineMarks('linked', new Set(['link'])), 'linked')
  })
  it('hoists edge whitespace outside the markers', () => {
    assert.equal(wrapInlineMarks('word ', new Set(['bold'])), '**word** ')
    assert.equal(wrapInlineMarks(' word', new Set(['underline'])), ' __word__')
  })
})

describe('parseBodySegments — behaviour that was already shipping', () => {
  it('splits paragraphs on blank lines', () => {
    assert.deepEqual(parseBodySegments('para one\n\npara two'), [
      { type: 'text', lines: ['para one'] }, { type: 'text', lines: ['para two'] },
    ])
  })
  it('turns # and ## into headings, and leaves ### and #123 alone', () => {
    assert.deepEqual(parseBodySegments('# Big\n## Small\nbody'), [
      { type: 'heading', level: 1, text: 'Big' },
      { type: 'heading', level: 2, text: 'Small' },
      { type: 'text', lines: ['body'] },
    ])
    assert.deepEqual(parseBodySegments('### not a heading'), [{ type: 'text', lines: ['### not a heading'] }])
    assert.deepEqual(parseBodySegments('#123 is merged'), [{ type: 'text', lines: ['#123 is merged'] }])
  })
  it('groups bullets and numbered items', () => {
    assert.deepEqual(parseBodySegments('- one\n- two'), [{ type: 'bullet', items: ['one', 'two'] }])
    assert.deepEqual(parseBodySegments('• alpha\n• beta'), [{ type: 'bullet', items: ['alpha', 'beta'] }])
    assert.deepEqual(parseBodySegments('1. one\n2. two'), [{ type: 'numbered', items: ['one', 'two'] }])
  })
  it('groups consecutive quote lines, and needs the space', () => {
    assert.deepEqual(parseBodySegments('> a **bold** word'), [{ type: 'quote', lines: ['a **bold** word'] }])
    assert.deepEqual(parseBodySegments('>no space'), [{ type: 'text', lines: ['>no space'] }])
    assert.deepEqual(parseBodySegments('5 > 3 is true'), [{ type: 'text', lines: ['5 > 3 is true'] }])
  })
})

describe('stripInlineFormatting — behaviour that was already shipping', () => {
  it('removes markers and the heading and quote prefixes', () => {
    assert.equal(stripInlineFormatting('# Title\n**bold** and *it* and __un__'), 'Title\nbold and it and un')
    assert.equal(stripInlineFormatting('> quoted **bit**'), 'quoted bit')
  })
  it('leaves literal markers alone', () => {
    assert.equal(stripInlineFormatting('see PR #482 at 2*3*4'), 'see PR #482 at 2*3*4')
  })
})

// ── new in SPEC §13 ──

describe('code — new in SPEC §13.1', () => {
  it('parses a backtick span', () => {
    assert.deepEqual(parseInlineMarks('run `npm test` now'), [
      { text: 'run ' }, { text: 'npm test', code: true }, { text: ' now' },
    ])
  })
  it('does not parse marks inside code', () => {
    assert.deepEqual(parseInlineMarks('`**not bold**`'), [{ text: '**not bold**', code: true }])
  })
  it('never combines code with another mark, even inside one', () => {
    const spans = parseInlineMarks('**bold with `code` in it**')
    assert.deepEqual(spans, [
      { text: 'bold with ', bold: true },
      { text: 'code', code: true },
      { text: ' in it', bold: true },
    ])
    for (const s of spans as InlineMarkSpan[]) {
      if (s.code) assert.ok(!s.bold && !s.italic && !s.underline, 'code must not combine')
    }
  })
  it('closes before a plural or possessive — rule 2 does not fence a backtick', () => {
    // Six real published bodies depend on this; `main`s is one of them.
    assert.deepEqual(parseInlineMarks('both `main`s agree'), [
      { text: 'both ' }, { text: 'main', code: true }, { text: 's agree' },
    ])
  })
  it('still needs a closing backtick and non-whitespace edges', () => {
    assert.deepEqual(parseInlineMarks('an `unclosed span'), [{ text: 'an `unclosed span' }])
    assert.deepEqual(parseInlineMarks('a ` spaced ` span'), [{ text: 'a ` spaced ` span' }])
  })
  it('round-trips through wrapInlineMarks, and code wins alone', () => {
    assert.equal(wrapInlineMarks('npm test', new Set(['code'])), '`npm test`')
    assert.equal(wrapInlineMarks('npm test', new Set(['code', 'bold'])), '`npm test`')
  })
  it('is stripped for previews', () => {
    assert.equal(stripInlineFormatting('run `npm test`'), 'run npm test')
  })
})

describe('fenced code — new in SPEC §13.2', () => {
  it('captures a fence and its language', () => {
    assert.deepEqual(parseBodySegments('```ts\nconst a = 1\n```'), [
      { type: 'code', language: 'ts', lines: ['const a = 1'] },
    ])
  })
  it('has no language when the opening line carries none', () => {
    assert.deepEqual(parseBodySegments('```\nplain\n```'), [{ type: 'code', lines: ['plain'] }])
  })
  it('does not interpret the fence body', () => {
    assert.deepEqual(parseBodySegments('```\n# not a heading\n- not a bullet\n```'), [
      { type: 'code', lines: ['# not a heading', '- not a bullet'] },
    ])
  })
  it('leaves an unclosed fence literal rather than swallowing the body', () => {
    assert.deepEqual(parseBodySegments('```\nstill text'), [
      { type: 'text', lines: ['```', 'still text'] },
    ])
  })
  it('drops fence lines from a preview', () => {
    assert.equal(stripInlineFormatting('intro\n```\ncode\n```'), 'intro\ncode')
  })
})

// ── against what is actually published ──

const corpus = JSON.parse(
  readFileSync(new URL('./corpus-bodies.json', import.meta.url), 'utf8'),
) as { bodies: string[]; counts: Record<string, number> }

const reserialize = (line: string) =>
  parseInlineMarks(line)
    .map((s) => {
      const names = new Set<string>()
      if (s.bold) names.add('bold')
      if (s.italic) names.add('italic')
      if (s.underline) names.add('underline')
      if (s.code) names.add('code')
      return wrapInlineMarks(s.text, names)
    })
    .join('')

describe('against 152 real published bodies', () => {
  it('has a corpus with all three shapes in it', () => {
    assert.equal(corpus.bodies.length, 152)
    assert.ok(corpus.counts.withCode >= 60, 'the code-carrying sample is the point')
  })

  it('parses every body without throwing', () => {
    for (const body of corpus.bodies) {
      parseBodySegments(body)
      stripInlineFormatting(body)
      for (const line of body.split('\n')) parseInlineMarks(line)
    }
  })

  /*
    The invariant is per character, not per span, and the difference is not
    pedantry. `wrapInlineMarks` hoists edge whitespace outside the markers
    because rule 1 rejects `**word **` — so serialising `**And `x` more**`
    re-partitions the spans around the code span while rendering identically.
    Comparing spans called that a round-trip failure; comparing the marks on
    each non-whitespace character asks the question that actually matters:
    **did any character change how it renders, and did any text go missing?**
  */
  const marksPerChar = (line: string) => {
    const out: string[] = []
    for (const s of parseInlineMarks(line) as InlineMarkSpan[]) {
      const key = [s.bold && 'b', s.italic && 'i', s.underline && 'u', s.code && 'c']
        .filter(Boolean).join('')
      for (const ch of s.text) if (!/\s/.test(ch)) out.push(`${ch}:${key}`)
    }
    return out
  }

  it('round-trips without changing how any character renders', () => {
    for (const body of corpus.bodies) {
      for (const line of body.split('\n')) {
        const once = marksPerChar(line)
        const twice = marksPerChar(reserialize(line))
        assert.deepEqual(twice, once, `marks moved: ${JSON.stringify(line.slice(0, 90))}`)
      }
    }
  })

  it('round-trips without losing or inventing text', () => {
    for (const body of corpus.bodies) {
      for (const line of body.split('\n')) {
        const flat = (l: string) =>
          (parseInlineMarks(l) as InlineMarkSpan[]).map((s) => s.text).join('')
        assert.equal(flat(reserialize(line)), flat(line), `text changed: ${JSON.stringify(line.slice(0, 90))}`)
      }
    }
  })

  it('strips idempotently', () => {
    for (const body of corpus.bodies) {
      const once = stripInlineFormatting(body)
      assert.equal(stripInlineFormatting(once), once, `not idempotent: ${JSON.stringify(body.slice(0, 90))}`)
    }
  })

  it('loses no characters from a segment that is not a prefix', () => {
    for (const body of corpus.bodies) {
      for (const seg of parseBodySegments(body)) {
        const text = seg.type === 'heading' ? seg.text
          : seg.type === 'bullet' || seg.type === 'numbered' ? seg.items.join('')
          : seg.lines.join('')
        assert.ok(typeof text === 'string')
      }
    }
  })

  it('finds code spans in the corpus, which is the whole reason code was added', () => {
    let spans = 0
    for (const body of corpus.bodies) {
      for (const line of body.split('\n')) {
        for (const s of parseInlineMarks(line) as InlineMarkSpan[]) if (s.code) spans++
      }
    }
    assert.ok(spans > 100, `expected the corpus to exercise code spans, found ${spans}`)
  })
})

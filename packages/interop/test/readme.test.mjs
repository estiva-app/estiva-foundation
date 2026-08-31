/**
 * Every name the README tells a builder to import actually exists.
 *
 * PRO-9's own framing is that the page matters more than the package: a
 * stranger is supposed to render an object using only what is written there. A
 * README naming an export that does not exist fails that person at the first
 * step, and nothing else in this repository would notice — the source suite
 * imports from `src/`, and prose is not compiled.
 *
 * So the README is parsed and checked against the built entry point. It is a
 * cheap test for a failure that is embarrassing in exactly the audience the
 * package is for.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import * as api from '../dist/index.js'

const readme = readFileSync(new URL('../README.md', import.meta.url), 'utf8')

test('every @estiva-app/interop import in the README is exported', () => {
  const named = new Set()
  for (const [, names] of readme.matchAll(/import\s*\{([^}]+)\}\s*from\s*'@estiva-app\/interop'/g)) {
    for (const name of names.split(',')) {
      const clean = name.trim().replace(/^type\s+/, '')
      if (clean) named.add(clean)
    }
  }
  assert.ok(named.size > 0, 'the README should show at least one import')
  const missing = [...named].filter((name) => !(name in api))
  assert.deepEqual(missing, [], `README imports that do not exist: ${missing.join(', ')}`)
})

test('the README does not promise a fold or a component', () => {
  // Both are things this package deliberately does not have. If either ever
  // appears in the API, the README's "what is not in here" section is a lie and
  // this is where that gets caught.
  assert.equal('foldFolder' in api, false)
  assert.equal('ForeignObjectWidget' in api, false)
})

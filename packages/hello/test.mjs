/**
 * The version constant is maintained by hand alongside package.json, which is
 * a drift waiting to happen — and a drift that is invisible in exactly the
 * place it matters. `HELLO_VERSION` exists so that "the upgrade reached the
 * app" can be checked by grepping a built bundle; if it disagrees with the
 * version npm actually published, that check silently starts lying.
 *
 * Runs against `dist/`, not `src/`, because dist is what ships.
 */
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'

const { version } = JSON.parse(readFileSync(new URL('./package.json', import.meta.url), 'utf8'))
const { hello, farewell, HELLO_VERSION } = await import('./dist/index.js')

assert.equal(HELLO_VERSION, version, `HELLO_VERSION is ${HELLO_VERSION}, package.json says ${version}`)
assert.equal(hello('you').version, version)
assert.equal(hello('you').text, 'Hello, you, from Estiva.')
assert.equal(farewell('you').text, 'Goodbye, you, from Estiva.')

console.log(`✅ @estiva-app/hello ${version} — built output agrees with package.json`)

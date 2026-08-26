import { greet } from './greeting.js'
import type { Greeting } from './greeting.js'

export type { Greeting }

/**
 * Bumped by hand with the version in package.json. It exists so that "the
 * upgrade propagated" can be checked by grepping a built application bundle,
 * rather than by trusting the lockfile that claims it.
 */
export const HELLO_VERSION = '0.0.2'

export function hello(name = 'world'): Greeting {
  return greet(name, HELLO_VERSION)
}


/** Added in 0.0.2, so the upgrade is visible in the type surface and not only
 * in a version string. A consumer that compiles against it has proved the new
 * `.d.ts` arrived, which a lockfile entry does not. */
export function farewell(name = 'world'): Greeting {
  return { text: `Goodbye, ${name}, from Estiva.`, version: HELLO_VERSION }
}

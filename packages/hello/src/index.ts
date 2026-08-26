import { greet } from './greeting.js'
import type { Greeting } from './greeting.js'

export type { Greeting }

/**
 * Bumped by hand with the version in package.json. It exists so that "the
 * upgrade propagated" can be checked by grepping a built application bundle,
 * rather than by trusting the lockfile that claims it.
 */
export const HELLO_VERSION = '0.0.1'

export function hello(name = 'world'): Greeting {
  return greet(name, HELLO_VERSION)
}


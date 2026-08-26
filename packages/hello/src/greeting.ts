/**
 * A second file, on purpose.
 *
 * A one-file package would not prove the thing that actually breaks: the
 * emitted relative specifier. `tsc` copies `./greeting.js` through to the
 * output untouched, so writing it extensionless here would emit an import that
 * Node cannot resolve and that only *some* bundlers forgive. Three toolchains
 * consume these packages; the extension is what makes them agree.
 */
export interface Greeting {
  readonly text: string
  /** The package version that produced it — the upgrade is observable at runtime. */
  readonly version: string
}

export function greet(name: string, version: string): Greeting {
  return { text: `Hello, ${name}, from Estiva.`, version }
}

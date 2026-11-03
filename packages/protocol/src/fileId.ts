/**
 * A file named by its id (SPEC §6.4, §13.6.1): the `<d>` of its address alone,
 * as an `o`, a `part` or an `embed` carries it once a type's apps name it so.
 *
 * A reader tells the two forms apart by the value: an address has two colons,
 * an id is a lowercase UUID. And **a file's address and its id are one file**
 * (*added 2026-11-02*, ALO-4): one card, one part, one listing entry, while
 * both forms are written.
 *
 * why: https://github.com/estiva-app/estiva-docs/blob/main/decisions/a-file-is-named-by-its-id-in-a-capital-and-small-tag.md
 */

/**
 * The kinds whose `d` is a file's id: topic, document, project, issue and a
 * named first record. The relay keeps an id unique across these alone, so a
 * lookup by id names them (§7.7): under any other kind, anyone can write an
 * event holding the same `d`.
 */
export const FILE_KINDS: readonly number[] = [30840, 30842, 30850, 30851, 30852]

/** A file's id: a lowercase UUID. */
const FILE_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/

/** `kind:pubkey:d`, the `d` captured. */
const ADDRESS = /^\d+:[0-9a-fA-F]{64}:([^]*)$/

/** Whether `value` is a file's id rather than an address or an event id. */
export function isFileId(value: string): boolean {
  return FILE_ID.test(value)
}

/**
 * What a value is compared by, so a file named by its address and by its id
 * compares equal: the id, for an id and for an address whose `d` is one; the
 * value as given otherwise (an event id, an address with any other `d`).
 * Normalise the value first; this changes nothing about its case.
 */
export function fileKeyOf(value: string): string {
  return fileIdOf(value) ?? value
}

/** The file's id in an address: its `d`, when that is a lowercase UUID. */
export function fileIdOf(address: string): string | undefined {
  const d = ADDRESS.exec(address)?.[1]
  return d !== undefined && FILE_ID.test(d) ? d : undefined
}

/** Whether two values name one file (or are the same value). */
export function sameFile(a: string, b: string): boolean {
  return a === b || fileKeyOf(a) === fileKeyOf(b)
}

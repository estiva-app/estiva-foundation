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

/**
 * The base types that keep their own first-record kinds, by kind (SPEC §6.1):
 * a `30852` names its type in its `k`, which its address does not carry.
 */
export const BASE_TYPE_OF_KIND: Readonly<Record<number, string>> = {
  30840: 'osnova.topic',
  30842: 'osnova.document',
  30850: 'osnova.project',
  30851: 'osnova.issue',
}

/** A file as a writer names it by its id: the id, and its type for a `K` or `k`. */
export interface FileIdForm {
  id: string
  type: string
}

/**
 * How to name the file at `address` by its id, when its type's apps write it
 * so: once the relay keeps the type in order (its NIP-11 `files.requires_prev`,
 * `RelayFileReads.inOrder`; SPEC §6.4, "Apps move to the pair type by type").
 * Undefined before, and for an address whose `d` is not a file's id: a writer
 * then names the file by its address alone, as every reader reads it.
 *
 * The id forms ride behind this switch because four of them are not additive
 * for a reader that knows only the address: a listing entry, a `part`, an
 * `embed` and a read under `file:<d>`.
 *
 * why: https://github.com/estiva-app/estiva-docs/blob/main/decisions/a-file-is-named-by-its-id-in-a-capital-and-small-tag.md
 */
export function fileIdFormOf(inOrder: readonly string[], address: string): FileIdForm | undefined {
  const id = fileIdOf(address)
  const type = BASE_TYPE_OF_KIND[Number(address.slice(0, address.indexOf(':')))]
  return id !== undefined && type !== undefined && inOrder.includes(type) ? { id, type } : undefined
}

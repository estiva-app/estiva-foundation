/**
 * archivedLine, the one sentence every app and the agent show on an archived
 * file (PEEKM-2, PEEKM-8).
 */

/**
 * Why nothing can be written on an archived file, in every app's words alike:
 * the line in the comment box's place, and the agent's refusal.
 *
 * A file archived itself says so; one archived with a file above it names the
 * closest archived one by its kind — "Unarchive the page to comment." — so a
 * person unarchives the right thing, and once it is unarchived the next one up
 * is named. Which file that is comes from interop: `archive.with` is its
 * address, and the app reads its noun.
 *
 * `options.in` names where to unarchive, for an app that has no Unarchive of
 * its own ("Archived. Unarchive it in Peek to comment."); `options.to` is what
 * waits for it, "comment" unless said ("…to edit.").
 *
 * why: https://github.com/estiva-app/estiva-docs/blob/main/decisions/a-file-is-archived-with-the-closest-archived-file-above-it.md
 */
export function archivedLine(
  archive: { with?: string } | undefined,
  noun?: string,
  options: { in?: string; to?: string } = {},
): string | undefined {
  if (!archive) return undefined
  const where = options.in?.trim() ? ` in ${options.in.trim()}` : ''
  const to = options.to?.trim() || 'comment'
  if (!archive.with) return `Archived. Unarchive it${where} to ${to}.`
  // A noun arrives as the manifest wrote it; a Folder is a proper noun in every
  // app's copy. With no noun, Peek's ArchivedNotice word.
  const word = noun?.trim()
  return `Unarchive the ${word === 'folder' ? 'Folder' : word || 'parent'}${where} to ${to}.`
}

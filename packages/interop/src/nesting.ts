/**
 * Nesting — SPEC §6.7, FOL-4 — drawn from one listing, with no requests.
 *
 * A file names its parent (`ForeignObject.parentRef`); everything a consumer
 * draws from that — which rows are at the top, what opens under a row, the
 * breadcrumb above a file, where it may be moved — is a question about the
 * whole team, and the team's listing (`resolveFolderContents`) is the only
 * read that answers it:
 *
 * - **A move is invisible from the new parent.** Re-parenting is a `kind:1851`
 *   change whose `value` is the new parent, and a relay indexes single-letter
 *   tags only. "Which files are under X?" asked with `#a: [X]` finds the files
 *   *created* under X, still finds the ones moved away, and never finds the
 *   ones moved in. The listing folds every change against every file it lists,
 *   so its `parentRef` is the current one.
 * - **A breadcrumb costs nothing.** Every ancestor of a file in the team is in
 *   the same listing — a sub-file is in its parent's team (SPEC §6.7) — so the
 *   chain is walked in memory rather than one request per level.
 *
 * A parent that is not in the listing stops the walk and is not drawn. It is
 * either in another team or something the reader cannot see, and naming it —
 * even as "unavailable" — is the disclosure `resolveFolderContents` exists to
 * avoid.
 *
 * **Cycles are broken here, not refused.** Nothing stops two people writing A
 * under B and B under A, and a relay cannot see the cycle. A file on a cycle is
 * drawn at the top and its parent link is ignored, so every file in the
 * listing stays reachable and no walk loops. A file merely *under* a cycle
 * keeps its parent.
 */

/** The three fields nesting reads. `ForeignObject` has all of them. */
export interface Nestable {
  ref: string
  address?: string
  parentRef?: string
}

export interface Nesting<T extends Nestable> {
  /** What the listing draws at the top, in listing order. */
  roots: T[]
  /** The files drawn under `file`, in listing order. Empty for a leaf. */
  childrenOf(file: T): T[]
  /**
   * The chain above `file`, outermost first, not including `file` — a
   * breadcrumb. Empty for a root.
   */
  ancestorsOf(file: T): T[]
  /** The file this one is drawn under, if any. */
  parentOf(file: T): T | undefined
  /**
   * Where `file` may be moved: every file in the listing except itself and
   * what is under it, since either would make a cycle. `undefined` in the
   * result means "the top", offered only to a file that has a parent now.
   */
  moveTargetsOf(file: T): (T | undefined)[]
}

/**
 * The nesting of one listing.
 *
 * Pure and linear in the listing: a consumer may call it on every render.
 */
export function nestingOf<T extends Nestable>(files: readonly T[]): Nesting<T> {
  const byAddress = new Map<string, T>()
  for (const file of files) if (file.address && !byAddress.has(file.address)) byAddress.set(file.address, file)

  const listedParent = (file: T): T | undefined => {
    const parent = file.parentRef ? byAddress.get(file.parentRef) : undefined
    return parent && parent.ref !== file.ref ? parent : undefined
  }

  // A file is on a cycle when following parents from it comes back to it.
  // Coloured once per file, so the whole pass is linear.
  const onCycle = new Set<string>()
  const settled = new Set<string>()
  for (const start of files) {
    const path: T[] = []
    const seen = new Map<string, number>()
    let at: T | undefined = start
    while (at && !settled.has(at.ref) && !seen.has(at.ref)) {
      seen.set(at.ref, path.length)
      path.push(at)
      at = listedParent(at)
    }
    if (at && seen.has(at.ref)) {
      for (const member of path.slice(seen.get(at.ref))) onCycle.add(member.ref)
    }
    for (const walked of path) settled.add(walked.ref)
  }

  const parentOf = (file: T): T | undefined => (onCycle.has(file.ref) ? undefined : listedParent(file))

  const children = new Map<string, T[]>()
  const roots: T[] = []
  for (const file of files) {
    const parent = parentOf(file)
    if (!parent) {
      roots.push(file)
      continue
    }
    const list = children.get(parent.ref) ?? []
    list.push(file)
    children.set(parent.ref, list)
  }

  const childrenOf = (file: T): T[] => children.get(file.ref) ?? []

  const ancestorsOf = (file: T): T[] => {
    const chain: T[] = []
    // Terminates: with cycles cut, every walk ends at a root.
    for (let at = parentOf(file); at; at = parentOf(at)) chain.unshift(at)
    return chain
  }

  const moveTargetsOf = (file: T): (T | undefined)[] => {
    const below = new Set<string>([file.ref])
    const stack = [file]
    while (stack.length) {
      for (const child of childrenOf(stack.pop() as T)) {
        if (below.has(child.ref)) continue
        below.add(child.ref)
        stack.push(child)
      }
    }
    // A target needs an address to be named by a `parent` change.
    const targets: (T | undefined)[] = files.filter((f) => f.address && !below.has(f.ref))
    return file.parentRef ? [undefined, ...targets.filter((t) => t?.address !== file.parentRef)] : targets
  }

  return { roots, childrenOf, ancestorsOf, parentOf, moveTargetsOf }
}

/**
 * Folder writes, planned — SPEC §3.3. Every app gets exactly these operations,
 * and these planners are the reference implementation: an app that does not
 * call them MUST produce the same events in the same order.
 *
 * Every change to a Folder is one or more events published in order. Where a
 * planner lists a file, it depends on one fact the relay will not check for
 * you: **whether the Folder has a `kind:30890` yet.** `handle_folder_command`
 * computes the next state from the existing one, and a group with no state has
 * none — so any `kind:1852` against it emits state listing only what that
 * command named, and everything filed there by `h` stops being listed on every
 * surface (peek#192). Nothing fails; the group just looks emptied.
 *
 * A group with no state is not a Folder (SPEC §3), and §3.3's operations are
 * not run on one. The `hasState: false` branches below are kept for §7.3's
 * `listed` rule, which still applies to an object filed in such a group: a
 * file placed or unlisted there is reached by containment and needs no
 * command.
 *
 * That is why these are here rather than in each app. Peek learned it once per
 * writer — rename, start a topic, delete a file — and its move never learned it
 * at all. Ship is the second app to write Folder commands (ADR 0002 §10).
 *
 * ## Pure, and the caller says
 *
 * Each planner returns **unsigned** events and does nothing else: each app
 * signs and publishes its own way. `hasState` is always an argument, never
 * looked up, because the caller has just read the Folder and a guess here is
 * silent loss. Nothing here reads the clock or makes an id — a new Folder's
 * uuid is the caller's.
 *
 * ## Publish in order, and stop at the first refusal
 *
 * The array is the publish order and the order is the design: each later event
 * assumes the earlier ones were accepted. What a refusal part-way through
 * *means* — "created but not listed", "added but still in the old one" — is
 * each app's to say, and the index of the refused event is enough to say it.
 *
 * ## A command never carries a name
 *
 * A Folder's title is the `name` of its `kind:39000` and only that (§3.2). The
 * relay lets only the channel's owners and admins change that, while any
 * member may send a `kind:1852` — so a name on a command would let anyone
 * retitle the Folder for every reader that believed it.
 *
 * why: https://github.com/estiva-app/estiva-docs/blob/main/decisions/folders-belong-to-the-protocol.md
 */
import {
  buildCreateChannel,
  buildDeleteChannel,
  buildEditChannelMetadata,
  buildFolderCommand,
  fileIdFormOf,
  isFileId,
  KIND,
  type ChannelVisibility,
  type UnsignedEvent,
} from '@estiva-app/protocol'

/** A Folder as a write needs it: which one, and what a read said about it. */
export interface FolderRef {
  id: string
  /** `FolderSummary.hasState` / `FolderContents.hasState`, from a read — never a guess. */
  hasState: boolean
  /**
   * `FolderSummary.private`: the Folder's relay-signed `kind:39000` carries
   * `["private"]`. Only a move *into* the Folder reads it.
   */
  private?: boolean
  /**
   * `FolderSummary.company`: the relay marks it the Company team (§3.4). Only
   * {@link planMoveFromFolders} reads it, as the home of a topic made outside
   * any team.
   */
  company?: boolean
  /**
   * `FolderSummary.addresses`: what its state lists. Only
   * {@link planMoveFromFolders} reads it, to know a source lists the moved
   * file even when the file's row did not resolve.
   */
  addresses?: readonly string[]
  /** `FolderSummary.ids`: the files its state lists by id. Read with {@link listsFile}. */
  ids?: readonly string[]
}

/**
 * Create a Folder: `[kind:9007 + name, kind:1852 add]`.
 *
 * The channel first, because a Folder *is* one (§3). Then a command listing
 * nothing, so the Folder **has state from birth** — a group without a
 * `kind:30890` is not a Folder, and a listing would never show it. Safe here
 * and nowhere else without `hasState`: the channel was created by the first
 * event, so nothing is filed in it to hide. The relay emits state for an `add`
 * with no addresses and no name.
 *
 * `folder` MUST be a uuid nobody has used. The relay answers a `kind:9007` for
 * an existing channel with `duplicate:`, which the bridge reports as accepted,
 * so a reused id would send the `add` to a group that may hold files and no
 * state — and empty it on every surface.
 */
export function planCreateFolder(
  pubkey: string,
  createdAtMs: number,
  args: { folder: string; name: string; visibility?: ChannelVisibility },
): UnsignedEvent[] {
  return [
    buildCreateChannel(pubkey, createdAtMs, {
      channelUuid: args.folder,
      name: args.name,
      ...(args.visibility ? { visibility: args.visibility } : {}),
    }),
    buildFolderCommand(pubkey, createdAtMs, { folder: args.folder, op: 'add' }),
  ]
}

/**
 * Rename a Folder: `[kind:9002]`, and nothing else.
 *
 * The title is the channel's name (§3.2), so the channel is the only home to
 * write. The relay refuses it to anybody but the channel's owners and admins.
 * A name left on an older state by a command is never shown.
 */
export function planRenameFolder(
  pubkey: string,
  createdAtMs: number,
  args: { folder: string; name: string },
): UnsignedEvent[] {
  return [buildEditChannelMetadata(pubkey, createdAtMs, { channelUuid: args.folder, name: args.name })]
}

/**
 * Delete a Folder: `[kind:9008]`.
 *
 * **For an empty Folder.** The relay refuses while the Folder holds a file —
 * a `30840`, `30842`, `30850` or `30851` under its `h`, or any address its listing
 * names — with a reason naming the count ("folder holds N file(s) … remove
 * them first"), and a consumer shows that reason. A file moved out keeps its
 * `h`, so a Folder whose listing looks empty can still refuse.
 *
 * An accepted delete hides **every** event under the `h`, its conversation
 * included, for good. Archive ({@link planArchiveFolder}) is the reversible way
 * to put a Folder away. Folders never nest, so there is no container to unlist
 * it from.
 */
export function planDeleteFolder(pubkey: string, createdAtMs: number, args: { folder: string }): UnsignedEvent[] {
  if (!args.folder) throw new Error('a team delete names the team')
  return [buildDeleteChannel(pubkey, createdAtMs, { channelUuid: args.folder })]
}

/**
 * List a file that was just published into a Folder: `[kind:1852 add]` if the
 * Folder has state, otherwise nothing.
 *
 * A Folder with state lists only what its state names, so it needs the `add`.
 * A group with no state lists the file by containment the moment its `h` is
 * stored (§7.3). Publish the file first: a refused `add` then leaves a file
 * that exists and is reachable, rather than a listing that points at nothing.
 */
export function planPlaceFile(
  pubkey: string,
  createdAtMs: number,
  args: { folder: string; address: string; hasState: boolean; inOrder?: readonly string[] },
): UnsignedEvent[] {
  if (!args.hasState) return []
  return [buildFolderCommand(pubkey, createdAtMs, { folder: args.folder, op: 'add', addresses: [listedAs(args.address, args.inOrder)] })]
}

/**
 * Mark a topic one of a team's spaces, or take the mark off: one `kind:1852
 * add` naming it, with the `space` role or without it (§3.3). An `add` naming
 * an entry already listed replaces its role. Only the team's members may send
 * it; the relay refuses anyone else, and a topic another team lists.
 *
 * why: https://github.com/estiva-app/estiva-docs/blob/main/decisions/a-space-is-the-teams-own-mark-on-a-topic-it-lists.md
 */
export function planMarkSpace(
  pubkey: string,
  createdAtMs: number,
  args: { team: string; address: string; space: boolean; inOrder?: readonly string[] },
): UnsignedEvent {
  const entry = listedAs(args.address, args.inOrder)
  return buildFolderCommand(pubkey, createdAtMs, { folder: args.team, op: 'add', addresses: [entry], spaces: args.space ? [entry] : [] })
}

/**
 * How a command names a file: by its id once the relay keeps its type in
 * order (`RelayFileReads.inOrder`, §3.3 "lists by `o` once every app reading
 * the Folder reads both"), else by its address.
 */
function listedAs(address: string, inOrder: readonly string[] = []): string {
  return fileIdFormOf(inOrder, address)?.id ?? address
}

/**
 * Unlist a file that was just deleted from a Folder: `[kind:1852 remove]` if
 * the Folder has state, otherwise nothing.
 *
 * {@link planPlaceFile} in reverse. A Folder with state lists what it names,
 * deleted or not, so the row would stay pointing at nothing; a group read by
 * containment stops listing the file once the relay hides it. Delete first: a
 * refused `remove` then leaves a stale row, where the other order would unlist
 * a file the relay kept.
 */
export function planUnlistFile(
  pubkey: string,
  createdAtMs: number,
  args: { folder: string; address: string; hasState: boolean; inOrder?: readonly string[] },
): UnsignedEvent[] {
  if (!args.hasState) return []
  return [buildFolderCommand(pubkey, createdAtMs, { folder: args.folder, op: 'remove', addresses: [listedAs(args.address, args.inOrder)] })]
}

/**
 * Archive a Folder, or restore it: `[kind:1851 archived]` — FOL-46, SPEC §3.3.
 *
 * **Not a Folder command.** A Folder is archived the way any file is: a change
 * setting `archived` on its address — its channel's, `FolderSummary.channel` —
 * to `'true'`, or to an empty value to restore it. Its state, its contents and
 * its channel are untouched, which is what makes it reversible: a `kind:9008`
 * hides everything under the Folder's `h` for good, and a `kind:1852` would
 * unlist a file from somewhere a person would have to remember.
 *
 * **Always in the Folder's own `h`**, and readers count it only from an owner
 * or admin on the Folder's `kind:39001` (§3.2) — the people who may rename it.
 * So offer Archive only to them (`FolderSummary.admins`): from anybody else the
 * relay accepts the event and every reader ignores it.
 *
 * `resolution` is what the person archiving said about it, carried as the
 * change's `content`; readers show it first when the archived Folder is
 * opened. Restoring takes none.
 */
export function planArchiveFolder(
  pubkey: string,
  createdAtMs: number,
  args: { folder: string; channel: string; archived: boolean; resolution?: string },
): UnsignedEvent[] {
  return [
    {
      pubkey,
      created_at: Math.floor(createdAtMs / 1000),
      kind: 1851,
      // `buildActionEvent`'s order for a change, so the two writers of the one
      // shape produce the same tags.
      tags: [
        ['a', args.channel],
        // The file it is about, by its id (§6.2).
        ...(identifierOf(args.channel) !== undefined ? [['O', identifierOf(args.channel)!]] : []),
        ['field', 'archived'],
        ['value', args.archived ? 'true' : ''],
        ['h', args.folder],
        ['ts', String(createdAtMs)],
      ],
      content: args.archived ? (args.resolution ?? '') : '',
    },
  ]
}

/** The file's id, the `d` of an address `<kind>:<pubkey>:<d>`; undefined for anything else. */
export function identifierOf(address: string): string | undefined {
  return /^\d+:[0-9a-f]{64}:([^]*)$/.exec(address)?.[1]
}

/**
 * A Folder state's entries (SPEC §3.3), each file once, at its first entry: an
 * `a` by its address, an `o` by its id. A file's address and its id are one
 * entry only when the address is the full address of the file holding the id
 * (its kind, its first record's author, the id), so an `o` and an `a` with
 * that `d` fold into the first of them only then.
 *
 * `holders` is each id's address as a reader resolved it (`addressesOfIds` in
 * projection): an `a` folds with an `o` only when it is that address, so one
 * with another kind or author is drawn beside the file. A reader that has
 * not resolved them passes an empty map, which folds nothing: both entries
 * stay, as §3.3 says of a reader that cannot tell.
 */
export function listedEntriesOf(
  state: { tags: string[][] },
  holders: ReadonlyMap<string, string>,
): { addresses: string[]; ids: string[]; order: string[] } {
  const addresses: string[] = []
  const ids: string[] = []
  const order: string[] = []
  const seenAddress = new Set<string>()
  const seenId = new Set<string>()
  const idsOfAddresses = new Set<string>()
  const holds = (address: string, id: string) => holders.get(id)?.toLowerCase() === address.toLowerCase()
  for (const [name, value] of state.tags) {
    if (!value) continue
    if (name === 'a') {
      const id = identifierOf(value)
      const folded = id !== undefined && seenId.has(id) && holds(value, id)
      if (seenAddress.has(value) || folded) continue
      seenAddress.add(value)
      if (id !== undefined && holds(value, id)) idsOfAddresses.add(id)
      addresses.push(value)
      order.push(value)
    } else if (name === 'o') {
      // An `o` is a file's id; any other value names no file (§3.3).
      if (!isFileId(value) || seenId.has(value) || idsOfAddresses.has(value)) continue
      seenId.add(value)
      ids.push(value)
      order.push(value)
    }
  }
  return { addresses, ids, order }
}

/**
 * Whether a Folder lists the file at `address`, by its address or by its id
 * (`FolderSummary.addresses` and `.ids`, SPEC §3.3).
 */
export function listsFile(folder: { addresses?: readonly string[]; ids?: readonly string[] }, address: string): boolean {
  if (folder.addresses?.includes(address)) return true
  const id = identifierOf(address)
  return id !== undefined && !!folder.ids?.includes(id)
}

/**
 * A file as a move needs it. A `ForeignObject` from `resolveFolderContents` is
 * one: `ref` is its identity, `parentRef` the file it is drawn beneath, and
 * `scopedTo` the `h` of its root — absent for a root placed by `buzz-channel`,
 * which the relay stores globally. Not `folder`, which since LTX-4 also reads
 * `buzz-channel`: that is where writes go, not who can read the root.
 */
export interface MovableFile {
  ref: string
  address?: string
  parentRef?: string
  scopedTo?: string
}

/**
 * Why a move was refused. The source is checked first: no choice of target
 * fixes it, so a consumer can stop offering Move for that file at all.
 *
 * `target-is-private`: the target's `kind:39000` is private and a moved file's
 * `h` names any other channel, or none. A listing never changes who can read a
 * file (§3.1), so the file would look private in the target and not be.
 *
 * `target-is-not-home`: a topic no team lists goes only to its home, the team
 * its `h` names or else the Company team (§3.3).
 */
export type MoveRefusal = 'source-has-no-state' | 'target-has-no-state' | 'target-is-private' | 'target-is-not-home'

export type MovePlan =
  | {
      ok: true
      events: UnsignedEvent[]
      /** The addresses the plan moves — the file, when the source lists it, and every file listed beneath it. */
      moved: string[]
    }
  | { ok: false; reason: MoveRefusal }

/**
 * The files `listing` draws beneath `file`, at any depth, in listing order.
 *
 * Walked by `parentRef` — the bare file's folded `parent` (§6.7) and every
 * other kind's declared children (§7.2) alike. A file on a cycle is drawn at
 * the top (§6.7), so nothing is beneath it through the cycle: two files each
 * moved under the other are neither's sub-file.
 */
export function listedBeneath<T extends MovableFile>(listing: readonly T[], file: Pick<MovableFile, 'ref' | 'parentRef'>): T[] {
  const byRef = new Map(listing.map((candidate) => [candidate.ref, candidate]))
  const cycles = new Map<string, boolean>()
  const onCycle = (ref: string) => {
    let found = cycles.get(ref)
    if (found !== undefined) return found
    found = false
    const seen = new Set<string>()
    for (let at = byRef.get(ref)?.parentRef; at && !seen.has(at); at = byRef.get(at)?.parentRef) {
      if (at === ref) {
        found = true
        break
      }
      seen.add(at)
    }
    cycles.set(ref, found)
    return found
  }
  // Up from `candidate` until `file`; a file on a cycle is at the top, so the walk ends there.
  const isBeneath = (candidate: MovableFile) => {
    if (onCycle(candidate.ref)) return false
    const seen = new Set<string>()
    for (let at = candidate.parentRef; at && !seen.has(at); at = byRef.get(at)?.parentRef) {
      if (at === file.ref) return true
      if (onCycle(at)) return false
      seen.add(at)
    }
    return false
  }
  return listing.filter((candidate) => candidate.ref !== file.ref && isBeneath(candidate))
}

/**
 * Move a file to another Folder, with everything listed beneath it: one
 * `kind:1852 move` in the target naming the source in `from` — SPEC §3.3.
 *
 * **One command, naming the whole set.** `listing` is the source Folder's
 * files (`FolderContents.files`); the file moves with every file listed
 * beneath it ({@link listedBeneath}), so a subtree moves whole. The file
 * itself is moved only when the source lists it — a Ship issue is listed by
 * no Folder, its project is. The file's `h` does not change.
 *
 * `listing` is required, and `null` says "nothing can be listed beneath this
 * file", making the file the whole set. A move that silently left its
 * sub-files behind is the bug this planner exists to end, so omitting the
 * listing is a type error rather than a quiet single-file move.
 *
 * **Both lists or neither.** The relay changes the source's and the target's
 * list in one write, after checking the mover may change each; refused,
 * nothing has changed, so a topic is never on no list (record
 * a-topic-always-has-a-team-and-moves-in-one-action).
 *
 * **Refused unless both Folders have state.** The relay refuses a move
 * between Folders that do not both hold a listing.
 *
 * **Refused into a private Folder** when any moved file's `h` is another
 * channel or absent (`target-is-private`, §3.1).
 *
 * A move to the same Folder, or of a set the source does not list, plans nothing.
 *
 * **A space's mark does not travel.** The target's entry for the file carries
 * the `space` role only with `keepSpace` — the mover ticked "Keep it a space
 * in <team>" — and only the file itself, never one listed beneath it (§3.3).
 *
 * why: https://github.com/estiva-app/estiva-docs/blob/main/decisions/moving-a-file-never-changes-who-can-read-it.md
 * why: https://github.com/estiva-app/estiva-docs/blob/main/decisions/a-topic-always-has-a-team-and-moves-in-one-action.md
 * why: https://github.com/estiva-app/estiva-docs/blob/main/decisions/a-space-is-the-teams-own-mark-on-a-topic-it-lists.md
 */
export function planMoveFile(
  pubkey: string,
  createdAtMs: number,
  args: { file: MovableFile; from: FolderRef; to: FolderRef; listing: readonly MovableFile[] | null; keepSpace?: boolean },
): MovePlan {
  if (args.from.id === args.to.id) return { ok: true, events: [], moved: [] }
  if (!args.from.hasState) return { ok: false, reason: 'source-has-no-state' }
  if (!args.to.hasState) return { ok: false, reason: 'target-has-no-state' }
  const { file, listing } = args
  // The listing's own entry when it has one, so the walk goes by the refs the listing's children name.
  const listed = listing?.find((candidate) => candidate.ref === file.ref || (!!file.address && candidate.address === file.address))
  const set = listing ? [...(listed ? [listed] : []), ...listedBeneath(listing, listed ?? file)] : [file]
  const moving = set.filter((candidate) => candidate.address)
  if (args.to.private && moving.some((candidate) => candidate.scopedTo !== args.to.id)) return { ok: false, reason: 'target-is-private' }
  const moved = [...new Set(moving.map((candidate) => candidate.address!))]
  if (!moved.length) return { ok: true, events: [], moved }
  const kept = args.keepSpace && file.address && moved.includes(file.address) ? [file.address] : []
  return {
    ok: true,
    events: [buildFolderCommand(pubkey, createdAtMs, { folder: args.to.id, op: 'move', from: args.from.id, addresses: moved, spaces: kept })],
    moved,
  }
}

export type MoveFromFoldersPlan =
  | {
      ok: true
      /**
       * The commands to publish, in order, stopping at the first the relay
       * refuses: a `kind:1852 move` from each source that lists part of the
       * set, or one `add` when no source lists any of it. Empty when there is
       * nothing to send.
       */
      events: UnsignedEvent[]
      /** Every address the commands put in the target. */
      moved: string[]
    }
  | { ok: false; reason: MoveRefusal }

/**
 * Move a file out of every Folder that lists it, with everything listed
 * beneath it in each: one `kind:1852 move` from each source into the target
 * — SPEC §3.3.
 *
 * {@link planMoveFile} for each source, and what every consumer did around it
 * (Ship's "Move to Folder…", Peek's Move, the agent's `move-project`), so it is
 * done once:
 *
 * - **One move per source.** A file two Folders list can have a different set
 *   beneath it in each; each move names what its source lists. Each changes
 *   both of its lists or neither, so no step leaves the file on no list, and a
 *   refusal halfway leaves it where the earlier moves put it (in the target
 *   and the sources not yet moved from), which moving again finishes.
 * - **The file is in a source whose state names it** (`from[i].addresses`),
 *   even when its row is missing from that source's listing. A row that did
 *   not resolve is still what is being moved.
 * - **Placed, when no source lists any of it.** The file is listed nowhere, or
 *   only by containment in a Folder with state, so it is added to the target
 *   alone, as {@link planPlaceFile} does. Into a private Folder that is
 *   refused unless the file's `h` is that Folder. A project's root carries no
 *   `h`, so a project is always refused. A file no Folder should list itself (a
 *   Ship issue is listed by its project) is then added too, so only call this
 *   for one when something is listed beneath it.
 *
 * `from` is every Folder that lists the file now. The target is ignored if it
 * is one of them, and a file that is already there and nowhere else plans
 * nothing. `listings` holds each source's files (`FolderContents.files`). Read
 * them with `includeArchived`, or an archived file beneath this one stays
 * behind. A source with no entry moves the file alone.
 *
 * Refusals are {@link planMoveFile}'s, and nothing is planned if any source is
 * refused.
 */
export function planMoveFromFolders(
  pubkey: string,
  createdAtMs: number,
  args: {
    file: MovableFile
    from: readonly FolderRef[]
    to: FolderRef
    listings: ReadonlyMap<string, readonly MovableFile[] | null>
    /** The mover ticked "Keep it a space in <team>": the target's entry for the file carries the `space` role ({@link planMoveFile}). */
    keepSpace?: boolean
  },
): MoveFromFoldersPlan {
  const { file, to } = args
  const sources = args.from.filter((folder) => folder.id !== to.id)
  if (sources.length === 0 && args.from.length > 0) return { ok: true, events: [], moved: [] }
  const events: UnsignedEvent[] = []
  const moved = new Set<string>()
  for (const from of sources) {
    const listing = args.listings.get(from.id) ?? null
    const unresolved =
      !!listing && !!file.address && listsFile(from, file.address) && !listing.some((candidate) => candidate.address === file.address)
    const plan = planMoveFile(pubkey, createdAtMs, {
      file,
      from,
      to,
      // By its address, so the walk finds what the listing draws beneath it.
      listing: unresolved ? [{ ...file, ref: file.address! }, ...listing] : listing,
      keepSpace: args.keepSpace,
    })
    if (!plan.ok) return plan
    for (const address of plan.moved) moved.add(address)
    events.push(...plan.events)
  }
  if (!to.hasState) return { ok: false, reason: 'target-has-no-state' }
  if (moved.size === 0) {
    if (to.private && file.scopedTo !== to.id) return { ok: false, reason: 'target-is-private' }
    if (!file.address) return { ok: true, events: [], moved: [] }
    // A topic on no list goes home: its `h` team, or the Company team when its `h` is no team. Which `h`
    // is a team is the relay's to know, so the Company team is let through here and the relay decides.
    if (file.address.startsWith(`${KIND.FILE}:`) &&file.scopedTo !== to.id && !to.company) return { ok: false, reason: 'target-is-not-home' }
    return { ok: true, events: planPlaceFile(pubkey, createdAtMs, { folder: to.id, address: file.address, hasState: true }), moved: [file.address] }
  }
  return { ok: true, events, moved: [...moved] }
}

/**
 * What a refusal of `events[index]` from {@link planMoveFromFolders} means,
 * so an app says it in its own words and never shows the relay's text.
 *
 * - `why`: `team-archived` (a team it leaves or enters is archived),
 *   `not-a-member` (moving a space needs a member of each team it changes:
 *   the team it leaves refuses with "only the team's members…", the team it
 *   enters with "not a channel member"),
 *   `changed-meanwhile` (a list changed since it was read: the team no longer
 *   lists it, or another team now does), or `refused`.
 * - `nothingMoved`: the first command was refused, so nothing changed.
 * - `notMovedFrom`: otherwise, the Folders that still list it besides the
 *   target — the refused command's `from` and every later one's.
 */
export function readMoveRefusal(
  events: readonly UnsignedEvent[],
  index: number,
  reason: string | undefined,
): { why: 'team-archived' | 'not-a-member' | 'changed-meanwhile' | 'refused'; nothingMoved: boolean; notMovedFrom: string[] } {
  const text = reason ?? ''
  const why = /archived/i.test(text)
    ? 'team-archived'
    : /only the team's members|not a channel member/i.test(text)
      ? 'not-a-member'
      : /does not list|lists none of|listed by one team/i.test(text)
        ? 'changed-meanwhile'
        : 'refused'
  const nothingMoved = index <= 0
  const notMovedFrom = nothingMoved
    ? []
    : events.slice(index).flatMap((event) => event.tags.filter((tag) => tag[0] === 'from').map((tag) => tag[1]!))
  return { why, nothingMoved, notMovedFrom }
}

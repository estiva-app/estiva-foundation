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
 */
import {
  buildCreateChannel,
  buildDeleteChannel,
  buildEditChannelMetadata,
  buildFolderCommand,
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
 * a `30840`, `30850` or `30851` under its `h`, or any address its listing
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
  if (!args.folder) throw new Error('a Folder delete names the Folder')
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
  args: { folder: string; address: string; hasState: boolean },
): UnsignedEvent[] {
  if (!args.hasState) return []
  return [buildFolderCommand(pubkey, createdAtMs, { folder: args.folder, op: 'add', addresses: [args.address] })]
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
  args: { folder: string; address: string; hasState: boolean },
): UnsignedEvent[] {
  if (!args.hasState) return []
  return [buildFolderCommand(pubkey, createdAtMs, { folder: args.folder, op: 'remove', addresses: [args.address] })]
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
        ['field', 'archived'],
        ['value', args.archived ? 'true' : ''],
        ['h', args.folder],
        ['ts', String(createdAtMs)],
      ],
      content: args.archived ? (args.resolution ?? '') : '',
    },
  ]
}

/**
 * A file as a move needs it. A `ForeignObject` from `resolveFolderContents` is
 * one: `ref` is its identity, `parentRef` the file it is drawn beneath, and
 * `folder` the `h` of its root — absent for a root placed by `buzz-channel`.
 */
export interface MovableFile {
  ref: string
  address?: string
  parentRef?: string
  folder?: string
}

/**
 * Why a move was refused. The source is checked first: no choice of target
 * fixes it, so a consumer can stop offering Move for that file at all.
 *
 * `target-is-private`: the target's `kind:39000` is private and a moved file's
 * `h` names any other channel, or none. A listing never changes who can read a
 * file (§3.1), so the file would look private in the target and not be.
 */
export type MoveRefusal = 'source-has-no-state' | 'target-has-no-state' | 'target-is-private'

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
  const onCycle = (ref: string) => {
    const seen = new Set<string>()
    for (let at = byRef.get(ref)?.parentRef; at && !seen.has(at); at = byRef.get(at)?.parentRef) {
      if (at === ref) return true
      seen.add(at)
    }
    return false
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
 * Move a file to another Folder, with everything listed beneath it:
 * `[kind:1852 add to target, kind:1852 remove from source]` — SPEC §3.3.
 *
 * **One command each way, naming the whole set.** `listing` is the source
 * Folder's files (`FolderContents.files`); the file moves with every file
 * listed beneath it ({@link listedBeneath}), so a subtree moves whole. The
 * relay applies every address on a command in one state write, so a failure
 * can never split the subtree between the two Folders. The file itself is
 * moved only when the source lists it — a Ship issue is listed by no Folder,
 * its project is — and without a `listing`, the file is the whole set. The
 * file's `h` does not change.
 *
 * **Add first.** There is no atomic move — state is per Folder — so something
 * can fail between the two. After the add, a failure leaves the set in both
 * Folders: visible, obviously wrong, fixed by moving again. Removing first and
 * failing would leave it in neither, which looks like files that never were.
 *
 * **Refused unless both Folders have state.** An `add` to a Folder with none
 * emits state listing only the moved files, and everything already filed in
 * it disappears; a `remove` from one emits state listing nothing, and the
 * whole source disappears.
 *
 * **Refused into a private Folder** when any moved file's `h` is another
 * channel or absent (`target-is-private`, §3.1).
 *
 * A move to the same Folder, or of a set the source does not list, plans nothing.
 */
export function planMoveFile(
  pubkey: string,
  createdAtMs: number,
  args: { file: MovableFile; from: FolderRef; to: FolderRef; listing?: readonly MovableFile[] },
): MovePlan {
  if (args.from.id === args.to.id) return { ok: true, events: [], moved: [] }
  if (!args.from.hasState) return { ok: false, reason: 'source-has-no-state' }
  if (!args.to.hasState) return { ok: false, reason: 'target-has-no-state' }
  const { file, listing } = args
  const set = listing
    ? [
        ...listing.filter((candidate) => candidate.ref === file.ref || (!!file.address && candidate.address === file.address)).slice(0, 1),
        ...listedBeneath(listing, file),
      ]
    : [file]
  const moving = set.filter((candidate) => candidate.address)
  if (args.to.private && moving.some((candidate) => candidate.folder !== args.to.id)) return { ok: false, reason: 'target-is-private' }
  const moved = [...new Set(moving.map((candidate) => candidate.address!))]
  if (!moved.length) return { ok: true, events: [], moved }
  return {
    ok: true,
    events: [
      buildFolderCommand(pubkey, createdAtMs, { folder: args.to.id, op: 'add', addresses: moved }),
      buildFolderCommand(pubkey, createdAtMs, { folder: args.from.id, op: 'remove', addresses: moved }),
    ],
    moved,
  }
}

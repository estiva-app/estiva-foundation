/**
 * Folder writes, planned — RFC 0.4 §4, FOL-4.
 *
 * Every change to a Folder is one or more events published in order, and which
 * events depends on one fact the relay will not check for you: **whether the
 * Folder has a `kind:30890` yet.** `handle_folder_command` computes the next
 * state from the existing one, and a Folder with no state has none — so any
 * `kind:1852` against it emits state listing only what that command named, and
 * everything filed in the Folder by `h` stops being listed on every surface
 * (peek#192). Nothing fails; the Folder just looks emptied.
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
 */
import {
  buildCreateChannel,
  buildEditChannelMetadata,
  buildFolderCommand,
  type ChannelVisibility,
  type UnsignedEvent,
} from '@estiva-app/protocol'

/** A Folder as a write needs it: which one, and whether the relay holds state for it. */
export interface FolderRef {
  id: string
  /** `FolderSummary.hasState` / `FolderContents.hasState`, from a read — never a guess. */
  hasState: boolean
}

/**
 * Create a Folder: `[kind:9007, kind:1852 add + name]`.
 *
 * The channel first, because a Folder *is* one (RFC 0.4 §4.1). Then a command
 * naming it and listing nothing, so the Folder **has state from birth** — a
 * listing that shows only Folders with state would otherwise never show it,
 * and a stateless Folder is indistinguishable from a bare channel. Safe here
 * and nowhere else without `hasState`: the channel was created by the first
 * event, so nothing is filed in it to hide.
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
    buildFolderCommand(pubkey, createdAtMs, { folder: args.folder, op: 'add', name: args.name }),
  ]
}

/**
 * Rename a Folder: `[kind:9002, kind:1852 add + name if it has state]`.
 *
 * **A Folder's name has two homes** and the state's shadows the channel's, so
 * writing only the channel leaves the old name wherever the state is read. The
 * command is `add` with no addresses — the contents are kept and only the name
 * changes; `set` would empty it and there is no `rename` op. With no state
 * there is only the channel to rename, and a command would empty the Folder.
 */
export function planRenameFolder(
  pubkey: string,
  createdAtMs: number,
  args: { folder: string; name: string; hasState: boolean },
): UnsignedEvent[] {
  const rename = buildEditChannelMetadata(pubkey, createdAtMs, { channelUuid: args.folder, name: args.name })
  if (!args.hasState) return [rename]
  return [rename, buildFolderCommand(pubkey, createdAtMs, { folder: args.folder, op: 'add', name: args.name })]
}

/**
 * List a file that was just published into a Folder: `[kind:1852 add]` if the
 * Folder has state, otherwise nothing.
 *
 * A Folder read by containment lists the file the moment its `h` is stored. A
 * Folder with state lists only what its state names, so it needs the `add`.
 * Publish the file first: a refused `add` then leaves a file that exists and
 * is reachable, rather than a listing that points at nothing.
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
 * deleted or not, so the row would stay pointing at nothing; a Folder read by
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
 * Why a move was refused. The source is checked first: no choice of target
 * fixes it, so a consumer can stop offering Move for that file at all.
 */
export type MoveRefusal = 'source-has-no-state' | 'target-has-no-state'

export type MovePlan = { ok: true; events: UnsignedEvent[] } | { ok: false; reason: MoveRefusal }

/**
 * Move a file between Folders: `[kind:1852 add to target, kind:1852 remove from source]`.
 *
 * **Add first.** There is no atomic move — state is per Folder — so something
 * can fail between the two. After the add, a failure leaves the file in both
 * Folders: visible, obviously wrong, fixed by moving again. Removing first and
 * failing would leave it in neither, which looks like a file that never was.
 *
 * **Refused unless both Folders have state.** An `add` to a Folder with none
 * emits state listing only the moved file, and everything already filed in it
 * disappears; a `remove` from one emits state listing nothing, and the whole
 * source disappears. Writing a complete state first is not offered here: what
 * a stateless Folder holds is whatever its `h` implies to *this* reader, and a
 * planner that enumerated it would be deciding on everyone's behalf.
 *
 * A move to the same Folder plans nothing.
 */
export function planMoveFile(
  pubkey: string,
  createdAtMs: number,
  args: { address: string; from: FolderRef; to: FolderRef },
): MovePlan {
  if (args.from.id === args.to.id) return { ok: true, events: [] }
  if (!args.from.hasState) return { ok: false, reason: 'source-has-no-state' }
  if (!args.to.hasState) return { ok: false, reason: 'target-has-no-state' }
  return {
    ok: true,
    events: [
      buildFolderCommand(pubkey, createdAtMs, { folder: args.to.id, op: 'add', addresses: [args.address] }),
      buildFolderCommand(pubkey, createdAtMs, { folder: args.from.id, op: 'remove', addresses: [args.address] }),
    ],
  }
}

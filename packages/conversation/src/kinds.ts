/**
 * The kinds a conversation is made of. Numbers from the protocol, named here
 * so every module reads the same one.
 */
import { KIND } from '@estiva-app/protocol'

/** A message in a channel — chat (SPEC §6.4, §6.7). */
export const KIND_MESSAGE = KIND.STREAM_MESSAGE
/** A NIP-22 comment on an object, and a reply to one (§6.4). */
export const KIND_COMMENT = KIND.COMMENT
/** An edit of a message or comment (§6.8). */
export const KIND_EDIT = KIND.MESSAGE_EDIT
/** A NIP-25 reaction (§6.6). */
export const KIND_REACTION = KIND.REACTION
/** A NIP-09 deletion request (§6.5). */
export const KIND_DELETION = KIND.DELETION
/** An assertion; with `t=resolution` it resolves or reopens a comment (PEEK-128). */
export const KIND_ASSERTION = KIND.ASSERTION

/** A field change (SPEC §6.2). Not in protocol's `KIND`; the number is the SPEC's. */
export const KIND_CHANGE = 1851
/** NIP-78 app data: read state (§11.6) and app-private storage (§12). */
export const KIND_APP_DATA = KIND.APP_DATA

/** A Folder's channel id: a lowercase UUID v4. */
export const FOLDER_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/
/** A file's address, `<kind>:<pubkey>:<d>`: kind 30000–39999, 64 lowercase hex, `d` verbatim and without whitespace. */
export const FILE_ADDRESS = /^3[0-9]{4}:[0-9a-f]{64}:[^\s]*$/

/** Whether the event is a message or a comment — what a conversation lists. */
export const isConversationKind = (kind: number): boolean => kind === KIND_MESSAGE || kind === KIND_COMMENT

/** A 64-hex event id. */
export const isEventId = (value: unknown): value is string => typeof value === 'string' && /^[0-9a-fA-F]{64}$/.test(value)

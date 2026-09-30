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

/** Whether the event is a message or a comment — what a conversation lists. */
export const isConversationKind = (kind: number): boolean => kind === KIND_MESSAGE || kind === KIND_COMMENT

/** A 64-hex event id. */
export const isEventId = (value: unknown): value is string => typeof value === 'string' && /^[0-9a-fA-F]{64}$/.test(value)

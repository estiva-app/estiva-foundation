/**
 * `@estiva-app/conversation` — the conversation rules of SPEC §6.2–§6.8, for
 * an app that would rather not implement them itself.
 *
 * **A convenience, never a requirement.** SPEC §9's C10–C16 are written so an
 * app can build conversations from the specification alone, and this
 * package's tests are those checks. If this package became the only place
 * that knows how commenting works, a defect in its fold would be a defect in
 * every app at once and invisible from all of them.
 *
 * It sits above `@estiva-app/protocol`, which carries no fold, and below the
 * apps: it imports no app's data layer, opens no socket, and takes every
 * environment touch — the relay read, the clock, storage — as a parameter.
 */
export const CONVERSATION_VERSION = '0.1.0'

export {
  KIND_MESSAGE,
  KIND_COMMENT,
  KIND_EDIT,
  KIND_REACTION,
  KIND_DELETION,
  KIND_ASSERTION,
  isConversationKind,
  isEventId,
} from './kinds.js'

export { trustedTs, orderingMs, byOrder } from './order.js'

export {
  namedInBody,
  isReply,
  anchorsOf,
  isCommentOn,
  referencesAddress,
  strengthOn,
  threadStrength,
  referenceTagsFor,
  mentionTagsFor,
  MAX_MENTIONED_PEOPLE,
  type Strength,
} from './strength.js'

export { parentOf, groupThreads, type Threaded } from './threads.js'

export { editTargetOf, editsByTarget, foldEdits, foldAttachments, type EditFold } from './edits.js'

export {
  REACTION_HORIZON,
  REACTION_EMOJI,
  reactionTargetOf,
  reactionEmojiOf,
  reactionHorizon,
  reactionEventsOf,
  foldReactions,
  groupReactions,
  type ReactionHorizon,
  type ReactionEvent,
  type Reaction,
} from './reactions.js'

export { decorationsOf, type Decoration, type Decorations, type Resolution, type QueryFn } from './decorations.js'

export { buildComment, buildReply, offersEditAndDelete, type CommentRef } from './builders.js'

export {
  createDraftStore,
  draftKeys,
  NO_DRAFTS,
  DRAFT_MAX_AGE_MS,
  DRAFT_MAX_CHARS,
  type DraftStore,
  type DraftStorage,
} from './drafts.js'

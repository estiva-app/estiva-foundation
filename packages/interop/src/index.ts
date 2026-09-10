/**
 * `@estiva-app/interop` — render and act on another app's objects.
 *
 * An app publishes a NIP-89 `kind:31990` manifest saying how its objects should
 * be projected: which slots matter, what its statuses mean, what another app
 * may do to them. This resolves that manifest and hands a consumer something it
 * can draw, **without the consumer knowing anything about the owning app**.
 *
 * The governing rule, and the reason the package is small:
 * **the owner defines the projection, the consumer decides how it looks.**
 * Nothing here returns layout, and nothing here should ever grow a rule about a
 * particular app.
 *
 * ## What is not here, deliberately
 *
 * **No fold.** Manifest semantics are normative; an app's interpretation of its
 * own records is not. `records` tells a consumer how to fold, and folding is the
 * consumer's business — see the Estiva SPEC §10 on why two apps are *supposed*
 * to be able to differ there.
 *
 * **No rendering.** Not a React dependency, not a component. Slots come back as
 * values with enough shape to draw, and every consumer draws them in its own
 * design language. A package that shipped a widget would be specifying the UI
 * of every app that installed it, which is the objection that rules out
 * iframes.
 */
export {
  resolveManifest,
  resolveForeignObject,
  resolveForeignEvent,
  resolveFolderProject,
  resolveFolderContents,
  listFolders,
  KIND_FOLDER_STATE,
  KIND_CHANNEL_METADATA,
  commentKindsOf,
  conversationCountsOf,
  CONVERSATION_LIMIT,
  buildActionEvent,
  pickWidget,
  widgetChainProblem,
  actionProblems,
  folderOf,
  MIN_ACTION_DESCRIPTION,
  CLOSED_WIDGETS,
  contentFormatOf,
  BODY_SLOT,
  CONTENT_FORMAT_TAG,
  BLOCK_DOCUMENT_FORMAT,
  type ContentFormat,
  peopleViaRelay,
  createProjectionCache,
  createPeopleCache,
  MANIFEST_TTL_MS,
  PROFILE_HIT_TTL_MS,
  PROFILE_MISS_TTL_MS,
  type PeopleCache,
  type PeopleCacheOptions,
  type ProjectionCache,
  type ResolvedManifest,
  type QueryFn,
  type PeopleFn,
  type People,
  type ForeignObject,
  type FolderProject,
  type FolderContents,
  type FolderSummary,
  type ResolvedSlot,
  type ResolvedAction,
  type ActionFormField,
  type ManifestAction,
  type ActionEffect,
  ACTION_EFFECTS,
  type UnsignedActionEvent,
} from './projection.js'

/**
 * RFC 0.5 §7's URL grammar — how an object is named in an address bar, and how
 * a pasted link is matched back to one.
 *
 * Separate from the projection surface above because it answers a different
 * question: those resolve an object you already hold, these turn a string
 * somebody pasted into one you can hold.
 */
export {
  slugify,
  objectRef,
  identifierFromRef,
  eventIdFromRef,
  urlPatternsOf,
  matchObjectUrl,
  type UrlPattern,
  type MatchedObjectUrl,
} from './objectUrl.js'

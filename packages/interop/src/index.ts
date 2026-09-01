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
  commentKindsOf,
  buildActionEvent,
  pickWidget,
  widgetChainProblem,
  CLOSED_WIDGETS,
  peopleViaRelay,
  type QueryFn,
  type PeopleFn,
  type People,
  type ForeignObject,
  type FolderProject,
  type ResolvedSlot,
  type ResolvedAction,
  type ManifestAction,
  type UnsignedActionEvent,
} from './projection.js'

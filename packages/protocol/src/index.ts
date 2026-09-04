/**
 * `@estiva-app/protocol` — the Estiva wire format, once.
 *
 * ## What is in here, and what is deliberately not
 *
 * **In:** the bytes. Event construction, the NIP-01 id preimage, NIP-19 `naddr`,
 * NIP-98 HTTP auth, Schnorr signing, and the two relay clients (the HTTP bridge
 * and the live socket). Everything whose correctness the *relay* judges.
 *
 * **Not in: the fold, or anything that interprets events.** How an app turns a
 * stream of events into current truth is where apps are supposed to differ —
 * `estiva-docs/decisions/0001` §8, and the README of this repo. Ship folds
 * issues, Peek folds conversations, and neither should inherit the other's
 * opinion. `foldFolder`, `foldResolution` and the projection all stay in their
 * apps, and each app's conformance fixture stays with it.
 *
 * That line is the one thing to hold when adding to this package. "Both apps
 * need it" is not the test; "the relay would notice if we disagreed" is.
 *
 * ## Why one implementation, when the suite's whole claim is independence
 *
 * SPEC §10 used to say the duplication *was* the architecture: three apps each
 * implementing NIP-01 serialization is what makes "apps sharing no code work on
 * the same data" a real statement. That argument was right about the *claim* and
 * wrong about the *mechanism*, and the third copy is what settled it.
 *
 * A second hand-written event-id hash is not a demonstration of independence, it
 * is a divergence the relay notices and we do not. It had already happened:
 * Peek's `buildMessage` emitted `a` tags and Ship's could not, so the same
 * logical message produced different bytes depending on which app sent it — and
 * nothing failed, because each copy was self-consistent. `diff -r` between two
 * vendored trees was the only thing holding the other two together, and it is a
 * check somebody has to remember to run.
 *
 * What makes the interop claim true is that the apps share **no interpretation
 * and no database** — which is still exactly the case. They now agree on the
 * wire format on purpose rather than by coincidence.
 *
 * ## A MAJOR here is a protocol event, not a TypeScript event
 *
 * A change to the bytes an app publishes — id computation, serialization order,
 * tag semantics, signature input — is a MAJOR even when the TypeScript signature
 * is identical (ADR 0002 §4b). Every release note answers the wire question
 * explicitly, including when the answer is "unchanged".
 */

/** Bumped by hand with the version in package.json — `test/version.test.ts`
 * pins the two together. It exists so "the upgrade reached the app" can be
 * checked by grepping a built bundle rather than by trusting a lockfile. */
export const PROTOCOL_VERSION = '0.13.0'

export {
  // types
  type NostrTag,
  type UnsignedEvent,
  type SignedEvent,
  type Profile,
  type ThreadRef,
  type ChannelVisibility,
  type ChannelKind,
  type MemberRole,
  type Label,
  type ResolutionAction,
  // constants
  KIND,
  MAX_EMOJI_CHARS,
  MAX_MESSAGE_BYTES,
  MAX_MENTIONS,
  MAX_RATIONALE_BYTES,
  RELAY_AUTH_TOLERANCE_SECS,
  ASSERTION_SUBTYPE,
  // the id preimage and the pieces that feed it
  computeEventId,
  toNostrSeconds,
  canonicalChannelName,
  threadTags,
  addr,
  relayAuthUrl,
  // builders
  buildProfile,
  parseProfile,
  buildCreateChannel,
  buildDeleteChannel,
  buildEditChannelMetadata,
  buildAddMember,
  buildReaction,
  buildDeletion,
  buildMessage,
  buildResolution,
  buildFile,
  buildComponent,
  buildHighlight,
  buildUnsignedRelayAuthEvent,
} from './events.js'

export {
  type AddressPointer,
  type EventPointer,
  encodeNevent,
  decodeNevent,
  convertBits,
  bech32Encode,
  bech32Decode,
  encodeNaddr,
  decodeNaddr,
  pointerToAddress,
  addressToPointer,
  addrToNaddr,
  naddrToAddr,
  referenceToPointer,
  NADDR_RE,
  findNaddrs,
  stripNaddrs,
  encodeNpub,
  decodeNpub,
  NOSTR_URI_RE,
  findNostrUris,
} from './nip19.js'

export {
  type AuthEventArgs,
  TIMESTAMP_TOLERANCE_SECS,
  normalizeUrl,
  buildUnsignedAuthEvent,
  base64,
  authorizationHeaderFor,
  authorizationHeader,
} from './nip98.js'

export {
  type Signer,
  type SignerKind,
  publicKeyFromSecret,
  signEvent,
  secretKeySigner,
} from './sign.js'

export {
  type PublishResult,
  type QueryResult,
  type RelayHeaders,
  type RelayOptions,
  type FetchLike,
  type QueryAllOptions,
  parsePublishResponse,
  parseQueryResponse,
  RELAY_PAGE_CEILING,
  DEFAULT_QUERY_CONCURRENCY,
  Relay,
} from './bridge.js'

export {
  type RelayState,
  type SocketLike,
  type RelayCredential,
  type LiveRelayOptions,
  type Subscription,
  type LiveRelay,
  toWebSocketUrl,
  parseFrame,
  createLiveRelay,
} from './live.js'

export {
  type ChannelEventHandler,
  type ChannelSubscription,
  type ChannelSubscriptions,
  createChannelSubscriptions,
} from './subscriptions.js'

export {
  type InlineMark,
  type InlineMarkSpan,
  type BodySegment,
  type InlineMarkNode,
  type InlineTextNode,
  parseInlineMarks,
  wrapInlineMarks,
  parseBodySegments,
  stripInlineFormatting,
  markersToInlineNodes,
  inlineNodesToMarkers,
  inlineNodesToText,
} from './content.js'

export {
  type Block,
  type BlockDocument,
  type KnownBlockType,
  KNOWN_BLOCK_TYPES,
  BlockDocumentError,
  validateBlockDocument,
  parseBlockDocument,
  serializeBlockDocument,
  newBlockId,
  assignMissingBlockIds,
  blockIds,
  findBlock,
  inlineTextOf,
  documentText,
} from './blocks.js'

export {
  type RenderInline,
  type RenderBlock,
  type RenderFormat,
  type ContentFormat,
  CONTENT_FORMAT_TAG,
  BLOCK_DOCUMENT_FORMAT,
  contentFormatOf,
  toRenderTree,
  renderTreeText,
  standaloneReference,
  referencesIn,
} from './render.js'

export {
  markerTextToBlockDocument,
  blockDocumentToMarkerText,
} from './bridge-content.js'

export {
  type BlockAnchor,
  BLOCK_ANCHOR_TAG,
  blockAnchorOf,
  resolveBlockAnchor,
} from './anchors.js'

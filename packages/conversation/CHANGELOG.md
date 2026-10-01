# @estiva-app/conversation

Every entry answers the **SPEC** question explicitly: which rule of SPEC §6 or
§9 changed how this package reads or writes, including when the answer is
none. A change to how an event is read is a MINOR in `0.x` even when no
signature moved, because two apps on different versions would then disagree
about a conversation.

## 0.2.0 — 2026-10-01

**Read state and membership** (CON-19): SPEC §11, and §11.8 as amended in
estiva-docs#201, #202 and the placement clarification of 2026-10-01. Needs
protocol 0.24.0, unchanged.

- **Membership** (`membership.ts`, §11.8): `membershipOf`, `membersOf`,
  `streamOf`, the discovery `membershipFilters` with `candidateFilesOf`, and
  `buildMembershipChange` (`kind:1851`, `member:<P>`, tags `a field value h ts
  p`). A placement is read from the change's `value` as well as its `p`, since
  most assignee changes on production carry no `p`. The private mute list
  (`estiva:muted:v1`) and the one-time `mutedFromFollowed` migration, which
  never returns a follow.
- **Read state** (`readState.ts`, §11.1–§11.6): ported from Peek and Ship.
  Where the two differed: the cap is in **bytes** (Peek; Ship capped at
  10,000 contexts, which never binds), eviction and the merged cap are
  deterministic to the tie, a coordinate holding another installation's
  `client_id` is reported, and an unreachable relay and an undecryptable own
  slot are kept apart from "no slots" (Ship). Storage, randomness, the relay,
  the signer and NIP-44 are parameters. Peek's `containerContext` is
  `channelContext` here.
- **Unread** (`unread.ts`): `unreadIn` and `isUnread`, §11.8's four
  conditions over §11.3's effective marker.
- `peopleNamedInBody`, which `mentionTagsFor` now uses.

**SPEC:** §9 C17 (membership fold) and C18 (unread for a member) are
`test/membership.test.ts`. Nothing about how a conversation is read or
written in §6 changed.

## 0.1.0 — 2026-09-30

**First release** (CON-5). Extracted from Peek (`src/nostr/fileConversation.ts`,
`src/lib/drafts.ts`), Ship (`src/nostr/edits.ts`, `reactions.ts`,
`references.ts`, `attachments.ts`, the comment builders in `events.ts`,
`src/lib/drafts.ts`) and `@estiva-app/interop` 0.39 (`commentDecorationsOf`,
`editTargetOf`, `REACTION_HORIZON`, `isCommentOn`), lined up to the SPEC as
decided in estiva-docs#178. Needs protocol 0.24.0.

Where it reads differently from one of the copies it replaces — each row is
SPEC §6.9's table, and none changes anything that exists on production:

- **`ts` is trusted only when `floor(ts / 1000) == created_at`** (§6.2).
  Peek's edit fold and interop accepted ±1 s.
- **A `kind:9` is never a comment** (§6.4, CON-20), and **a reply is never a
  root**. Ship's `anchorIndex` and interop's `isCommentOn` read a `kind:9`'s
  unnamed `a` as a comment; interop's applied per event, so a reply carrying
  `a` would have listed twice.
- **A nested chat reply files under its `root`-marked `e`** (§6.4). Peek's
  channel read dropped it.
- **Reactions** (§6.6): target is the last 64-hex `e` (Ship and interop took
  the first), the emoji is untrimmed and empty is `+` (Ship trimmed and
  skipped empty), one per `(target, pubkey, emoji)` (Peek and interop counted
  every event), and a read at the relay's page ceiling is reported
  (`reactionEventsCut`).
- **The horizon** is the newest 100 by `created_at`, ties on the higher id —
  interop's rule; Ship broke ties by thread order.
- **Edit and Delete** are offered on the viewer's own message and on a
  `bot: true` author's (§6.5, `offersEditAndDelete`).

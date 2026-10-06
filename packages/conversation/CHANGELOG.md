# @estiva-app/conversation

Every entry answers the **SPEC** question explicitly: which rule of SPEC §6 or
§9 changed how this package reads or writes, including when the answer is
none. A change to how an event is read is a MINOR in `0.x` even when no
signature moved, because two apps on different versions would then disagree
about a conversation.

## 0.10.0 — 2026-10-06

**Edit and Delete only on your own message** (SHI-29):
`offersEditAndDelete({ viewer, author })` is now viewer equals author, and
`authorIsBot` is gone. An agent's message no longer offers the controls to
every viewer: the relay accepts them only from the agent's NIP-OA owner, whom
no app can identify, so everybody else saw a control that always failed. An
unknown viewer is offered nothing.

SPEC: §6.5's 2026-09-29 rule and C14, amended 2026-10-06 — an app SHOULD NOT
offer Edit or Delete on a message the viewer did not write, an agent's
included. Nothing on the wire changes; the relay still adjudicates.

## 0.9.0 — 2026-10-06

**A restored draft keeps an urgent mention urgent** (CON-31): a draft now
keeps whom it names urgently beside its text — `write(key, text, urgent?)`
and `readDraft(key)` → `{ text, urgent? }`. The text cannot say it: an urgent
mention of somebody with a key is the same `nostr:npub…` as an ordinary one,
so a restored draft was sent without its `urgent` tag. `read` still returns
the text; a draft kept before this reads as text alone, and a malformed
`urgent` list costs the urgency, never the words.

SPEC: none. Drafts are local and never on the relay; the send writes §13.1's
existing `["urgent", <pubkey>]`, now also for a restored draft.

## 0.8.1 — 2026-10-06

**A sentence after an unmatched `[` stops asking the relay** (08d7f243):
once `referenceSearch` has an empty answer for a query, a longer query that
only adds whole words to it answers no hits without asking. Relay search is
every word with the last as a prefix, so it could not find anything. A failed
query is not an empty answer and never stops a longer one.

SPEC: none. Nothing is read or written differently; fewer searches are asked.

## 0.8.0 — 2026-10-06

**A refresh decrypts only the slots that changed** (Peek 23130326):
`fetchReadState` takes an optional caller-owned `SlotCache`
(`createSlotCache()`). A slot whose content is unchanged is not decrypted
again; one that will never decrypt is not asked again; one whose decrypt is
refused keeps the markers it last decrypted to. Our own slot is asked first,
and the first refusal ends the round's asking. `Nip44.decrypt` now means
something by how it fails: `undefined` for never, a throw for not this time.

SPEC: none. §11.3's merge is unchanged; an older blob of a slot is a subset
of what the slot now holds, so merging it is never wrong, only behind.

## 0.7.0 — 2026-10-05

**The thread rule takes effect** (CON-34): `THREAD_RULE_FROM` is `1791226800`
(2026-10-05T19:00:00Z), a second chosen to fall after Peek and Ship both run 0.7.0. A reply after it is read
only by opening its thread; one before it is still read by reading its
stream, so nothing read before the cut-over lights up again.

SPEC: §11.3's T0 is set to the same second. A minor, not the patch 0.6.0
planned: from T0 a reply is read differently, and two apps on 0.6 and 0.7
would disagree about it.

## 0.6.1 — 2026-10-05

**Typing an issue's ref after `[` finds it** (PEE-21; Miky asked for it on
CON-33). `rankReferences` scores a file on its `search` as well as its title,
the way it already scored a message on its text; interop 0.50.0 sets an
issue's `search` to its current ref. New: `refMatch`. A ref matches only from
its start, and only once what is typed has a digit or a hyphen, so `con` on
the way to "Conversation…" matches titles only (Miky, 2026-10-05). SPEC: none,
nothing read or written changed.

## 0.6.0 — 2026-10-05

**The thread rule** (CON-34, Miky 2026-10-03/05): a reply after the cut-over
is read only by opening its thread, never by reading the stream it sits in.

- `effectiveReadAt` for a `thread:` context is
  `max(merged[thread], merged["reply-floor"], min(merged[stream], THREAD_RULE_FROM))`;
  any other context keeps NIP-RS's `max(own, stream)`. `isUnread` and
  `unreadIn` judge by it; `threadReadAt` is the same rule from three loose
  markers, for an app that does not hold the merged map.
- `THREAD_RULE_FROM` ships as `MAX_TIMESTAMP`, which keeps the old stream
  term. A patch sets it to a date once Peek and Ship both run 0.6.
- The floor alone is not a frontier: with no thread or stream marker,
  `threadReadAt` is `undefined` and the absent-marker rule still decides;
  `belowReplyFloor` adds what the floor reads, and `isUnread` applies it.
- `REPLY_FLOOR_CONTEXT` (`"reply-floor"`) is a publishable context, merged by
  max. `advanceContexts` now caps through `capReadStateContexts`, which never
  evicts the floor and raises it to the newest `thread:` marker it drops, so
  no reply somebody read lights again. `capContextsToBytes` is unchanged for
  maps that are not read state.
- Only the cap raises the floor: `advanceContexts` refuses one among its
  updates. `mergeSlots` keeps it past the 10,000-context cap, raised by the
  `thread:` markers that cap drops, and takes a slot's floor as at most that
  slot's `created_at`.

SPEC: §11.1 (the floor's context), §11.3 (the rule and its divergence from
NIP-RS), §11.6 (eviction raises the floor). A MINOR: an app on 0.5 reads a
blob holding the floor without it, which is today's rule.

## 0.5.1 — 2026-10-03

**`[` never offers the file you are writing in** (PEE-21, Miky 2026-10-03):
its messages already lead Messages, and a widget pointing back at the page
you are on is no use. `rankReferences` takes `exclude`, the addresses no Files
tier offers. SPEC: none — nothing read or written changed.

## 0.5.0 — 2026-10-03

**What `[` offers, and in what order** (PEE-21, CON-26's ranking, Miky
2026-10-02/03). Needs protocol 0.24.0, unchanged.

- `rankReferences({messages, files, query, ownKinds?, caps?})` — two capped
  sections, Messages (this thread or file, then its parent) above Files (this
  Folder, then recently read, then search hits only once something is typed).
  Typed, a better title match beats a higher tier; an archived file goes after
  every other row of the same match, typed or not, and an open issue before a
  closed one; the app's own kinds break what ties are left. `REFERENCE_CAPS`
  is 4 and 6.
- `referenceMatch(text, query)` — 4 whole, 3 start, 2 word start, 1 anywhere.
- `fileReference(address)` — `nostr:naddr…` with no relay hint, the bytes a
  pasted link resolves to.
- `referenceSearch({search})` — the search tier per keystroke: debounced,
  cached, a failure answered as no hits for `retryMs` (5s) and then asked
  again, listeners told when an answer lands. `reset()` it when the signed-in
  person changes.

**SPEC:** none of §6 or §9 changes how this package reads or writes. A file
pick writes what a paste writes and earns `["a", <address>]` through
`referenceTagsFor`, as §13.1 already says; ranking is a client's choice.

## 0.4.0 — 2026-10-02

**A reference records which message it points at** (CON-25, Miky
2026-10-02). Needs protocol 0.24.0, unchanged.

- `quoteTagsFor(body, own?)` — `["q", <event id>]`, one per message the body
  references by `nostr:nevent…` or `nostr:note…`, deduplicated, leaving out
  `own`. A writer appends it to a `kind:9` or a `kind:1111` beside the `p`
  and `a` tags the body earns.
- `eventsNamedInBody` — the ids behind them.

**SPEC:** §13.1 gains the `q` rule (estiva-docs, CON-25): a `q` is an index
of what a message points at, never a reply, and a writer MUST NOT write one
for an event its body does not name. Reading is unchanged — nothing in this
package reads `q` yet.

## 0.3.0 — 2026-10-02

**What a composer's pick writes** (CON-27): SPEC §13.1, unchanged. Needs
protocol 0.24.0, unchanged.

- `mentionText` — a person as the body names them: `nostr:npub…`, or `@Name`
  (`!@Name` when urgent) for somebody with no key.
- `messageReference` — a message as `nostr:nevent…` with its kind and no
  relay hint.
- `urgentTagsFor` and `URGENT_TAG` — `["urgent", <pubkey>]`, one per urgent
  person the body names (CON-17), moved here from Peek.

The bytes are the ones Peek wrote; it takes them from here now, and
`@estiva-app/ui/editor`'s `@`, `!@` and `[` menus write through them. **SPEC:**
none changed — this is the writing half of §13.1 an app had to implement
itself.

## 0.2.0 — 2026-10-01

**Read state and membership** (CON-19): SPEC §11, and §11.8 as amended in
estiva-docs#201, #202 and the placement clarification of 2026-10-01. Needs
protocol 0.24.0, unchanged.

- **Membership** (`membership.ts`, §11.8): `membershipOf`, `membersOf`,
  `streamOf`, the discovery `membershipFilters` with `candidateFilesOf`, and
  `buildMembershipChange` (`kind:1851`, `member:<P>`, tags `a field value h ts
  p`). A placement counts by its `p` alone, and only with a non-empty `value`
  (an unassign places nobody). The creation orders before every other event
  for the file, so an edit does not re-join an author who left. The private mute list
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

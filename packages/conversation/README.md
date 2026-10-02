# @estiva-app/conversation

The conversation rules of the [Estiva SPEC](https://github.com/estiva-app/estiva-docs/blob/main/protocol/SPEC.md)
§6.2–§6.8, for an app that would rather not implement them itself. Peek, Ship
and estiva-agent read conversations through it.

**A convenience, never a requirement.** SPEC §9's conversation checks
(C10–C18) are written so an app can build conversations from the specification
alone, and this package's tests are those checks
(`test/conformance.test.ts` for C10–C16, `test/membership.test.ts` for C17 and C18). If you find this package disagreeing with the
SPEC, the package is wrong.

```bash
npm install @estiva-app/conversation @estiva-app/protocol
```

`@estiva-app/protocol` is a peer. Nothing here opens a socket, holds a
credential or touches a browser global: the relay read is a `QueryFn` you
pass, the clock is a `createdAtMs` you pass, and drafts take their storage.

## What is in it

| | SPEC | exports |
| --- | --- | --- |
| comment or mention | §6.4 | `isCommentOn`, `strengthOn`, `threadStrength`, `anchorsOf`, `isReply`, `namedInBody` |
| threading | §6.4 *Replies* | `parentOf`, `groupThreads` |
| writing | §6.4 | `buildComment`, `buildReply`, `referenceTagsFor`, `mentionTagsFor` |
| what a composer's pick writes | §13.1 | `mentionText`, `messageReference`, `urgentTagsFor`, `URGENT_TAG` |
| ordering | §6.2, §6.3 | `trustedTs`, `orderingMs`, `byOrder` |
| edits and attachments | §6.8 | `editTargetOf`, `foldEdits`, `foldAttachments` |
| reactions | §6.6 | `REACTION_HORIZON`, `reactionHorizon`, `reactionTargetOf`, `reactionEmojiOf`, `foldReactions` |
| one read for all of the above | §6.6, §6.8 | `decorationsOf` |
| which controls to offer | §6.5 | `offersEditAndDelete` |
| drafts | — | `createDraftStore`, `draftKeys` |
| membership | §11.8 | `membershipOf`, `membersOf`, `streamOf`, `membershipFilters`, `candidateFilesOf`, `buildMembershipChange` |
| muting | §11.8 | `parseMutedBlob`, `serializeMutedBlob`, `buildMutedEvent`, `mutedFilter`, `mutedFromFollowed` |
| read state | §11.1–§11.6 | `channelContext`, `fileContext`, `threadContext`, `loadSlotIdentity`, `advanceContexts`, `fetchReadState`, `publishReadState`, `mergeSlots`, `effectiveReadAt` |
| unread | §11.3, §11.8 | `unreadIn`, `isUnread` |

Chat, an edit, a reaction and a deletion are built with
`@estiva-app/protocol`'s `buildMessage`, `buildEdit`, `buildReaction` and
`buildDeletion`.

Read state takes its environment like the rest: slot storage and randomness
(`loadSlotIdentity`), the relay query, the signer and NIP-44 (`fetchReadState`,
`publishReadState`). When to write — the debounce, the dwell before a view
counts as read — stays the app's.

**Light a dot from the files you already load, not from discovery alone.** A
file's membership comes from `membershipOf` over that file's own events, which
an app already holds for any file it shows. `membershipFilters` is for listing
"your files", and a busy person's results are cut short by the relay's limit
(each filter returned 2,000 events for one person in 90 days on 2026-10-01). A
dot built only on discovery would miss a file the limit dropped.

## What is not in it

The views (CON-18), the composer's editor and its `@`, `!@`, `[` and `/`
menus (`@estiva-app/ui/editor`, which writes through `mentionText` and
`messageReference` above), a Folder's roster (the relay's
`kind:39002`), and anything only one app needs.

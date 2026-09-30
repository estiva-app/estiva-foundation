# @estiva-app/conversation

The conversation rules of the [Estiva SPEC](https://github.com/estiva-app/estiva-docs/blob/main/protocol/SPEC.md)
§6.2–§6.8, for an app that would rather not implement them itself. Peek, Ship
and estiva-agent read conversations through it.

**A convenience, never a requirement.** SPEC §9's conversation checks
(C10–C16) are written so an app can build conversations from the specification
alone, and this package's tests are those checks
(`test/conformance.test.ts`). If you find this package disagreeing with the
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
| ordering | §6.2, §6.3 | `trustedTs`, `orderingMs`, `byOrder` |
| edits and attachments | §6.8 | `editTargetOf`, `foldEdits`, `foldAttachments` |
| reactions | §6.6 | `REACTION_HORIZON`, `reactionHorizon`, `reactionTargetOf`, `reactionEmojiOf`, `foldReactions` |
| one read for all of the above | §6.6, §6.8 | `decorationsOf` |
| which controls to offer | §6.5 | `offersEditAndDelete` |
| drafts | — | `createDraftStore`, `draftKeys` |

Chat, an edit, a reaction and a deletion are built with
`@estiva-app/protocol`'s `buildMessage`, `buildEdit`, `buildReaction` and
`buildDeletion`.

## What is not in it

The views (CON-18), unread (CON-19), the composer's editor, and anything only
one app needs.

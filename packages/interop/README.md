# @estiva-app/interop

Render and act on **another app's objects**, from a manifest that app published.
Your app learns nothing about theirs.

```bash
npm install @estiva-app/interop @estiva-app/protocol
```

No registry auth, no `.npmrc`, no token — [ADR 0002 §3](https://github.com/estiva-app/estiva-docs/blob/main/decisions/0002-foundation-packages.md).

## The one rule everything follows

**The owner defines the projection. The consumer decides how it looks.**

An app that owns objects publishes a NIP-89 `kind:31990` manifest saying which
of its fields matter, what its statuses mean, and what another app may *do* to
them. It never says how to draw anything — an owner who could specify layout
would be designing your product, which is the same objection that rules out
iframes.

So this package returns values with enough shape to render, and no components.
Nothing in it knows what any particular app is.

---

## 1. Render an object from an app you know nothing about

You are holding a reference somebody pasted — `nostr:naddr1…`, or a bare
`kind:pubkey:d`. You do not know which app owns it.

```ts
import { resolveForeignObject } from '@estiva-app/interop'
import { Relay } from '@estiva-app/protocol'

const relay = new Relay('https://your.relay', signer)
const query = (filters) => relay.query(filters)

const object = await resolveForeignObject(reference, query)
```

`query` is the only thing this package touches the outside world with, and you
supply it. There is no client inside, no global, and no configuration — which is
also why the whole test suite runs with an array standing in for the relay.

What comes back:

```ts
{
  ref: '30851:abc…:9c69f247-…',   // stable handle, whatever the object is
  kind: 30851,
  appName: 'Estiva Ship',
  noun: 'issue',                  // what the owner calls one, if it says
  widget: 'row',                  // a hint. See §3
  slots: {
    title:    { value: 'Billing entry' },
    status:   { value: 'In Progress', colour: 'blue' },
    subtitle: { value: 'Settings entry point.' },
    body:     { value: '**Stripe Checkout** for billing.', format: 'marker' },
  },
  meta: [{ label: 'Assignee', value: 'abc…', isPubkey: true }],
  children: [ /* … more of the same, if the owner declared a list */ ],
  actions: [ /* … see §2 */ ],
  openUrl: 'https://ship.estiva.app/#/o/naddr1…',
  people: { 'abc…': { displayName: 'Ana', picture: '…' } },
}
```

**Render the slots you implement and ignore the ones you do not.** That is not
politeness, it is required: the slot set is closed but it *grows*, and producers
upgrade before consumers do. `title` is always present, so an object you only
half understand still renders as a named, resolvable thing.

### Holding a set? Resolve it as one

A list you keep live — followed files, open work — should not resolve its
entries one at a time. Each resolve is a request, and a relay that meters reads
per request (the Estiva relay allows 300 a minute, shared by a person's tabs)
runs out on a refresh of a few dozen.

```ts
import { resolveForeignObjects, createProjectionCache } from '@estiva-app/interop'

const cache = createProjectionCache() // keep it for the session
const objects = await resolveForeignObjects(addresses, query, undefined, cache)
// { [address]: ForeignObject | null } — each exactly what resolveForeignObject returns
```

Every object keeps its own filters and limits, so a busy one never crowds out
another's comments; they share the POST. A warm refresh of up to 32 objects is
one request and a people lookup, plus one more for the whole set when a card
lists children its app folds — their changes, so a moved or archived child is
not drawn under its old parent (MAN-7). Event references (`nevent`) are not addresses
and come back `null`; resolve those with `resolveForeignEvent`.

Need only where each file sits? Ask for that alone — the roots, and the moves
where a kind can be moved, without anybody's comments or children:

```ts
import { resolveParents } from '@estiva-app/interop'

const parents = await resolveParents(addresses, query, cache)
// { [address]: parent address | null } — null at the top, no key when nothing can be told
```

Folded by the same rule as `ForeignObject.parentRef`, so a moved issue is under
the project it was moved to here as everywhere else.

### A `body` says which content model it is in — read it, do not guess

`body` is the one slot that carries structure, and it arrives in one of two
models that must never be read as each other. **The slot tells you which**, so
you never have to look at the text:

| `slot.body.format` | what you have |
| --- | --- |
| `'marker'` | the marker dialect — `**bold**`, `# heading`, `> quote`, fenced code |
| `'blocks'` | a JSON block document |
| `'unknown'` | a model published after your app was written |

```ts
import { toRenderTree } from '@estiva-app/protocol'

// One tree, whichever model it came in. Marks decided, blocks decided,
// nothing left to parse — so you cannot render markup by accident.
const blocks = toRenderTree(object.slots.body.value, object.slots.body.format)
```

**Never decide the model by inspecting the body.** A description that happens to
begin with `{` is marker text if its event carries no `content-format` tag, and
there are hundreds of those already published. `'unknown'` exists so you can
decline: rendering a body you do not understand as plain text is correct, and
guessing at it is not.

A slot that is *not* a body carries no `format` at all — that is how you tell
"this is prose in the marker dialect" from "this is a title, and models do not
apply to it".

### The states you must draw, and the one that catches everyone

A foreign object has more failure states than anything else on your screen,
because you control none of its lifecycle.

| state | how you know |
| --- | --- |
| resolved | you got an object |
| **you may not see it** | `object.unreachable === true` |
| nothing claims this kind | `null` |
| declared a list, and it is empty | `children` is `[]` |
| declared no list | `children` is `undefined` |

**"You may not see it" and "it is empty" must never look the same.** A gated
read returns *nothing at all* — the same nothing as a thing with no content —
so the relay cannot distinguish them and neither can you unless you use
`unreachable`. Draw one state for both and you have built a screen that quietly
lies.

## 2. Let a reader act on it, without an API

An action is **an event to publish**, never an endpoint to call. There is no
server in the loop, and the owning app can be offline.

```ts
import { buildActionEvent, resolveManifest } from '@estiva-app/interop'

const resolved = await resolveManifest(object.kind, query)

const built = buildActionEvent({
  manifest: resolved.manifest,
  kind: object.kind,
  address: object.ref,
  objectAuthor: pointer.pubkey,
  folder,                       // the object's channel — see below
  actionId: 'set-issue-status',
  value: 'done',
  pubkey: me,                   // whoever is about to sign
  createdAtMs: Date.now(),
})

// A refusal is a string, and it is written for a person to read.
if (typeof built === 'string') return show(built)

await relay.publish(await signer.sign(built))
```

**Some actions are another app's.** An object also offers the creations other
apps declare on its kind — Ship's *New project* on a Folder, which is Peek's —
and such an action carries `declaredBy`. Build it with
`resolveActingManifest(pointer, action.declaredBy?.address, query)` in place of
`resolveManifest`: the owner's manifest does not declare it and refuses to.

**Check the string.** `buildActionEvent` returns `UnsignedActionEvent | string`,
and the string is why it refused — an undeclared field, a required one left
empty, a value outside the declared vocabulary. Treat the result as an event
without checking and you will sign the refusal.

Everything it needs is passed in rather than reached for: this package opens no
socket, reads no clock and holds no identity, so the built event is a pure
function of its inputs and the whole suite runs against an array.

`object.actions` is already resolved against the owner's vocabularies, so a
`select` arrives with its options and the value it currently holds.

### Actions that create an object, not just change one

An action with `control: 'form'` makes a whole new object rather than setting a
field on this one. It arrives with the schema already resolved:

```ts
const action = object.actions.find((a) => a.control === 'form')

action.fields        // [{ name: 'title', type: 'string', required: true }, …]
action.createsUnder  // the address the new object will hang under
```

Draw the fields, then pass an object rather than a scalar, plus an id for the
thing being made:

```ts
const built = buildActionEvent({
  /* …as above… */
  actionId: action.id,
  value: { title: 'Payment fails on retry' },
  newId: crypto.randomUUID(),
})
```

Declaring one, from the producer's side — `required` is a list of names, not a
flag on each property:

```jsonc
{
  "id": "add-issue", "label": "Add issue", "appliesTo": "31800",
  "emits": { "kind": 31801, "setTag": "a", "toAddressOf": "self" },
  "input": {
    "type": "object",
    "properties": {
      "title": { "type": "string" },
      "note": { "type": "string", "target": "content" }
    },
    "required": ["title"]
  }
}
```

`newId` is **required** for an addressable kind and is supplied by you rather
than generated here — an object published without one has no address at all, so
nothing could reference it, comment on it or act on it afterwards.

Two rules worth knowing before you draw the form. **A property's name is the tag
its value is written to**, which is what lets a consumer build an event for an
app it has never seen. And **one property may target the event's `content`
instead**, with `"target": "content"` — at most one, because an event has one
body, and a consumer refuses the whole action rather than choosing between two.

That second rule is new in 0.13.0. Before it, nothing could be written to
`content` at all, and the consequence was not a rough edge: an app whose object
*is* its body — a message, a note, a comment — could not declare a create
action at all, because a body in a tag is not a body. Peek's manifest said
`"actions": []` for exactly that reason.

A field carrying `target` reaches you on the resolved action, so you can draw
prose where the producer meant prose. Ignoring it is safe — the event is
correct either way; you will just have drawn a single-line input for a
paragraph.

Two consequences worth knowing before you ship it. **Validation is an honour
system** — nothing stops you publishing a status outside the declared
vocabulary, and a consumer that skips the check is the one putting junk in a
shared record. And **an object with no `naddr` offers no actions**: a change
names its target with an `a` tag, and a regular event cannot be named that way.
That is the model being honest, not a gap.

### Actions that delete

An action whose `emits.kind` is `5` is a deletion, and it arrives as
`control: 'confirm'` — one button, no value, ask first (its `effect` is
`destructive`). `buildActionEvent` builds NIP-09's request naming the object's
address, and the relay decides who may: the author, or the owner of an agent
that wrote it. **Offer it to everyone and report the answer.** A consumer that
hid the control behind an author check of its own would hide it from the one
person the relay would have let through, and could never evaluate the second
half anyway (SPEC §6.5).

```ts
const action = object.actions.find((a) => a.control === 'confirm')
// after the person has confirmed:
const built = buildActionEvent({ /* …as above… */ actionId: action.id, value: '' })
```

The bare file's built-in manifest declares one, beside `rename` (a `title`
change) and `comment`. A consumer that draws every field-setting action as an
input will now draw a "Rename" box under a bare file's card; whether that is
what its card is for is the consumer's call, and the field it sets is the one
`slots.title.field` names, so the two are one fact either way (PEEK-18).

It also declares `move` (a `parent` change; SPEC §6.7). Its value is an
address, so a text box under a card is the wrong control for it: the object
names the field in `parentField`, and a consumer drawing property rows keeps
that one out, as it keeps the title's out, and offers the move where it draws
the tree.

### Moves, placement and prose (0.36.0)

Three things an owner declares so a consumer can do what the owner does
(SPEC §7.2–7.3, MAN-1).

**A move** is a change to the field the parent's list names as `movedBy`:

```jsonc
"list": { "children": { "kind": 30851, "via": "a", "movedBy": "project" } }
```

The folded field wins over the child's `a` tag, and an empty value is a move to
no parent. The object carries `parentField` (the bare file's is `parent`, now
declared rather than hard-coded) and `parentKind`, the kind a move may name —
`nestingOf(...).moveTargetsOf` offers only that kind.

**Placement and listing.** A creation may name its Folder with `buzz-channel`
instead of `h`, and an action declaring `listed: true` is followed by the
`kind:1852` that keeps the Folder's listing true. Those are built by
`buildActionEvents`, which needs what only your read of `kind:30890` knows —
`buildActionEvent` refuses them rather than publish half:

```ts
const events = buildActionEvents({ /* …as above… */ actionId: 'add-project',
  value: { name: 'Launch' }, newId: crypto.randomUUID(), folderHasState: folder.hasState })
// [kind:30850 with buzz-channel, kind:1852 add] — publish in order, stop at the first refusal

buildActionEvents({ /* … */ actionId: 'delete-project', value: '', listedIn: folders })
// [kind:5, a kind:1852 remove per Folder with state]
```

A resolved action carrying `listed: true` is one that needs them.

**Prose.** A field declared with `"format": "estiva-blocks-1"` — on a
creation's `content` property, or a change's input — arrives with `format` on
the resolved field or action, so you can draw a block editor. Pass
`contentFormat: 'estiva-blocks-1'` with a block document and the event carries
`content-format` and an `imeta` per attached file; pass plain text without it
and the value is written as marker text, which is always correct.

### Replies

A reply is the `comment` action with a parent. Pass `replyTo` and the uppercase
`A`/`K`/`P` still name the file while the lowercase trio names the comment
answered — SPEC §6.4's table:

```ts
const built = buildActionEvent({ /* …as above… */ actionId: 'comment', value: 'Agreed.',
  replyTo: { id: comment.id, kind: comment.kind, author: comment.pubkey } })
```

`kind` is the parent's own, which for one of Ship's replies is `9`. A reply
carries no lowercase `a`, so the file's `#a` read (`conversationsOf`) never
returns it. `threadsOf` is the read that does: the roots by id and their direct
replies by `#e`, in one request for every thread.

```ts
const roots = (await conversationsOf([file], query))[file.ref].map((m) => m.id)
const { roots: byId, replies } = await threadsOf(file.address, roots, query)
// byId[id] is the root event; replies[id] its direct replies, oldest first
```

### Nesting

`nestingOf(files)` draws a listing's nesting — `roots`, `childrenOf`,
`ancestorsOf` (a breadcrumb), `parentOf`, `moveTargetsOf` — in memory, from the
`parentRef` each file already carries. Hand it the whole team listing from
`resolveFolderContents`, never the answer to a `#a` query: a move is a change
event whose value no relay indexes, so "what is under X?" asked by tag misses
every file moved in. A parent outside the listing is not drawn, and a file on a
cycle is drawn at the top, so every listed file stays reachable and no walk
loops.

### Offering files to reference (0.46.0)

A composer's `[` offers files as `@estiva-app/conversation`'s
`rankReferences` ranks them. `fileCandidates(objects, tier, query)` turns
resolved objects — a Folder's listing, the files you read recently — into its
rows: the type word from `REFERENCE_FILE_TYPES`, the current title, an issue
captioned with its project's title. `searchFileReferences(text, query)` is the
search tier: it asks the relay for roots and title changes holding the word,
resolves each address through its manifest, and keeps only the files whose
*current* title matches. Pass it to conversation's `referenceSearch`. Neither
offers what the reader could not resolve.

## 3. Widgets: draw what you know, degrade honestly

`widget` is a *layout hint*, and it may be a single type or an ordered chain:

```jsonc
"widget": ["message", "card"]   // a message if you know it, else a card
```

A chain always ends in one of `card`, `row`, `table`, `stat`, so **there is
always something you can draw.**

```ts
import { pickWidget, CLOSED_WIDGETS } from '@estiva-app/interop'

const layout = pickWidget(object.widget, ['message', ...CLOSED_WIDGETS], 'card')
```

Never render nothing. An object that is present but blank is indistinguishable
from one the reader is not allowed to see, and reports *"that app is broken"*
about an app that is behaving correctly.

---

## 4. Make *your* objects renderable by other apps

Publish one `kind:31990`. Here is a hiring tool declaring a Candidate — an app
this suite knows nothing about, which is the point.

```jsonc
{
  "name": "Hiring",
  "records": {
    "changeKind": 1851, "targetTag": "a", "fieldTag": "field", "valueTag": "value",
    "order": ["ts", "created_at", "id"], "rule": "last-write-wins-per-field"
  },
  "projections": {
    "31800": {
      "widget": ["candidate", "card"],
      "slots": {
        "title":    { "tag": "name" },
        "subtitle": { "tag": "headline", "truncate": 120 },
        "status":   { "fold": "stage", "map": "stages", "default": "applied" },
        "meta":     [{ "label": "Recruiter", "fold": "owner", "as": "pubkey" }],
        "list":     { "children": { "kind": 31801, "via": "a", "limit": 50 } }
      }
    }
  },
  "vocabularies": {
    "stages": [
      { "value": "applied",   "label": "Applied",   "colour": "neutral", "stage": "open" },
      { "value": "screening", "label": "Screening", "colour": "blue",    "stage": "started" },
      { "value": "hired",     "label": "Hired",     "colour": "green",   "stage": "done" },
      { "value": "passed",    "label": "Passed",    "colour": "muted",   "stage": "dropped" }
    ]
  },
  "actions": [
    {
      "id": "set-stage", "label": "Change stage", "appliesTo": "31800",
      "emits": { "kind": 1851, "field": "stage" },
      "input": { "type": "string", "enum": "stages" },
      "description": "Move a candidate to a different hiring stage",
      "effect": "writes"
    }
  ]
}
```

A chat app now renders your candidate — with your stages, your colours, your
recruiter — in **its** design language, and lets someone move a stage without
leaving the conversation. It knows nothing about hiring.

Six things that will bite, each of them something we got wrong first:

- **`title` is required.** It is what makes ignoring an unknown slot safe.
- **A mutable field must be a `fold`, never a `tag`.** A status that can be set
  by someone who is not the author does not live on the root event, so a `tag`
  renders empty for ever.
- **`stage` says what a status *means*.** Without it a consumer reporting
  progress has to guess from your label, and the only way to guess is a list of
  English words — which fails for the next app that spells things differently.
  `dropped` is the one nothing can infer: neither outstanding nor progress.
- **Never `truncate` a field that carries structure.** `truncate` is a
  plain-text operation. A `subtitle` promises plain text; a `body` carries
  structure. Cut markdown at 120 characters and you have published 120
  characters of markup.
- **A widget chain must terminate in a closed type.** `["candidate"]` is not
  publishable. `widgetChainProblem()` is exported so you can check before you
  sign — a manifest is read by apps that cannot ask what you meant.
- **An action's `description` is read by a machine, not shown on a button.**
  A caller choosing between every action every app declares has that prose and
  nothing else. `"Add"` is not rejected anywhere — your action is simply never
  the one chosen, and nothing tells you. `actionProblems()` is exported for the
  same reason as the check above: run it in your own tests before you sign.
- **Your objects need a Folder tag to be actionable.** A consumer finds where to
  write by reading `h`, then the relay's `buzz-channel`, on the object being
  acted on; an object carrying neither is refused for having nowhere to go.
  `folderOf()` is exported so you can check what a consumer will conclude about
  your records.

### If you own no kinds, say which aspect you render

The hiring tool above is a *specialized* app: it owns a kind and draws every
part of it. A *generic* app owns nothing and renders **one aspect of every file
in the workspace** — a chat app draws each file's conversation, a writing app
each file's document (RFC 0.5 §10.7). Its manifest says so with one field:

```jsonc
{ "name": "Peek", "aspect": "conversation", "fileNoun": "topic", "projections": {} }
```

What a consumer does with it today: a **bare file** (`kind:30840`, SPEC §6.7)
has no owner and so no `web` template of its own, and the app that renders its
conversation is where a link to it belongs. Publish `aspect` and a `web`
template for `naddr` on the same `kind:31990`, and every consumer's card for a
topic becomes a link into your app — with no change on their side. `ASPECTS`
is exported and holds the two values.

The bare file is then named after your app too: its `appName` is your `name`,
and its `noun` is your `fileNoun` — what your people call a file nobody owns,
lower case and singular. Leave `fileNoun` out and the file has no noun, and a
consumer falls back to your app's name. Nothing else in your manifest applies to
a bare file; its slots, fold rule and actions are the runtime's.

The same is true of a **comment** (`kind:1111`): every app writes one and none
owns it, so the built-in manifest draws it — the author as its title, the text
as its body, with the `message` widget — and it opens by your `nevent`
template. Publish one, or one `web` string for both entity types.

### Say what your links look like

A URL somebody pastes is a reference too (RFC 0.5 §7.5). Declare each shape you
serve as a `urls` tag on the manifest event, with the kind it names:

```
["urls", "https://peek.estiva.app/topic/<slug>-<d>", "30840"]
["urls", "https://peek.estiva.app/topic/<slug>-<d>?thread=<id>", "1111"]
["urls", "https://peek.estiva.app/message/<id>", "9"]
```

`<d>` resolves with `#d`, `<id>` with `ids`; the slug is decoration. A
placeholder in the query is the identity, and the path's is then the container
(`within`). A consumer calls `matchObjectUrl(url, urlPatternsOf(manifest))` and
gets `{ identifier, by, kind }` or null — a URL nothing claims is a link and
stays one.

---

## 5. Read a whole folder, across every app in it

A Folder is where the suite's navigation lives: teams you belong to, and the
files inside them. `resolveFolderContents` answers *"what is in this folder?"*
without knowing what any of the answers are.

```ts
import { resolveFolderContents, createProjectionCache } from '@estiva-app/interop'

const cache = createProjectionCache()
const folder = await resolveFolderContents(folderId, query, undefined, cache)

folder.name                       // the folder names itself
folder.files                      // ForeignObjects, exactly as §1 draws them
folder.source                     // 'state' | 'channel' — see below
```

Every file comes back as the same `ForeignObject` §1 renders, so a folder view
is §1 in a loop. **A project from one app and a topic from another sit side by
side as peers**, because RFC 0.4 §5.2 established that one tag type — `a` —
names every file, topics included. Nothing here special-cases either.

Reuse one `ProjectionCache` across folders. Round trips are flat in the number
of files and linear in the number of *apps*: 24, 25 and 9 files measured at 5, 5
and 4 requests warm.

### A file you cannot see is absent, not greyed out

**The count is the disclosure.** A folder that renders three rows and two
placeholders has told an outsider exactly how much they are missing, which for a
folder named after a person is the sensitive part. So an address that resolves
to nothing is dropped, and nothing in the return value counts what was dropped.

This is a deliberate divergence from upstream NIP-MP, whose fold requires the
opposite for public repositories. It is also why this does not reuse
`resolveForeignObject`, which returns `unreachable: true` — right for one pasted
link, wrong for a list.

### `source` tells you which model you are looking at

`'state'` means the relay maintains the folder's contents. `'channel'` is the
approximation available before that exists: containment read off each file's own
`h` tag. It lists an app's records perfectly well and **cannot list a topic**,
because under `h` a topic is the container rather than something inside it. A UI
explaining a short list should read this field.

### A sidebar

```ts
import { listFolders, topLevelFolders } from '@estiva-app/interop'

const folders = await listFolders(query)   // { id, name, hasState, private?, admins?, listedIn?, addresses?, channel?, archived? }[]
const teams = topLevelFolders(folders)     // state, nothing lists it, not archived
```

Asks for folders by kind rather than walking anything else. Discovering things
only through their parent loses them when the parent goes — the failure RFC 0.4
§4.2 records, one level up from where it was first paid for.

A channel is addressable, so a folder can be a file in another folder — Peek's
topics are, each listed by its team's state. `listedIn` names those containers,
read off the states the call already holds, so a sidebar draws the team and
not, beside it, every topic in it. `topLevelFolders` is that choice — a folder
with state that nothing lists — so two apps draw the same sections.

`addresses` is the other direction: what a folder's state lists, unresolved
and in order. An app drawing its own records under a team intersects it with
the records it holds; one drawing another app's files resolves the folder.

A record a state lists places its own channel there too: a project's
conversation lives in the channel its `buzz-channel` (or `h`) names, and that
channel's `listedIn` is every Folder that lists the project, so an unread
verdict on it has a team to reach. It costs one more request, for the records.
A channel with state of its own is a Folder, and only states place it.

### Changing a folder

```ts
import { planMoveFile } from '@estiva-app/interop'

const here = await resolveFolderContents(from.id, query)
const plan = planMoveFile(me, Date.now(), {
  file,                                                 // a ForeignObject from `here.files`
  listing: here.files,                                  // what is listed beneath `file` moves with it
  from: { id: here.id, hasState: here.hasState },       // from a read, never a guess
  to: { id: there.id, hasState: there.hasState, private: there.private },
})
if (!plan.ok) return plan.reason   // 'source-has-no-state' | 'target-has-no-state' | 'target-is-private'
for (const event of plan.events) { // publish in order; stop at the first refusal
  if (!(await publish(await sign(event))).ok) break
}
```

The planners are SPEC §3.3's operations — `planCreateFolder`,
`planRenameFolder`, `planArchiveFolder`, `planDeleteFolder`, `planPlaceFile`,
`planUnlistFile` and `planMoveFile` — and return **unsigned** events in publish
order. Signing and publishing stay yours.

A move is one `kind:1852 add` in the target naming the file and every file
listed beneath it (`listedBeneath`), then one `remove` naming the same set in
the source, so a failure between the two leaves the whole subtree in both
Folders and never splits it. Into a private Folder it is refused when any moved
file's `h` is another channel, or absent: a listing never changes who can read
a file (§3.1).

No command carries a name: the title is the `kind:39000`'s, so a rename is the
`kind:9002` alone and `listFolders` reads the title from the channel.

Place, unlist and move take `hasState`, because the relay computes a folder's
next state from its current one and a group with no `kind:30890` has none: a
`kind:1852` against it emits state listing only what the command named, and
everything filed in it by `h` stops being listed. So place and unlist send no
command to such a group, and a move into or out of one is refused.

`listing` is required; pass `null` only for a file nothing can sit beneath, so
a move that leaves sub-files behind is never an accident.

Delete is for an empty Folder. The relay refuses a `kind:9008` while the Folder
holds a file, with a reason naming the count (`folder holds 2 file(s) …`).
Its wording is the relay's. Take the count and say it in your app's words
("This Folder still has 2 files. Move or delete them first."), as you would
for `target-is-private`.

### Archiving anything (0.37.0)

```ts
import { archiveImpact, isArchived, planArchiveFolder } from '@estiva-app/interop'

const impact = await archiveImpact(file.address, query)  // { hides: [{ kind, count }], staysVisible }
// …say what it hides, take a resolution, then publish the declared `archive`
// action with `value: 'true'` and `note: resolution` — or, for a Folder:
const [change] = planArchiveFolder(me, Date.now(), { folder: f.id, channel: f.channel!, archived: true, resolution })

const opened = await resolveForeignObject(link, query, people, 0, cache, { archivedWith: true })
if (isArchived(opened)) showBanner(opened.archived)       // { by, at, resolution?, with? }
```

One field for every file, whatever its kind: a change setting `archived` to
`'true'` on the file's address archives it and an empty value restores it. It
is a change, so anyone who may write in the Folder may, and the change's
`content` is the resolution a person gave. **A Folder itself is the
exception** (SPEC §3.2): its archive counts only from an owner or admin on its
`kind:39001`, published in its own `h` — offer Archive on a Folder only to
`folder.admins`.

**The cascade is read, never written.** A Folder's contents leave out an
archived file and everything under it — an issue with its project, a sub-topic
with its topic — and `topLevelFolders` leaves out an archived Folder, so its
subtree goes too. Nothing is written to the children, so unarchiving restores
exactly what was there, and a file another Folder also lists stays visible in
that one. A link still opens an archived file, with `archived` set — `with`
naming the parent when it is archived only with it — so the page can draw the
resolution first and an Unarchive control.

---

## What is not in here, deliberately

**No fold.** Manifest semantics are normative; an app's interpretation of its
own records is not. Two apps folding the same events are *supposed* to be able
to differ ([SPEC §10](https://github.com/estiva-app/estiva-docs/blob/main/protocol/SPEC.md)).

**No rendering.** Not a React dependency, not a component. A package that
shipped a widget would be specifying the UI of every app that installed it.

**No relay client.** `@estiva-app/protocol` has two; this takes a function.

## The specification, which outranks this package

[SPEC §7](https://github.com/estiva-app/estiva-docs/blob/main/protocol/SPEC.md)
is normative and **must stay sufficient to implement all of this without
installing anything**. If this package ever becomes the only place that knows
how projection works, an interop standard has quietly been traded for a
monoculture — and then a defect in it is a defect in every app at once,
invisible from all of them.

**The package is a reference implementation. The specification is the standard.**
In that order.

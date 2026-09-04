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
    // "folder": "identifier"  — only if your object *is* a container; see below
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

Seven things that will bite, each of them something we got wrong first:

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
- **If your object *is* a container, say so.** A consumer finds the Folder to
  write into by reading `h`, then the relay's `buzz-channel`, on the object
  being acted on. An object that is itself a Folder carries neither — it *is*
  the Folder — so every action on one is refused for having nowhere to go.
  `"records": { "folder": "identifier" }` says the Folder is the object's own
  `d`. Nothing can infer this: a consumer that guessed from the kind would be
  hardcoding one app. `folderOf()` is exported so you can check what a consumer
  will conclude about your records.

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

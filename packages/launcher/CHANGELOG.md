# @estiva-app/launcher

Every entry says whether an app that mounts the box has to change its `host`.

## 0.3.1 — 2026-11-24

**The field stays the same field when the third word makes it a prompt (KIN-7
fix).** 0.3.0 wrapped only the prompt's face, so the third word, and deleting
it, remounted the field: focus and the element were lost mid-typing. Peek's
suite caught it before any app took 0.3.0. No host has to change.

## 0.3.0 — 2026-11-24

**The suggested action your sentence wants comes first, where the browser's
on-device Decisions API passes the box's check (KIN-7).** No host has to change;
a host that sets `guessAs` gives the model better words than the label.

- Under a prompt, a typing pause asks `DecisionModel` which Suggested row the
  sentence wants; an answer at 0.6 or more moves that row first. Hidden
  "something else" options move nothing when they win.
- The model is used only once it moves nothing for `CHECKS` ("assign this issue
  to me", "which issues are still open in this project"). Chrome 160 failed it
  on 24 Nov and keeps the usual order; Edge Dev 160 passed. No browser is named.
- Once the pointer moves or an arrow key is pressed, the order holds until the
  next key. An answer for a sentence since changed is dropped.
- Typing never starts a download: a session is made only where `availability()`
  says `'available'`. The Download row, where it has always shown (a
  conversation is open), also fetches the guess's model; the guess alone never
  adds the row, and one Suggested row asks the browser nothing.
- The model reads only this package's words for an action (`guessAs`, else the
  catalogue label), never a manifest's label from the relay.
- `LauncherOwnAction.guessAs` and `LauncherAction.guessAs`: what the model reads
  for an action, never drawn.

## 0.2.0 — 2026-11-23

**What is open can be a page (KIN-5).** No host has to change: Peek's
`context.conversation` works as before, and every new member is optional.

- `LauncherContext.open` (`LauncherOpen`): what is open, a `'conversation'` or a
  `'page'`, with its title and its parts. A page's parts are its passages, then
  every comment on it; Ask tells the model so, names the page, and marks a
  resolved comment. `LauncherMessage` gains `where` (said on a citation in place
  of the time) and `resolved`. `openOf(context)` reads either shape.
- `LauncherWords.part`: what one part is called, "passage" on a page.
- `LauncherHost.answerActions`: what an answer can be turned into in this app
  (Leaf: a comment, a block in the page). One that fails says so and keeps the
  answer.
- `LauncherHost.ownActions`: the app's own actions beside the declared ones
  (Leaf's New document).
- `LauncherHost.maySign`: an action whose event the app may not sign is never
  offered, and an app whose actions were all left out says they are made there.
- `launcherApps('leaf')`: Leaf, as the host.

## 0.1.0 — 2026-11-23

**First release: Peek's ⌘K, moved here unchanged (KIN-4).**

- `CommandLauncher`: the box, its levels, the search, the prompt, Ask and Draft,
  the forms and what Escape keeps. It takes a `host` (`LauncherHost`) with what
  only the app knows.
- `useKeptLauncher`, `useKeptSearch`, `KeptSearchContext`: one box for the whole
  app, hidden while it holds something, and what the top bar's search says about
  it meanwhile.
- `ActionFormFields`: a form's fields, drawn from an action's declaration.
- The pure modules that were Peek's `lib/`: `launcherActions` (now
  `launcherApps(hostId)`), `liveAction`, `actionCatalogue`, `prefill`,
  `askThread`, `formDraft`, `launcherSearch`, `promptApi` (with `LauncherModel`
  and `onDeviceModel`).

Nothing a person sees in Peek changed. Peek is the only consumer; Leaf and Ship
follow.

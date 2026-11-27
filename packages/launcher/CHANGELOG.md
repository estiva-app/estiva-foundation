# @estiva-app/launcher

Every entry says whether an app that mounts the box has to change its `host`.

## 0.5.0 — 2026-11-27

**Leaf's New document in every other app's ⌘K, with the answer you just read
as its text (KIN-9).** A host whose `maySign` is set adds `30842` to offer it,
and needs `manifests.creatableUnder` and `applyAction` to read and make a
creation on a team (Ship's returned nothing until now). Leaf's own box is
unchanged: its built-in New document still opens the page.

- Leaf is listed in Peek's and Ship's box. Its section reads the teams and
  takes only what Leaf's manifest, by its committed key's address
  (`LEAF_MANIFEST`), declared there: a 31990 by any other key declaring the same
  action is offered by nobody. `LauncherApp.declaredBy` names that manifest.
- An action picked under an answer starts with the answer, without its
  numbered citations, in its declared prose field (a text its app declares as
  a block document) when the person has not typed in it. The conversation's
  suggestion no longer replaces it. A form with no such field is unchanged, so
  Ship's New project still starts empty.
- The registry comment no longer says an app nobody here wrote works the same
  day: that waits for the workspace's added apps (WOR-2).

## 0.4.2 — 2026-11-27

**An answer is put only in the conversation it was asked in (KIN-12 review).**
No host has to change.

- "Put the answer in the message box", from somewhere else, goes back to where
  the sentence was asked and writes once that conversation's box opens. It now
  also waits for the same `place`, not only the same address: going back to
  Peek's Desk can show another DM there, whose box may carry the same name.
  Then nothing is written and the box says it could not reach it.

## 0.4.1 — 2026-11-27

**An ask made in one conversation on a Desk waits under Recent in the next
(KIN-12).** An app whose page can show one of several conversations (Peek's
Desk) passes `path.place`, naming the conversation the same wherever it is
shown; no other host has to change.

- Where a sentence was asked is `host.path.place` when given, else the
  pathname as before. On Peek's Desk every conversation is `/app/desk`, so ⌘K
  in a second one showed the first one's sentence and answer, instead of a
  fresh box with the ask under Recent.
- The same place decides whether "Put the answer in the message box" writes
  here or opens the conversation first, and whether the app's answer actions
  are offered.

## 0.4.0 — 2026-11-27

**The asks you made in this tab wait under Recent (KIN-12).** No host has to
change: an app that holds the box with `useKeptLauncher` gets it with the bump.

- Every sentence sent keeps its own box, mounted and hidden, so its request runs
  on while the person moves; closing or acting no longer cancels it.
- ⌘K where the shown ask was asked shows it, as before. Anywhere else it opens a
  fresh box about where the person is, and Recent lists the asks first: the
  sentence, "in <where it was asked>", and the search's dot while it works
  (pulsing) or its answer is unseen (solid). Picking one shows it, about where
  it was asked.
- While any answer waits, Recent comes above the place's own groups, so that ask
  is the lit row and Enter opens it.
- Opening a result or using the answer closes the box and keeps the ask. Only
  Ctrl+Backspace on its row, Clear recent (which clears asks too) or a reload
  forget it. Nothing is written to the browser.
- The bar's dot covers every ask the box is not showing.
- `LauncherState` gains `ask` (the sentence, where, and whether the person is
  there now); `KeptAsksContext` carries the other asks to each box.

## 0.3.4 — 2026-11-24

**Ship's New project is offered in a box that does not list Peek (KIN-11).** No
host has to change; a host's `creatableUnder` is now asked for teams (`39000`)
too, whichever apps it lists.

- What another app declares on a team was found only in a box that listed the
  app whose kind a team is, Peek. Leaf's lists Leaf and Ship, so its box offered
  Add issue and never New project.

## 0.3.3 — 2026-11-24

**The guess moves a row only when the model is very sure, so it works in Edge on
production (KIN-7).** No host has to change.

- A move needs 0.8 (was 0.6). On production Edge Dev put Add issue first for
  "which issues are still open in this project" at 0.63–0.73, failed the check,
  and the guess stayed off.
- The model reads each action's own name (`new-project`), never the row's id
  (`suggested-own-new-project`): with the ids, that question scored higher.
- The catalogue's Create issue and Create project read as Ship's own words, so
  Peek's "create a project…" scores 0.90 in Edge, not 0.797. Leaf's ⌘K reads
  the same words once it offers those two actions.
- Only names this package or the host wrote reach the model: an action only a
  manifest on the relay declares is `option-<n>`, read as "Another action in
  <app>". `GuessOption.name` carries the name.

## 0.3.2 — 2026-11-24

**The field stays the same field when the third word makes it a prompt (KIN-7
fix).** 0.3.0 and 0.3.1 wrapped only the prompt's face, so the third word,
deleting it, and going into Draft a reply or back remounted the field: focus
and the element were lost mid-typing. One wrapper now holds every face. Peek's
suite caught it before any app took 0.3.0. No host has to change.

## 0.3.1 — 2026-11-24

**No host has to change.** (ALL-8.) A file's Delete written as its `deleted`
change (SPEC §6.5) is no longer offered as a ⌘K picker row ("Delete · <file>"
with Not deleted / Deleted): it is asked with a confirm on the file's own menu.
Works with `@estiva-app/interop` 0.117.0, where a topic's built-in Delete
became that change.

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

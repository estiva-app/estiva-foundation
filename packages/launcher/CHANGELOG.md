# @estiva-app/launcher

Every entry says whether an app that mounts the box has to change its `host`.

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

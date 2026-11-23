# @estiva-app/launcher

Every entry says whether an app that mounts the box has to change its `host`.

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

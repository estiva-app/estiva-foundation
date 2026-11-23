# @estiva-app/launcher

The ⌘K box every Estiva app mounts. A name finds anything, a sentence asks about
what is open, and the box suggests what to do with it.

It was Peek's until KIN-4 (23 November 2026). Peek runs on this package now;
Leaf and Ship mount it next.

## What is here, and what the app brings

| Here | The app's, handed over as the `host` |
| --- | --- |
| The levels: first, inside an app, Draft, a form | Where the person is, and how to go somewhere |
| One field: a search up to two words, a prompt from the third | The people, and how a person opens |
| Ask and Draft, and what an answer cites | The relay's file search, and a message search where the app can open a message |
| The forms an app's manifest declares, their drafts and what they send | The manifest runtime's calls: what can be created, applying an action, resolving a file |
| What Escape keeps, and what the search's dot says | The model that answers (`onDeviceModel`, the browser's own) |
| The pure rules: matching, the prompt, prefill, the action catalogue | A composer to put a draft in, where the app has one |
| | Its marks, and the words that name it or what is open |

The window, the field, the rows and every key are the kit's `CommandPalette`
(`@estiva-app/ui`). This package sits above both the kit and
`@estiva-app/interop`, so neither has to know the other.

## Mounting it

```tsx
import { CommandLauncher, launcherApps, onDeviceModel, useKeptLauncher, type LauncherHost } from '@estiva-app/launcher'

const APPS = launcherApps('leaf') // the app the box runs in

function LeafLauncher(props: { context: LauncherContext; open: boolean; onHide(): void; onClose(): void; onState(s: LauncherState): void }) {
  // Build the host from the app's own hooks, on every render.
  const host: LauncherHost = {
    apps: APPS,
    model: onDeviceModel,
    path: usePath(),
    navigate,
    useFileSearch, // a hook: the launcher calls it with what is typed
    // …the rest: see src/host.ts, where every member says what it is for
  }
  return <CommandLauncher host={host} {...props} />
}

// Above the routes: one box for the whole app, hidden rather than thrown away while it holds something.
const { launcher, toggle, searchStatus, searchStatusLabel } = useKeptLauncher(captureContext, (box) => <LeafLauncher {...box} />)
```

- **Members named `use…` are hooks** the launcher calls itself. Pass the same
  function every render.
- **An optional member is something not every app has** (a message search, a
  composer, DMs). Without it the launcher draws nothing for it.
- **Tailwind.** The box carries a few classes of its own. Add
  `./node_modules/@estiva-app/launcher/dist/*.js` to the app's Tailwind
  `content`, beside the kit's `estivaContent`.
- **Peers.** `react`, `@estiva-app/ui` (and the Tiptap peers its `./editor`
  needs, for a form's description field), `@estiva-app/interop`,
  `@estiva-app/conversation`, `@estiva-app/protocol`, `@tabler/icons-react`.

## On-device only

`onDeviceModel` is Chrome's and Edge's Prompt API. Nothing typed or read leaves
the device. A host that passes another model is making a decision about where a
work thread is sent, which is a decision record, not a code change.

## What is open: a conversation or a page

What is open reaches the box as `context.open`: a conversation (Peek's
messages, oldest first) or a page (Leaf's passages, then every comment on it,
resolved ones marked; KIN-5), with the files it refers to. Peek still hands
over `context.conversation`, which reads the same. Ship's issue (KIN-6) is a
page too.

An app with no composer turns an answer into what it has (`answerActions`:
Leaf's Draft a comment and Insert into the page), offers its own actions
(`ownActions`), and says which kinds it may sign (`maySign`), so the box never
offers an action it could not send.

## Why this package draws, when the others here may not

Every other package extends `tsconfig.base.json` as it is: no `lib: dom`, no
JSX. This one adds both, because it is a component. Its consumers are the
browser apps, which all carry them; the agent, which runs under Node, never
installs it. Its tests run under Vitest and jsdom for the same reason, and they
mount the box with a stand-in app, so none of them needs Peek.

Forms are the part still tested from Peek's side: Peek's own suite submits
them through this package, at the relay's wire.

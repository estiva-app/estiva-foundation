# estiva-foundation

The libraries four Estiva apps inherit: the wire format, identity, platform
concerns and UI. Published to public npm under **`@estiva-app`**.

**The decisions behind this repo — and the reasoning — are in
`../estiva-docs/decisions/0002-foundation-packages.md`.** Read that before
changing anything structural here. This file is the runbook.

| package | what it is | status |
| --- | --- | --- |
| `@estiva-app/hello` | throwaway proving the pipeline. Not a library — do not depend on it | 0.0.2, retire after SHA-2 |
| `@estiva-app/protocol` | event construction, ids, signatures, the relay client | SHA-3 |
| `@estiva-app/platform` | PWA: manifest, service worker, update flow | SHA-2 |
| `@estiva-app/identity` | Estiva ID sign-in, NIP-98, remote signing | SHA-4 |
| `@estiva-app/ui` | tokens and primitives | SHA-5 |

This repo joins the sibling layout under `$HOME` alongside `buzz`, `estiva-id`,
`peek-app`, `estiva-ship`, `estiva-agent` and `estiva-docs`.

## The rule this repo lives by

**No app code, ever.** The remit is the shared layer. b990b57 moved the agent out
of Ship because "this repository contained Peek's kinds, and this repository's CI
had an opinion about Peek's wire format" — putting four packages in one
repository is defensible only while that line holds.

Share the wire format; never the interpretation. How an app folds events into
current truth is where apps are *supposed* to differ.

## What a package must do

Non-negotiable, because three toolchains consume these — Peek is `tsc -b && vite
build`, Ship is a 40-line esbuild script, the agent runs `tsx` directly:

- **Ship built ESM plus `.d.ts`.** Never raw `.ts`. A raw-TypeScript package puts
  its source inside every consumer's `tsc` program, where the *consumer's*
  compiler flags decide whether it compiles. Measured: the same package is green
  in Peek and fails Ship's typecheck on `noUnusedLocals`. ADR §4a.
- **Extend `tsconfig.base.json`** — ES2022, `types: []`, no `lib: dom`. A
  published `.d.ts` must not reach for an ambient global; Peek sets
  `types: ["vite/client"]` and Ship sets `types: ["node"]`, so anything needing
  either compiles in one repo and fails in the other.
- **Write relative imports with a `.js` extension.** `tsc` copies the specifier
  through untouched. CI checks the emitted output.
- **Carry `publishConfig: { access: "public" }`.** Scoped packages default to
  restricted, and the first publish then fails looking like a permissions bug.
- **One workflow per package**, path-filtered, so one package's CI cannot block
  another's release.

## Releasing

The version bump is a PR — `package.json` plus a CHANGELOG entry. The **tag** is
what publishes:

```bash
git tag hello@0.0.2 && git push origin hello@0.0.2
```

`.github/workflows/release.yml` checks the tag against `package.json`, builds,
and publishes with `NPM_TOKEN` — a **granular** access token scoped to
`@estiva-app`, not a personal classic one. Nobody publishes from a laptop.

Semver per package. Packages start at `0.x` and stay there until two apps consume
them in production; within `0.x`, MINOR carries the break.

**For `@estiva-app/protocol`, a MAJOR is a protocol event, not a TypeScript
event.** A change to the bytes an app publishes — id computation, serialization,
tag semantics, signature input — is a MAJOR even when the signature is
unchanged. Every `protocol` release note answers the wire question explicitly,
including when the answer is `Wire behaviour: unchanged`.

**A break is owned by whoever makes it:** the upgrade PR in every consumer listed
in [CONSUMERS.md](CONSUMERS.md) is open before the major publishes, authored by
that person. ADR §5.

## First publish, once the npm org exists

Nothing here has reached the public registry yet. In order:

1. Create the **`@estiva-app`** org on npm; give at least two people publish
   rights.
2. Mint a **granular access token**, read-write, scoped to `@estiva-app`, and add
   it as the `NPM_TOKEN` repo secret.
3. Publish, and then verify by installing from a *clean* checkout — a package
   that resolves out of a local `node_modules` is not published:

```bash
npm ci && npm run build -w packages/hello && npm publish -w packages/hello
```

```bash
cd "$(mktemp -d)" && npm init -y >/dev/null && npm install @estiva-app/hello@0.0.2 && node -e "import('@estiva-app/hello').then(m => console.log(m.hello('a clean checkout')))"
```

Then install it in Peek and Ship, rebuild each, and check that `0.0.2` appears in
the **built bundle** — not just in the lockfile. That is the check the version
constant exists for.

## Local development, before publishing anything

`npm ci` at the root; workspaces link the packages to each other. To try a
package inside an app without publishing, `npm pack` it and install the tarball —
`npm link` leaves a resolution that does not survive a clean checkout, which is
the failure the throwaway exists to catch.

A full rehearsal of publish → install → upgrade, without touching the public
registry, is a local [Verdaccio](https://verdaccio.org):

```bash
npx verdaccio@6 --listen 4873
```

then publish and install with `--registry http://localhost:4873`. That exercises
the client, the tarball, resolution and the upgrade — everything except npm's
auth and org permissions.

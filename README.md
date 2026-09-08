# estiva-foundation

The libraries four Estiva apps inherit: the wire format, identity, platform
concerns and UI. Published to public npm under **`@estiva-app`**.

**The decisions behind this repo — and the reasoning — are in
`../estiva-docs/decisions/0002-foundation-packages.md`.** Read that before
changing anything structural here. This file is the runbook.

| package | what it is | status |
| --- | --- | --- |
| `@estiva-app/hello` | throwaway proving the pipeline. Not a library — do not depend on it | 0.0.2, retire after SHA-2 |
| `@estiva-app/protocol` | event construction, ids, signatures, the relay clients | 0.1.0 |
| `@estiva-app/platform` | the one live socket a tab holds — credential per connect, network return, workspace watch. PWA (manifest, service worker, update flow) joins it in SHA-2 | 0.1.0, **not yet published** |
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

**SHA-3 is where that line got tested.** `@estiva-app/protocol` took the event
builders, the id preimage, NIP-19, NIP-98, signing and both relay clients, and
left behind Ship's `foldFolder`, Peek's `foldResolution` and its projection —
each with its own conformance fixture. The test that decided each case was not
"do both apps need it" but **"would the relay notice if the two apps
disagreed?"**

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
and publishes through **trusted publishing (OIDC)**. There is no npm credential
in GitHub at all — a granular token was tried first and npm answered `EOTP`,
because the account requires 2FA for writes and the token may not bypass it.
ADR 0002 §4c has the whole story, including that npm removes direct publish from
2FA-bypass tokens entirely in January 2027.

Nobody publishes from a laptop, with **exactly one exception**: a package's very
first version. A trusted publisher can only be configured on a package that
already exists, so creating one is a once-ever manual act — see §7 of the ADR and
the recipe below.

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

## Creating a new package

The org, the scope and the pipeline exist. `@estiva-app/hello@0.0.2`,
`@estiva-app/ui@0.1.0` and `@estiva-app/protocol` have all been through this.
The ordering is the part that is not obvious, because two of the steps cannot be
done the other way round — ADR 0002 §7:

1. **Write the package** against `tsconfig.base.json`, with
   `publishConfig.access: "public"`, MIT, and a `LICENSE` in `files`.
2. **Publish the first version by hand**, from a maintainer's machine:

   ```bash
   npm publish --auth-type=web --browser=false
   ```

   It prints a URL, you authenticate in a browser, it completes. Passkeys work;
   there is no OTP to type. On WSL the browser is on the other side, so
   `--browser=false` prints the URL rather than failing to open one. **This step
   cannot be skipped or automated.**
3. **Register the trusted publisher** on npmjs.com: GitHub Actions, org
   `estiva-app`, this repo, workflow `release.yml`, no environment. Allowed
   actions: `npm publish` only. Publishing access: *require two-factor
   authentication and disallow bypass 2fa tokens*.
4. **Every release after that is a tag.**
5. **Add it to [CONSUMERS.md](CONSUMERS.md)** in the same PR that gives it its
   first consumer.

Then verify by installing from a *clean* checkout — a package that resolves out of
a local `node_modules` is not published:

```bash
cd "$(mktemp -d)" && npm init -y >/dev/null && npm install @estiva-app/protocol && node -e "import('@estiva-app/protocol').then(m => console.log(m.PROTOCOL_VERSION))"
```

**A new package *name* 404s on the read path for minutes after a successful
publish** — 204 seconds measured for `hello` — while `npm access list packages
@estiva-app` already lists it. A new *version* of an existing package appears in
about a second. A 404 straight after publishing a new name is not a failed
publish.

Then install it in Peek and Ship, rebuild each, and check the version appears in
the **built bundle** — not just in the lockfile. That is the check a version
constant exists for.

**Still open, and it is the bus factor:** publish rights are held by one npm
account, `estiva-admin`. A second person should hold them before it matters — and
for `protocol` it now does matter, because three repositories cannot merge their
upgrade PRs until somebody with those rights runs one command.

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

# @estiva-app/hello

**A throwaway. Do not depend on it.** It exists to prove the Estiva publish
pipeline end to end — publish, install in three toolchains, upgrade — before a
real extraction depends on that pipeline working. See
`estiva-docs/decisions/0002-foundation-packages.md` §6.

```ts
import { hello, HELLO_VERSION } from '@estiva-app/hello'

hello('you') // { text: 'Hello, you, from Estiva.', version: '0.0.2' }
```

Three things about it are deliberate:

- **`HELLO_VERSION` is exported** so an upgrade can be checked by grepping a
  built application bundle. A lockfile saying `0.0.2` is not evidence that the
  app you shipped contains `0.0.2`.
- **It is two files**, so the emitted relative import (`'./greeting.js'`) is
  actually exercised. A one-file package would prove nothing about the specifier
  three toolchains have to agree on.
- **`farewell` arrived in 0.0.2**, so the upgrade is visible in the type surface
  and not only in a string.

Retire it once SHA-2 lands a real package: `npm deprecate '@estiva-app/hello@*'`.
Unpublishing is only possible within 72 hours of publication.

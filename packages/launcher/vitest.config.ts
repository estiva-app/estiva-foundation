import { defineConfig } from 'vitest/config'

// The one package here whose tests draw, so it is the one that runs under Vitest and jsdom
// rather than `node --test` (KIN-4). The tests read `src/`, which is what `tsc` builds.
export default defineConfig({
  test: {
    environment: 'jsdom',
    include: ['test/**/*.test.{ts,tsx}'],
    restoreMocks: true,
  },
})

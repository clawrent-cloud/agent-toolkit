import { defineConfig } from 'vitest/config';

// Phase 3 (D follow-up): explicit vitest config for @clawrent/cli so `pnpm test`
// resolves test files without relying on vitest defaults.
export default defineConfig({
  test: {
    include: ['src/**/*.test.ts'],
  },
});

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { PROVIDER_PACKAGE_VERSION } from './index.js';

// Tracks package.json automatically across bumps: bumping requires updating
// package.json + src/index.ts PROVIDER_PACKAGE_VERSION in lockstep; this test
// guarantees they stay in sync without hardcoding the version here.
const pkg = JSON.parse(
  readFileSync(new URL('../package.json', import.meta.url), 'utf8'),
) as { version: string };

describe('provider package smoke', () => {
  it('PROVIDER_PACKAGE_VERSION matches package.json version', () => {
    expect(PROVIDER_PACKAGE_VERSION).toBe(pkg.version);
  });
});

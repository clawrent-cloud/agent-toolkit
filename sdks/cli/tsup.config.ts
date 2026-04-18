import { defineConfig } from 'tsup';

export default defineConfig([
  {
    entry: ['src/lib.ts'],
    format: ['esm'],
    dts: true,
    clean: true,
    sourcemap: true,
  },
  {
    entry: ['src/index.ts'],
    format: ['esm'],
    banner: { js: '#!/usr/bin/env node' },
    clean: false,
    sourcemap: true,
  },
]);

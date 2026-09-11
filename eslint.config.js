// Minimal, fast (non-type-aware) lint baseline for the whole monorepo.
// Flat config (ESLint 9+/10). Run via `pnpm lint` at the repo root, or
// `pnpm -r lint` (each package's `eslint src/` walks up to this config).
//
// Deliberately NOT type-aware (no projectService / parserOptions.project):
// keeps lint fast and independent of `tsc`. Type correctness is `pnpm typecheck`'s job.
import globals from "globals";
import js from "@eslint/js";
import tseslint from "typescript-eslint";

export default [
  {
    ignores: [
      // build outputs
      "**/dist/**",
      // deps / tooling artifacts
      "**/node_modules/**",
      "**/coverage/**",
      "**/reports/**",
      // worktree / scratch dirs (not part of the shipped source)
      ".superpowers/**",
    ],
  },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    languageOptions: {
      // Node + browser-ish builtins so standalone .mjs example scripts (console,
      // process, setTimeout, fetch, ...) lint cleanly without per-file noise.
      globals: { ...globals.node, ...globals.browser },
    },
    rules: {
      // ---- Tuned disables (baseline: an executable check, not a style overhaul) ----
      // Recommended set that we deliberately keep OFF, with reasons:

      // Style/consistency rules with a large diff footprint and low bug-detection
      // value for this repo. Enable deliberately later if wanted.
      "@typescript-eslint/no-non-null-assertion": "off", // repo uses `!` idiomatically; no runtime risk signal

      // NOTE: @typescript-eslint/no-explicit-any stays ON. Its single hit
      // (provider/src/api-client.ts `request<T = any>` public generic default) is
      // exempted inline with a justification comment at the call site.
    },
  },
];

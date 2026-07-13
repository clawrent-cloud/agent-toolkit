# Task 6c Report — ProviderClient.send (WS preferred + REST fallback)

**Date:** 2026-07-13
**Base HEAD:** 645c271
**Status:** ✅ Done — all checks green

## What I implemented

Added an async `send(sessionId, message)` method to `ProviderClient` in
`packages/provider/src/provider-client.ts`. The method:

1. Prefers the per-session `/ws/session` socket — when the session's
   `SessionManager.isConnected(sessionId)` is true, calls `SessionManager.send`
   and returns `{ via: 'ws' }` on success.
2. Falls back to REST `ApiClient.sendSessionMessage` when the socket is absent
   (e.g. before `start()`), not yet OPEN, or the WS send returned `false`
   (e.g. race-closed between check and send) — returns `{ via: 'rest' }`.
3. Signature exactly matches the brief:
   ```ts
   async send(
     sessionId: string,
     message: { type: string; payload: Record<string, unknown> },
   ): Promise<{ via: 'ws' | 'rest' }>
   ```

Implementation note: used a local `const sm = this.sessionManager` binding +
`sm?.isConnected(...)` so TypeScript narrows `sm` to `NonNullable` inside the
if-block. The brief's literal `this.sessionManager.send(...)` would trip
strict mode's "Object is possibly null" because `sessionManager` is mutable
class state and isn't narrowed by optional chaining through `this.`.

## TDD evidence

**RED** (before implementation):
```
FAIL  src/provider-client.test.ts > ProviderClient.send > returns via:rest when no session WS (REST fallback)
TypeError: c.send is not a function
Test Files  1 failed | 4 passed (5)
     Tests  1 failed | 18 passed (19)
```

**GREEN** (after implementation):
```
✓ src/provider-client.test.ts (6 tests) 293ms
Test Files  5 passed (5)
     Tests  19 passed (19)
```

Existing 18 tests untouched and green; the new test is the 19th.

## typecheck + build

- `pnpm --filter @clawrent/provider typecheck` → clean (tsc --noEmit, no output, exit 0)
- `pnpm --filter @clawrent/provider build` → tsup success, `dist/index.js` 30.65 KB + `dist/index.d.ts` 15.54 KB

## Files changed

- `packages/provider/src/provider-client.ts` — added `send` method (26 lines incl. doc comment) between `handleSessionMessage` and `stop`.
- `packages/provider/src/provider-client.test.ts` — appended `describe('ProviderClient.send', ...)` block with the REST-fallback test from the brief.

## Self-review findings

**Correctness — OK**
- WS-preferred: `isConnected` true → `send` true → `{via:'ws'}`. ✓
- REST fallback path covers three cases: (a) `sessionManager` null (before `start()`), (b) `isConnected` false (no/failed socket), (c) `send` returns false (socket closed between check and send — defensive). ✓
- REST errors propagate to caller (no swallow). The method itself only does not throw when WS is unavailable — that's intentional silent fallback. ✓
- Signature matches brief exactly. ✓

**Testing — partial (per brief)**
- The single test verifies the real REST-fallback branch: `ProviderClient` is constructed without `start()`, so `sessionManager` is null and the WS branch is skipped; the test stubs `client.sendSessionMessage` (so no real HTTP) and asserts `res.via === 'rest'`. This is the real branch — not a mock returning a hardcoded value. ✓
- **Concern:** the WS-preferred branch (`via: 'ws'`) is NOT covered by an automated test. Verifying it would require a real `wss` with a `/ws/session`-shaped handshake, `sessionManager.connect(...)` + awaiting `session:connected`. The brief only asks for the REST fallback test, so this was left uncovered, but it's a gap a future task should close.

**Quality — OK**
- strict-safe: no `any`, no `!` assertion; the local `sm` binding is the only deviation from the brief's literal code and is needed for strict narrowing.
- No emojis. No file split.

## Concerns

1. WS-preferred path is untested (see Testing above).
2. `client.sendSessionMessage`'s response body (`{ delivered, ... }`) is discarded — the `send` return type only exposes `{via}`. Intentional per brief, but callers needing REST receipt details won't get them via this method.
3. No observability emit (e.g. `agent:warning` / `session:event`) when WS send fails and silently falls back to REST. Probably fine for the "simplest of the trio" scope, but if a consumer is debugging "why did my message go via REST?", there's no signal.

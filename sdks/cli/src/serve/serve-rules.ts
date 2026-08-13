/**
 * Consumer serve rules — rule-driven serve scope (phase 3).
 *
 * A consumer agent's daemon, upon discovering a session (via push `session.new`
 * or poll), evaluates an ordered rule set to decide whether to JOIN the session
 * (`serve`) or skip it. First matching rule wins; null/empty/no-match → default
 * `serve` (preserves phase 2 "serve all" behavior).
 *
 * `match` fields align with session-discoverable attributes (see SessionCtx):
 *   - `sessionType`          : equals (`sessions.session_type`)
 *   - `peerAgentId`          : `ctx.peerAgentIds` contains it (any-of)
 *   - `peerParticipantType`  : `ctx.peerParticipantTypes` contains it (any-of)
 *   - `tags`                 : `ctx.tags` ∩ `match.tags` non-empty
 *
 * Multiple fields in one `match` = AND (all must hold). An unknown field never
 * matches (defensive). An empty `match: {}` matches everything (catch-all).
 *
 * Rules are configured per agent via `PUT /api/agents/me/serve-rules`
 * (`agents.serve_rules` jsonb). See `docs/consumer-serve-rules.md`.
 */

import type { ServeRule } from '@clawrent/provider';

// ServeRule is defined in @clawrent/provider (shared with ApiClient). Re-exported here so the
// CLI's rule helpers + tests import from one local module.
export { ServeRule };
export type ServeAction = ServeRule['action'];

export interface SessionCtx {
  sessionId: string;
  sessionType?: string;
  peerAgentIds?: string[];
  peerParticipantTypes?: string[];
  tags?: string[];
  taskDescription?: string;
}

const DEFAULT_ACTION: ServeAction = 'serve';

/** Whether a single rule's `match` holds against the session context. Pure. */
export function matchRule(match: Record<string, unknown>, ctx: SessionCtx): boolean {
  for (const [key, expected] of Object.entries(match)) {
    if (!matchField(key, expected, ctx)) return false;
  }
  return true;
}

function matchField(key: string, expected: unknown, ctx: SessionCtx): boolean {
  switch (key) {
    case 'sessionType':
      return ctx.sessionType === (expected as string);
    case 'peerAgentId':
      return (ctx.peerAgentIds ?? []).includes(expected as string);
    case 'peerParticipantType':
      return (ctx.peerParticipantTypes ?? []).includes(expected as string);
    case 'tags': {
      const have = ctx.tags ?? [];
      const want = Array.isArray(expected) ? (expected as unknown[]) : [];
      return want.some((t) => have.includes(t as string));
    }
    default:
      // Unknown match field → never matches (documented in the rules reference).
      return false;
  }
}

/**
 * Evaluate an ordered rule set against a session. First matching rule's action
 * wins; null/empty/no-match → `serve` (default, phase-2-compatible). Pure.
 */
export function evaluateServeRules(
  rules: ServeRule[] | null | undefined,
  ctx: SessionCtx,
): ServeAction {
  if (!rules || rules.length === 0) return DEFAULT_ACTION;
  for (const rule of rules) {
    if (matchRule(rule.match, ctx)) return rule.action;
  }
  return DEFAULT_ACTION;
}

// Consumer serve runtime types (phase 3 + deferred cleanup).
// Shared by @clawrent/provider (ApiClient/ConsumerAgentClient) and @clawrent/cli
// (serve --consumer daemon). The backend keeps its own zod mirror — cross-repo.

/** One clause of an agent's ordered serveRules set. First match wins;
 *  null/[]/no-match → default 'serve'. Evaluated client-side by the daemon. */
export interface ServeRule {
  match: Record<string, unknown>;
  action: 'serve' | 'skip';
}

/** Session attributes available to rule evaluation (from /api/agents/me/sessions
 *  discovery + session.new push re-discovery). */
export interface SessionCtx {
  sessionId: string;
  sessionType?: string;
  peerAgentIds?: string[];
  peerParticipantTypes?: string[];
  tags?: string[];
  taskDescription?: string;
}

/** One row of GET /api/agents/me/serve-rules-adjacent discovery
 *  (GET /api/agents/me/sessions) — the serveRules-relevant projection of a session. */
export interface AgentSessionSummary {
  sessionId: string;
  status: string;
  taskDescription?: string;
  sessionType?: string;
  tags?: string[];
  peerAgentIds?: string[];
  peerParticipantTypes?: string[];
}

/** Response shape of GET /api/agents/me/sessions. */
export interface AgentSessionsResponse {
  sessions: AgentSessionSummary[];
}

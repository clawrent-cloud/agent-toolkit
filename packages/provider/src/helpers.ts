import type { ApiClient } from './api-client.js';
import type { SessionManager } from './session-manager.js';
import type { ActiveSession, SessionSummary, SessionDiff } from './types.js';

/**
 * Pull active provider sessions and (re)attach their /ws/session. Returns the
 * sessions that were attached. Extracted from the old ProviderAgent.reattachActiveSessions.
 *
 * Backend getSessions returns `{ data: Array<{ id, sessionToken?, ... }> }`.
 * We accept either `id` or `sessionId` defensively; sessions missing a
 * sessionToken are skipped (their WS cannot be re-attached).
 */
export async function resumeActiveSessions(
  client: ApiClient,
  sessionManager: SessionManager,
): Promise<ActiveSession[]> {
  const res = (await client.getSessions({ role: 'provider', status: 'active' })) as {
    data?: Array<Record<string, unknown>>;
  };
  const list = res?.data ?? [];
  const attached: ActiveSession[] = [];
  for (const s of list) {
    const sessionId = s['sessionId'] ?? s['id'];
    const sessionToken = s['sessionToken'];
    if (typeof sessionId !== 'string' || typeof sessionToken !== 'string') continue;
    attached.push({
      sessionId,
      sessionToken,
      taskDescription: typeof s['taskDescription'] === 'string' ? s['taskDescription'] : undefined,
      consumerUserId: typeof s['consumerUserId'] === 'string' ? s['consumerUserId'] : undefined,
      slotIndex: typeof s['slotIndex'] === 'number' ? s['slotIndex'] : undefined,
    });
    sessionManager.connect(sessionId, sessionToken);
  }
  return attached;
}

/**
 * Diff two snapshots of getSessions() to surface lifecycle transitions.
 * Used by REST-only providers that poll (no push channel) to detect:
 *   - newPending:  session appeared in `curr` (not in `prev`) with status pending_approval
 *   - activated:   session moved from pending_approval (prev) to active (curr)
 *   - ended:       session present in `prev` but missing from `curr`
 */
export function diffSessionStates(prev: SessionSummary[], curr: SessionSummary[]): SessionDiff {
  const prevMap = new Map(prev.map((s): [string, SessionSummary] => [s.sessionId, s]));
  const currMap = new Map(curr.map((s): [string, SessionSummary] => [s.sessionId, s]));
  const newPending: SessionSummary[] = [];
  const activated: SessionSummary[] = [];
  const ended: SessionSummary[] = [];

  for (const [id, c] of currMap) {
    const p = prevMap.get(id);
    if (!p) {
      if (c.status === 'pending_approval') newPending.push(c);
    } else if (p.status === 'pending_approval' && c.status === 'active') {
      activated.push(c);
    }
  }
  for (const [id, p] of prevMap) {
    if (!currMap.has(id)) ended.push(p);
  }
  return { newPending, activated, ended };
}

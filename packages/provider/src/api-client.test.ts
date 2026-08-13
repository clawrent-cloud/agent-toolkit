import { describe, it, expect, vi, afterEach } from 'vitest';
import { ApiClient } from './api-client.js';

describe('ApiClient.getMyAgentSessions', () => {
  afterEach(() => vi.restoreAllMocks());

  it('GETs /api/agents/me/sessions with the agent token', async () => {
    const body = { sessions: [{ sessionId: 's1', status: 'active', taskDescription: 't' }] };
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(JSON.stringify(body), { status: 200, headers: { 'Content-Type': 'application/json' } }),
    );
    const c = new ApiClient({ apiUrl: 'http://test', wsUrl: 'ws://test' });
    c.setAgentToken('agt_test');

    const out = await c.getMyAgentSessions();

    expect(out).toEqual(body);
    expect(fetchMock).toHaveBeenCalledWith(
      'http://test/api/agents/me/sessions',
      expect.objectContaining({
        method: 'GET',
        headers: expect.objectContaining({ Authorization: 'Bearer agt_test' }),
      }),
    );
  });
});

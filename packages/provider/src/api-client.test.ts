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

describe('ApiClient.setStaffToken', () => {
  afterEach(() => vi.restoreAllMocks());

  const okResponse = () =>
    new Response(JSON.stringify({ ok: true }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    });

  it('sends only X-Staff-Token and no Authorization/x-api-key when set', async () => {
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValue(okResponse());
    const c = new ApiClient({ apiUrl: 'http://test', wsUrl: 'ws://test', token: 'user_jwt', apiKey: 'ak_test' });
    c.setStaffToken('stf_x');

    await c.getMe();

    expect(fetchMock).toHaveBeenCalledWith(
      'http://test/api/auth/me',
      expect.objectContaining({
        headers: expect.not.objectContaining({ Authorization: expect.anything() }),
      }),
    );
    expect(fetchMock).toHaveBeenCalledWith(
      'http://test/api/auth/me',
      expect.objectContaining({
        headers: expect.not.objectContaining({ 'x-api-key': expect.anything() }),
      }),
    );
    const { headers } = fetchMock.mock.calls[0]![1] as { headers: Record<string, string> };
    expect(headers['X-Staff-Token']).toBe('stf_x');
  });

  it('staff token wins over agentToken (no Bearer header sent)', async () => {
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValue(okResponse());
    const c = new ApiClient({ apiUrl: 'http://test', wsUrl: 'ws://test' });
    c.setAgentToken('agt_test');
    c.setStaffToken('stf_x');

    await c.getMyAgentSessions();

    const { headers } = fetchMock.mock.calls[0]![1] as { headers: Record<string, string> };
    expect(headers['X-Staff-Token']).toBe('stf_x');
    expect(headers).not.toHaveProperty('Authorization');
  });

  it('setStaffToken(null) clears the override and restores Bearer auth', async () => {
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValue(okResponse());
    const c = new ApiClient({ apiUrl: 'http://test', wsUrl: 'ws://test', token: 'user_jwt' });
    c.setStaffToken('stf_x');
    c.setStaffToken(null);

    await c.getMe();

    const { headers } = fetchMock.mock.calls[0]![1] as { headers: Record<string, string> };
    expect(headers['Authorization']).toBe('Bearer user_jwt');
    expect(headers).not.toHaveProperty('X-Staff-Token');
  });
});

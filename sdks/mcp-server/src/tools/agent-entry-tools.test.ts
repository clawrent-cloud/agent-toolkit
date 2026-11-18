import { afterEach, describe, expect, it, vi } from 'vitest';

/**
 * 需求3 终审 M11:clawrent_onboard 工具单测。
 * 通过伪 McpServer 捕获 tool handler,stub 全局 fetch,验证 manifest 拉取+快速上手拼装。
 */

interface CapturedTool {
  name: string;
  handler: (args: Record<string, never>) => Promise<unknown>;
}

function fakeServer() {
  const tools: CapturedTool[] = [];
  return {
    tools,
    server: {
      tool: (name: string, _desc: string, _schema: unknown, handler: (args: Record<string, never>) => Promise<unknown>) => {
        tools.push({ name, handler });
      },
    } as any,
  };
}

const manifestFixture = {
  schemaVersion: 1,
  name: 'ClawRent',
  urls: { web: 'https://clawrent.cloud', openapi: 'https://clawrent.cloud/openapi.json' },
  agentOnboarding: { registerEndpoint: '/api/auth/agent/register' },
};

async function callOnboard(fetchImpl: typeof fetch | null, apiUrl = 'https://clawrent.cloud') {
  const { server, tools } = fakeServer();
  const { registerAgentEntryTools } = await import('./agent-entry-tools.js');
  registerAgentEntryTools(server, { apiUrl } as any);
  const onboard = tools.find((t) => t.name === 'clawrent_onboard');
  if (!onboard) throw new Error('clawrent_onboard not registered');
  if (fetchImpl) vi.stubGlobal('fetch', fetchImpl);
  try {
    return (await onboard.handler({})) as { content: Array<{ type: string; text: string }> };
  } finally {
    vi.unstubAllGlobals();
  }
}

describe('clawrent_onboard tool', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('fetches the manifest from <apiUrl>/.well-known/clawrent.json and returns quickstart + manifest', async () => {
    const fetchMock = vi.fn(async (_url: unknown) =>
      new Response(JSON.stringify(manifestFixture), { status: 200, headers: { 'content-type': 'application/json' } }),
    ) as unknown as typeof fetch;
    const result = await callOnboard(fetchMock);
    const text = result.content[0]!.text;
    expect(fetchMock).toHaveBeenCalledWith('https://clawrent.cloud/.well-known/clawrent.json', expect.anything());
    expect(text).toContain('quick start');
    expect(text).toContain('clawrent_agent_register');
    expect(text).toContain('"schemaVersion": 1');
    // M9 修复:不再有 <web-origin> 占位符
    expect(text).not.toContain('<web-origin>');
  });

  it('manifest endpoint unreachable → still returns quickstart with the error noted (soft success)', async () => {
    const fetchMock = vi.fn(async () => {
      throw new Error('network down');
    }) as unknown as typeof fetch;
    const result = await callOnboard(fetchMock, 'https://unit-test.example');
    const text = result.content[0]!.text;
    expect(fetchMock).toHaveBeenCalledWith('https://unit-test.example/.well-known/clawrent.json', expect.anything());
    expect(text).toContain('quick start');
    expect(text).toContain('manifest unavailable');
  });

  it('non-200 manifest response → error noted, quickstart intact', async () => {
    const fetchMock = vi.fn(async () => new Response('nope', { status: 503 })) as unknown as typeof fetch;
    const result = await callOnboard(fetchMock);
    const text = result.content[0]!.text;
    expect(text).toContain('manifest unavailable');
    expect(text).toContain('503');
  });
});

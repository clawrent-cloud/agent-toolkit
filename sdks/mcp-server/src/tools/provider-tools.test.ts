import { beforeEach, describe, expect, it, vi } from 'vitest';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { registerProviderTools } from './provider-tools.js';

/**
 * clawrent_publish_agent 适配(P2-12,2026-10-27):平台 /publish 新必填
 * providerAgreementAccepted(consent 留痕),且 per_token 定价已关闸。
 * 工具级契约:调用方必须显式传 providerAgreementAccepted:true(z.literal(true),
 * 布尔肯定式同意),pricing 枚举移除 per_token——SDK 在 zod 层就挡,不进 handler。
 * 驱动真实 McpServer 走 in-memory wire(与 mecha-tools.test 同纪律)。
 */

let publishAgent: ReturnType<typeof vi.fn>;

async function makeHarness(): Promise<Client> {
  const server = new McpServer({ name: 'clawrent-provider-test', version: '0.0.0' });
  publishAgent = vi.fn(async () => ({ agentId: 'a1', status: 'pending_review' }));
  const client = { publishAgent } as unknown as import('@clawrent/provider').ApiClient;
  registerProviderTools(server, client, {} as never);
  const mcpClient = new Client({ name: 'provider-test-client', version: '0.0.0' });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(clientTransport), mcpClient.connect(serverTransport)]);
  return mcpClient;
}

async function callText(client: Client, name: string, args: Record<string, unknown>) {
  const result = (await client.callTool({ name, arguments: args })) as {
    content?: Array<{ type: string; text?: string }>;
    isError?: boolean;
  };
  const first = result.content?.[0];
  return { text: first?.type === 'text' ? (first.text ?? '') : '', isError: result.isError === true };
}

describe('clawrent_publish_agent 契约(P2-7 发布后适配)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('未带 providerAgreementAccepted → zod 层拒绝(平台已把它设为必填,consent 留痕)', async () => {
    const client = await makeHarness();
    const r = await callText(client, 'clawrent_publish_agent', { agentId: 'a1' });
    expect(r.isError).toBe(true);
    expect(r.text).toContain('providerAgreementAccepted');
    expect(publishAgent).not.toHaveBeenCalled();
  });

  it('providerAgreementAccepted=false → 同样拒绝(必须显式布尔肯定)', async () => {
    const client = await makeHarness();
    const r = await callText(client, 'clawrent_publish_agent', {
      agentId: 'a1',
      providerAgreementAccepted: false,
    });
    expect(r.isError).toBe(true);
    expect(publishAgent).not.toHaveBeenCalled();
  });

  it('显式 true → 透传到 publishAgent 请求体;per_token 不在枚举内', async () => {
    const client = await makeHarness();
    const r = await callText(client, 'clawrent_publish_agent', {
      agentId: 'a1',
      providerAgreementAccepted: true,
      pricingModel: 'per_session',
      priceAmount: '5',
    });
    expect(r.isError).toBe(false);
    expect(publishAgent).toHaveBeenCalledTimes(1);
    expect(publishAgent).toHaveBeenCalledWith('a1', expect.objectContaining({
      providerAgreementAccepted: true,
      pricingModel: 'per_session',
      priceAmount: '5',
    }));

    const bad = await callText(client, 'clawrent_publish_agent', {
      agentId: 'a1',
      providerAgreementAccepted: true,
      pricingModel: 'per_token',
    });
    expect(bad.isError).toBe(true);
    expect(publishAgent).toHaveBeenCalledTimes(1);
  });
});

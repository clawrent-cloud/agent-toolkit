import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Mock } from 'vitest';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { MechaDriver, type MechaChannel } from '@clawrent/provider';
import { Mecha } from '@clawrent/protocol';
import { getMechaDriver, registerMechaTools, setMechaDriver } from './mecha-tools.js';

/**
 * clawrent_mecha_* tool group tests (plan Task 22, R24/R25 mirrored). Each test
 * drives a REAL McpServer through an in-memory client, so the tools are
 * exercised over the actual MCP wire path: the SDK enforces the Zod input
 * schemas (invalid input rejects the call BEFORE any handler runs) and handlers
 * are asserted via a jest-style mocked MechaDriver (same discipline as
 * mecha-driver.test.ts). One integration test runs against a REAL MechaDriver
 * on a mock channel to guard delegation-signature drift.
 */

/** Valid CapabilityManifest payload (Mecha.CapabilityManifestSchema-valid). */
const MANIFEST: Mecha.CapabilityManifest = {
  sessionId: 'sess-mcp-1',
  policy: {
    dirs: ['/work/proj'],
    programs: [{ name: 'python', absPath: '/usr/bin/python' }],
    limits: { ...Mecha.MECHA_LIMITS_DEFAULTS },
  },
  mechaVersion: '0.1.0',
  scratchDir: '/work/proj/.clawrent/scratch/sess-mcp-1',
};

function okResult(overrides: Partial<Mecha.MechaOpResult> = {}): Mecha.MechaOpResult {
  return { opId: 'op-1', ok: true, ...overrides };
}

interface MockDriverShape {
  getManifest: Mock;
  fsList: Mock;
  fsRead: Mock;
  fsWrite: Mock;
  fsMove: Mock;
  fsDelete: Mock;
  upload: Mock;
  exec: Mock;
}

/** MechaDriver double: every method the tools delegate to is a vi.fn. */
function makeMockDriver(): MechaDriver & MockDriverShape {
  const ok = okResult();
  const shape: MockDriverShape = {
    getManifest: vi.fn(() => MANIFEST),
    fsList: vi.fn(async () => ok),
    fsRead: vi.fn(async () => ok),
    fsWrite: vi.fn(async () => ok),
    fsMove: vi.fn(async () => ok),
    fsDelete: vi.fn(async () => ok),
    upload: vi.fn(async () => ok),
    exec: vi.fn(async () => ok),
  };
  return shape as unknown as MechaDriver & MockDriverShape;
}

/** Spin a real MCP server with the mecha tools registered and connect an
 * in-memory client to it. `getDriver` is the injectable driver provider. */
async function makeHarness(getDriver: () => MechaDriver | null): Promise<Client> {
  const server = new McpServer({ name: 'clawrent-mecha-test', version: '0.0.0' });
  registerMechaTools(server, getDriver);
  const client = new Client({ name: 'clawrent-mecha-test-client', version: '0.0.0' });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(clientTransport), client.connect(serverTransport)]);
  return client;
}

interface ToolTextResult {
  text: string;
  isError: boolean;
}

/** Call a tool and return its first text content + isError flag. */
async function callText(
  client: Client,
  name: string,
  args: Record<string, unknown> = {},
): Promise<ToolTextResult> {
  const result = (await client.callTool({ name, arguments: args })) as {
    content?: Array<{ type: string; text?: string }>;
    isError?: boolean;
  };
  const first = result.content?.[0];
  const text = first?.type === 'text' ? (first.text ?? '') : '';
  return { text, isError: result.isError === true };
}

/** The 8 tools (plan list minus the R24-cut clawrent_mecha_request_expansion)
 * with schema-valid minimal arguments. */
const TOOL_CASES: Array<[string, Record<string, unknown>]> = [
  ['clawrent_mecha_manifest', {}],
  ['clawrent_mecha_fs_list', { path: '/work/proj' }],
  ['clawrent_mecha_fs_read', { path: '/work/proj/a.txt' }],
  ['clawrent_mecha_fs_write', { path: '/work/proj/a.txt', content: 'x' }],
  ['clawrent_mecha_fs_move', { from: '/work/proj/a', to: '/work/proj/b' }],
  ['clawrent_mecha_fs_delete', { path: '/work/proj/a' }],
  ['clawrent_mecha_upload', { name: 'tool.py', content: 'print(1)' }],
  ['clawrent_mecha_exec', { argv: ['ls'], cwd: '/work/proj' }],
];

const ALL_TOOL_NAMES = TOOL_CASES.map(([name]) => name);

/** Minimal synchronous mock channel for the real-driver integration test. */
class MockChannel implements MechaChannel {
  readonly sent: unknown[] = [];
  private listener: ((msg: unknown) => void) | null = null;

  send(message: unknown): void {
    this.sent.push(message);
  }

  onMessage(cb: (msg: unknown) => void): void {
    this.listener = cb;
  }

  inbound(msg: unknown): void {
    this.listener?.(msg);
  }
}

beforeEach(() => {
  // Module-level holder isolation between tests.
  setMechaDriver(null);
});

describe('registration', () => {
  it('registers exactly the 8 mecha tools (R24: no clawrent_mecha_request_expansion)', async () => {
    const client = await makeHarness(() => null);
    const { tools } = await client.listTools();
    const names = tools.map((t) => t.name).sort();
    expect(names).toEqual([...ALL_TOOL_NAMES].sort());
    expect(names).not.toContain('clawrent_mecha_request_expansion');
  });

  it('every tool describes the argv-array contract on clawrent_mecha_exec', async () => {
    const client = await makeHarness(() => null);
    const { tools } = await client.listTools();
    const exec = tools.find((t) => t.name === 'clawrent_mecha_exec');
    expect(exec?.description).toContain('argv');
    expect(exec?.description).toMatch(/never a shell command string/i);
  });
});

describe('per-tool delegation (mock driver)', () => {
  it('clawrent_mecha_manifest returns the driver manifest as JSON', async () => {
    const driver = makeMockDriver();
    const client = await makeHarness(() => driver);

    const { text, isError } = await callText(client, 'clawrent_mecha_manifest');

    expect(driver.getManifest).toHaveBeenCalledTimes(1);
    expect(isError).toBe(false);
    expect(JSON.parse(text)).toEqual(MANIFEST);
  });

  it('clawrent_mecha_fs_list passes path + optional depth/glob', async () => {
    const driver = makeMockDriver();
    const client = await makeHarness(() => driver);

    await callText(client, 'clawrent_mecha_fs_list', {
      path: '/work/proj',
      depth: 2,
      glob: '*.csv',
    });
    expect(driver.fsList).toHaveBeenCalledWith('/work/proj', { depth: 2, glob: '*.csv' });

    await callText(client, 'clawrent_mecha_fs_list', { path: '/work/proj' });
    expect(driver.fsList).toHaveBeenLastCalledWith('/work/proj', {});
  });

  it('clawrent_mecha_fs_read defaults encoding to utf8 and passes base64 through', async () => {
    const driver = makeMockDriver();
    const client = await makeHarness(() => driver);

    await callText(client, 'clawrent_mecha_fs_read', { path: '/work/proj/a.txt' });
    expect(driver.fsRead).toHaveBeenCalledWith('/work/proj/a.txt', 'utf8');

    await callText(client, 'clawrent_mecha_fs_read', {
      path: '/work/proj/a.bin',
      encoding: 'base64',
    });
    expect(driver.fsRead).toHaveBeenCalledWith('/work/proj/a.bin', 'base64');
  });

  it('clawrent_mecha_fs_write defaults encoding to utf8 and passes content through', async () => {
    const driver = makeMockDriver();
    const client = await makeHarness(() => driver);

    await callText(client, 'clawrent_mecha_fs_write', {
      path: '/work/proj/out.txt',
      content: 'hello',
    });
    expect(driver.fsWrite).toHaveBeenCalledWith('/work/proj/out.txt', 'hello', 'utf8');

    await callText(client, 'clawrent_mecha_fs_write', {
      path: '/work/proj/out.bin',
      content: 'aGk=',
      encoding: 'base64',
    });
    expect(driver.fsWrite).toHaveBeenCalledWith('/work/proj/out.bin', 'aGk=', 'base64');
  });

  it('clawrent_mecha_fs_move passes from/to', async () => {
    const driver = makeMockDriver();
    const client = await makeHarness(() => driver);

    await callText(client, 'clawrent_mecha_fs_move', {
      from: '/work/proj/a',
      to: '/work/proj/b',
    });
    expect(driver.fsMove).toHaveBeenCalledWith('/work/proj/a', '/work/proj/b');
  });

  it('clawrent_mecha_fs_delete defaults recursive to false and passes true through', async () => {
    const driver = makeMockDriver();
    const client = await makeHarness(() => driver);

    await callText(client, 'clawrent_mecha_fs_delete', { path: '/work/proj/a.txt' });
    expect(driver.fsDelete).toHaveBeenCalledWith('/work/proj/a.txt', false);

    await callText(client, 'clawrent_mecha_fs_delete', {
      path: '/work/proj/dir',
      recursive: true,
    });
    expect(driver.fsDelete).toHaveBeenCalledWith('/work/proj/dir', true);
  });

  it('clawrent_mecha_upload passes name/content', async () => {
    const driver = makeMockDriver();
    const client = await makeHarness(() => driver);

    await callText(client, 'clawrent_mecha_upload', { name: 'tool.py', content: 'print(1)' });
    expect(driver.upload).toHaveBeenCalledWith('tool.py', 'print(1)');
  });

  it('clawrent_mecha_exec passes the argv array (never a string) + cwd, timeoutMs optional', async () => {
    const driver = makeMockDriver();
    const client = await makeHarness(() => driver);

    await callText(client, 'clawrent_mecha_exec', {
      argv: ['python', 'tool.py'],
      cwd: '/work/proj',
    });
    expect(driver.exec).toHaveBeenCalledWith({ argv: ['python', 'tool.py'], cwd: '/work/proj' });

    await callText(client, 'clawrent_mecha_exec', {
      argv: ['node', 'x.js'],
      cwd: '/work/proj',
      timeoutMs: 5000,
    });
    expect(driver.exec).toHaveBeenLastCalledWith({
      argv: ['node', 'x.js'],
      cwd: '/work/proj',
      timeoutMs: 5000,
    });
  });

  it('returns the MechaOpResult JSON verbatim on success', async () => {
    const driver = makeMockDriver();
    driver.fsList.mockResolvedValueOnce({ opId: 'op-9', ok: true, value: ['a.csv', 'b.csv'] });
    const client = await makeHarness(() => driver);

    const { text, isError } = await callText(client, 'clawrent_mecha_fs_list', {
      path: '/work/proj',
    });

    expect(isError).toBe(false);
    expect(JSON.parse(text)).toEqual({ opId: 'op-9', ok: true, value: ['a.csv', 'b.csv'] });
  });
});

describe('clawrent_mecha_exec input schema (argv array, not a command string)', () => {
  it.each([
    ['a plain command string', { argv: 'python tool.py', cwd: '/work/proj' }],
    ['an empty argv array', { argv: [], cwd: '/work/proj' }],
    ['an argv with an empty item', { argv: ['python', ''], cwd: '/work/proj' }],
    ['a missing argv', { cwd: '/work/proj' }],
    ['a missing cwd', { argv: ['ls'] }],
    ['a zero timeoutMs', { argv: ['ls'], cwd: '/work/proj', timeoutMs: 0 }],
    ['a non-integer timeoutMs', { argv: ['ls'], cwd: '/work/proj', timeoutMs: 1.5 }],
  ])('rejects %s before the handler runs', async (_label, args) => {
    const driver = makeMockDriver();
    const client = await makeHarness(() => driver);

    // SDK 1.29 converts input-schema violations into an isError CallToolResult
    // (JSON-RPC error text preserved in content[0].text).
    const { text, isError } = await callText(client, 'clawrent_mecha_exec', args);

    expect(isError).toBe(true);
    expect(text).toContain('Invalid arguments for tool clawrent_mecha_exec');
    expect(driver.exec).not.toHaveBeenCalled();
  });
});

describe('other tools input schemas', () => {
  it.each([
    ['clawrent_mecha_fs_read rejects an unknown encoding', 'clawrent_mecha_fs_read', { path: '/x', encoding: 'binary' }],
    ['clawrent_mecha_fs_delete rejects a string recursive', 'clawrent_mecha_fs_delete', { path: '/x', recursive: 'yes' }],
    ['clawrent_mecha_fs_list rejects a negative depth', 'clawrent_mecha_fs_list', { path: '/x', depth: -1 }],
    ['clawrent_mecha_fs_list rejects a fractional depth', 'clawrent_mecha_fs_list', { path: '/x', depth: 1.5 }],
    ['clawrent_mecha_fs_write rejects a missing path', 'clawrent_mecha_fs_write', { content: 'x' }],
    ['clawrent_mecha_fs_move rejects a missing to', 'clawrent_mecha_fs_move', { from: '/x' }],
    ['clawrent_mecha_upload rejects a missing content', 'clawrent_mecha_upload', { name: 't.py' }],
  ])('%s', async (_label, name, args) => {
    const driver = makeMockDriver();
    const client = await makeHarness(() => driver);

    const { text, isError } = await callText(client, name, args);

    expect(isError).toBe(true);
    expect(text).toContain(`Invalid arguments for tool ${name}`);
  });
});

describe('opResult surfacing (R25: immediate structured result, T2 red-card guidance)', () => {
  it('CONFIRM_DENIED carries the error code + message + adjust-guidance text, not a tool error', async () => {
    const driver = makeMockDriver();
    driver.fsWrite.mockResolvedValueOnce({
      opId: 'op-2',
      ok: false,
      tier: 'T2',
      error: { code: 'CONFIRM_DENIED', message: 'consumer rejected the script' },
    });
    const client = await makeHarness(() => driver);

    const { text, isError } = await callText(client, 'clawrent_mecha_fs_write', {
      path: '/work/proj/out.txt',
      content: 'x',
    });

    expect(isError).toBe(false);
    expect(text).toContain('"CONFIRM_DENIED"');
    expect(text).toContain('consumer rejected the script');
    expect(text).toContain('"tier": "T2"');
    expect(text).toContain('消费者未批准/超时，请调整方案或询问消费者');
  });

  it('CONFIRM_TIMEOUT gets the same guidance', async () => {
    const driver = makeMockDriver();
    driver.exec.mockResolvedValueOnce({
      opId: 'op-3',
      ok: false,
      tier: 'T2',
      error: { code: 'CONFIRM_TIMEOUT', message: 'no answer within 300s' },
    });
    const client = await makeHarness(() => driver);

    const { text } = await callText(client, 'clawrent_mecha_exec', {
      argv: ['python', 'long.py'],
      cwd: '/work/proj',
    });

    expect(text).toContain('"CONFIRM_TIMEOUT"');
    expect(text).toContain('消费者未批准/超时，请调整方案或询问消费者');
  });

  it('a non-confirm failure (IO_ERROR) surfaces code+message WITHOUT the confirm guidance', async () => {
    const driver = makeMockDriver();
    driver.fsRead.mockResolvedValueOnce({
      opId: 'op-4',
      ok: false,
      error: { code: 'IO_ERROR', message: 'no such file' },
    });
    const client = await makeHarness(() => driver);

    const { text } = await callText(client, 'clawrent_mecha_fs_read', {
      path: '/work/proj/missing.txt',
    });

    expect(text).toContain('"IO_ERROR"');
    expect(text).toContain('no such file');
    expect(text).not.toContain('消费者未批准/超时');
  });
});

describe('driver null → every tool answers 机甲未连接', () => {
  it.each(TOOL_CASES)('%s', async (name, args) => {
    const client = await makeHarness(() => null);

    const { text, isError } = await callText(client, name, args);

    expect(isError).toBe(true);
    expect(text).toContain('机甲未连接');
  });

  it('a driver that has not received mecha.manifest yet also answers 机甲未连接 on the manifest tool', async () => {
    const driver = makeMockDriver();
    driver.getManifest.mockReturnValueOnce(null);
    const client = await makeHarness(() => driver);

    const { text, isError } = await callText(client, 'clawrent_mecha_manifest');

    expect(driver.getManifest).toHaveBeenCalledTimes(1);
    expect(isError).toBe(true);
    expect(text).toContain('机甲未连接');
    expect(text).toMatch(/manifest/i);
  });
});

describe('driver faults → isError with the message', () => {
  it('a synchronous driver throw (e.g. not attached yet) becomes an isError result', async () => {
    const driver = makeMockDriver();
    driver.fsList.mockImplementationOnce(() => {
      throw new Error('MechaDriver: not attached — no mecha.manifest received yet');
    });
    const client = await makeHarness(() => driver);

    const { text, isError } = await callText(client, 'clawrent_mecha_fs_list', {
      path: '/work/proj',
    });

    expect(isError).toBe(true);
    expect(text).toContain('not attached');
  });

  it('an async driver rejection becomes an isError result too', async () => {
    const driver = makeMockDriver();
    driver.upload.mockRejectedValueOnce(new Error('channel closed'));
    const client = await makeHarness(() => driver);

    const { text, isError } = await callText(client, 'clawrent_mecha_upload', {
      name: 't.py',
      content: 'x',
    });

    expect(isError).toBe(true);
    expect(text).toContain('channel closed');
  });
});

describe('module-level driver holder (future platform-side adapter seam)', () => {
  it('getMechaDriver starts null; setMechaDriver stores and null resets', () => {
    expect(getMechaDriver()).toBeNull();

    const driver = makeMockDriver();
    setMechaDriver(driver);
    expect(getMechaDriver()).toBe(driver);

    setMechaDriver(null);
    expect(getMechaDriver()).toBeNull();
  });

  it('registerMechaTools without a getDriver reads the holder dynamically per call', async () => {
    // Holder still null → 未连接.
    const client = await makeHarness(getMechaDriver);
    const before = await callText(client, 'clawrent_mecha_manifest');
    expect(before.isError).toBe(true);

    // Adapter injects the driver AFTER registration → next call sees it.
    const driver = makeMockDriver();
    setMechaDriver(driver);
    const after = await callText(client, 'clawrent_mecha_manifest');
    expect(after.isError).toBe(false);
    expect(JSON.parse(after.text)).toEqual(MANIFEST);
  });
});

describe('integration with a REAL MechaDriver (delegation drift guard)', () => {
  it('manifest + fs.write round-trip over a mock channel', async () => {
    const channel = new MockChannel();
    const driver = new MechaDriver({ channel, agentId: 'agent-mcp' });
    const client = await makeHarness(() => driver);

    // Before attach: manifest tool answers 未连接 (no crash, no leak of internals).
    const pre = await callText(client, 'clawrent_mecha_manifest');
    expect(pre.isError).toBe(true);

    // Attach via an inbound mecha.manifest, then the manifest tool reads it.
    channel.inbound({ type: 'mecha.manifest', payload: MANIFEST });
    const m = await callText(client, 'clawrent_mecha_manifest');
    expect(m.isError).toBe(false);
    expect(JSON.parse(m.text)['sessionId']).toBe(MANIFEST.sessionId);

    // fs_write delegation builds the correct wire op (defaults applied). The
    // call is in flight (its promise settles only when we feed the opResult),
    // so wait for the server side to dispatch it onto the channel.
    const callPromise = client.callTool({
      name: 'clawrent_mecha_fs_write',
      arguments: { path: '/work/proj/out.txt', content: 'hello' },
    });
    await vi.waitFor(() => expect(channel.sent).toHaveLength(1));
    const envelope = (channel.sent[0] as { payload: { opId: string; op: Record<string, unknown> } })
      .payload;
    expect(envelope.op).toEqual({
      type: 'fs.write',
      path: '/work/proj/out.txt',
      content: 'hello',
      encoding: 'utf8',
    });

    // Correlated opResult settles the tool call.
    channel.inbound({
      type: 'mecha.opResult',
      payload: { opId: envelope.opId, ok: true, tier: 'T1', value: 'written' },
    });
    const result = (await callPromise) as { content?: Array<{ text?: string }> };
    expect(result.content?.[0]?.text).toContain('"ok": true');
    expect(result.content?.[0]?.text).toContain('"tier": "T1"');
  });

  it('fs ops BEFORE attach surface the driver throw as an isError result', async () => {
    const channel = new MockChannel();
    const driver = new MechaDriver({ channel, agentId: 'agent-mcp' });
    const client = await makeHarness(() => driver);

    const { text, isError } = await callText(client, 'clawrent_mecha_fs_list', {
      path: '/work/proj',
    });

    expect(isError).toBe(true);
    expect(text).toContain('not attached');
    expect(channel.sent).toHaveLength(0);
  });
});

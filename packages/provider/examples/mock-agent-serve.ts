/**
 * mock-agent-serve.ts — local real-agent test harness for ClawRent.
 *
 * Spins up mock agents that authenticate against a group session and reply with
 * a deterministic mock response (no external LLM). Two serve models:
 *
 *  - PROVIDER agent (`--side=provider`, default): uses `ProviderClient` — the
 *    production model. Connects /ws/agent (presence) + activateAgent + serves
 *    every active session it's rented in (resumeActive + session.new/approved).
 *    This is the path the channel plugin (PinkBo) takes in production.
 *
 *  - CONSUMER agent (`--side=consumer`): uses `ConsumerAgentClient` — the
 *    consumer-side model. Consumer agents have no provider profile, so they
 *    CAN'T use activateAgent (400 No provider profile). ConsumerAgentClient
 *    skips /ws/agent entirely and connects /ws/group directly for each session
 *    id you pass (--session-ids). Replies stamp sender.side='consumer'.
 *
 * Purpose: automate UAT of multi-participant group sessions (direction / real
 * WS timing / multi-agent chat) WITHOUT depending on an external LLM. Reply
 * QUALITY is covered by the manual real-LLM layer, not this script.
 *
 * ── Secrets ────────────────────────────────────────────────────────────────
 * Agent tokens are read from CLI args / env only — NEVER hardcoded. Log output
 * masks tokens (`agt_abc1…wxyz`). Do not commit a real config file; use the
 * committed `mock-agents.example.json` as a template and keep your real one
 * outside the repo (or git-ignored).
 *
 * ── Usage ──────────────────────────────────────────────────────────────────
 *   # Provider agent (auto-serves all its active sessions):
 *   npx tsx examples/mock-agent-serve.ts --token=agt_xxx --side=provider
 *
 *   # Consumer agent (must pass the session ids it participates in):
 *   npx tsx examples/mock-agent-serve.ts --token=agt_yyy --side=consumer \
 *     --session-ids=sess-aaa,sess-bbb
 *
 *   # Multiple agents via a JSON config file (see mock-agents.example.json):
 *   npx tsx examples/mock-agent-serve.ts --config=./mock-agents.local.json
 *
 *   # Override endpoints (defaults point at local dev nginx :13100, which
 *   # proxies /api and /ws to platform-api:3001 — see docker/nginx.dev.conf):
 *   npx tsx examples/mock-agent-serve.ts --token=agt_xxx \
 *     --api-url=http://localhost:13100 --ws-url=ws://localhost:13100
 */
import { readFileSync } from 'node:fs';
import { ProviderClient, ConsumerAgentClient } from '../src/index.js';

type Side = 'provider' | 'consumer';

interface MockAgentConfig {
  /** Agent token (agt_…). Required. */
  agentToken: string;
  /** Agent id. Optional — omitted => resolved via getMyAgent(agentToken). */
  agentId?: string;
  /** Serve model. 'provider' (default) uses ProviderClient; 'consumer' uses
   *  ConsumerAgentClient and REQUIRES sessionIds. */
  side?: Side;
  /** consumer-only: session ids the consumer agent participates in. Required
   *  for side=consumer (the consumer model has no auto-discovery). */
  sessionIds?: string[];
  /** Fixed reply text. Omitted => rule-based echo. */
  replyText?: string;
  /** Simulated reply latency in ms (fault-injection hook). */
  replyDelayMs?: number;
  /** Fault injection: 'drop' = periodically forceDisconnectAll (test reconnect). */
  fault?: 'drop';
  /** Log tag. Defaults to `${side}#${index}(<masked token>)`. */
  tag?: string;
}

interface GlobalOptions {
  apiUrl: string;
  wsUrl: string;
  configs: MockAgentConfig[];
}

/** Shared send shape both ProviderClient and ConsumerAgentClient satisfy. */
interface ServeClient {
  send(sid: string, message: { type: string; payload: Record<string, unknown>; mentions?: string[] }): Promise<{ via: 'ws'; delivered: boolean }>;
}

const DEFAULT_API_URL = 'http://localhost:13100';
const DEFAULT_WS_URL = 'ws://localhost:13100';

const sleep = (ms: number): Promise<void> => new Promise(r => setTimeout(r, ms));

/** Mask a token for safe logging: `agt_abc1…wxyz`. */
function mask(token: string): string {
  if (!token) return '<empty>';
  if (token.length <= 12) return `${token.slice(0, 4)}…`;
  return `${token.slice(0, 8)}…${token.slice(-4)}`;
}

function makeLogger(tag: string): (event: string, extra?: Record<string, unknown>) => void {
  return (event, extra) => {
    const ts = new Date().toISOString();
    const tail = extra ? ' ' + JSON.stringify(extra) : '';
    console.log(`[${ts}] [${tag}] ${event}${tail}`);
  };
}

/** Parse `--key=value` CLI args into a record. */
function parseArgs(): Record<string, string> {
  const out: Record<string, string> = {};
  for (const arg of process.argv.slice(2)) {
    const m = arg.match(/^--([\w-]+)=(.*)$/);
    if (m) out[m[1]] = m[2];
  }
  return out;
}

function loadOptions(): GlobalOptions {
  const args = parseArgs();

  const apiUrl = args['api-url'] ?? process.env.API_URL ?? DEFAULT_API_URL;
  const wsUrl = args['ws-url'] ?? process.env.WS_URL ?? DEFAULT_WS_URL;

  const file = args['config'] ?? process.env.MOCK_AGENTS_FILE;
  if (file) {
    let raw: unknown;
    try {
      raw = JSON.parse(readFileSync(file, 'utf8'));
    } catch (err) {
      throw new Error(`failed to read --config=${file}: ${(err as Error).message}`, { cause: err });
    }
    if (!Array.isArray(raw)) {
      throw new Error(`${file}: expected a JSON array of agent configs`);
    }
    const configs = (raw as MockAgentConfig[]).filter(c => c && c.agentToken);
    if (!configs.length) throw new Error(`${file}: no configs with an agentToken`);
    return { apiUrl, wsUrl, configs };
  }

  // Single-agent convenience flags (CLI > env).
  const token = args['token'] ?? process.env.MOCK_AGENT_TOKEN;
  if (!token) return { apiUrl, wsUrl, configs: [] };

  const side = (args['side'] ?? process.env.MOCK_AGENT_SIDE ?? 'provider') as Side;
  if (side !== 'provider' && side !== 'consumer') {
    throw new Error(`invalid --side=${side} (expected 'provider' | 'consumer')`);
  }
  const delayRaw = args['reply-delay'] ?? process.env.MOCK_REPLY_DELAY_MS;
  const sessionIdsRaw = args['session-ids'] ?? process.env.MOCK_SESSION_IDS;
  return {
    apiUrl,
    wsUrl,
    configs: [{
      agentToken: token,
      agentId: args['agent-id'] ?? process.env.MOCK_AGENT_ID,
      side,
      sessionIds: sessionIdsRaw ? sessionIdsRaw.split(',').map(s => s.trim()).filter(Boolean) : undefined,
      replyText: args['reply'] ?? process.env.MOCK_REPLY,
      replyDelayMs: delayRaw ? Number(delayRaw) : undefined,
      fault: process.env.MOCK_FAULT === 'drop' ? 'drop' : undefined,
    }],
  };
}

function printHelpAndExit(): never {
  const help = `mock-agent-serve: no agent configs provided.

Provider agent (auto-serves all its active sessions):

  npx tsx examples/mock-agent-serve.ts --token=agt_xxx --side=provider

Consumer agent (consumer agents have no provider profile, so they use a
different serve model that connects /ws/group directly — you must pass the
session ids the consumer agent participates in):

  npx tsx examples/mock-agent-serve.ts --token=agt_yyy --side=consumer \\
    --session-ids=sess-aaa,sess-bbb

Other flags: --agent-id, --reply="fixed text", --reply-delay=1500,
--api-url, --ws-url, --config=<file>.

Env equivalents: MOCK_AGENT_TOKEN, MOCK_AGENT_ID, MOCK_AGENT_SIDE,
MOCK_SESSION_IDS, MOCK_REPLY, MOCK_REPLY_DELAY_MS, MOCK_AGENTS_FILE, API_URL, WS_URL.
`;
  console.error(help);
  process.exit(1);
}

/** Shared onMessage: log inbound, mock reply (echo or fixed), send. Both serve
 *  clients stamp sender.side correctly by default (provider / consumer). */
function makeOnMessage(
  client: ServeClient,
  cfg: MockAgentConfig,
  side: Side,
  log: (event: string, extra?: Record<string, unknown>) => void,
): (session: { sessionId: string }, message: Record<string, unknown>) => void | Promise<void> {
  return async (session, message) => {
    const payload = message['payload'] as { content?: unknown } | undefined;
    const content = payload?.content;
    const meta = message['_meta'] as { senderRole?: string } | undefined;
    const sender = (message['sender'] as { agentId?: string; side?: string } | undefined);
    const fromAgent = !!sender?.agentId;

    // Only reply to natural-language dialogue (skip instruction.* / result.*).
    if (typeof content !== 'string') {
      log('← non-dialogue, no reply', { sid: session.sessionId, type: message['type'] });
      return;
    }
    log('← received', { sid: session.sessionId, from: meta?.senderRole ?? sender?.side ?? '?', fromAgent, content });

    // Don't reply to other agents' messages — avoids mock-vs-mock echo loops
    // (production agents self-decide per spec §6.3; mock simulates "reply only
    // to humans" so two mocks in one session don't echo each other forever).
    if (fromAgent) {
      log('   skip (other agent message — avoid echo loop)', { sid: session.sessionId });
      return;
    }

    const reply = cfg.replyText ?? `[mock ${side}] received: "${content}"`;
    if (cfg.replyDelayMs && cfg.replyDelayMs > 0) {
      log('thinking…', { delayMs: cfg.replyDelayMs });
      await sleep(cfg.replyDelayMs);
    }
    const res = await client.send(session.sessionId, {
      type: 'dialogue.message',
      payload: { content: reply },
    });
    log('→ sent', { sid: session.sessionId, delivered: res.delivered, reply });
  };
}

async function createProviderMock(cfg: MockAgentConfig, index: number, apiUrl: string, wsUrl: string): Promise<ProviderClient> {
  const tag = cfg.tag ?? `provider#${index}(${mask(cfg.agentToken)})`;
  const log = makeLogger(tag);
  const client = new ProviderClient({
    apiUrl, wsUrl, agentToken: cfg.agentToken,
    useGroupChannel: true,
    autoApprove: true,
  });
  client.on('agent:started', aid => log('started', { agentId: aid }));
  client.on('agent:connected', () => log('ws/agent open'));
  client.on('agent:disconnected', (code, reason) => log('ws/agent closed', { code, reason }));
  client.on('agent:reconnecting', delay => log('ws/agent reconnecting', { delayMs: delay }));
  client.on('agent:activated', aid => log('activated', { agentId: aid }));
  client.on('agent:warning', m => log('WARN', { message: m }));
  client.on('agent:dead', (aid, reason) => log('DEAD (terminal)', { agentId: aid, reason }));
  client.on('session:new', s => log('session.new', { sid: s.sessionId }));
  client.on('session:connected', sid => log('ws/group open', { sid }));
  client.on('session:participant', (sid, p) => log('handshake ok', { sid, participantId: p?.participantId }));
  client.on('session:disconnected', (sid, reason) => log('ws/group closed', { sid, reason }));
  client.on('session:paused', (sid, reason) => log('PAUSED (4020)', { sid, reason }));
  client.on('session:dead', (sid, reason) => log('session DEAD', { sid, reason }));
  client.on('session:error', (sid, err) => log('ERROR', { sid, error: String(err) }));

  await client.start({
    agentId: cfg.agentId,
    onMessage: makeOnMessage(client, cfg, 'provider', log),
  });
  return client;
}

async function createConsumerMock(cfg: MockAgentConfig, index: number, apiUrl: string, wsUrl: string): Promise<ConsumerAgentClient> {
  const tag = cfg.tag ?? `consumer#${index}(${mask(cfg.agentToken)})`;
  const log = makeLogger(tag);
  const sessionIds = cfg.sessionIds ?? [];
  if (!sessionIds.length) {
    log('WARN no sessionIds — consumer agent has nothing to serve. Pass --session-ids or config.sessionIds.');
  }
  const client = new ConsumerAgentClient({ apiUrl, wsUrl, agentToken: cfg.agentToken, agentId: cfg.agentId });
  client.on('started', aid => log('started', { agentId: aid }));
  client.on('session:connected', sid => log('ws/group open', { sid }));
  client.on('session:participant', (sid, p) => log('handshake ok', { sid, participantId: p?.participantId }));
  client.on('session:disconnected', (sid, reason) => log('ws/group closed', { sid, reason }));
  client.on('session:dead', (sid, reason) => log('session DEAD', { sid, reason }));
  client.on('session:error', (sid, err) => log('ERROR', { sid, error: String(err) }));
  client.on('warning', m => log('WARN', { message: m }));

  await client.start({
    sessionIds,
    onMessage: makeOnMessage(client, cfg, 'consumer', log),
  });
  return client;
}

async function createMockAgent(cfg: MockAgentConfig, index: number, apiUrl: string, wsUrl: string): Promise<ProviderClient | ConsumerAgentClient> {
  const side: Side = cfg.side ?? 'provider';
  return side === 'consumer'
    ? createConsumerMock(cfg, index, apiUrl, wsUrl)
    : createProviderMock(cfg, index, apiUrl, wsUrl);
}

async function main(): Promise<void> {
  const { apiUrl, wsUrl, configs } = loadOptions();
  if (!configs.length) printHelpAndExit();

  console.log(`mock-agent-serve: ${configs.length} agent(s)`);
  console.log(`  API: ${apiUrl}`);
  console.log(`  WS : ${wsUrl}`);
  console.log('  (tokens are masked in logs; Ctrl+C to stop)\n');

  const clients: Array<ProviderClient | ConsumerAgentClient> = [];
  for (let i = 0; i < configs.length; i++) {
    const cfg = configs[i];
    const side = cfg.side ?? 'provider';
    const sessionsInfo = side === 'consumer' ? ` sessions=${cfg.sessionIds?.length ?? 0}` : '';
    console.log(`starting #${i}: side=${side}${sessionsInfo} replyDelay=${cfg.replyDelayMs ?? 0}ms reply=${cfg.replyText ? 'fixed' : 'echo'}`);
    const client = await createMockAgent(cfg, i, apiUrl, wsUrl);
    clients.push(client);
    if (cfg.fault === 'drop') {
      console.log(`  #${i}: fault=drop — forceDisconnectAll every 4s (reconnect test)`);
      setInterval(() => {
        try { client.forceDisconnectAll(); } catch (e) { console.log(`  [mock#${i}] forceDisconnectAll error: ${String(e)}`); }
      }, 8_000);
    }
  }

  console.log(`\nall ${clients.length} agent(s) serving.`);

  let shuttingDown = false;
  const shutdown = (): void => {
    if (shuttingDown) return;
    shuttingDown = true;
    console.log('\nshutting down…');
    for (const c of clients) c.stop();
    setTimeout(() => process.exit(0), 500);
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}

main().catch(err => {
  console.error('fatal:', err instanceof Error ? err.stack : err);
  process.exit(1);
});

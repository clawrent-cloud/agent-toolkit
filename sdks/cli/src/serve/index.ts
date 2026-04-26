import { Command } from 'commander';
import WebSocket from 'ws';
import { loadConfig } from '../config.js';
import { ApiClient } from '../api-client.js';
import { printError, printSuccess } from '../output.js';
import { isDaemonRunning, spawnDaemon, writePid, getLogFilePath } from '../daemon.js';
import { StdioBridge } from './stdio-bridge.js';
import { SessionManager } from './session-manager.js';
import {
  createCorrelationId,
  isResponse,
  isRequest,
  type JsonRpcMessage,
  type ResultPayload,
} from './protocol.js';

interface ServeOptions {
  agentToken: string;
  autoApprove: boolean;
  pollInterval: string;
  daemon: boolean;
}

/** Pending instruction tracking: correlationId -> sessionId */
const pendingInstructions = new Map<string, string>();

/** Known session IDs we've already seen (to avoid duplicate polling notifications) */
const knownPendingSessions = new Set<string>();
const activeSessions = new Set<string>();

export function registerServeCommand(program: Command): void {
  program
    .command('serve')
    .description('Start serve daemon - bridge WebSocket sessions to stdin/stdout')
    .requiredOption('--agent-token <token>', 'Agent token (agt_clawrent_*) for authentication')
    .option('--auto-approve', 'Automatically approve incoming sessions', false)
    .option('--poll-interval <ms>', 'Polling interval for pending sessions (ms)', '5000')
    .option('-d, --daemon', 'Run in background as a daemon process', false)
    .action(async (opts: ServeOptions) => {
      try {
        if (opts.daemon) {
          // --- Daemon mode: resolve agentId first, then fork ---
          const config = loadConfig();
          // Override token for this request
          config.token = opts.agentToken;
          const client = new ApiClient(config);

          let agentId: string;
          try {
            const agent = await client.getMyAgent();
            agentId = agent['id'] as string;
          } catch {
            printError('Failed to resolve agent from token. Is the token valid?');
            process.exit(1);
          }

          const { running, pid: existingPid } = isDaemonRunning(agentId);
          if (running) {
            printError(`Daemon already running for agent ${agentId} (PID: ${existingPid}). Use 'clawrent stop --agent-id ${agentId}' first.`);
            process.exit(1);
          }

          // Rebuild args without --daemon / -d
          const args: string[] = ['serve', '--agent-token', opts.agentToken];
          if (opts.autoApprove) args.push('--auto-approve');
          if (opts.pollInterval !== '5000') args.push('--poll-interval', opts.pollInterval);

          const pid = spawnDaemon(agentId, args);
          writePid(agentId, pid);
          printSuccess(`Daemon started for agent ${agentId} (PID: ${pid})\nLogs: ${getLogFilePath(agentId)}`);
          process.exit(0);
        }

        await runDaemon(opts);
      } catch (err: unknown) {
        printError(err instanceof Error ? err.message : String(err));
        process.exit(1);
      }
    });
}

async function runDaemon(opts: ServeOptions): Promise<void> {
  const config = loadConfig();
  // Override token for agentToken auth
  config.token = opts.agentToken;
  const client = new ApiClient(config);
  const bridge = new StdioBridge();
  const sessionManager = new SessionManager(config.wsUrl);
  const pollInterval = parseInt(opts.pollInterval, 10);
  let agentWs: WebSocket | null = null;
  let agentHeartbeatTimer: ReturnType<typeof setInterval> | null = null;

  // --- 1. Startup: resolve agent from token ---
  let agentId: string;
  let agentName: string;
  try {
    const agent = await client.getMyAgent();
    agentId = agent['id'] as string;
    agentName = (agent['name'] as string) ?? agentId;
    sessionManager.agentId = agentId;
  } catch {
    printError('Failed to resolve agent from token. Is the token valid?');
    process.exit(1);
  }

  // --- 2. Notify ready ---
  bridge.writeNotification('ready', {
    agentId,
    agentName,
  });

  // --- 3. Wire up session manager events ---
  sessionManager.on('session:connected', (sessionId: string) => {
    bridge.writeNotification('session.connected', { sessionId });
  });

  sessionManager.on('session:message', (sessionId: string, message: Record<string, unknown>) => {
    const type = message['type'] as string;

    if (type?.startsWith('instruction.')) {
      // Instruction from consumer -> forward as JSON-RPC request (expects response)
      const corrId = createCorrelationId();
      pendingInstructions.set(corrId, sessionId);

      bridge.writeRequest('instruction', corrId, {
        sessionId,
        messageId: (message['id'] as string) ?? corrId,
        type,
        payload: (message['payload'] as Record<string, unknown>) ?? {},
        sender: message['sender'],
      });
    } else if (type?.startsWith('dialogue.')) {
      // Dialogue from consumer -> forward as notification
      const payload = (message['payload'] as Record<string, unknown>) ?? {};
      bridge.writeNotification('dialogue', {
        sessionId,
        content: payload['content'] ?? '',
        dialogueType: payload['dialogueType'] ?? 'message',
      });
    } else if (type?.startsWith('result.')) {
      // Result from consumer -> forward as notification
      bridge.writeNotification('result', {
        sessionId,
        type,
        payload: (message['payload'] as Record<string, unknown>) ?? {},
      });
    } else if (type === 'system.session_ended' || type === 'system.peer_disconnected') {
      activeSessions.delete(sessionId);
      bridge.writeNotification('session.ended', {
        sessionId,
        reason: type,
      });
    } else if (type === 'system.peer_connected') {
      bridge.writeNotification('session.peer_connected', { sessionId });
    } else if (type !== 'system.heartbeat_ack') {
      // Forward unknown messages as-is
      bridge.writeNotification('message', { sessionId, ...message });
    }
  });

  sessionManager.on('session:disconnected', (sessionId: string, reason: string) => {
    activeSessions.delete(sessionId);
    bridge.writeNotification('session.disconnected', { sessionId, reason });
  });

  sessionManager.on('session:reconnecting', (sessionId: string, delay: number) => {
    bridge.writeNotification('session.reconnecting', { sessionId, delay });
  });

  sessionManager.on('session:error', (sessionId: string, err: Error) => {
    bridge.writeNotification('session.error', { sessionId, message: err.message });
  });

  // --- 4. Handle stdin messages from agent ---
  bridge.start((msg: JsonRpcMessage) => {
    if (isResponse(msg)) {
      // Agent is responding to an instruction we forwarded
      const sessionId = pendingInstructions.get(msg.id);
      if (sessionId && msg.result) {
        pendingInstructions.delete(msg.id);
        const result = msg.result as unknown as ResultPayload;
        sessionManager.send(sessionId, {
          type: result.type ?? 'result.success',
          payload: result.payload ?? result,
        });
      }
    } else if (isRequest(msg)) {
      // Agent is proactively sending something
      if (msg.method === 'send') {
        const params = msg.params as Record<string, unknown> | undefined;
        if (params?.['sessionId']) {
          const sent = sessionManager.send(params['sessionId'] as string, {
            type: params['type'] ?? 'dialogue.message',
            payload: (params['payload'] as Record<string, unknown>) ?? { content: '' },
          });
          bridge.writeResponse(msg.id, { success: sent });
        }
      } else if (msg.method === 'approve') {
        const params = msg.params as Record<string, unknown> | undefined;
        const sid = params?.['sessionId'] as string | undefined;
        if (sid) {
          approveAndConnect(client, sessionManager, bridge, sid).catch(() => {
            bridge.writeResponse(msg.id, { success: false, error: 'Failed to approve' });
          }).then(() => {
            bridge.writeResponse(msg.id, { success: true });
          });
        }
      }
    }
    // Notifications from agent are ignored for now
  });

  // --- 5. Agent control channel (/ws/agent) + fallback poll loop ---
  let pollTimer: ReturnType<typeof setInterval> | null = null;

  function connectAgentWs(token: string) {
    const wsBase = config.wsUrl ?? config.apiUrl.replace(/^http/, 'ws');
    const url = `${wsBase}/ws/agent?token=${token}`;
    agentWs = new WebSocket(url);

    agentWs.on('open', () => {
      bridge.writeNotification('agent.connected', { agentId });

      // Start heartbeat on agent channel
      agentHeartbeatTimer = setInterval(() => {
        if (agentWs && agentWs.readyState === WebSocket.OPEN) {
          agentWs.send(JSON.stringify({ type: 'system.heartbeat', payload: {} }));
        }
      }, 25_000);

      // Stop polling when WS is connected
      if (pollTimer) {
        clearInterval(pollTimer);
        pollTimer = null;
      }
    });

    agentWs.on('message', (raw) => {
      try {
        const message = JSON.parse(raw.toString());
        const type = message.type as string;

        if (type === 'session.new' || type === 'session.approved') {
          const payload = message.payload as Record<string, unknown>;
          const sid = payload['sessionId'] as string;
          const sessionToken = payload['sessionToken'] as string;

          if (knownPendingSessions.has(sid) || activeSessions.has(sid)) return;
          knownPendingSessions.add(sid);

          if (opts.autoApprove && type === 'session.new') {
            approveAndConnect(client, sessionManager, bridge, sid);
          } else if (type === 'session.approved' && sessionToken) {
            // Already approved, connect directly
            activeSessions.add(sid);
            bridge.writeNotification('session.new', {
              sessionId: sid,
              sessionToken,
              taskDescription: (payload['taskDescription'] as string) ?? '',
              consumerUserId: (payload['consumerUserId'] as string) ?? '',
              slotIndex: (payload['slotIndex'] as number) ?? 0,
            });
            sessionManager.connect(sid, sessionToken);
          } else {
            bridge.writeNotification('session.pending', {
              sessionId: sid,
              taskDescription: (payload['taskDescription'] as string) ?? '',
              consumerUserId: (payload['consumerUserId'] as string) ?? '',
              slotIndex: (payload['slotIndex'] as number) ?? 0,
            });
          }
        }
        // Ignore heartbeat_ack and other system messages
      } catch {
        // Ignore parse errors on agent channel
      }
    });

    agentWs.on('close', (code, reason) => {
      if (agentHeartbeatTimer) {
        clearInterval(agentHeartbeatTimer);
        agentHeartbeatTimer = null;
      }
      bridge.writeNotification('agent.disconnected', {
        agentId,
        code,
        reason: reason.toString(),
      });

      // Fall back to polling
      if (!pollTimer) {
        startPollLoop();
      }

      // Reconnect after 5s unless deliberately closed
      if (code !== 1000 && code !== 4009) {
        setTimeout(() => connectAgentWs(token), 5000);
      }
    });

    agentWs.on('error', () => {
      // Error will trigger close event
    });
  }

  function startPollLoop() {
    pollTimer = setInterval(async () => {
      try {
        const sessions = (await client.getSessions({
          role: 'provider',
          status: 'pending_approval',
        })) as { data: Array<Record<string, unknown>> };

        for (const session of sessions.data ?? []) {
          const sid = session['id'] as string;
          if (knownPendingSessions.has(sid) || activeSessions.has(sid)) continue;
          knownPendingSessions.add(sid);

          if (opts.autoApprove) {
            await approveAndConnect(client, sessionManager, bridge, sid);
          } else {
            bridge.writeNotification('session.pending', {
              sessionId: sid,
              taskDescription: session['taskDescription'] ?? '',
              consumerUserId: session['consumerUserId'] ?? '',
            });
          }
        }
      } catch {
        // Silently retry on next poll
      }
    }, pollInterval);
  }

  // Connect via /ws/agent with the token
  connectAgentWs(opts.agentToken);

  // --- 6. Graceful shutdown ---
  const shutdown = async () => {
    if (pollTimer) clearInterval(pollTimer);
    if (agentHeartbeatTimer) clearInterval(agentHeartbeatTimer);
    bridge.stop();

    // Close agent WS (this triggers server-side offline update)
    if (agentWs) {
      try { agentWs.close(1000, 'Shutting down'); } catch { /* ignore */ }
      agentWs = null;
    }

    sessionManager.disconnectAll();
    bridge.writeNotification('shutdown', { reason: 'signal' });

    // Give a moment for messages to flush
    setTimeout(() => process.exit(0), 500);
  };

  process.on('SIGINT', () => { void shutdown(); });
  process.on('SIGTERM', () => { void shutdown(); });
}

async function approveAndConnect(
  client: ApiClient,
  sessionManager: SessionManager,
  bridge: StdioBridge,
  sessionId: string,
): Promise<void> {
  try {
    const approved = (await client.approveSession(sessionId)) as Record<string, unknown>;
    const sessionToken = approved['sessionToken'] as string;
    const taskDescription = approved['taskDescription'] as string;

    activeSessions.add(sessionId);

    bridge.writeNotification('session.new', {
      sessionId,
      sessionToken,
      taskDescription: taskDescription ?? '',
      consumerUserId: (approved['consumerUserId'] as string) ?? '',
    });

    sessionManager.connect(sessionId, sessionToken);
  } catch (err: unknown) {
    bridge.writeNotification('session.approve_failed', {
      sessionId,
      error: err instanceof Error ? err.message : String(err),
    });
  }
}

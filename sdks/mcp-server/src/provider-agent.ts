import { EventEmitter } from 'node:events';
import { ProviderClient } from '@clawrent/provider';
import type { ApiClient, ActiveSession } from '@clawrent/provider';

export type { ActiveSession };

/**
 * ProviderAgent — thin adapter letting MCP tools keep their existing
 * ProviderAgent-shaped surface while delegating the real WebSocket / session
 * work to `@clawrent/provider.ProviderClient`.
 *
 * History: this file used to ship a full in-process /ws/agent client + session
 * manager (a copy of what now lives in @clawrent/provider). Task 7 collapsed it
 * into a delegate so all provider logic is maintained in one place. MCP tools
 * (`provider-tools.ts`) and `index.ts` keep calling `running` / `start` / `stop`
 * / `send` / `sendViaWsOrRest` / `getSessions` and listening for the
 * `session:message` event — unchanged.
 *
 * The wrapper also re-emits the rest of ProviderClient's lifecycle / session
 * events under their existing names so any future listener keeps working.
 */
export class ProviderAgent extends EventEmitter {
  private pc: ProviderClient | null = null;
  private agentId: string | null = null;
  /** Sessions observed via ProviderClient callbacks; backs getSessions() for serving_status. */
  private readonly wrapperSessions = new Map<string, ActiveSession>();

  constructor(private readonly client: ApiClient) {
    super();
  }

  get running(): boolean {
    return this.pc?.running ?? false;
  }

  get currentAgentId(): string | null {
    return this.agentId;
  }

  getSessions(): ActiveSession[] {
    return Array.from(this.wrapperSessions.values());
  }

  /**
   * Start serving: spin up a ProviderClient (which connects /ws/agent, activates
   * the agent, re-attaches active sessions) and re-emit its events on this
   * instance under the names mcp tools already listen to.
   *
   * The shared ApiClient's agent-token override is set too, so non-serving
   * provider REST calls (approve/list/end/balance) made by other mcp tools
   * authenticate as the agent owner without a separate user JWT. This mirrors
   * the pre-Task-7 behavior; ProviderClient uses its own internal ApiClient for
   * its own REST calls, so the wrapper must keep the shared one in sync.
   */
  async start(agentId: string, agentToken: string, autoApprove = false): Promise<void> {
    if (this.pc) {
      throw new Error(`Already serving agent ${this.agentId}`);
    }

    this.agentId = agentId;
    this.pc = new ProviderClient({
      apiUrl: this.client.apiUrl,
      wsUrl: this.client.wsUrl,
      agentToken,
      autoApprove,
    });

    this.forwardProviderClientEvents();

    this.client.setAgentToken(agentToken);

    await this.pc.start({
      agentId,
      onMessage: async (session, message) => {
        // ProviderClient routes /ws/session frames through onMessage (with cursor
        // dedupe); re-emit under the event name index.ts listens to.
        this.emit('session:message', session.sessionId, message);
      },
      onSessionNew: (session) => {
        this.wrapperSessions.set(session.sessionId, session);
      },
      onSessionEnded: (session) => {
        this.wrapperSessions.delete(session.sessionId);
      },
    });
  }

  /** Stop serving: tear down the ProviderClient and clear local state. */
  stop(): void {
    this.pc?.stop();
    this.pc = null;
    this.wrapperSessions.clear();
    this.agentId = null;
    this.client.setAgentToken(null);
    this.emit('stopped');
  }

  /**
   * Fire-and-forget send. Returns false when not serving. MCP tools use
   * `sendViaWsOrRest` (which awaits); this is kept for surface compatibility.
   */
  send(sessionId: string, message: { type: string; payload: Record<string, unknown> }): boolean {
    if (!this.pc) return false;
    void this.pc.send(sessionId, message);
    return true;
  }

  /**
   * Send via WS if attached, else fall back to REST. Never fails with "not
   * attached" — when not serving, uses the shared ApiClient's REST endpoint so
   * `clawrent_send_session_message` still works after a restart that detached
   * the socket. Returns the transport actually used.
   */
  async sendViaWsOrRest(
    sessionId: string,
    message: { type: string; payload: Record<string, unknown> },
  ): Promise<{ via: 'ws' | 'rest' }> {
    if (!this.pc) {
      await this.client.sendSessionMessage(sessionId, message);
      return { via: 'rest' };
    }
    return this.pc.send(sessionId, message);
  }

  /**
   * Re-emit ProviderClient's lifecycle / session events under the same names on
   * this instance. `session:message` is handled separately via the onMessage
   * callback in start(); the rest are forwarded here so any future listener
   * (matching the pre-Task-7 surface) keeps working.
   */
  private forwardProviderClientEvents(): void {
    const pc = this.pc;
    if (!pc) return;
    const forward = (evt: string): void => {
      pc.on(evt, (...args: unknown[]) => {
        this.emit(evt, ...args);
      });
    };
    forward('agent:connected');
    forward('agent:disconnected');
    forward('agent:started');
    forward('agent:warning');
    forward('agent:reconnecting');
    forward('agent:activated');
    forward('agent:activation:failed');
    forward('agent:dead');
    forward('session:new');
    forward('session:approved');
    forward('session:connected');
    forward('session:disconnected');
    forward('session:reattached');
    forward('session:error');
  }
}

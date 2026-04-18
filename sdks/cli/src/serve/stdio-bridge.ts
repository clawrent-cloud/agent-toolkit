import { createInterface } from 'node:readline';
import type { JsonRpcMessage, JsonRpcResponse, JsonRpcRequest, JsonRpcNotification } from './protocol.js';

export type StdinMessageHandler = (msg: JsonRpcMessage) => void;

/**
 * StdioBridge handles JSON Lines communication over stdin/stdout.
 * Each line is a JSON-RPC 2.0 message.
 */
export class StdioBridge {
  private handler: StdinMessageHandler | null = null;
  private rl: ReturnType<typeof createInterface> | null = null;

  /** Start reading from stdin */
  start(handler: StdinMessageHandler): void {
    this.handler = handler;
    this.rl = createInterface({ input: process.stdin, crlfDelay: Infinity });

    this.rl.on('line', (line) => {
      const trimmed = line.trim();
      if (!trimmed) return;

      try {
        const msg = JSON.parse(trimmed) as JsonRpcMessage;
        if (msg.jsonrpc !== '2.0') {
          this.writeError('Invalid JSON-RPC: missing jsonrpc field');
          return;
        }
        this.handler?.(msg);
      } catch {
        this.writeError(`Failed to parse JSON: ${trimmed.slice(0, 100)}`);
      }
    });

    this.rl.on('close', () => {
      // stdin closed — process will shut down
    });
  }

  /** Stop reading */
  stop(): void {
    this.rl?.close();
    this.rl = null;
  }

  /** Write a JSON-RPC message to stdout */
  write(msg: JsonRpcMessage): void {
    process.stdout.write(JSON.stringify(msg) + '\n');
  }

  /** Write a notification */
  writeNotification(method: string, params: Record<string, unknown>): void {
    const msg: JsonRpcNotification = { jsonrpc: '2.0', method, params };
    this.write(msg);
  }

  /** Write a request (expects response) */
  writeRequest(method: string, id: string, params: Record<string, unknown>): void {
    const msg: JsonRpcRequest = { jsonrpc: '2.0', method, id, params };
    this.write(msg);
  }

  /** Write a response */
  writeResponse(id: string, result: Record<string, unknown>): void {
    const msg: JsonRpcResponse = { jsonrpc: '2.0', id, result };
    this.write(msg);
  }

  /** Write an error notification to stdout */
  private writeError(message: string): void {
    this.writeNotification('error', { message });
  }
}

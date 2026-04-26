import { Command } from 'commander';
import WebSocket from 'ws';
import { loadConfig } from '../config.js';
import { ApiClient } from '../api-client.js';
import { printJson, printError, printSuccess } from '../output.js';

export function registerSendCommand(program: Command): void {
  program
    .command('send <sessionId>')
    .description('Send a message to a session via WebSocket')
    .requiredOption('--content <text>', 'Message content')
    .option('--type <messageType>', 'Message type', 'dialogue.message')
    .option('--token <sessionToken>', 'Session token (auto-fetched if not provided)')
    .option('--slot <index>', 'Slot index for consumer role (default: 0)', '0')
    .option('--wait <ms>', 'Wait for response (milliseconds)')
    .action(async (sessionId: string, opts: { content: string; type: string; token?: string; slot: string; wait?: string }) => {
      try {
        const config = loadConfig();
        const client = new ApiClient(config);

        // Get session token if not provided
        let sessionToken = opts.token;
        let role = 'consumer';
        if (!sessionToken) {
          const session = await client.getSession(sessionId);
          sessionToken = session['sessionToken'] as string;
          // Determine role
          if (config.userId && session['providerUserId'] === config.userId) {
            role = 'provider';
          }
        }

        if (!sessionToken) {
          printError('Could not determine session token. Use --token flag.');
          process.exit(1);
        }

        const wsUrl = `${config.wsUrl}/ws/session?sessionId=${sessionId}&token=${sessionToken}&role=${role}${role === 'consumer' ? `&slotIndex=${opts.slot}` : ''}`;

        await new Promise<void>((resolve, reject) => {
          const ws = new WebSocket(wsUrl);
          let responded = false;

          ws.on('open', () => {
            // Build full protocol envelope as required by ClawRentMessageSchema
            const message = {
              id: `msg_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`,
              sessionId,
              timestamp: Date.now(),
              sender: { role, agentId: config.userId ?? 'unknown' },
              type: opts.type,
              payload: { content: opts.content, dialogueType: 'message' },
            };
            ws.send(JSON.stringify(message));

            if (opts.wait) {
              // Wait for response
              setTimeout(() => {
                if (!responded) {
                  ws.close(1000);
                  printSuccess('Message sent (no response within timeout).');
                  resolve();
                }
              }, parseInt(opts.wait, 10));
            } else {
              // Send and close
              setTimeout(() => {
                ws.close(1000);
                printSuccess('Message sent.');
                resolve();
              }, 500);
            }
          });

          ws.on('message', (raw) => {
            try {
              const data = JSON.parse(raw.toString());
              if (data.type !== 'system.heartbeat_ack' && data.type !== 'system.peer_connected') {
                responded = true;
                printJson(data);
                if (opts.wait) {
                  ws.close(1000);
                  resolve();
                }
              }
            } catch {
              // ignore parse errors
            }
          });

          ws.on('error', (err) => {
            reject(err);
          });

          ws.on('close', () => {
            if (!responded && opts.wait) {
              resolve();
            }
          });
        });
      } catch (err: unknown) {
        printError(err instanceof Error ? err.message : String(err));
        process.exit(1);
      }
    });
}

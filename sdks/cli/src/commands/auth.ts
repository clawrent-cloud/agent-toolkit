import { Command } from 'commander';
import { createInterface } from 'node:readline';
import { loadConfig, saveConfig, clearConfig, getConfigPath } from '../config.js';
import { ApiClient } from '../api-client.js';
import { printJson, printError, printSuccess } from '../output.js';

function deriveWsUrl(apiUrl: string): string {
  return apiUrl.replace(/^http/, 'ws');
}

async function promptInput(prompt: string, hidden: boolean = false): Promise<string> {
  const rl = createInterface({ input: process.stdin, output: process.stderr });

  return new Promise((resolve) => {
    if (hidden) {
      // For password: write prompt manually, mute output
      process.stderr.write(prompt);
      const stdin = process.stdin;
      const wasRaw = stdin.isRaw;
      if (stdin.isTTY) stdin.setRawMode(true);
      let input = '';
      const onData = (ch: Buffer) => {
        const c = ch.toString('utf-8');
        if (c === '\n' || c === '\r') {
          stdin.removeListener('data', onData);
          if (stdin.isTTY && wasRaw !== undefined) stdin.setRawMode(wasRaw);
          process.stderr.write('\n');
          rl.close();
          resolve(input);
        } else if (c === '\u0003') {
          // Ctrl+C
          rl.close();
          process.exit(1);
        } else if (c === '\u007F' || c === '\b') {
          // Backspace
          input = input.slice(0, -1);
        } else {
          input += c;
        }
      };
      stdin.on('data', onData);
    } else {
      rl.question(prompt, (answer) => {
        rl.close();
        resolve(answer);
      });
    }
  });
}

export function registerAuthCommand(program: Command): void {
  const auth = program
    .command('auth')
    .description('Authentication management');

  auth
    .command('login')
    .description('Login to ClawRent platform')
    .option('-e, --email <email>', 'Email address')
    .option('-p, --password <password>', 'Password')
    .option('--api-url <url>', 'Platform API URL')
    .action(async (opts: { email?: string; password?: string; apiUrl?: string }) => {
      try {
        const currentConfig = loadConfig();
        const apiUrl = opts.apiUrl ?? currentConfig.apiUrl;
        const wsUrl = deriveWsUrl(apiUrl);

        const email = opts.email ?? await promptInput('Email: ');
        const password = opts.password ?? await promptInput('Password: ', true);

        if (!email || !password) {
          printError('Email and password are required.');
          process.exit(1);
        }

        const client = new ApiClient({ ...currentConfig, apiUrl, wsUrl });
        const result = await client.login(email, password);

        // Save credentials (do NOT save apiUrl/wsUrl — they come from defaults or env vars,
        // saving them would pin the config to a specific URL and break after default changes)
        saveConfig({
          token: result.token,
          userId: result.user.id,
          email: result.user.email,
          name: result.user.name,
        });

        printSuccess(`Logged in as ${result.user.name} (${result.user.email})`);
        printSuccess(`Config saved to ${getConfigPath()}`);
      } catch (err: unknown) {
        printError(err instanceof Error ? err.message : String(err));
        process.exit(1);
      }
    });

  auth
    .command('logout')
    .description('Logout and clear saved credentials')
    .action(() => {
      try {
        clearConfig();
        printSuccess('Logged out. Config cleared.');
      } catch (err: unknown) {
        printError(err instanceof Error ? err.message : String(err));
        process.exit(1);
      }
    });

  auth
    .command('whoami')
    .description('Show current user info')
    .action(async () => {
      try {
        const config = loadConfig();
        const client = new ApiClient(config);
        const me = await client.getMe();
        printJson(me);
      } catch (err: unknown) {
        printError(err instanceof Error ? err.message : String(err));
        process.exit(1);
      }
    });
}

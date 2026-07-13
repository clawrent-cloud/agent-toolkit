import { Command } from 'commander';
import { createInterface } from 'node:readline';
import { ApiClient, loadConfig, saveConfig, clearConfig, getConfigPath } from '@clawrent/provider';
import { printJson, printError, printSuccess } from '../output.js';

/**
 * Prompt for input. Works in both interactive (TTY) and non-interactive (piped) modes.
 * - TTY: shows the question, reads from terminal
 * - No-TTY: reads a single line from stdin (for agent piped input)
 */
async function promptInput(prompt: string, hidden: boolean = false): Promise<string> {
  const stdin = process.stdin;

  // Non-interactive: read a line from stdin pipe
  if (!stdin.isTTY) {
    const rl = createInterface({ input: stdin });
    return new Promise((resolve) => {
      rl.question('', (answer) => {
        rl.close();
        resolve(answer.trim());
      });
    });
  }

  // Interactive: show prompt
  return new Promise((resolve) => {
    if (hidden) {
      process.stderr.write(prompt);
      const wasRaw = stdin.isRaw;
      if (stdin.setRawMode) stdin.setRawMode(true);
      let input = '';
      const onData = (ch: Buffer) => {
        const c = ch.toString('utf-8');
        if (c === '\n' || c === '\r' || c === '\u0004') {
          stdin.removeListener('data', onData);
          if (stdin.setRawMode && wasRaw !== undefined) stdin.setRawMode(wasRaw);
          process.stderr.write('\n');
          resolve(input);
        } else if (c === '\u0003') {
          process.exit(1);
        } else if (c === '\u007F' || c === '\b') {
          input = input.slice(0, -1);
        } else {
          input += c;
        }
      };
      stdin.on('data', onData);
    } else {
      const rl = createInterface({ input: stdin, output: process.stderr });
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
    .command('send-verification')
    .description('Send email verification code (step 1 of registration)')
    .requiredOption('-e, --email <email>', 'Email address')
    .action(async (opts: { email: string }) => {
      try {
        const currentConfig = loadConfig();
        const client = new ApiClient(currentConfig);
        const result = await client.sendVerification(opts.email);
        printJson({ email: opts.email, sent: true, ...result });
      } catch (err: unknown) {
        printError(err instanceof Error ? err.message : String(err));
        process.exit(1);
      }
    });

  auth
    .command('register')
    .description('Register a new ClawRent account')
    .option('-e, --email <email>', 'Email address')
    .option('-n, --name <name>', 'Display name')
    .option('-p, --password <password>', 'Password (min 8 chars). If omitted, prompts interactively.')
    .option('-c, --code <code>', '6-digit verification code. If omitted, sends code first and prompts.')
    .action(async (opts: { email?: string; name?: string; password?: string; code?: string }) => {
      try {
        const currentConfig = loadConfig();
        const client = new ApiClient(currentConfig);

        const email = opts.email ?? await promptInput('Email: ');
        const name = opts.name ?? await promptInput('Display name: ');
        const password = opts.password ?? await promptInput('Password (min 8 chars): ', true);

        if (password.length < 8) {
          printError('Password must be at least 8 characters');
          process.exit(1);
        }

        let verificationCode: string;

        if (opts.code) {
          verificationCode = opts.code;
        } else {
          // Interactive: send verification code first
          printSuccess('Sending verification code to your email...');
          await client.sendVerification(email);
          printSuccess('Verification code sent! Check your inbox.');
          verificationCode = await promptInput('Verification code: ');
        }

        const result = await client.registerUser({
          email,
          password,
          name,
          verificationCode,
        });

        // Save credentials (NO URLs per config separation principle)
        saveConfig({
          token: result.token,
          apiKey: result.apiKey,
          userId: result.user.id,
          email: result.user.email,
          name: result.user.name,
        });

        printJson({
          success: true,
          user: result.user,
          token: result.token,
          apiKey: result.apiKey,
          configSaved: getConfigPath(),
        });
      } catch (err: unknown) {
        printError(err instanceof Error ? err.message : String(err));
        process.exit(1);
      }
    });

  auth
    .command('login')
    .description('Login to ClawRent platform')
    .option('-e, --email <email>', 'Email address')
    .option('-p, --password <password>', 'Password')
    .action(async (opts: { email?: string; password?: string }) => {
      try {
        const currentConfig = loadConfig();
        const email = opts.email ?? await promptInput('Email: ');
        const password = opts.password ?? await promptInput('Password: ', true);

        if (!email || !password) {
          printError('Email and password are required.');
          process.exit(1);
        }

        const client = new ApiClient(currentConfig);
        const result = await client.login(email, password);

        // Save credentials (do NOT save apiUrl/wsUrl — they come from defaults or env vars)
        saveConfig({
          token: result.token,
          userId: result.user.id,
          email: result.user.email,
          name: result.user.name,
        });

        printJson({
          success: true,
          user: result.user,
          token: result.token,
          configSaved: getConfigPath(),
        });
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
        printJson({ success: true, message: 'Credentials cleared' });
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

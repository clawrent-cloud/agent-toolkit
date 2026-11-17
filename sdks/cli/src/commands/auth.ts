import { Command } from 'commander';
import { createInterface } from 'node:readline';
import { ApiClient, loadConfig, saveConfig, clearConfig, getConfigPath, generateAgentKeyPair, signChallenge, loadKeyPair, saveKeyPair, defaultKeysDir } from '@clawrent/provider';
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
    .option('--agent', 'Agent self-registration: Ed25519 keypair identity, no email / no human (需求1). Key stored under ~/.clawrent/keys/.')
    .action(async (opts: { email?: string; name?: string; password?: string; code?: string; agent?: boolean }) => {
      try {
        const currentConfig = loadConfig();
        const client = new ApiClient(currentConfig);

        // ── Agent 自主注册:keypair 身份,无邮箱无验证码 ──
        if (opts.agent) {
          const name = opts.name ?? `agent-${Date.now().toString(36)}`;
          const keysDirInfo = defaultKeysDir();
          if (loadKeyPair('default')) {
            printError(`Key 'default' already exists under ${keysDirInfo} — use \`clawrent keys add\` for more keys, or remove the existing key file to register a NEW account.`);
            process.exit(1);
          }
          const pair = generateAgentKeyPair();
          const keyPath = saveKeyPair('default', pair);
          printSuccess(`Ed25519 keypair generated → ${keyPath}`);
          printSuccess('⚠️  Losing this key locks the account permanently (platform ruling D6). Back it up.');

          let reg: Awaited<ReturnType<typeof client.agentRegister>>;
          try {
            reg = await client.agentRegister({ name, publicKey: pair.publicKey });
          } catch (err) {
            // 注册阶段失败:账号绝无可能存在 → 删孤儿钥文件保住重试路径(I2;
            // 不删则下次被「钥已存在」挡住,且手动删除重试还会白烧共享 IP 配额)
            const { rmSync } = await import('node:fs');
            try { rmSync(keyPath); } catch { /* best-effort */ }
            printError(`Registration failed (no account was created, key file cleaned): ${err instanceof Error ? err.message : String(err)}`);
            process.exit(1);
          }

          try {
            const signature = await signChallenge(pair.privateKey, reg.challenge);
            const result = await client.agentRegisterConfirm({ challengeId: reg.challengeId, signature });

            saveConfig({
              token: result.token,
              apiKey: result.apiKey,
              userId: result.user.id,
              name: result.user.name,
            });
            printJson({
              success: true,
              user: result.user,
              token: result.token,
              apiKey: result.apiKey,
              keyPath,
              configSaved: getConfigPath(),
              note: 'Unclaimed agent account: browse/serve/earn now; claim with `clawrent auth claim` (bind email + set password) to enable payouts.',
            });
          } catch (err) {
            // confirm 阶段失败有歧义(账号可能已建,删钥=自断 D6 救济)→ 保留文件 + 探测法
            printError(`Registration confirm failed: ${err instanceof Error ? err.message : String(err)}`);
            printError(`Key file kept at ${keyPath}. The account may exist — probe with \`clawrent keys list\` (401 unknown_key = no account holds this key; then delete the file and retry).`);
            process.exit(1);
          }
          return;
        }

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
    .command('claim')
    .description('Claim an agent-registered account: bind an email + set a password (enables payouts)')
    .option('-k, --key <name>', "Local key name (default: 'default')", 'default')
    .option('-e, --email <email>', 'Email to bind')
    .option('-c, --code <code>', '6-digit verification code (sent to the email)')
    .option('-p, --password <password>', 'New password (min 8 chars)')
    .action(async (opts: { key?: string; email?: string; code?: string; password?: string }) => {
      try {
        const pair = loadKeyPair(opts.key ?? 'default');
        if (!pair) {
          printError(`Key '${opts.key ?? 'default'}' not found under ${defaultKeysDir()}. Agent accounts are claimed with their Ed25519 key.`);
          process.exit(1);
        }
        const client = new ApiClient(loadConfig());
        // 邮箱先问完再取挑战(操作挑战 60s TTL,别让输入时间吃掉窗口 —— 终审 M6)
        const email = opts.email ?? await promptInput('Email to bind: ');
        const code = opts.code ?? await promptInput('Verification code: ');
        const password = opts.password ?? await promptInput('New password (min 8 chars): ', true);
        if (password.length < 8) {
          printError('Password must be at least 8 characters');
          process.exit(1);
        }

        const ch = await client.agentChallenge(pair.publicKey);
        const signature = await signChallenge(pair.privateKey, ch.challenge);
        await client.agentClaimStart({ publicKey: pair.publicKey, challengeId: ch.challengeId, signature, email });
        printSuccess(`Verification code sent to ${email}.`);

        const ch2 = await client.agentChallenge(pair.publicKey);
        const signature2 = await signChallenge(pair.privateKey, ch2.challenge);
        const result = await client.agentClaimConfirm({
          publicKey: pair.publicKey,
          challengeId: ch2.challengeId,
          signature: signature2,
          email,
          verificationCode: code,
          newPassword: password,
        });
        saveConfig({ token: result.token, email });
        printJson({ success: true, email, token: result.token, configSaved: getConfigPath() });
      } catch (err: unknown) {
        printError(err instanceof Error ? err.message : String(err));
        process.exit(1);
      }
    });

  auth
    .command('reissue')
    .description('Reissue clr_ API key + JWT for the agent account bound to a local key (lost credentials recovery, R4)')
    .option('-k, --key <name>', "Local key name (default: 'default')", 'default')
    .action(async (opts: { key?: string }) => {
      try {
        const pair = loadKeyPair(opts.key ?? 'default');
        if (!pair) {
          printError(`Key '${opts.key ?? 'default'}' not found under ${defaultKeysDir()}.`);
          process.exit(1);
        }
        const client = new ApiClient(loadConfig());
        const ch = await client.agentChallenge(pair.publicKey);
        const signature = await signChallenge(pair.privateKey, ch.challenge);
        const result = await client.agentReissue({ publicKey: pair.publicKey, challengeId: ch.challengeId, signature });
        saveConfig({ token: result.token, apiKey: result.apiKey });
        printJson({ success: true, apiKey: result.apiKey, token: result.token, configSaved: getConfigPath() });
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

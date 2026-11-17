import { Command } from 'commander';
import {
  ApiClient,
  loadConfig,
  generateAgentKeyPair,
  signChallenge,
  saveKeyPair,
  loadKeyPair,
  listKeyPairs,
} from '@clawrent/provider';
import { printJson, printError, printSuccess } from '../output.js';

/**
 * 需求1:`clawrent keys` —— agent 账号的 principal keys 管理。
 * 全部操作需持现有 active 钥签名(挑战-应答),与平台 /api/auth/agent/keys 对齐。
 */
export function registerKeysCommand(program: Command): void {
  const keys = program
    .command('keys')
    .description('Manage the Ed25519 keys of an agent-registered account');

  keys
    .command('list')
    .description('List local key files and the account keys on the platform')
    .option('-k, --key <name>', "Local key name used to authenticate (default: 'default')", 'default')
    .action(async (opts: { key?: string }) => {
      try {
        printJson({ localKeys: listKeyPairs() });
        const pair = loadKeyPair(opts.key ?? 'default');
        if (!pair) {
          printError(`Key '${opts.key ?? 'default'}' not found locally — platform keys listing needs a local key.`);
          process.exit(1);
        }
        const client = new ApiClient(loadConfig());
        const ch = await client.agentChallenge(pair.publicKey);
        const signature = await signChallenge(pair.privateKey, ch.challenge);
        const result = await client.agentKeysList({ publicKey: pair.publicKey, challengeId: ch.challengeId, signature });
        printJson({ platformKeys: result.data });
      } catch (err: unknown) {
        printError(err instanceof Error ? err.message : String(err));
        process.exit(1);
      }
    });

  keys
    .command('add')
    .description('Generate a new keypair locally and attach its public key to the account')
    .requiredOption('-n, --name <name>', 'Local name for the new key file (e.g. laptop, server)')
    .option('-k, --key <name>', "Existing local key that authorizes the add (default: 'default')", 'default')
    .option('-l, --label <label>', 'Label shown in the platform key list')
    .action(async (opts: { name: string; key?: string; label?: string }) => {
      try {
        const authPair = loadKeyPair(opts.key ?? 'default');
        if (!authPair) {
          printError(`Key '${opts.key ?? 'default'}' not found locally.`);
          process.exit(1);
        }
        if (loadKeyPair(opts.name)) {
          printError(`Local key '${opts.name}' already exists.`);
          process.exit(1);
        }
        const client = new ApiClient(loadConfig());
        const ch = await client.agentChallenge(authPair.publicKey);
        const signature = await signChallenge(authPair.privateKey, ch.challenge);
        const newPair = generateAgentKeyPair();
        const result = await client.agentKeysAdd({
          publicKey: authPair.publicKey,
          challengeId: ch.challengeId,
          signature,
          newPublicKey: newPair.publicKey,
          label: opts.label ?? opts.name,
        });
        const keyPath = saveKeyPair(opts.name, newPair);
        printJson({ success: true, added: result, keyPath });
      } catch (err: unknown) {
        printError(err instanceof Error ? err.message : String(err));
        process.exit(1);
      }
    });

  keys
    .command('revoke')
    .description('Revoke a key on the account (the last active key cannot be revoked)')
    .requiredOption('--pubkey <pubkey>', 'Base64 public key of the key to revoke')
    .option('-k, --key <name>', "Local key that authorizes the revoke (default: 'default')", 'default')
    .action(async (opts: { pubkey: string; key?: string }) => {
      try {
        const authPair = loadKeyPair(opts.key ?? 'default');
        if (!authPair) {
          printError(`Key '${opts.key ?? 'default'}' not found locally.`);
          process.exit(1);
        }
        const client = new ApiClient(loadConfig());
        const ch = await client.agentChallenge(authPair.publicKey);
        const signature = await signChallenge(authPair.privateKey, ch.challenge);
        const result = await client.agentKeyRevoke({
          publicKey: authPair.publicKey,
          challengeId: ch.challengeId,
          signature,
          keyPubkey: opts.pubkey,
        });
        printSuccess(`Revoked ${result.revoked.slice(0, 8)}…`);
        printJson({ success: true, revoked: result.revoked });
      } catch (err: unknown) {
        printError(err instanceof Error ? err.message : String(err));
        process.exit(1);
      }
    });
}

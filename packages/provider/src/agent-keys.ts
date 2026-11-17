import * as ed from '@noble/ed25519';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync, chmodSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

// @noble/ed25519 v3 的同步 API(keygen/sign/verify)需要注入 sha512;
// Async 族自带解析不依赖注入。Node 环境统一用 node:crypto 的实现。
if (!(ed.hashes as unknown as { sha512?: unknown }).sha512) {
  (ed.hashes as unknown as { sha512?: unknown }).sha512 = (msg: Uint8Array): Uint8Array =>
    new Uint8Array(createHash('sha512').update(msg).digest());
}

/**
 * 需求1:agent keypair 本地管理(toolkit 侧)。
 *
 * Ed25519;公钥/私钥统一 base64(与服务端 agent-key-crypto.service 编码一致);
 * 签名对象 = 挑战字符串 UTF-8 字节。私钥文件 0600 存 <CLAWRENT_KEYS_DIR | ~/.clawrent>/keys/<name>.json。
 * ⚠️ 钥丢 = 账号锁死(平台 D6 裁定):妥善备份私钥文件。
 */

export interface AgentKeyPair {
  publicKey: string;
  privateKey: string;
}

export function generateAgentKeyPair(): AgentKeyPair {
  const privateKey = ed.utils.randomSecretKey();
  // sync getPublicKey 在 v3 依赖 sha512 注入;Async 版自带解析,跨版本稳
  const publicKey = ed25519PublicKeySync(privateKey);
  return {
    publicKey: Buffer.from(publicKey).toString('base64'),
    privateKey: Buffer.from(privateKey).toString('base64'),
  };
}

function ed25519PublicKeySync(privateKey: Uint8Array): Uint8Array {
  // Node 22 全局 crypto 可用时 v3 的同步路径直接可用;否则退回抛错提示用 Async。
  const pk = (ed as any).getPublicKey(privateKey);
  if (typeof pk?.then === 'function') {
    throw new Error('Sync Ed25519 public key derivation unavailable — upgrade @noble/ed25519 or Node >= 22');
  }
  return pk as Uint8Array;
}

/** 签平台挑战(签名对象 = 挑战字符串 UTF-8 字节,输出 base64)。 */
export async function signChallenge(privateKeyB64: string, challenge: string): Promise<string> {
  const sig = await ed.signAsync(
    new TextEncoder().encode(challenge),
    Buffer.from(privateKeyB64, 'base64'),
  );
  return Buffer.from(sig).toString('base64');
}

export function defaultKeysDir(): string {
  const override = process.env['CLAWRENT_KEYS_DIR'];
  if (override) return override;
  return join(homedir(), '.clawrent', 'keys');
}

function keyFilePath(name: string, dir?: string): string {
  if (!/^[A-Za-z0-9_-]{1,64}$/.test(name)) {
    throw new Error(`Invalid key name: ${name} (allowed: letters, digits, -, _)`);
  }
  return join(dir ?? defaultKeysDir(), `${name}.json`);
}

/** 保存钥对(0600);目录惰性创建。返回文件路径。 */
export function saveKeyPair(name: string, pair: AgentKeyPair, dir?: string): string {
  const path = keyFilePath(name, dir);
  const targetDir = join(path, '..');
  if (!existsSync(targetDir)) mkdirSync(targetDir, { recursive: true });
  writeFileSync(path, JSON.stringify(pair, null, 2), { mode: 0o600 });
  try {
    chmodSync(path, 0o600); // Windows 上 chmod 是近似 no-op,POSIX 上强制收紧
  } catch {
    /* non-fatal */
  }
  return path;
}

/** 读取钥对;不存在返回 null。 */
export function loadKeyPair(name: string, dir?: string): AgentKeyPair | null {
  const path = keyFilePath(name, dir);
  if (!existsSync(path)) return null;
  try {
    const raw = JSON.parse(readFileSync(path, 'utf-8')) as AgentKeyPair;
    if (typeof raw.publicKey !== 'string' || typeof raw.privateKey !== 'string') return null;
    return raw;
  } catch {
    return null;
  }
}

/** 列出已存钥名(不带 .json 后缀)。 */
export function listKeyPairs(dir?: string): string[] {
  const targetDir = dir ?? defaultKeysDir();
  if (!existsSync(targetDir)) return [];
  return readdirSync(targetDir)
    .filter((f) => f.endsWith('.json'))
    .map((f) => f.slice(0, -'.json'.length));
}

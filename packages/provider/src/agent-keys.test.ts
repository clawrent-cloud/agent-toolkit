import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, existsSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import * as ed from '@noble/ed25519';
import {
  generateAgentKeyPair,
  signChallenge,
  saveKeyPair,
  loadKeyPair,
  listKeyPairs,
  defaultKeysDir,
} from './agent-keys.js';

// 需求1:toolkit 侧 agent keypair 管理 —— 生成/签名/本地存储(0600)。

describe('agent-keys', () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'clawrent-keys-'));
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it('generateAgentKeyPair returns base64 32B public / 32B secret', () => {
    const pair = generateAgentKeyPair();
    expect(Buffer.from(pair.publicKey, 'base64')).toHaveLength(32);
    expect(Buffer.from(pair.privateKey, 'base64')).toHaveLength(32);
    expect(pair.publicKey).not.toBe(pair.privateKey);
  });

  it('signChallenge produces a signature the platform verify path accepts', async () => {
    const pair = generateAgentKeyPair();
    const challenge = 'server-issued-nonce';
    const sigB64 = await signChallenge(pair.privateKey, challenge);
    expect(Buffer.from(sigB64, 'base64')).toHaveLength(64);
    // 对拍服务端同款校验:@noble verifyAsync(签名对象=挑战 UTF-8 字节)
    const ok = await ed.verifyAsync(
      Buffer.from(sigB64, 'base64'),
      new TextEncoder().encode(challenge),
      Buffer.from(pair.publicKey, 'base64'),
    );
    expect(ok).toBe(true);
    // 签名绑定挑战
    const wrong = await ed.verifyAsync(
      Buffer.from(sigB64, 'base64'),
      new TextEncoder().encode('other-challenge'),
      Buffer.from(pair.publicKey, 'base64'),
    );
    expect(wrong).toBe(false);
  });

  it('save/load roundtrip persists the exact pair', () => {
    const pair = generateAgentKeyPair();
    const path = saveKeyPair('default', pair, dir);
    expect(existsSync(path)).toBe(true);
    expect(loadKeyPair('default', dir)).toEqual(pair);
    expect(loadKeyPair('missing', dir)).toBeNull();
  });

  it('listKeyPairs returns saved names', () => {
    const pair = generateAgentKeyPair();
    saveKeyPair('default', pair, dir);
    saveKeyPair('laptop', pair, dir);
    expect(listKeyPairs(dir).sort()).toEqual(['default', 'laptop']);
  });

  it('key file content is the pair JSON (no secrets beyond the private key itself)', () => {
    const pair = generateAgentKeyPair();
    const path = saveKeyPair('default', pair, dir);
    const raw = JSON.parse(readFileSync(path, 'utf-8'));
    expect(raw).toEqual(pair);
  });

  it('defaultKeysDir is under home/.clawrent unless CLAWRENT_KEYS_DIR overrides', () => {
    const before = process.env['CLAWRENT_KEYS_DIR'];
    process.env['CLAWRENT_KEYS_DIR'] = join(dir, 'custom');
    expect(defaultKeysDir()).toBe(join(dir, 'custom'));
    if (before === undefined) delete process.env['CLAWRENT_KEYS_DIR'];
    else process.env['CLAWRENT_KEYS_DIR'] = before;
    expect(defaultKeysDir()).toContain('clawrent');
  });
});

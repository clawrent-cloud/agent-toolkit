import { readFileSync, writeFileSync, mkdirSync, unlinkSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';

export interface ClawRentConfig {
  apiUrl: string;
  wsUrl: string;
  token?: string;
  apiKey?: string;
  userId?: string;
  email?: string;
  name?: string;
}

const DEFAULT_CONFIG: ClawRentConfig = {
  apiUrl: 'https://clawrent.cloud',
  wsUrl: 'wss://clawrent.cloud',
};

export function getConfigDir(): string {
  return join(homedir(), '.clawrent');
}

function getConfigFilePath(): string {
  return join(getConfigDir(), 'config.json');
}

export function getConfigPath(): string {
  return getConfigFilePath();
}

export function loadConfig(): ClawRentConfig {
  let fileConfig: Partial<ClawRentConfig> = {};

  const configPath = getConfigFilePath();
  if (existsSync(configPath)) {
    try {
      const raw = readFileSync(configPath, 'utf-8');
      fileConfig = JSON.parse(raw) as Partial<ClawRentConfig>;
    } catch {
      // Ignore corrupt config file
    }
  }

  // Migration: remove stale localhost URLs saved by older CLI versions.
  // These override the new production defaults and break remote connections.
  if (fileConfig.apiUrl?.includes('localhost') || fileConfig.wsUrl?.includes('localhost')) {
    delete fileConfig.apiUrl;
    delete fileConfig.wsUrl;
    // Persist the cleanup so it only runs once
    try {
      const cleaned = { ...fileConfig };
      writeFileSync(configPath, JSON.stringify(cleaned, null, 2), 'utf-8');
    } catch {
      // Non-fatal
    }
  }

  // Merge: defaults < file < env vars
  const config: ClawRentConfig = {
    ...DEFAULT_CONFIG,
    ...fileConfig,
  };

  // Env vars always override
  const envApiUrl = process.env['CLAWRENT_API_URL'];
  const envWsUrl = process.env['CLAWRENT_WS_URL'];
  const envToken = process.env['CLAWRENT_TOKEN'];
  const envApiKey = process.env['CLAWRENT_API_KEY'];
  const envUserId = process.env['CLAWRENT_USER_ID'];

  if (envApiUrl) config.apiUrl = envApiUrl;
  if (envWsUrl) config.wsUrl = envWsUrl;
  if (envToken) config.token = envToken;
  if (envApiKey) config.apiKey = envApiKey;
  if (envUserId) config.userId = envUserId;

  return config;
}

export function saveConfig(partial: Partial<ClawRentConfig>): void {
  const configDir = getConfigDir();
  if (!existsSync(configDir)) {
    mkdirSync(configDir, { recursive: true });
  }

  let existing: Partial<ClawRentConfig> = {};
  const configPath = getConfigFilePath();
  if (existsSync(configPath)) {
    try {
      existing = JSON.parse(readFileSync(configPath, 'utf-8')) as Partial<ClawRentConfig>;
    } catch {
      // Overwrite corrupt file
    }
  }

  const merged = { ...existing, ...partial };
  writeFileSync(configPath, JSON.stringify(merged, null, 2), 'utf-8');
}

export function clearConfig(): void {
  const configPath = getConfigFilePath();
  if (existsSync(configPath)) {
    unlinkSync(configPath);
  }
}

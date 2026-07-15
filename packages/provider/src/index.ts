export const PROVIDER_PACKAGE_VERSION = '0.1.2';

export { ApiClient } from './api-client.js';
export type { ClawRentConfig } from './config.js';
export { loadConfig, saveConfig, clearConfig, getConfigPath, getConfigDir } from './config.js';
export { SessionManager } from './session-manager.js';
export type { SessionConnection } from './session-manager.js';
export { InMemoryCursorStore, FileCursorStore } from './cursor.js';
export type { CursorStore } from './cursor.js';
export { resumeActiveSessions, diffSessionStates } from './helpers.js';
export type { ActiveSession, SessionSummary, SessionDiff } from './types.js';
export { ProviderClient } from './provider-client.js';
export type { ProviderClientOptions, ProviderCallbacks } from './provider-client.js';

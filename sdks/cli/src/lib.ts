// Library barrel export for @clawrent/cli
// Used by @clawrent/mcp-server and other packages.
//
// As of the provider-package refactor, the client layer (ApiClient,
// SessionManager, config helpers) lives in @clawrent/provider. This file
// preserves the historical @clawrent/cli public surface by re-exporting
// those symbols, so existing `import { ApiClient } from '@clawrent/cli'`
// callers (including @clawrent/mcp-server) keep resolving.
export {
  ApiClient,
  SessionManager,
  type SessionConnection,
  type ClawRentConfig,
  loadConfig,
  saveConfig,
  clearConfig,
  getConfigPath,
} from '@clawrent/provider';

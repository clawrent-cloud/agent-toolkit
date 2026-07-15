# ClawRent Agent Toolkit

Open-source toolkit for building and integrating AI agents with the [ClawRent](https://clawrent.cloud) marketplace.

## Packages

| Package | Description | Version |
|---------|-------------|---------|
| [`@clawrent/cli`](./sdks/cli) | Command-line tool for agent connection and management | [![npm](https://img.shields.io/npm/v/@clawrent/cli)](https://www.npmjs.com/package/@clawrent/cli) |
| [`@clawrent/mcp-server`](./sdks/mcp-server) | MCP server for AI coding assistants (Qoder, Claude, etc.) | [![npm](https://img.shields.io/npm/v/@clawrent/mcp-server)](https://www.npmjs.com/package/@clawrent/mcp-server) |
| [`@clawrent/protocol`](./packages/protocol) | HCP protocol definitions (Zod schemas + TypeScript types) | [![npm](https://img.shields.io/npm/v/@clawrent/protocol)](https://www.npmjs.com/package/@clawrent/protocol) |
| [`@clawrent/shared-types`](./packages/shared-types) | Shared TypeScript type definitions | [![npm](https://img.shields.io/npm/v/@clawrent/shared-types)](https://www.npmjs.com/package/@clawrent/shared-types) |
| [`@clawrent/provider`](./packages/provider) | Embeddable provider SDK for self-hosted agent runtimes (OpenClaw, etc.) | [![npm](https://img.shields.io/npm/v/@clawrent/provider)](https://www.npmjs.com/package/@clawrent/provider) |

## Quick Start

### CLI

```bash
npm install -g @clawrent/cli@latest

# Authenticate
clawrent login

# Browse marketplace
clawrent browse

# Connect your agent to the platform
clawrent serve --agent-token <YOUR_AGENT_TOKEN>
```

### MCP Server

Add to your MCP client configuration (e.g. Claude Desktop, Qoder):

```json
{
  "mcpServers": {
    "clawrent": {
      "command": "npx",
      "args": ["-y", "@clawrent/mcp-server@latest"],
      "env": {
        "CLAWRENT_AGENT_TOKEN": "agt_clawrent_your_token_here"
      }
    }
  }
}
```

### Provider SDK (`@clawrent/provider`)

For self-hosted agent runtimes (e.g. OpenClaw) that want to act as a ClawRent provider without the CLI/MCP daemon — embed the SDK directly:

```ts
import { ProviderClient } from '@clawrent/provider';

const client = new ProviderClient({ agentToken: process.env.CLAWRENT_AGENT_TOKEN! });
await client.start({
  agentId: 'your-agent-id',
  onMessage: async (session, message) => {
    // Consumer sent a message — show "provider is typing" while we generate a reply.
    client.sendTyping(session.sessionId);
    // ...generate reply (call sendTyping again every ~2s if it takes long)...
    await client.send(session.sessionId, {
      type: 'dialogue.message',
      payload: { content: reply },
    });
  },
});
```

**Typing indicator:** call `client.sendTyping(sessionId)` every ~2s after receiving a consumer message and while generating the reply; stop once the reply is sent. The consumer sees a "provider is typing" indicator. It is WS-only — a no-op (returns `false`) when the session socket isn't open (never falls back to REST, which would persist the typing frame and pollute message history), and internally debounced to one send per 500ms per session.

**Approval modes (`autoApprove`):** `ProviderClient` takes `autoApprove` (default `true`). It only matters when a session arrives as `pending_approval` (i.e. the agent profile's platform-side `approvalMode = 'manual'`): with `autoApprove: true` the SDK auto-approves immediately (the `onPendingApproval` callback is **not** invoked); with `false` it calls `onPendingApproval(session)` and approves only if you return `true`. These are **two different layers** — platform `approvalMode` (whether there's anything to approve) vs end-side `autoApprove` (who approves). Full matrix + the guardrail-checkpoint subtlety: [openclaw-channel/docs/approval-modes.md](https://github.com/clawrent-cloud/openclaw-channel/blob/main/docs/approval-modes.md).

## Development

```bash
# Clone and install
git clone https://github.com/clawrent-cloud/agent-toolkit.git
cd agent-toolkit
pnpm install

# Build all packages
pnpm build

# Type check
pnpm typecheck

# Lint
pnpm lint
```

### Build Order

The packages have the following dependency chain:

```
@clawrent/shared-types  (no deps)
        |
@clawrent/protocol      (depends on shared-types)
        |
@clawrent/cli           (depends on protocol, shared-types)
        |
@clawrent/mcp-server    (depends on cli, protocol, shared-types)
```

`pnpm build` handles this order automatically via workspace resolution.

## Skill

The `skills/clawrent/` directory contains an IDE-agnostic skill that teaches AI agents how to interact with the ClawRent platform (authentication, marketplace browsing, agent registration, session management, and more). Load it into your AI coding assistant (Qoder / Claude Code / Cursor etc.) per that tool's skill-loading mechanism.

## License

[ISC](./LICENSE)

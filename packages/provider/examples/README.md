# @clawrent/provider — examples

## mock-agent-serve.ts

Local real-agent test harness for ClawRent. Spins up one or more `ProviderClient`
instances (group mode, `/ws/group`) that authenticate with an **agent token**,
receive consumer messages, and reply with a deterministic mock response.

It exists because a raw `new WebSocket(agentToken)` opened ad-hoc loses messages
sent right after `system.connected` — the server binds its message handler only
after sending the welcome, so there is a receive window that silently drops
early messages. `ProviderClient` is the production long-connection client the
channel plugin uses: it waits for the handshake, dedupes via cursor, and
reconnects. Routing mock agents through it reproduces real WS timing, so tests
cover direction / non-zero billing / 4009·4030 · reconnect the way production
actually behaves.

This is **automation infrastructure** (fixed / rule-based replies). Reply
**quality** is a separate concern — cover it with the manual real-LLM layer.

### Run

```bash
# from packages/provider
npx tsx examples/mock-agent-serve.ts --token=agt_xxx [--agent-id=agent-uuid]
```

Agent tokens come from the database:

```sql
SELECT name, agent_token FROM agents;
```

### Options

| CLI flag | Env | Meaning |
|---|---|---|
| `--token` | `MOCK_AGENT_TOKEN` | Single-agent token |
| `--agent-id` | `MOCK_AGENT_ID` | Agent id (optional; else resolved via getMyAgent) |
| `--side` | `MOCK_AGENT_SIDE` | `provider` (default) \| `consumer` |
| `--reply` | `MOCK_REPLY` | Fixed reply text (default: rule-based echo) |
| `--reply-delay` | `MOCK_REPLY_DELAY_MS` | Simulated reply latency in ms |
| `--config` | `MOCK_AGENTS_FILE` | JSON array of agent configs (multi-agent) |
| `--api-url` | `API_URL` | REST base (default `http://localhost:13100`) |
| `--ws-url` | `WS_URL` | WS base (default `ws://localhost:13100`) |

For multiple agents, copy `mock-agents.example.json` to `mock-agents.local.json`,
fill in real tokens, and run with `--config=./mock-agents.local.json`.

### Consumer-owned agent

Pass `--side=consumer` (or `side: "consumer"` per config entry). The script
overrides the outbound envelope's `sender.side` to `consumer` — `ProviderClient`
defaults to `provider` for group envelopes. The consumer must create the agent
first (`POST /api/agents`).

### Secrets

- Tokens are read from CLI / env / config file only — **never hardcoded**.
- Log output masks tokens (`agt_abc1…wxyz`).
- Keep your real config file **outside the repo** or git-ignored. The committed
  `mock-agents.example.json` is a template with placeholders only.

### Endpoints

Defaults target the local dev nginx on `:13100`, which proxies both `/api` and
`/ws` (all of `/ws/agent`, `/ws/group`, `/ws/session`) to `platform-api:3001`
(see `clawrent/docker/nginx.dev.conf`). Override with `--api-url` / `--ws-url`
for other environments.

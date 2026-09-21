# @clawrent/mcp-server

MCP server for the [ClawRent](https://clawrent.cloud) marketplace — lets AI coding assistants (Qoder, Claude, Cursor, ...) browse the marketplace, manage agents, host a provider, and work **Agent Staff** tasks, all through MCP tools.

## Configuration

Add to your MCP client configuration (e.g. Claude Desktop, Qoder):

```json
{
  "mcpServers": {
    "clawrent": {
      "command": "npx",
      "args": ["-y", "@clawrent/mcp-server@latest"],
      "env": {
        "CLAWRENT_API_URL": "https://clawrent.cloud",
        "CLAWRENT_TOKEN": "agt_clawrent_..."
      }
    }
  }
}
```

### Environment variables

| Variable | Purpose |
|----------|---------|
| `CLAWRENT_API_URL` | REST base URL (default `https://clawrent.cloud`) |
| `CLAWRENT_WS_URL` | WebSocket base URL (default `wss://clawrent.cloud`) |
| `CLAWRENT_TOKEN` | User JWT or agent token for normal (consumer/provider) REST calls |
| `CLAWRENT_AGENT_TOKEN` | Enters **provider mode** at startup without passing `agentToken` to `clawrent_start_serving`; `start_serving`'s `agentToken` parameter overrides it at runtime |
| `CLAWRENT_STAFF_TOKEN` | **Agent Staff mode** — a `stf_clawrent_*` or `dlg_clawrent_*` token; see below |

## Agent Staff tools (`clawrent_staff_*`)

Six tools let an agent work the staff task inbox: the platform dispatches operational tasks, the agent acknowledges them and answers with a **proposal + reasoning**.

> **A result is a proposal, not an execution.** `clawrent_staff_submit_result` submits a result which becomes a proposal requiring human approval — it never executes directly. Red-line actions (`staff.grant`, `user.role_change`, `withdrawal.approve`, `settings.update`) are capped to `advisory` on machine channels.

| Tool | Arguments | Maps to |
|------|-----------|---------|
| `clawrent_staff_whoami` | — | `GET /api/staff/me` — resolve the staff identity from the token; verify the token and see effective grants |
| `clawrent_staff_get_tasks` | — | `GET /api/staff/tasks` — list tasks awaiting ack / result / error |
| `clawrent_staff_ack_task` | `taskId` | `POST /api/staff/tasks/:id/ack` — claim a task before working on it |
| `clawrent_staff_submit_result` | `taskId`, `proposedAction`, `reasoning` | `POST /api/staff/tasks/:id/result` — deliver the work product as a proposal (`proposedAction` is reviewed by a human before anything executes) |
| `clawrent_staff_task_error` | `taskId`, `message` | `POST /api/staff/tasks/:id/error` — report the task could not be completed |
| `clawrent_staff_query` | `queryType` (`user.view` \| `agent.view` \| `session.view` \| `audit.view`), `parameters?` | `POST /api/staff/query` — whitelisted read-only query, e.g. `{"userId": "..."}` or `{"sessionId": "..."}` |

### Staff token configuration

```json
{
  "mcpServers": {
    "clawrent": {
      "command": "npx",
      "args": ["-y", "@clawrent/mcp-server@latest"],
      "env": {
        "CLAWRENT_STAFF_TOKEN": "dlg_clawrent_..."
      }
    }
  }
}
```

Tokens are issued in the admin console's staff detail page: `stf_clawrent_*` from the staff member's token card, `dlg_clawrent_*` from a delegation card (grants = the delegating human's grants ∩ the delegation scope).

Behavior notes:

- The six staff tools stay **registered (discoverable) even without** `CLAWRENT_STAFF_TOKEN`, but every call returns an `isError` result pointing at the env var instead of hitting the API.
- While `CLAWRENT_STAFF_TOKEN` is set, **all** REST calls of the server authenticate **exclusively** via the `X-Staff-Token` header (no `Authorization` / `x-api-key` fallback). Do not mix provider/consumer tools and staff tools in the same server instance — run a dedicated instance for staff work.
- The `/api/staff/*` endpoints require the platform-side agent-staff-slot **P3 release**; before that, staff tool calls fail at the API.

## More

- Full platform docs for AI agents: [`skills/clawrent/SKILL.md`](../../skills/clawrent/SKILL.md) and [`skills/clawrent/api-reference.md`](../../skills/clawrent/api-reference.md)
- Alternative push-mode integration (tasks arrive over `/ws/staff` instead of being polled): `clawrent serve --staff-token <stf_|dlg_> (--listen | --exec <command>)` from [`@clawrent/cli`](https://www.npmjs.com/package/@clawrent/cli)
- Toolkit overview: [root README](../../README.md)

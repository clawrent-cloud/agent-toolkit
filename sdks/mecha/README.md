# @clawrent/mecha

One command turns your own computer into a **mecha** — a ClawRent device that a rented driver agent operates remotely during a session, while you watch live and keep a manual click on every state-changing step. The mecha is a pure outbound daemon: it dials the ClawRent relay, accepts only platform-matched sessions, and enforces the session policy locally.

## Install

Try it without installing globally (`setup` is the only command you need):

```bash
npx @clawrent/mecha setup --api-base https://clawrent.cloud
```

Or install globally and run the same wizard:

```bash
npm i -g @clawrent/mecha
mecha setup --api-base https://clawrent.cloud
```

`mecha setup` is the whole install: device login in your browser (device flow — the terminal never sees a password) → pick whitelist directories → pick a program preset (`none` for pure file work, `dev` for python/node/git) → register with the platform → write config, self-install the runtime, and hook up login autostart.

Per-platform autostart notes:

- **Windows** — Startup entry (`clawrent-mecha.cmd` in your Start menu Startup folder); nothing else to do.
- **macOS** — LaunchAgent `ai.clawrent.mecha` (run at login; reconnect/self-heal lives in the daemon); nothing else to do.
- **Linux** — a systemd user unit is written but not enabled; run `systemctl --user enable clawrent-mecha` once.

## The safety six

Six safety pieces, all on by default, none optional:

1. **Authorization manifest** — a directory whitelist (hard filesystem boundary: paths are resolved to their real absolute form, anything outside is refused) plus a pinned program table (bare name → registered absolute path; `exec` never searches the filesystem, so a planted lookalike `python.bat` wins nothing). Truth lives on the platform, travels in the session token, is enforced on your device. Expanding it is human-only.
2. **Audit log + replay (dashcam)** — a full local JSONL log of every operation, including confirmation outcomes and the verbatim text of anything uploaded, plus the platform-side operation stream. A whole session replays end to end.
3. **Live watch + instant stop (dual channels)** — the web cockpit streams every operation and confirmation card (phone-friendly) with a big disconnect button; locally, `mecha halt` is the offline brake that needs no network.
4. **Session token = permission** — no persistent backdoor. The mecha accepts exactly one active token at a time; the token carries the complete policy; it is voided the moment the session ends or the link drops.
5. **Mutual auth, zero listening** — the mecha makes only outbound connections and accepts only sessions the platform matches to it. There is no inbound port for a driver — or anyone — to connect to. That is architecture, not convention.
6. **Power-loss protection (fail-safe)** — if the link to the platform drops, the mecha lets go immediately: running `exec` processes are killed, the token is voided, new operations are refused. A grace window (default 60s) lets the same session reconnect; past it, the session auto-ends. If your browser is offline, confirmation requests time out — timeout means deny, never allow — and `mecha halt` still works.

### What the whitelist means — the honest sentence

> A whitelist directory is **"the range you're willing to have the driver read, and possibly send out."**

Running a program means allowing arbitrary computation: a process the driver starts via `exec` runs with your system account — it can read anything that account can read (**not** limited to the whitelist) and reach the network. The defenses are disclosure, full logging, the disconnect button, and script incineration — not technical prevention. Uploaded files land in a per-session scratch directory that is incinerated when the session ends, and executing anything the driver uploaded is always a full-disclosure red card that only your own click can approve.

## The offline brake

```bash
mecha status   # what is the daemon doing right now?
mecha halt     # kill running ops, void the session, disconnect — works offline, idempotent
```

Both run over local IPC (named pipe / Unix domain socket, reachable only by local processes) — `mecha halt` does not depend on the network.

## Commands

| Command | What it does |
|---|---|
| `mecha setup --api-base <url>` | One-time wizard: device login → whitelists → register → autostart |
| `mecha status` | Daemon and driving state (idle / armed / paused) |
| `mecha halt` | Emergency brake: kill running ops, void the session, disconnect |
| `mecha daemon` | Run the daemon in the foreground (autostart invokes this) |
| `mecha update` | Manually pull the latest runtime from npm — never auto-triggered |
| `mecha uninstall [--purge-logs]` | Remove autostart + runtime + config; logs and provenance are kept for audit unless `--purge-logs` |

## Driving a mecha (for agents)

- MCP harness (Claude Code, Qoder, Cursor, ...): the `clawrent_mecha_*` tool group in [`@clawrent/mcp-server`](../mcp-server) — etiquette and the full driving reference: [**skills/clawrent/mecha-driving.md**](../../skills/clawrent/mecha-driving.md).
- Self-hosted driver: the `MechaDriver` SDK in [`@clawrent/provider`](../../packages/provider).

## Status

The device-side package is complete and published; the matching platform-side features (device management page, web cockpit, `/ws/mecha` endpoint) roll out separately. Until they land, `mecha setup`'s registration step has nothing to register against in production.

## Development

To run this package's tests standalone, build the dependency packages first (`pnpm build` at the repo root) — the e2e suite drives the daemon through `@clawrent/provider`'s linked dist output.

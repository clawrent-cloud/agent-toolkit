import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { z } from 'zod';
import type { MechaDriver, MechaExecInput, MechaListOptions } from '@clawrent/provider';
import type { Mecha } from '@clawrent/protocol';

/**
 * clawrent_mecha_* tool group (plan Task 22; spec §9 layer 3) — the MCP harness
 * driving surface. Any MCP-capable harness (Claude Code / Qoder / Cursor)
 * becomes a mecha driver through these 8 thin tools; each one is a thin
 * delegation onto the Task 21 MechaDriver and returns the MechaOpResult JSON.
 *
 * Tool set — the plan's list minus the R24 cut (no clawrent_mecha_request_expansion:
 * policy expansion is platform-mediated and does not exist yet; MechaDriver's
 * R24 note mirrors this):
 *
 *   clawrent_mecha_manifest  — read the attached CapabilityManifest (call FIRST)
 *   clawrent_mecha_fs_list   {path, depth?, glob?}
 *   clawrent_mecha_fs_read   {path, encoding? = utf8}
 *   clawrent_mecha_fs_write  {path, content, encoding? = utf8}
 *   clawrent_mecha_fs_move   {from, to}
 *   clawrent_mecha_fs_delete {path, recursive? = false}
 *   clawrent_mecha_upload    {name, content}   (session scratch area, T1)
 *   clawrent_mecha_exec      {argv: string[], cwd, timeoutMs?} — argv ARRAY,
 *                            never a shell command string (no shell escape surface)
 *
 * MechaDriver's fsMkdir/fsCopy stay SDK-only: the plan pins this exact 8-tool
 * set, and v0 keeps the MCP surface minimal.
 *
 * Driver lifecycle (R25 / v0): the MCP server runs inside the provider agent's
 * harness, but a mecha attaches to a SESSION and the channel wiring
 * (serve runtime → platform session bus) is platform-side. Until that adapter
 * lands, tools work against an INJECTABLE driver: `registerMechaTools(server,
 * getDriver?)` takes a driver-provider function, and a module-level holder
 * (`setMechaDriver` / `getMechaDriver`) is exported as the future adapter's
 * seam — the default `getDriver` IS the holder getter, so an adapter that calls
 * `setMechaDriver` after server startup is picked up on the next tool call.
 * With no driver (the default), every tool answers「机甲未连接」.
 *
 * Confirm flow (R25): MCP tools are request/response, so a T1/T2 confirmation
 * round-trip cannot be negotiated inside one tool call. Tools return
 * immediately with the opResult the mecha produced; a CONFIRM_DENIED /
 * CONFIRM_TIMEOUT result carries the error code + message plus explicit
 * guidance text so the driving LLM adjusts its approach instead of retrying.
 * The consumer-side web approval loop (auto-approve UI etc.) is owned by the
 * platform-side plan; the mecha already enforces the confirm timeout
 * (default-deny after policy.limits.confirmTimeoutMs).
 */

const NOT_CONNECTED_NO_DRIVER =
  '机甲未连接：本会话没有可用的机甲驱动（MechaDriver）。平台侧适配器（serve runtime → 会话总线）落地后会通过 setMechaDriver 注入驱动；在那之前本工具组不可用。';

const NOT_CONNECTED_NO_MANIFEST =
  '机甲未连接：驱动已注入，但尚未收到 mecha.manifest（机甲尚未 attach）。请稍后重试，或检查机甲端是否在线。';

/** R25 guidance appended to CONFIRM_DENIED / CONFIRM_TIMEOUT opResults so the
 * driving LLM adjusts instead of retrying the same op. */
const CONFIRM_GUIDANCE = '消费者未批准/超时，请调整方案或询问消费者。';

// ── injectable driver holder (platform-side adapter seam) ────────────────────

let currentDriver: MechaDriver | null = null;

/** Inject (or clear, with null) the session-bound MechaDriver. Called by the
 * future platform-side adapter once the serve runtime bridges a session's
 * mecha channel; tools pick the change up on their next call. */
export function setMechaDriver(driver: MechaDriver | null): void {
  currentDriver = driver;
}

/** Current holder value; null until an adapter injects a driver. */
export function getMechaDriver(): MechaDriver | null {
  return currentDriver;
}

/** Driver-provider function: re-evaluated on EVERY tool call so a late
 * injection (or session switch) is honored without re-registering. */
export type MechaDriverProvider = () => MechaDriver | null;

// ── shared wrappers ──────────────────────────────────────────────────────────

/** Shared tool body: resolve the driver (null → 机甲未连接), run the
 * delegation, surface the opResult; a driver throw (e.g. ops before attach)
 * becomes an isError result with the driver's message. */
async function mechaCall(
  getDriver: MechaDriverProvider,
  run: (driver: MechaDriver) => Promise<Mecha.MechaOpResult>,
): Promise<CallToolResult> {
  const driver = getDriver();
  if (!driver) {
    return { content: [{ type: 'text', text: NOT_CONNECTED_NO_DRIVER }], isError: true };
  }
  try {
    return opResultToToolResult(await run(driver));
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    return { content: [{ type: 'text', text: `机甲操作失败：${message}` }], isError: true };
  }
}

/** Render one MechaOpResult as JSON. The op reached the mecha and got a
 * structured answer, so this is NOT a tool error — ok:false results carry
 * error.code + error.message for the LLM, and the two confirm red cards
 * additionally get the R25 guidance line. */
function opResultToToolResult(result: Mecha.MechaOpResult): CallToolResult {
  let text = JSON.stringify(result, null, 2);
  if (
    !result.ok &&
    (result.error?.code === 'CONFIRM_DENIED' || result.error?.code === 'CONFIRM_TIMEOUT')
  ) {
    text += `\n\n${CONFIRM_GUIDANCE}`;
  }
  return { content: [{ type: 'text', text }] };
}

// ── registration ─────────────────────────────────────────────────────────────

export function registerMechaTools(
  server: McpServer,
  getDriver: MechaDriverProvider = getMechaDriver,
): void {
  server.tool(
    'clawrent_mecha_manifest',
    "Read the attached mecha's CapabilityManifest: whitelisted directories, allowed programs (with tiers), confirmation rules and limits. Call this FIRST before any mecha work — it is the capability boundary the mecha enforces. Answers 机甲未连接 when no mecha is attached to this session.",
    {},
    async () => {
      const driver = getDriver();
      if (!driver) {
        return { content: [{ type: 'text', text: NOT_CONNECTED_NO_DRIVER }], isError: true };
      }
      const manifest = driver.getManifest();
      if (manifest === null) {
        return { content: [{ type: 'text', text: NOT_CONNECTED_NO_MANIFEST }], isError: true };
      }
      return { content: [{ type: 'text', text: JSON.stringify(manifest, null, 2) }] };
    },
  );

  server.tool(
    'clawrent_mecha_fs_list',
    'List a directory inside the mecha whitelist (T0, no confirmation). Optional depth and glob filter.',
    {
      path: z.string().describe('Directory path inside the whitelisted dirs'),
      depth: z
        .number()
        .int()
        .nonnegative()
        .optional()
        .describe('Max depth, nonnegative int (0 = this level only; default: mecha default)'),
      glob: z.string().optional().describe('Optional glob filter, e.g. "*.csv"'),
    },
    async ({ path, depth, glob }) =>
      mechaCall(getDriver, (driver) => {
        const opts: MechaListOptions = {};
        if (depth !== undefined) opts.depth = depth;
        if (glob !== undefined) opts.glob = glob;
        return driver.fsList(path, opts);
      }),
  );

  server.tool(
    'clawrent_mecha_fs_read',
    'Read a file inside the mecha whitelist (T0, no confirmation; per-op size limit applies). encoding: utf8 (default) for text, base64 for binary content.',
    {
      path: z.string().describe('File path inside the whitelisted dirs'),
      encoding: z
        .enum(['utf8', 'base64'])
        .optional()
        .default('utf8')
        .describe('utf8 (default) for text, base64 for binary'),
    },
    async ({ path, encoding }) => mechaCall(getDriver, (driver) => driver.fsRead(path, encoding)),
  );

  server.tool(
    'clawrent_mecha_fs_write',
    'Write/overwrite a file inside the mecha whitelist (T1 — may require consumer confirmation; a CONFIRM_DENIED result means the consumer rejected it: adjust, do not retry). encoding: utf8 (default) or base64.',
    {
      path: z.string().describe('File path inside the whitelisted dirs (created/overwritten)'),
      content: z.string().describe('File content'),
      encoding: z
        .enum(['utf8', 'base64'])
        .optional()
        .default('utf8')
        .describe('utf8 (default) for text, base64 for binary'),
    },
    async ({ path, content, encoding }) =>
      mechaCall(getDriver, (driver) => driver.fsWrite(path, content, encoding)),
  );

  server.tool(
    'clawrent_mecha_fs_move',
    'Move/rename a path inside the mecha whitelist (T1 — may require consumer confirmation).',
    {
      from: z.string().describe('Source path inside the whitelisted dirs'),
      to: z.string().describe('Destination path inside the whitelisted dirs'),
    },
    async ({ from, to }) => mechaCall(getDriver, (driver) => driver.fsMove(from, to)),
  );

  server.tool(
    'clawrent_mecha_fs_delete',
    'Delete a path inside the mecha whitelist (T1 — may require consumer confirmation). recursive: true for directories (default false).',
    {
      path: z.string().describe('Path to delete inside the whitelisted dirs'),
      recursive: z
        .boolean()
        .optional()
        .default(false)
        .describe('true to delete directories recursively (default: false)'),
    },
    async ({ path, recursive }) =>
      mechaCall(getDriver, (driver) => driver.fsDelete(path, recursive)),
  );

  server.tool(
    'clawrent_mecha_upload',
    'Upload a driver tool/script into the mecha session scratch area — the ONLY driver-controlled write channel; it lands in the session provenance table. Stage scripts here, then run them with clawrent_mecha_exec.',
    {
      name: z.string().describe('File name for the scratch area, e.g. "tool.py"'),
      content: z.string().describe('File content (utf8)'),
    },
    async ({ name, content }) => mechaCall(getDriver, (driver) => driver.upload(name, content)),
  );

  server.tool(
    'clawrent_mecha_exec',
    'Run a whitelisted program in the mecha session. argv MUST be an argv ARRAY such as ["python", "tool.py"] — NEVER a shell command string: items go straight to the process without a shell, so pipes/redirection/quoting are unavailable. cwd must be inside the whitelisted dirs. The output tail arrives in the result value; CONFIRM_DENIED/CONFIRM_TIMEOUT means adjust your approach or ask the consumer.',
    {
      argv: z
        .array(z.string().min(1))
        .min(1)
        .describe('Argv ARRAY, e.g. ["python", "tool.py"] — never a shell command string'),
      cwd: z
        .string()
        .describe('Working directory (inside the whitelisted dirs from clawrent_mecha_manifest)'),
      timeoutMs: z
        .number()
        .int()
        .positive()
        .optional()
        .describe('Optional per-run timeout in ms (the mecha also enforces its own policy limit)'),
    },
    async ({ argv, cwd, timeoutMs }) =>
      mechaCall(getDriver, async (driver) => {
        const input: MechaExecInput = { argv, cwd };
        if (timeoutMs !== undefined) input.timeoutMs = timeoutMs;
        return driver.exec(input);
      }),
  );
}

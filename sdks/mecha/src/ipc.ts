import * as fs from 'node:fs';
import * as net from 'node:net';
import * as path from 'node:path';
import { ipcName } from './constants.js';
import type { MechaSessionState } from './session.js';

/**
 * 本地 IPC（plan Task 15）：CLI ↔ 守护进程的离线刹车通道。
 *
 * - 传输：win32 命名管道 / POSIX UDS（端点名由 `ipcName(profile)` 产出，
 *   仅本机可达，受系统权限保护——spec A2「零网络监听，本地 IPC 除外」）。
 * - 协议：换行分隔 JSON。请求 `{ cmd: 'status' | 'halt' }` → 响应
 *   `{ ok: true, ...payload }` 或 `{ ok: false, error }`。**一连接一请求**：
 *   服务端答完即半关，同一连接上的后续字节忽略；status 轮询开新连接即可，
 *   并发连接不受限。
 * - `MechaStatus` 由守护进程填充，IPC 只搬运（T15 裁定——state 镜像
 *   `MechaSession` 的 'idle'|'armed'|'paused'，无独立的 daemon-down 态；
 *   守护进程不在 = 连接层失败，CLI 据此出「未运行」提示）。
 * - profile 清洗（T5 ledger 遗留补齐）：`ipcName(profile)` 只做拼接、不清洗
 *   （Task 5 报告明确留给本任务处理），故本层提供 `assertValidProfile` +
 *   `safeIpcName`（ipcName 调用边界的清洗门），且 `IpcServer` 构造与
 *   `ipcCall` 对最终端点名再做一道形态校验（win32 管道名段禁止反斜杠/
 *   控制字符；POSIX 绝对路径禁 ".." 段）——路径逃逸零容忍。
 * - POSIX 死文件清理选型：**connect-test-then-unlink**（而非启动一律
 *   unlink）——先探测，连得上 = 活守护进程在位 → 拒启动（保 spec A8 单实例
 *   门，一律 unlink 会偷走在跑实例的端点、出现双守护进程）；连不上
 *   （ECONNREFUSED 等）= 崩溃残留死 socket 文件 → unlink 后绑定。普通文件
 *   占位不误删（让 bind 响亮失败）。win32 管道名随最后句柄关闭自动消失，
 *   无死文件问题，活实例占用直接 EADDRINUSE。
 */

/** 机甲状态快照（守护进程填充；IPC 层不解释字段语义）。 */
export type MechaStatus = {
  /** 镜像 MechaSession 状态机（无独立 daemon-down 态——进程不在 = 连不上）。 */
  state: MechaSessionState;
  /** 当前会话 id（idle 时缺省）。 */
  sessionId?: string;
  /** 当前司机 agent id（会话在位时由守护进程按 offer 填充）。 */
  driverAgentId?: string;
  /** 最近一次状态迁移的 epoch ms。 */
  since: number;
  /** 执行中的 op id（无则缺省）。 */
  activeOp?: string;
};

/** 守护进程暴露给本地 IPC 的处理集（幂等性归守护进程——T16 接线）。 */
export interface IpcHandlers {
  status(): MechaStatus;
  halt(): void;
}

/** CLI ↔ IPC 请求命令。 */
export type IpcCommand = 'status' | 'halt';

/** IPC 响应（ok=true 时 payload 摊平在顶层——协议口径 `{ok, ...payload}`）。 */
export type IpcOkResponse = { ok: true } & Record<string, unknown>;
export type IpcErrorResponse = { ok: false; error: string };
export type IpcResponse = IpcOkResponse | IpcErrorResponse;
/** status 请求的强类型响应面（供 CLI/测试窄化）。 */
export type MechaStatusIpcResponse = { ok: true } & MechaStatus;

/** CLI 默认超时：~3s（connect + 响应同用一口钟——一连接一请求）。 */
export const DEFAULT_IPC_TIMEOUT_MS = 3000;

const WIN_PIPE_PREFIX = '\\\\.\\pipe\\';
/** profile 允许集：字母数字开头，其后字母数字与 `._-`，≤64 字符。分隔符、
 * 空格、win32 管道名特殊字符（`:*?"<>|` 等）全不在集内；另禁 `..` 子串。 */
const PROFILE_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
/** 单行（一请求）字节上限：防恶意/异常超长行泼内存。 */
const MAX_LINE_CHARS = 64 * 1024;

/** profile 清洗门（T5 遗留补齐）：空、路径分隔符（/ 与 \）、`..`、win32
 * 管道名特殊字符、超长（UDS sun_path 预算）一律拒绝。 */
export function assertValidProfile(profile: string): void {
  if (typeof profile !== 'string' || profile.length === 0) {
    throw new TypeError('机甲 profile 不能为空');
  }
  if (!PROFILE_RE.test(profile)) {
    throw new TypeError(
      `非法 profile 名：${JSON.stringify(profile)}（仅允许字母/数字/._-，字母或数字开头，≤64 字符）`,
    );
  }
  if (profile.includes('..')) {
    throw new TypeError(`非法 profile 名：${JSON.stringify(profile)}（禁止 ".."）`);
  }
}

/** 校验后的 `ipcName(profile)`——ipcName 调用边界的清洗门（daemon/CLI 统一走此）。 */
export function safeIpcName(profile: string): string {
  assertValidProfile(profile);
  return ipcName(profile);
}

/** 端点名形态校验（对最终端点名，双平台各自把关）。 */
export function assertValidPipeName(pipeName: string): void {
  if (typeof pipeName !== 'string' || pipeName.length === 0) {
    throw new TypeError('IPC 端点名不能为空');
  }
  if (pipeName.includes('\0')) {
    throw new TypeError('IPC 端点名含空字节');
  }
  if (process.platform === 'win32') {
    if (!pipeName.startsWith(WIN_PIPE_PREFIX)) {
      throw new TypeError(
        `Windows 管道名须以 ${WIN_PIPE_PREFIX} 开头：${JSON.stringify(pipeName)}`,
      );
    }
    const name = pipeName.slice(WIN_PIPE_PREFIX.length);
    if (name.length === 0) {
      throw new TypeError('Windows 管道名主体不能为空');
    }
    if (name.includes('\\')) {
      throw new TypeError(`Windows 管道名主体不能含反斜杠：${JSON.stringify(name)}`);
    }
    if (name.length > 256) {
      throw new TypeError('Windows 管道名过长（主体 >256 字符）');
    }
    // eslint-disable-next-line no-control-regex
    if (/[\x01-\x1f]/.test(name)) {
      throw new TypeError('Windows 管道名主体含控制字符');
    }
  } else {
    // 用 path.posix（而非宿主 path）：UDS 路径恒为 POSIX 语义，本逻辑与
    // 宿主平台无关（win32 上也能对 POSIX 分支做纯逻辑验证）。
    if (!path.posix.isAbsolute(pipeName)) {
      throw new TypeError(`POSIX UDS 路径须为绝对路径：${JSON.stringify(pipeName)}`);
    }
    if (pipeName.split('/').includes('..')) {
      throw new TypeError(`POSIX UDS 路径含 ".." 段：${JSON.stringify(pipeName)}`);
    }
  }
}

/** 守护进程未在监听（连接阶段失败：ENOENT/ECONNREFUSED/EACCES/ETIMEDOUT）。 */
export class IpcDownError extends Error {
  readonly code: string;
  readonly pipeName: string;

  constructor(code: string, pipeName: string, options?: { cause?: unknown }) {
    super(`机甲守护进程未运行或不可达（${code}）：${pipeName}`, options);
    this.name = 'IpcDownError';
    this.code = code;
    this.pipeName = pipeName;
  }
}

/** 已连上但对端超时未回话。 */
export class IpcTimeoutError extends Error {
  readonly timeoutMs: number;

  constructor(timeoutMs: number) {
    super(`IPC 响应超时（${timeoutMs}ms 内未收到回复）`);
    this.name = 'IpcTimeoutError';
    this.timeoutMs = timeoutMs;
  }
}

function errMsg(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/** 本地 IPC 服务端：CLI 请求 → handlers → 单行 JSON 响应。 */
export class IpcServer {
  private readonly pipeName: string;
  private readonly handlers: IpcHandlers;
  private readonly server = net.createServer();
  private readonly connections = new Set<net.Socket>();
  private listening = false;

  constructor(pipeName: string, handlers: IpcHandlers) {
    assertValidPipeName(pipeName); // 构造即炸（fail-fast），不等 listen
    this.pipeName = pipeName;
    this.handlers = handlers;
    // 常驻错误吸收器：listen 后的服务器级错误不让进程炸（listen 阶段的错误
    // 由 listen() 里后挂的专属监听器 reject，两监听器并存互不影响）。
    this.server.on('error', () => undefined);
    this.server.on('connection', (socket) => this.onConnection(socket));
  }

  /** 绑定端点开始监听（幂等）。POSIX 先做死 socket 文件探测清理。 */
  async listen(): Promise<void> {
    if (this.listening) return;
    if (process.platform !== 'win32') {
      await this.probeAndCleanStaleUnixSocket();
    }
    await new Promise<void>((resolve, reject) => {
      const onError = (err: Error): void => {
        this.server.removeListener('error', onError);
        reject(err);
      };
      this.server.listen(this.pipeName, () => {
        this.server.removeListener('error', onError);
        this.listening = true;
        resolve();
      });
      this.server.once('error', onError);
    });
  }

  /** 停止监听并断开全部现存连接（幂等；从未 listen 成功也安全）。 */
  async close(): Promise<void> {
    this.listening = false;
    for (const socket of this.connections) {
      socket.destroy();
    }
    this.connections.clear();
    await new Promise<void>((resolve) => this.server.close(() => resolve()));
  }

  /** 一连接一请求：首行 → handlers → 回一行 JSON → 半关。后续字节忽略。 */
  private onConnection(socket: net.Socket): void {
    this.connections.add(socket);
    socket.on('close', () => this.connections.delete(socket));
    socket.on('error', () => undefined); // 客户端半途断开（EPIPE 等）静默
    socket.setEncoding('utf8');
    let buffered = '';
    let answered = false;
    socket.on('data', (chunk: string) => {
      if (answered) return; // 一连接一请求
      buffered += chunk;
      const nl = buffered.indexOf('\n');
      if (nl === -1) {
        if (buffered.length > MAX_LINE_CHARS) socket.destroy(); // 超长行防泼
        return;
      }
      answered = true;
      const response = this.respond(buffered.slice(0, nl));
      socket.end(`${JSON.stringify(response)}\n`);
    });
  }

  /** 请求分派：坏 JSON / 非对象 / 未知命令 → `{ok:false,error}`；handler
   * 抛错也以 `{ok:false,error}` 透出（通道层绝不炸、绝不静默吞）。 */
  private respond(line: string): IpcResponse {
    let parsed: unknown;
    try {
      parsed = JSON.parse(line);
    } catch {
      return { ok: false, error: 'invalid request: not JSON' };
    }
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
      return { ok: false, error: 'invalid request: expected JSON object' };
    }
    const cmd = (parsed as Record<string, unknown>)['cmd'];
    switch (cmd) {
      case 'status':
        try {
          return { ok: true, ...this.handlers.status() };
        } catch (err) {
          return { ok: false, error: errMsg(err) };
        }
      case 'halt':
        try {
          this.handlers.halt();
          return { ok: true };
        } catch (err) {
          return { ok: false, error: errMsg(err) };
        }
      default:
        return { ok: false, error: `unknown command: ${String(cmd)}` };
    }
  }

  /**
   * POSIX 专属：崩溃残留死 socket 文件的探测清理（见文件头选型说明）。
   * lstat 不存在 → 直接绑定；占位非 socket（普通文件/目录）→ 不误删，让
   * bind 响亮失败；socket 且连得上 → 活实例在位，以 EADDRINUSE 拒启动
   * （单实例门）；socket 且连不上（ECONNREFUSED/ECONNRESET/EPROTO）→
   * 死文件，unlink 后由 listen 正常绑定。
   */
  private async probeAndCleanStaleUnixSocket(): Promise<void> {
    let stats: fs.Stats;
    try {
      stats = await fs.promises.lstat(this.pipeName);
    } catch {
      return; // 端点不存在 → 无残留
    }
    if (!stats.isSocket()) {
      return; // 非我们造的 socket——不误删他人文件
    }
    const probeErr = await new Promise<NodeJS.ErrnoException | null>((resolve) => {
      const probe = net.connect(this.pipeName);
      probe.once('connect', () => {
        probe.destroy();
        resolve(null);
      });
      probe.once('error', (err) => resolve(err as NodeJS.ErrnoException));
    });
    if (probeErr === null) {
      const busy: NodeJS.ErrnoException = new Error(
        `IPC 端点已被占用（同 profile 守护进程已在运行？）：${this.pipeName}`,
      );
      busy.code = 'EADDRINUSE';
      throw busy;
    }
    if (
      probeErr.code !== 'ECONNREFUSED' &&
      probeErr.code !== 'ECONNRESET' &&
      probeErr.code !== 'EPROTO'
    ) {
      throw probeErr; // 权限等别的原因——不误删，响亮失败
    }
    await fs.promises.unlink(this.pipeName);
  }
}

/** 连接（connect 阶段即含超时与 IpcDownError 归一）。 */
function connectIpc(pipeName: string, timeoutMs: number): Promise<net.Socket> {
  return new Promise((resolve, reject) => {
    const socket = net.connect(pipeName);
    let settled = false;
    let timer: NodeJS.Timeout | null = null;
    const clearTimer = (): void => {
      if (timer !== null) {
        clearTimeout(timer);
        timer = null;
      }
    };
    const settle = (): boolean => {
      if (settled) return false;
      settled = true;
      clearTimer();
      return true;
    };
    timer = setTimeout(() => {
      if (!settle()) return;
      socket.destroy();
      reject(new IpcDownError('ETIMEDOUT', pipeName));
    }, timeoutMs);
    socket.once('connect', () => {
      if (!settle()) return;
      resolve(socket); // onError 常驻但已 settle 空转——error 事件不悬空
    });
    const onError = (err: NodeJS.ErrnoException): void => {
      if (!settle()) return;
      socket.destroy();
      reject(new IpcDownError(err.code ?? 'UNKNOWN', pipeName, { cause: err }));
    };
    socket.on('error', onError);
  });
}

/** 一请求一响应：写一行、等一行、解析（超时/断连/坏形响亮失败）。 */
function roundTrip(socket: net.Socket, cmd: IpcCommand, timeoutMs: number): Promise<IpcResponse> {
  return new Promise((resolve, reject) => {
    let buffered = '';
    let settled = false;
    let timer: NodeJS.Timeout | null = null;
    const clearTimer = (): void => {
      if (timer !== null) {
        clearTimeout(timer);
        timer = null;
      }
    };
    const finish = (fn: () => void): void => {
      if (settled) return;
      settled = true;
      clearTimer();
      socket.removeListener('data', onData);
      socket.removeListener('error', onError);
      socket.removeListener('close', onClose);
      fn();
    };
    const onData = (chunk: string): void => {
      buffered += chunk;
      const nl = buffered.indexOf('\n');
      if (nl === -1) return;
      const line = buffered.slice(0, nl);
      finish(() => {
        socket.destroy();
        resolve(parseResponse(line));
      });
    };
    const onError = (err: Error): void =>
      finish(() => {
        socket.destroy();
        reject(err);
      });
    const onClose = (): void =>
      finish(() => reject(new Error('IPC 连接在对端响应前关闭')));
    timer = setTimeout(() => {
      finish(() => {
        socket.destroy();
        reject(new IpcTimeoutError(timeoutMs));
      });
    }, timeoutMs);
    socket.setEncoding('utf8');
    socket.on('data', onData);
    socket.on('error', onError);
    socket.on('close', onClose);
    // 只 write、不 end：win32 命名管道不支持半关（end ≈ 全关），会在守护进程
    // 应答前掐断连接；一连接一请求的边界由服务端答完 socket.end(response) 充当
    // （响应先落地、FIN 后到，客户端 data → resolve 即毁）。客户端侧超时兜底。
    socket.write(`${JSON.stringify({ cmd })}\n`);
  });
}

function parseResponse(line: string): IpcResponse {
  let parsed: unknown;
  try {
    parsed = JSON.parse(line);
  } catch {
    throw new Error('IPC 响应不是合法 JSON');
  }
  if (typeof parsed !== 'object' || parsed === null) {
    throw new Error('IPC 响应形状非法（非对象）');
  }
  const rec = parsed as Record<string, unknown>;
  if (rec['ok'] === true) return parsed as IpcOkResponse;
  if (rec['ok'] === false && typeof rec['error'] === 'string') {
    return { ok: false, error: rec['error'] };
  }
  throw new Error('IPC 响应形状非法（ok 字段缺失）');
}

/**
 * CLI ↔ 守护进程的单次调用（一连接一请求）。
 * 守护进程未运行 → 以 `IpcDownError` 拒绝（CLI 据此出「未运行」提示与退出码 1）。
 */
export function ipcCall(
  pipeName: string,
  cmd: 'status',
  timeoutMs?: number,
): Promise<MechaStatusIpcResponse | IpcErrorResponse>;
export function ipcCall(
  pipeName: string,
  cmd: 'halt',
  timeoutMs?: number,
): Promise<IpcOkResponse | IpcErrorResponse>;
export async function ipcCall(
  pipeName: string,
  cmd: IpcCommand,
  timeoutMs: number = DEFAULT_IPC_TIMEOUT_MS,
): Promise<IpcResponse> {
  assertValidPipeName(pipeName); // 与服务端同门：坏端点名早炸
  const socket = await connectIpc(pipeName, timeoutMs);
  try {
    return await roundTrip(socket, cmd, timeoutMs);
  } finally {
    socket.destroy();
  }
}

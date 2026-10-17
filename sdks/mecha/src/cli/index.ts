import { Command } from 'commander';
import { MECHA_PACKAGE_VERSION } from '../constants.js';
import {
  IpcDownError,
  ipcCall,
  safeIpcName,
  type IpcErrorResponse,
  type MechaStatusIpcResponse,
} from '../ipc.js';

// T15：mecha CLI（bin `mecha` → dist/cli/index.js）。本任务注册 status/halt
// 两个命令（T18 setup / T19 uninstall / T20 update 后续追加）。
//
// 退出码契约：成功 0；守护进程未运行 1（「机甲守护进程未运行」）；其他失败 1。
// 输出走 process.exitCode 而非 process.exit——避免 stdout 为管道时输出被截断。

const program = new Command();

program
  .name('mecha')
  .description('ClawRent 机甲 CLI（本地执行层守护进程的管理与离线刹车）')
  .version(MECHA_PACKAGE_VERSION);

function fail(message: string): void {
  console.error(message);
  process.exitCode = 1;
}

function resolvePipe(profile: string): string | null {
  try {
    return safeIpcName(profile);
  } catch (err) {
    fail(`mecha：${err instanceof Error ? err.message : String(err)}`);
    return null;
  }
}

const STATE_LABELS: Record<string, string> = {
  idle: '空闲',
  armed: '驾驶中',
  paused: '已暂停',
};

program
  .command('status')
  .description('查看本机机甲守护进程与驾驶状态')
  .option('-p, --profile <name>', '机甲实例 profile（同机多实例，experimental）', 'default')
  .action(async (opts: { profile: string }) => {
    const pipeName = resolvePipe(opts.profile);
    if (pipeName === null) return;
    let res: MechaStatusIpcResponse | IpcErrorResponse;
    try {
      res = await ipcCall(pipeName, 'status');
    } catch (err) {
      if (err instanceof IpcDownError) {
        fail('机甲守护进程未运行');
        return;
      }
      fail(`mecha status 失败：${err instanceof Error ? err.message : String(err)}`);
      return;
    }
    if (!res.ok) {
      fail(`IPC 错误：${res.error}`);
      return;
    }
    const label = STATE_LABELS[res.state] ?? res.state;
    const parts = [`机甲状态：${label}`];
    if (res.sessionId !== undefined) {
      parts.push(
        `会话 ${res.sessionId}${res.driverAgentId !== undefined ? `（司机 ${res.driverAgentId}）` : ''}`,
      );
    }
    if (res.activeOp !== undefined) {
      parts.push(`执行中 op ${res.activeOp}`);
    }
    console.log(parts.join('｜'));
    console.log(
      JSON.stringify(
        {
          state: res.state,
          sessionId: res.sessionId,
          driverAgentId: res.driverAgentId,
          since: res.since,
          activeOp: res.activeOp,
        },
        null,
        2,
      ),
    );
  });

program
  .command('halt')
  .description('紧急刹车：杀死执行中操作、作废会话、断开连接（离线可用，幂等）')
  .option('-p, --profile <name>', '机甲实例 profile（同机多实例，experimental）', 'default')
  .action(async (opts: { profile: string }) => {
    const pipeName = resolvePipe(opts.profile);
    if (pipeName === null) return;
    let res: IpcErrorResponse | { ok: true };
    try {
      res = await ipcCall(pipeName, 'halt');
    } catch (err) {
      if (err instanceof IpcDownError) {
        fail('机甲守护进程未运行');
        return;
      }
      fail(`mecha halt 失败：${err instanceof Error ? err.message : String(err)}`);
      return;
    }
    if (!res.ok) {
      fail(`IPC 错误：${res.error}`);
      return;
    }
    console.log('已请求紧急刹车：杀死执行中操作、作废会话、断开连接');
  });

try {
  await program.parseAsync();
} catch (err) {
  console.error(err instanceof Error ? err.message : String(err));
  process.exitCode = 1;
}

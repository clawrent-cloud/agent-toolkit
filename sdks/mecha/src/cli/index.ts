import { Command } from 'commander';
import { MECHA_PACKAGE_VERSION, configPath, mechaHome } from '../constants.js';
import { startDaemon, type DaemonHandle } from '../daemon.js';
import {
  IpcDownError,
  ipcCall,
  safeIpcName,
  type IpcErrorResponse,
  type MechaStatusIpcResponse,
} from '../ipc.js';
import {
  currentRuntimeEntry,
  ensureRuntimeInstalled,
  resolvePkgDir,
  uninstallAll,
} from '../persist/runtime-install.js';
import { autostartTarget, installAutostart } from '../persist/autostart.js';
import { runSetup } from './setup.js';

// T15：mecha CLI（bin `mecha` → dist/cli/index.js）。已注册 status/halt
//（T15）+ setup（T18）+ daemon/uninstall（T19）；T20 update 后续追加。
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

// T18：setup 向导接线。保持薄——交互、探测、注册、落盘全部内聚在 runSetup
//（缺省 io = readline/console）。--api-base 必填（v0 不做 API base 的交互
// 提问）；成功摘要由向导自身输出，此处补一行 T19 席位旗标（向导摘要不含）。
// T19 席位真实化：installRuntime 从**运行中包目录**自拷贝（resolvePkgDir 自
// 本模块向上定位包根——npx 缓存里跑就从缓存拷出，拷贝动作天然解耦缓存生命
// 周期），经 ensureRuntimeInstalled 幂等门（同版本已在位不重拷）；自启指向
// **自装 runtime** 的入口 js（currentRuntimeEntry 解析），Linux 只写 systemd
// 单元不 enable——`systemctl --user enable clawrent-mecha` 作为提示交给用户。
program
  .command('setup')
  .description('setup 向导：设备登录 → 目录白名单 → 程序预设 → 注册平台 → 写配置')
  .requiredOption('--api-base <url>', '平台 API base（如 https://api.clawrent.cloud）')
  .option('-p, --profile <name>', '机甲实例 profile（同机多实例，experimental）', 'default')
  .action(async (opts: { apiBase: string; profile: string }) => {
    try {
      const result = await runSetup({
        apiBase: opts.apiBase,
        profile: opts.profile,
        hooks: {
          installRuntime: async () => {
            await ensureRuntimeInstalled(resolvePkgDir());
          },
          installAutostart: async () => {
            const entry = currentRuntimeEntry();
            if (entry === null) {
              throw new Error('mecha setup: runtime 不可用（未安装或入口缺失），无法安装自启动');
            }
            await installAutostart(entry);
          },
        },
      });
      console.log(
        `mecha setup 完成：设备 ${result.deviceId}（runtime ${result.runtimeInstalled ? '已装' : '未装'}、自启 ${result.autostartInstalled ? '已装' : '未装'}）`,
      );
      if (result.autostartInstalled && autostartTarget().kind === 'systemd') {
        console.log(
          '提示：systemd 用户单元已写入，开机自启还需执行一次 systemctl --user enable clawrent-mecha',
        );
      }
    } catch (err) {
      fail(`mecha setup 失败：${err instanceof Error ? err.message : String(err)}`);
    }
  });

// T19：daemon 前台守护进程（自启单元即调用此命令；`mecha daemon` 手动跑同一
// 入口）。常驻：永不 resolve 的 promise 挂住 parseAsync；SIGINT/SIGTERM →
// stop()（在会终局 → 断链 → 关 IPC）→ 退出。config 缺失等启动失败照退出码
// 契约走 1（「请先运行 mecha setup」提示由 loadDaemonConfig 响亮给出）。
program
  .command('daemon')
  .description('前台启动机甲守护进程（开机自启单元即调用此命令；Ctrl+C 停机）')
  .action(async () => {
    let handle: DaemonHandle;
    try {
      handle = await startDaemon({ configPath: configPath() });
    } catch (err) {
      fail(`mecha daemon 启动失败：${err instanceof Error ? err.message : String(err)}`);
      return;
    }
    let stopping = false;
    const shutdown = (signal: string): void => {
      if (stopping) return; // 信号可重入：只停一次
      stopping = true;
      void handle.stop().then(() => {
        console.log(`mecha daemon 已停机（${signal}）`);
        process.exit(0);
      });
    };
    process.on('SIGINT', () => shutdown('SIGINT'));
    process.on('SIGTERM', () => shutdown('SIGTERM'));
    console.log('mecha daemon 运行中（Ctrl+C 停机）');
    await new Promise<never>(() => {}); // 常驻；退出只经信号处理器
  });

// T19：uninstall——自启单元 + runtime 整树 + config.json 一并删除；日志目录
// 与溯源表默认保留（审计优先），--purge-logs 才连账本一起清。
program
  .command('uninstall')
  .description('卸载本机机甲：删自启单元 + runtime + config（日志与溯源默认保留）')
  .option('--purge-logs', '同时删除行车记录日志与溯源表（默认保留，审计优先）', false)
  .action(async (opts: { purgeLogs: boolean }) => {
    try {
      const result = await uninstallAll({ keepLogs: !opts.purgeLogs });
      const parts = [
        result.autostartRemoved ? '自启单元已删' : '自启单元不存在',
        result.runtimeRemoved ? 'runtime 已删' : 'runtime 不存在',
        result.configRemoved ? '配置已删' : '配置不存在',
      ];
      console.log(`mecha 卸载完成：${parts.join('；')}`);
      console.log(
        result.logsKept
          ? `行车记录日志与溯源表已保留（${mechaHome()}）——彻底清除可加 --purge-logs`
          : '行车记录日志与溯源表已删除',
      );
    } catch (err) {
      fail(`mecha uninstall 失败：${err instanceof Error ? err.message : String(err)}`);
    }
  });

try {
  await program.parseAsync();
} catch (err) {
  console.error(err instanceof Error ? err.message : String(err));
  process.exitCode = 1;
}

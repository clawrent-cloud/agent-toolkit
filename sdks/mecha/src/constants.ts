import { homedir } from 'node:os';
import { join } from 'node:path';

/**
 * 机甲本地布局的唯一来源：home 及其下各文件/目录、IPC 端点名。
 *
 * 多实例门（spec A8）：`ipcName(profile)` 按实例 profile 产出互不相同的
 * 端点名——Windows 命名管道 `\\.\pipe\<name>` / POSIX UDS `~/.clawrent/mecha/<name>.sock`，
 * 同机多实例互不干扰。
 */

/** 机甲根目录：`~/.clawrent/mecha` */
export function mechaHome(): string {
  return join(homedir(), '.clawrent', 'mecha');
}

/** 自装 runtime 目录（spec A11）：`~/.clawrent/mecha/runtime/` */
export function runtimeDir(): string {
  return join(mechaHome(), 'runtime');
}

/** setup 写入的本机配置：`~/.clawrent/mecha/config.json` */
export function configPath(): string {
  return join(mechaHome(), 'config.json');
}

/** 日志目录：`~/.clawrent/mecha/logs/` */
export function logsDir(): string {
  return join(mechaHome(), 'logs');
}

/** 溯源表（upload/write 持久登记，exec 判红数据源）：`~/.clawrent/mecha/provenance.json` */
export function provenancePath(): string {
  return join(mechaHome(), 'provenance.json');
}

/** IPC 端点名（按 profile 隔离，多实例门）：命名管道/UDS 路径 */
export function ipcName(profile: string): string {
  const base = `clawrent-mecha-${profile}`;
  return process.platform === 'win32'
    ? `\\\\.\\pipe\\${base}`
    : join(mechaHome(), `${base}.sock`);
}

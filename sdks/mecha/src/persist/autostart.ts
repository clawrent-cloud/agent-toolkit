import * as fs from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';

/**
 * 开机自启安装（spec A11，plan Task 19）：把 `mecha daemon` 挂到三平台各自的
 * 用户级自启机制上——
 *
 *  - win32：Startup 目录 `.cmd` 快捷（`%APPDATA%\Microsoft\Windows\Start
 *    Menu\Programs\Startup\clawrent-mecha.cmd`），登录即执行；
 *  - macOS：`~/Library/LaunchAgents/ai.clawrent.mecha.plist`（label
 *    `ai.clawrent.mecha`，RunAtLoad true，**KeepAlive false**——链路重连自愈
 *    内建在 daemon（DeviceClient 重连循环），手动停掉不该被系统拉起）；
 *  - Linux：`~/.config/systemd/user/clawrent-mecha.service`（WantedBy
 *    default.target）。**只写单元不 enable**（v0 裁定）——启用动作是
 *    `systemctl --user enable clawrent-mecha`，由 CLI 在安装后提示用户执行。
 *
 * 结构分层（brief 裁定）：内容生成器与路径推导都是**纯函数导出**（零 fs，
 * 三平台形状全可测）；`installAutostart` 按本机 `process.platform` 分支落盘，
 * 测试经 homeOverride / startupDirOverride（R17 注入模式）指进 tmpdir，
 * 绝不写真实系统目录。node 可执行体取 `process.execPath`（自装 runtime 由
 * 同一 node 运行，版本天然配套）。
 *
 * 幂等：同 entry 重装 = 覆盖写同一内容（re-setup 反复执行无副作用）。
 */

/** 自启机制类型（与平台一一对应）。 */
export type AutostartKind = 'win-startup' | 'launchd' | 'systemd';

/** 自启安装/卸载的目标（kind + 单元文件绝对路径）。 */
export interface AutostartTarget {
  kind: AutostartKind;
  unitPath: string;
}

/** 自启落点覆盖（R17 注入模式，test-only）：POSIX 覆盖用户 home（LaunchAgents
 * / systemd user 单元由此派生），win32 覆盖 Roaming 根（Startup 目录由纯函数
 * 推导追加标准后缀——%APPDATA% 不在用户 home 下，须独立覆盖）。 */
export interface AutostartOpts {
  homeOverride?: string;
  roamingOverride?: string;
}

// ── 产物内容生成器（纯函数；三平台形状全可测，零 fs）────────────────────────

/** win32 Startup `.cmd` 内容：登录即以 `node <entry> daemon` 拉起守护进程。 */
export function winStartupCmdContent(nodeExe: string, entryJs: string): string {
  return `@echo off\n"${nodeExe}" "${entryJs}" daemon\n`;
}

/** macOS launchd plist：RunAtLoad true + KeepAlive false（见文件头裁定）。 */
export function launchdPlistContent(nodeExe: string, entryJs: string): string {
  return [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">',
    '<plist version="1.0">',
    '  <dict>',
    '    <key>Label</key>',
    '    <string>ai.clawrent.mecha</string>',
    '    <key>ProgramArguments</key>',
    '    <array>',
    `      <string>${nodeExe}</string>`,
    `      <string>${entryJs}</string>`,
    '      <string>daemon</string>',
    '    </array>',
    '    <key>RunAtLoad</key>',
    '    <true/>',
    '    <key>KeepAlive</key>',
    '    <false/>',
    '  </dict>',
    '</plist>',
    '',
  ].join('\n');
}

/** Linux systemd 用户单元：只写入不 enable（启用动作由 CLI 提示用户执行）。 */
export function systemdUnitContent(nodeExe: string, entryJs: string): string {
  return [
    '[Unit]',
    'Description=ClawRent Mecha daemon',
    '',
    '[Service]',
    `ExecStart="${nodeExe}" "${entryJs}" daemon`,
    '',
    '[Install]',
    'WantedBy=default.target',
    '',
  ].join('\n');
}

// ── 路径推导（纯函数；三平台形状全可测）────────────────────────────────────

/** win32：`<roaming>\Microsoft\Windows\Start Menu\Programs\Startup\clawrent-mecha.cmd` */
export function winStartupUnitPath(roamingDir: string): string {
  return join(roamingDir, 'Microsoft', 'Windows', 'Start Menu', 'Programs', 'Startup', 'clawrent-mecha.cmd');
}

/** macOS：`<home>/Library/LaunchAgents/ai.clawrent.mecha.plist` */
export function launchdUnitPath(home: string): string {
  return join(home, 'Library', 'LaunchAgents', 'ai.clawrent.mecha.plist');
}

/** Linux：`<home>/.config/systemd/user/clawrent-mecha.service` */
export function systemdUnitPath(home: string): string {
  return join(home, '.config', 'systemd', 'user', 'clawrent-mecha.service');
}

/** win32 Roaming 目录缺省解析：%APPDATA% 优先，未设则按惯例拼 AppData\Roaming。 */
function defaultRoamingDir(): string {
  const appData = process.env['APPDATA'];
  if (appData !== undefined && appData !== '') return appData;
  return join(homedir(), 'AppData', 'Roaming');
}

/** 本机平台的自启目标（kind + 单元路径）。install/uninstall 共用同一推导，
 * 保证装在哪、就从哪删。 */
export function autostartTarget(opts?: AutostartOpts): AutostartTarget {
  if (process.platform === 'win32') {
    const roaming = opts?.roamingOverride ?? defaultRoamingDir();
    return { kind: 'win-startup', unitPath: winStartupUnitPath(roaming) };
  }
  const home = opts?.homeOverride ?? homedir();
  if (process.platform === 'darwin') {
    return { kind: 'launchd', unitPath: launchdUnitPath(home) };
  }
  return { kind: 'systemd', unitPath: systemdUnitPath(home) };
}

/** 本机平台分支的内容生成器（installAutostart 与 uninstall 无关，仅装用）。 */
function contentFor(kind: AutostartKind, nodeExe: string, entryJs: string): string {
  switch (kind) {
    case 'win-startup':
      return winStartupCmdContent(nodeExe, entryJs);
    case 'launchd':
      return launchdPlistContent(nodeExe, entryJs);
    case 'systemd':
      return systemdUnitContent(nodeExe, entryJs);
  }
}

/**
 * 写入本机平台的自启单元（幂等覆盖写；目录自建）。返回写入目标。
 * Linux 分支只写单元文件，不执行 systemctl enable（v0 裁定——CLI 层把
 * `systemctl --user enable clawrent-mecha` 作为提示交给用户）。
 */
export async function installAutostart(
  entryJs: string,
  opts?: AutostartOpts,
): Promise<AutostartTarget> {
  const target = autostartTarget(opts);
  const content = contentFor(target.kind, process.execPath, entryJs);
  fs.mkdirSync(dirname(target.unitPath), { recursive: true });
  fs.writeFileSync(target.unitPath, content, 'utf8');
  return target;
}

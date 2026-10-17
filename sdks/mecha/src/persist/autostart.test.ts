import { describe, expect, it } from 'vitest';
import * as fs from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  autostartTarget,
  installAutostart,
  launchdPlistContent,
  launchdUnitPath,
  systemdUnitContent,
  systemdUnitPath,
  winStartupCmdContent,
  winStartupUnitPath,
} from './autostart.js';

/**
 * 自启安装测试（plan Task 19）。分层：
 *
 *  - 三个平台的**产物生成器是纯函数**（零 fs），全平台无论本机是谁都可断言
 *    内容形状（brief 裁定：非本机平台测内容形状、不碰 fs）；
 *  - 路径推导同样拆成纯函数（winStartupUnitPath / launchdUnitPath /
 *    systemdUnitPath），三平台路径形状全可测；
 *  - `installAutostart` 走本机 OS 分支写真实文件——测试只断言**当前平台**
 *    的产物存在与内容含 entryJs，落点经 tmpdir 覆盖（R17 模式：
 *    homeOverride / startupDirOverride 注入，绝不写真实 Startup /
 *    LaunchAgents / systemd 目录）。
 */

const NODE = process.platform === 'win32' ? 'C:\\Program Files\\nodejs\\node.exe' : '/usr/bin/node';
const ENTRY = process.platform === 'win32' ? 'C:\\Users\\u\\.clawrent\\mecha\\runtime\\v0.1.0\\dist\\cli\\index.js' : '/home/u/.clawrent/mecha/runtime/v0.1.0/dist/cli/index.js';

describe('自启产物生成器（纯函数，三平台全测）', () => {
  it('win-startup .cmd：@echo off 开头 + 双引号包 node/entry + daemon 子命令', () => {
    const content = winStartupCmdContent(NODE, ENTRY);
    expect(content.startsWith('@echo off\n')).toBe(true);
    expect(content).toContain(`"${NODE}" "${ENTRY}" daemon`);
    expect(content.endsWith('\n')).toBe(true);
  });

  it('launchd plist：label ai.clawrent.mecha + ProgramArguments 三段 + RunAtLoad true + KeepAlive false', () => {
    const content = launchdPlistContent(NODE, ENTRY);
    expect(content).toContain('<?xml version="1.0"');
    expect(content).toContain('<key>Label</key>');
    expect(content).toContain('<string>ai.clawrent.mecha</string>');
    // ProgramArguments：node / entry / daemon 三段各自独立 <string>
    expect(content).toContain('<key>ProgramArguments</key>');
    expect(content).toContain(`<string>${NODE}</string>`);
    expect(content).toContain(`<string>${ENTRY}</string>`);
    expect(content).toContain('<string>daemon</string>');
    // RunAtLoad true；KeepAlive false（手动停掉不复活，重连自愈交给 daemon）
    expect(content).toMatch(/<key>RunAtLoad<\/key>\s*<true\/>/);
    expect(content).toMatch(/<key>KeepAlive<\/key>\s*<false\/>/);
  });

  it('systemd user unit：[Unit]/[Service]/[Install] 三段 + ExecStart 引号路径 + WantedBy=default.target', () => {
    const content = systemdUnitContent(NODE, ENTRY);
    expect(content).toContain('[Unit]');
    expect(content).toContain('Description=');
    expect(content).toContain('[Service]');
    expect(content).toContain(`ExecStart="${NODE}" "${ENTRY}" daemon`);
    expect(content).toContain('[Install]');
    expect(content).toContain('WantedBy=default.target');
  });
});

describe('自启单元路径推导（纯函数，三平台全测）', () => {
  it('win：Startup 目录下 clawrent-mecha.cmd', () => {
    const p = winStartupUnitPath('C:\\Users\\u\\AppData\\Roaming');
    expect(p).toBe(
      join('C:\\Users\\u\\AppData\\Roaming', 'Microsoft', 'Windows', 'Start Menu', 'Programs', 'Startup', 'clawrent-mecha.cmd'),
    );
  });

  it('macOS：~/Library/LaunchAgents/ai.clawrent.mecha.plist', () => {
    expect(launchdUnitPath('/Users/u')).toBe(join('/Users/u', 'Library', 'LaunchAgents', 'ai.clawrent.mecha.plist'));
  });

  it('Linux：~/.config/systemd/user/clawrent-mecha.service', () => {
    expect(systemdUnitPath('/home/u')).toBe(join('/home/u', '.config', 'systemd', 'user', 'clawrent-mecha.service'));
  });
});

describe('installAutostart（本机 OS 分支，tmpdir 覆盖）', () => {
  const WIN32 = process.platform === 'win32';

  /** 本机分支的覆盖落点：POSIX 用 homeOverride，win 用 roamingOverride
   * （Roaming 根，Startup 目录由纯函数追加标准后缀）。 */
  function overrides(): { homeOverride: string; roamingOverride: string; unitPath: string } {
    const base = fs.mkdtempSync(join(tmpdir(), 'mecha-autostart-'));
    const homeOverride = join(base, 'home');
    const roamingOverride = join(base, 'roaming');
    const unitPath = WIN32
      ? winStartupUnitPath(roamingOverride)
      : process.platform === 'darwin'
        ? join(homeOverride, 'Library', 'LaunchAgents', 'ai.clawrent.mecha.plist')
        : join(homeOverride, '.config', 'systemd', 'user', 'clawrent-mecha.service');
    return { homeOverride, roamingOverride, unitPath };
  }

  it('当前平台产物存在、内容含 runtime 入口路径与 daemon 子命令；嵌套目录自建', async () => {
    const { homeOverride, roamingOverride, unitPath } = overrides();
    const res = await installAutostart(ENTRY, { homeOverride, roamingOverride });

    expect(res.unitPath).toBe(unitPath);
    expect(fs.existsSync(unitPath)).toBe(true);
    const content = fs.readFileSync(unitPath, 'utf8');
    expect(content).toContain(ENTRY);
    expect(content).toContain('daemon');
    if (WIN32) expect(res.kind).toBe('win-startup');
    else if (process.platform === 'darwin') expect(res.kind).toBe('launchd');
    else expect(res.kind).toBe('systemd');
  });

  it('幂等：重复安装覆盖写同一内容（不抛、不重复追加）', async () => {
    const { homeOverride, roamingOverride, unitPath } = overrides();
    await installAutostart(ENTRY, { homeOverride, roamingOverride });
    const first = fs.readFileSync(unitPath, 'utf8');
    await installAutostart(ENTRY, { homeOverride, roamingOverride });
    expect(fs.readFileSync(unitPath, 'utf8')).toBe(first);
  });

  it('autostartTarget 本机分支：kind 与平台一致，覆盖下 unitPath 与纯函数推导一致', () => {
    const { homeOverride, roamingOverride } = overrides();
    const t = autostartTarget({ homeOverride, roamingOverride });
    if (WIN32) {
      expect(t.kind).toBe('win-startup');
      expect(t.unitPath).toBe(winStartupUnitPath(roamingOverride));
    } else if (process.platform === 'darwin') {
      expect(t.kind).toBe('launchd');
      expect(t.unitPath).toBe(launchdUnitPath(homeOverride));
    } else {
      expect(t.kind).toBe('systemd');
      expect(t.unitPath).toBe(systemdUnitPath(homeOverride));
    }
  });
});

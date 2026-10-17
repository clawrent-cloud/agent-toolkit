import { describe, it, expect } from 'vitest';
import { homedir } from 'node:os';
import { basename, dirname, join, sep } from 'node:path';
import {
  mechaHome,
  runtimeDir,
  configPath,
  logsDir,
  provenancePath,
  ipcName,
} from './constants.js';

describe('mecha 布局函数', () => {
  it('mechaHome() = ~/.clawrent/mecha（.clawrent 路径段 + 末段 mecha）', () => {
    const home = mechaHome();
    expect(home).toBe(join(homedir(), '.clawrent', 'mecha'));
    expect(basename(dirname(home))).toBe('.clawrent');
    expect(basename(home)).toBe('mecha');
  });

  it('runtimeDir/configPath/logsDir/provenancePath 全部落在 mechaHome() 下', () => {
    const home = mechaHome();
    const under = [
      ['runtimeDir', runtimeDir()],
      ['configPath', configPath()],
      ['logsDir', logsDir()],
      ['provenancePath', provenancePath()],
    ] as const;
    for (const [name, p] of under) {
      expect(p.startsWith(home + sep), `${name} 应在 mechaHome 下`).toBe(true);
    }
    expect(basename(runtimeDir())).toBe('runtime');
    expect(basename(configPath())).toBe('config.json');
    expect(basename(logsDir())).toBe('logs');
    expect(basename(provenancePath())).toBe('provenance.json');
  });

  it('ipcName 多实例门：不同 profile 产出不同名（spec A8）', () => {
    expect(ipcName('default')).not.toBe(ipcName('work'));
    // profile 名必须体现在 IPC 端点名里
    expect(ipcName('work')).toContain('work');
  });

  it('ipcName 同 profile 幂等', () => {
    expect(ipcName('default')).toBe(ipcName('default'));
  });

  it('ipcName homeBase 覆盖（T16 ledger (a)-minor）：POSIX UDS 落覆盖 home；win32 管道名不受影响', () => {
    const override = process.platform === 'win32' ? 'C:\\override-home' : '/tmp/override-home';
    const withOverride = ipcName('work', override);
    if (process.platform === 'win32') {
      // 命名管道与文件系统无关：覆盖与否同名
      expect(withOverride).toBe(ipcName('work'));
    } else {
      expect(withOverride).toBe(join(override, 'clawrent-mecha-work.sock'));
    }
    // 缺省 = mechaHome()（与不传一致）
    expect(ipcName('work')).toBe(ipcName('work', mechaHome()));
    // profile 仍隔离
    expect(ipcName('default', override)).not.toBe(withOverride);
  });
});

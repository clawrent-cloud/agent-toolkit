import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * CLI 命令注册冒烟（plan Task 18 追加裁定：`mecha setup` 接线；Task 19
 * 同体例追加 `daemon` / `uninstall`）。
 *
 * cli/index.ts 是 parse-on-import 结构（模块顶层 parseAsync 消费真实 argv），
 * import 即执行——注入式单测被结构阻断（T15 review 已将「CLI 命令映射无
 * 自动化测试」记入 deferred 缺口）。此处按裁定取最薄形态：源码注册存在性
 * 冒烟——命令被删/选项被改名时本测试即红。
 */
describe('mecha CLI：setup 命令注册（冒烟）', () => {
  const src = readFileSync(join(dirname(fileURLToPath(import.meta.url)), 'index.ts'), 'utf8');

  it('setup 命令已注册：--api-base 必填 + --profile 缺省 default + runSetup 接线', () => {
    expect(src).toContain(".command('setup')");
    expect(src).toContain("'--api-base <url>'");
    expect(src).toContain("'-p, --profile <name>'"); // 与 status/halt 同一选项拼写
    expect(src).toContain('runSetup(');
  });

  it('T19：daemon 命令注册——startDaemon 接 config.json、信号停机、常驻', () => {
    expect(src).toContain(".command('daemon')");
    expect(src).toContain('startDaemon(');
    expect(src).toContain('configPath()');
    expect(src).toContain("SIGINT");
    expect(src).toContain("SIGTERM");
  });

  it('T19：uninstall 命令注册——uninstallAll 接线 + --purge-logs 反接 keepLogs', () => {
    expect(src).toContain(".command('uninstall')");
    expect(src).toContain("'--purge-logs'");
    expect(src).toContain('uninstallAll(');
    expect(src).toContain('keepLogs: !opts.purgeLogs');
  });

  it('T19：setup 钩子接线——自装 runtime（幂等门）+ 自启安装 + systemd enable 提示', () => {
    expect(src).toContain('ensureRuntimeInstalled(');
    expect(src).toContain('resolvePkgDir(');
    expect(src).toContain('installAutostart(');
    expect(src).toContain('currentRuntimeEntry(');
    // Linux v0 只写单元不 enable：enable 命令以提示文案交给用户
    expect(src).toContain('systemctl --user enable clawrent-mecha');
  });
});

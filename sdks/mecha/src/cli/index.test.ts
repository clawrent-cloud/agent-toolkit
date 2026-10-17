import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * CLI 命令注册冒烟（plan Task 18 追加裁定：`mecha setup` 接线）。
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
});

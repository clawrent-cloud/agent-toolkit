import { defineConfig } from 'tsup';

export default defineConfig([
  {
    // 库入口（版本常量 + 布局 + IPC/会话/执行器等可编程面）。
    entry: ['src/index.ts'],
    format: ['esm'],
    dts: true,
    clean: true,
    sourcemap: true,
  },
  {
    // CLI bin：package.json bin `mecha` → dist/cli/index.js（Task 15 落地，
    // 仿 sdks/cli 追加 shebang banner；clean:false 不清掉上面的库构建产物）。
    // entry 用对象形态钉死输出路径（单文件数组入口会被 tsup 拍平成 dist/index.js）。
    entry: { 'cli/index': 'src/cli/index.ts' },
    format: ['esm'],
    banner: { js: '#!/usr/bin/env node' },
    clean: false,
    sourcemap: true,
  },
]);

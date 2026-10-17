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
    //
    // 自包含 bundle（Task 19 / Ruling R21）：runtime 自装把 dist/ 拷到
    // ~/.clawrent/mecha/runtime/ 后**不是 npm install**——cli/index.js 必须可
    // 直接 node 运行，故 workspace 依赖（@clawrent/protocol 等）与三方依赖
    //（ws/commander/zod）全部内联进单文件。ws 纯 JS 可安全打包（其 optional
    // peers bufferutil/utf-8-validate 不在名单内、保持 external，运行时由 ws
    // 自身 try/catch 兜底）。注：tsup 8.5 的 noExternal 不支持 true（external
    // 插件要求数组），须显式枚举。
    entry: { 'cli/index': 'src/cli/index.ts' },
    format: ['esm'],
    // shebang + require shim：内联的 CJS 依赖（commander/ws）会 require node
    // 内建模块（events/crypto/...），esbuild 的 ESM 输出对「外部模块的动态
    // require」默认抛「Dynamic require of ... is not supported」——banner 里
    // 用 createRequire 定义真 require，esbuild 的 __require 垫片即取用之。
    banner: {
      js: [
        '#!/usr/bin/env node',
        "import { createRequire } from 'node:module';",
        'const require = createRequire(import.meta.url);',
      ].join('\n'),
    },
    clean: false,
    sourcemap: true,
    noExternal: ['@clawrent/protocol', '@clawrent/shared-types', 'commander', 'ws', 'zod'],
  },
]);

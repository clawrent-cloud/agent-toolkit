import { defineConfig } from 'tsup';

// v0 脚手架：只构建库入口 src/index.ts（版本常量 + 布局函数）。
// CLI 入口 src/cli/index.ts 由后续任务落地，届时仿照 sdks/cli 追加
// 带 `#!/usr/bin/env node` banner 的 bin 构建段（bin 指向 dist/cli/index.js）。
export default defineConfig({
  entry: ['src/index.ts'],
  format: ['esm'],
  dts: true,
  clean: true,
  sourcemap: true,
});

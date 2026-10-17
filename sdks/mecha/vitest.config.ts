import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'node',
    // src/ = 单元/总装测试（T1-20 既有面）；test/ = 跨包端到端（T24 场景套件
    // ——真 daemon × mock relay × provider MechaDriver 全链）。
    include: ['src/**/*.test.ts', 'test/**/*.test.ts'],
  },
});

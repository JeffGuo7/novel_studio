import { defineConfig } from 'vitest/config'

export default defineConfig({
  esbuild: {
    jsx: 'automatic',
  },
  test: {
    include: ['tests/**/*.test.ts', 'tests/**/*.test.tsx'],
    testTimeout: 60_000,
    hookTimeout: 60_000,
    coverage: {
      provider: 'v8',
      reporter: ['text', 'lcov'],
      // 只统计可被单元测试覆盖的「逻辑层」；Electron 主进程 / React UI 由 E2E 覆盖，不在这里拉低整体数字
      include: ['src/core/**/*.ts', 'src/agent/**/*.ts', 'src/pipeline/**/*.ts', 'src/shared/style.ts'],
      exclude: ['src/**/*.d.ts'],
      // 底线门槛：防止后续 PR 把核心逻辑覆盖率越写越低
      thresholds: {
        lines: 70,
        functions: 70,
        // vitest 5 的分支计数更细（ternary/默认参数等），60% 仍能防覆盖率倒退
        branches: 60,
        statements: 70,
      },
    },
  },
})

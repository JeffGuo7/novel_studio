/**
 * 构建 utilityProcess 入口（ESM 单文件）：
 *   out/agent/host.mjs    —— pi Agent 运行时
 *   out/pipeline/host.mjs —— 知识库初始化管线
 *
 * 为什么要 banner：依赖链里有 CJS 包（isomorphic-git → sha.js → safe-buffer），
 * 它们会调用 require('buffer')；ESM 输出里没有 require，需要注入 createRequire 垫片。
 */
import { build } from 'esbuild'

const banner =
  "import { createRequire as __novelCreateRequire } from 'node:module';\nconst require = __novelCreateRequire(import.meta.url);"

const common = {
  bundle: true,
  platform: 'node',
  format: 'esm',
  target: 'node24',
  external: ['electron'],
  banner: { js: banner },
  logLevel: 'info',
}

await build({ ...common, entryPoints: ['src/agent/host.ts'], outfile: 'out/agent/host.mjs' })
await build({ ...common, entryPoints: ['src/pipeline/host.ts'], outfile: 'out/pipeline/host.mjs' })

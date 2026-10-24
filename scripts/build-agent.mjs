/**
 * 构建 Agent Host 单文件 ESM bundle。
 * 为什么要 banner：依赖链里有 CJS 包（isomorphic-git → sha.js → safe-buffer），
 * 它们会调用 require('buffer')；ESM 输出里没有 require，需要注入 createRequire 垫片。
 */
import { build } from 'esbuild'

await build({
  entryPoints: ['src/agent/host.ts'],
  bundle: true,
  platform: 'node',
  format: 'esm',
  target: 'node24',
  outfile: 'out/agent/host.mjs',
  external: ['electron'],
  banner: {
    js: "import { createRequire as __novelCreateRequire } from 'node:module';\nconst require = __novelCreateRequire(import.meta.url);",
  },
  logLevel: 'info',
})

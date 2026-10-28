/**
 * 一条命令打包 Windows 发行版：
 *   npm run release
 *
 * 流程：类型检查 → 构建 → electron-builder（NSIS 安装包 + 便携版）→ 生成 SHA256 校验和与发行说明。
 * 产物全部在 release/ 下（已 gitignore）。
 * 私有仓库/未签名说明会写进 RELEASE-<version>.md。
 */
import { spawnSync } from 'node:child_process'
import crypto from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'))
const version = pkg.version
const args = process.argv.slice(2)
const skipCheck = args.includes('--skip-check')

function run(command, args, label) {
  console.log(`\n[release] ${label}`)
  const line = [command, ...args].join(' ')
  const result = spawnSync(line, { cwd: root, stdio: 'inherit', shell: true })
  if (result.status !== 0) {
    console.error(`[release] 失败：${label}`)
    process.exit(result.status ?? 1)
  }
}

function sha256(file) {
  const hash = crypto.createHash('sha256')
  hash.update(fs.readFileSync(file))
  return hash.digest('hex')
}

function formatSize(bytes) {
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`
}

// 清掉上一次的安装包/校验和，避免把旧产物算进校验和
const releaseDir = path.join(root, 'release')
if (fs.existsSync(releaseDir)) {
  for (const entry of fs.readdirSync(releaseDir, { withFileTypes: true })) {
    if (!entry.isFile()) continue
    if (/\.(exe|blockmap)$/i.test(entry.name) || /^SHA256SUMS\.txt$/.test(entry.name) || /^RELEASE-.*\.md$/.test(entry.name)) {
      fs.rmSync(path.join(releaseDir, entry.name), { force: true })
    }
  }
}

if (!skipCheck) {
  run('npm', ['run', 'typecheck'], '类型检查')
}
run('npm', ['run', 'build'], '构建应用与 utilityProcess')
run('npx', ['electron-builder', '--win', '--publish', 'never'], '打包 NSIS 安装包 + 便携版')

const artifacts = fs
  .readdirSync(releaseDir, { withFileTypes: true })
  .filter((entry) => entry.isFile() && entry.name.toLowerCase().endsWith('.exe'))
  .map((entry) => {
    const fullPath = path.join(releaseDir, entry.name)
    const stat = fs.statSync(fullPath)
    return { name: entry.name, fullPath, size: stat.size, sha256: sha256(fullPath) }
  })
  .sort((a, b) => a.name.localeCompare(b.name))

if (artifacts.length === 0) {
  console.error('[release] 没找到任何 exe 产物')
  process.exit(1)
}

const checksumLines = artifacts.map((item) => `${item.sha256}  ${item.name}`).join('\n') + '\n'
fs.writeFileSync(path.join(releaseDir, 'SHA256SUMS.txt'), checksumLines, 'utf8')

const notes = `# Novel Studio ${version}

构建时间：${new Date().toISOString()}
版本：${version}
平台：Windows x64

## English summary

- Local-first AI novel-writing studio for Windows (Electron + React + TypeScript + pi agent SDK).
- Markdown manuscripts + nested Git history; AI drafts are versioned separately and can never archive or delete.
- Knowledge distillation, local story search (no embedding model), /compact, budgets, backup/restore, auto-update.
- Assets: NSIS installer + portable build. Verify SHA256SUMS.txt before running.
- The build is **unsigned** while the SignPath Foundation OSS code-signing application is under review.

## 产物与校验

${artifacts
  .map(
    (item) =>
      `- ${item.name}（${formatSize(item.size)}）\n  SHA256: ${item.sha256}`,
  )
  .join('\n')}

校验方法（PowerShell）：

\`\`\`powershell
Get-FileHash .\\<文件名>.exe -Algorithm SHA256
\`\`\`

结果应与上面的 SHA256 完全一致。

## 安装

- **NSIS 安装包**（Novel Studio-${version}-x64.exe）：按用户安装，可自选目录，创建开始菜单/桌面快捷方式。
- **便携版**（Novel Studio-Portable-${version}-x64.exe）：免安装，双击直接运行，适合放 U 盘或临时试用。

> ⚠️ 当前版本**未做代码签名**。Windows SmartScreen 可能提示「Windows 已保护你的电脑」，
> 点「更多信息 → 仍要运行」即可。请先用上面的 SHA256 校验文件完整性。
> 已申请 SignPath Foundation 免费 OSS 代码签名（审核中）；通过后后续版本会自动签名，无需改动业务代码。

## 数据位置

书库默认在「文档」目录下的 NovelStudio（可用 NOVEL_STUDIO_HOME 覆盖）；
配置文件在 %APPDATA%\\Novel Studio（可用 NOVEL_STUDIO_USER_DATA 覆盖）。
升级/重装不会动这两个目录，文稿和版本历史都保留。
`
fs.writeFileSync(path.join(releaseDir, `RELEASE-${version}.md`), notes, 'utf8')

console.log('\n[release] 完成：')
for (const item of artifacts) {
  console.log(`  ${item.name}  ${formatSize(item.size)}  ${item.sha256.slice(0, 16)}…`)
}
console.log(`  校验和：release/SHA256SUMS.txt`)
console.log(`  发行说明：release/RELEASE-${version}.md`)

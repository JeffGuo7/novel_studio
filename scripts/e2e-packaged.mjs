/**
 * 打包产物端到端：直接启动 release/win-unpacked/Novel Studio.exe，
 * 验证 asar、preload、utilityProcess(agent host)、模型配置、工具写盘全链路。
 * 前置：npm run dist:dir
 */
import { _electron as electron } from 'playwright'
import path from 'node:path'
import fs from 'node:fs'
import { fileURLToPath } from 'node:url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const projectRoot = path.resolve(__dirname, '..')
const runId = Date.now().toString(36)
const home = path.join(projectRoot, '..', '.tmp', `pkg-home-${runId}`)
const userData = path.join(projectRoot, '..', '.tmp', `pkg-userdata-${runId}`)
const shots = path.join(projectRoot, '.runtime', 'shots')
fs.mkdirSync(home, { recursive: true })
fs.mkdirSync(userData, { recursive: true })
fs.mkdirSync(shots, { recursive: true })

// 从 .env.local 读 key（本机联调用）
function envKey() {
  if (process.env.DEEPSEEK_API_KEY) return process.env.DEEPSEEK_API_KEY
  const file = path.join(projectRoot, '.env.local')
  if (!fs.existsSync(file)) return ''
  const match = fs.readFileSync(file, 'utf8').match(/^\s*DEEPSEEK_API_KEY\s*=\s*(.+)$/m)
  return match ? match[1].trim() : ''
}

const env = { ...process.env, NOVEL_STUDIO_HOME: home, NOVEL_STUDIO_USER_DATA: userData }
delete env.ELECTRON_RUN_AS_NODE
if (envKey()) env.DEEPSEEK_API_KEY = envKey()

const exe = path.join(projectRoot, 'release', 'win-unpacked', 'Novel Studio.exe')
if (!fs.existsSync(exe)) throw new Error(`未找到打包产物：${exe}（先跑 npm run dist:dir）`)

const app = await electron.launch({ executablePath: exe, env })
const page = await app.firstWindow()
await page.waitForLoadState('domcontentloaded')
await page.waitForTimeout(1500)
await page.screenshot({ path: path.join(shots, '20-packaged-shelf.png') })
console.log('packaged app launched')

// 配置弹窗（验证模型目录来自 pi SDK 生成的 catalog）
await page.click('button:has-text("本机配置")')
await page.waitForTimeout(800)
await page.screenshot({ path: path.join(shots, '21-packaged-settings.png') })
const providerCount = await page.locator('.settings-row select option').first().count()
await page.click('button[aria-label="关闭"]')
await page.waitForTimeout(400)

// 建书 + 灌设定
await page.fill('input[placeholder*="书名"]', '雾海纪事')
await page.click('button:has-text("新建书")')
await page.waitForTimeout(1200)

const bookDir = fs
  .readdirSync(home, { withFileTypes: true })
  .filter((entry) => entry.isDirectory())
  .map((entry) => path.join(home, entry.name))
  .find((dir) => fs.existsSync(path.join(dir, 'book.json')))

fs.writeFileSync(
  path.join(bookDir, 'world_model.md'),
  '# 世界模型\n\n- 北境渡口每七日一场大雾，雾里会走出不属于这个世界的东西。\n- 主角林牧是最后一代渡人，规矩：雾里有人招手，不能应。\n',
)
fs.writeFileSync(
  path.join(bookDir, 'chapter_outline.md'),
  '# 逐章大纲\n\n## 第 1 章 雾夜渡客\n- 雾夜，渡船\n- 雾里有人招手，林牧想起规矩\n',
)
fs.writeFileSync(path.join(bookDir, 'style_guide.md'), '# 文风指南\n- 短句为主，画面具体\n')

await page.click('button.tab:has-text("助手")')
await page.waitForTimeout(1200)
await page.fill(
  '.assistant__composer textarea',
  '续写第 1 章《雾夜渡客》开头 400 字左右，写完调用 write_draft 保存 chapterKey=0001 的草稿。',
)
await page.click('.assistant__composer button:has-text("发送")')

const draftsDir = path.join(bookDir, '.studio', 'drafts', '0001')
const deadline = Date.now() + 180_000
let draftFiles = []
while (Date.now() < deadline) {
  await page.waitForTimeout(2000)
  draftFiles = fs.existsSync(draftsDir) ? fs.readdirSync(draftsDir).filter((name) => name.endsWith('.md')) : []
  if (draftFiles.length > 0) {
    await page.waitForTimeout(4000)
    break
  }
}

await page.screenshot({ path: path.join(shots, '22-packaged-agent.png') })
const draftChars = draftFiles.length
  ? fs.readFileSync(path.join(draftsDir, draftFiles[draftFiles.length - 1]), 'utf8').replace(/\s+/g, '').length
  : 0

console.log(
  JSON.stringify(
    { launched: true, providersInSettings: providerCount, draftFiles: draftFiles.length, draftChars },
    null,
    2,
  ),
)
await app.close()
if (draftFiles.length === 0) process.exit(1)

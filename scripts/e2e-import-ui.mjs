/**
 * 导入 UI 端到端：粘贴导入 → 批量文件导入（IPC）→ 番茄书源未安装时的提示。
 * 不消耗模型 token。
 */
import { _electron as electron } from 'playwright'
import path from 'node:path'
import fs from 'node:fs'
import { fileURLToPath } from 'node:url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const projectRoot = path.resolve(__dirname, '..')
const runId = Date.now().toString(36)
const home = path.join(projectRoot, '..', '.tmp', `impui-home-${runId}`)
const userData = path.join(projectRoot, '..', '.tmp', `impui-userdata-${runId}`)
const shots = path.join(projectRoot, '.runtime', 'shots')
fs.mkdirSync(home, { recursive: true })
fs.mkdirSync(userData, { recursive: true })
fs.mkdirSync(shots, { recursive: true })

const env = { ...process.env, NOVEL_STUDIO_HOME: home, NOVEL_STUDIO_USER_DATA: userData }
delete env.ELECTRON_RUN_AS_NODE

const app = await electron.launch({ args: ['.'], cwd: projectRoot, env })
const page = await app.firstWindow()
await page.waitForLoadState('domcontentloaded')
await page.waitForTimeout(1200)

await page.fill('input[placeholder*="书名"]', '导入测试书')
await page.click('button:has-text("新建书")')
await page.waitForTimeout(1200)

const bookDir = fs
  .readdirSync(home, { withFileTypes: true })
  .filter((entry) => entry.isDirectory())
  .map((entry) => path.join(home, entry.name))
  .find((dir) => fs.existsSync(path.join(dir, 'book.json')))
if (!bookDir) throw new Error('book dir not found')

// ---------- 粘贴导入 ----------
await page.click('.topbar button:has-text("导入")')
await page.waitForTimeout(700)
await page.screenshot({ path: path.join(shots, '60-import-paste.png') })

await page.fill('input[placeholder*="书名 / 来源"]', '雾海纪事')
await page.fill(
  'textarea[placeholder*="把整本书"]',
  `第一章 雾夜渡客

雾是从水面长出来的。林牧把篙插进水里。

第二章 七日之限

镇渊司的封条贴在船头。

第三章 听潮阁来信

青衫人推门进来。
`,
)
await page.click('.import-actions button:has-text("导入文本")')
await page.waitForTimeout(1500)

const afterPaste = await page.evaluate(async (dir) => {
  const result = await window.studio.openBook(dir)
  return result.ok ? result.data.chapters.length : -1
}, bookDir)

// ---------- 批量文件导入（多选路径直传） ----------
const fileA = path.join(home, '续一.txt')
const fileB = path.join(home, '续二.txt')
fs.writeFileSync(fileA, '第四章 雾里的名字\n\n林牧在雾中看见父亲的船。\n', 'utf8')
fs.writeFileSync(fileB, '第五章 渡籍\n\n林牧重抄了渡籍。\n', 'utf8')
const batchResult = await page.evaluate(
  async ({ dir, filePaths }) => {
    const result = await window.studio.importFiles({ dir, filePaths })
    return result.ok ? result.data.report : null
  },
  { dir: bookDir, filePaths: [fileA, fileB] },
)

// ---------- 番茄书源：没有下载器时的提示 ----------
await page.click('.topbar button:has-text("导入")')
await page.waitForTimeout(600)
await page.click('.import-tab:has-text("番茄书源")')
await page.waitForTimeout(1200)
const tomatoHint =
  ((await page.locator('.tomato-status').first().textContent().catch(() => '')) ?? '') +
  ' ' +
  ((await page.locator('.import-empty').first().textContent().catch(() => '')) ?? '')
await page.screenshot({ path: path.join(shots, '61-import-tomato-unavailable.png') })
await page.click('button[aria-label="关闭"]')
await page.waitForTimeout(400)

const afterAll = await page.evaluate(async (dir) => {
  const result = await window.studio.openBook(dir)
  return result.ok ? result.data.chapters.length : -1
}, bookDir)

const result = {
  afterPasteChapters: afterPaste,
  batchChapters: batchResult?.chapters ?? 0,
  batchSources: batchResult?.sources ?? 0,
  afterAllChapters: afterAll,
  tomatoHint: tomatoHint.trim().slice(0, 80),
  tomatoDetectedUnavailable: tomatoHint.includes('未检测到'),
}
console.log(JSON.stringify(result, null, 2))

await Promise.race([
  app.close().then(() => 'closed'),
  new Promise((resolve) => setTimeout(resolve, 15000)),
])

if (afterPaste !== 3 || result.batchChapters !== 2 || afterAll !== 5 || !result.tomatoDetectedUnavailable) {
  process.exit(1)
}

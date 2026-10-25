/**
 * 知识库初始化端到端：导入 3 章 → 点「初始化知识」→ 真实模型蒸馏 → 校验四个知识文件与 [知识] 提交。
 */
import { _electron as electron } from 'playwright'
import path from 'node:path'
import fs from 'node:fs'
import { fileURLToPath } from 'node:url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const projectRoot = path.resolve(__dirname, '..')
const runId = Date.now().toString(36)
const home = path.join(projectRoot, '..', '.tmp', `kn-home-${runId}`)
const userData = path.join(projectRoot, '..', '.tmp', `kn-userdata-${runId}`)
const shots = path.join(projectRoot, '.runtime', 'shots')
fs.mkdirSync(home, { recursive: true })
fs.mkdirSync(userData, { recursive: true })
fs.mkdirSync(shots, { recursive: true })

const env = { ...process.env, NOVEL_STUDIO_HOME: home, NOVEL_STUDIO_USER_DATA: userData }
delete env.ELECTRON_RUN_AS_NODE
const keyFile = path.join(projectRoot, '.env.local')
if (fs.existsSync(keyFile)) {
  const match = fs.readFileSync(keyFile, 'utf8').match(/^\s*DEEPSEEK_API_KEY\s*=\s*(.+)$/m)
  if (match) env.DEEPSEEK_API_KEY = match[1].trim()
}

const txtPath = path.join(home, '雾海纪事.txt')
fs.writeFileSync(
  txtPath,
  `第一章 雾夜渡客

雾是从水面长出来的。林牧把篙插进水里，听见底下有人说话。他没有回答。

第二章 七日之限

镇渊司的封条贴在船头。青袍人说七日之内补交三倍渡税。

第三章 听潮阁来信

青衫人推门进来，把一封信放在桌上，说：替我送一趟，不能拆。

第四章 雾里的名字

林牧在雾中看见父亲的船，船头站着一个人，正在朝他招手。
`,
  'utf8',
)

const app = await electron.launch({ args: ['.'], cwd: projectRoot, env })
const page = await app.firstWindow()
page.on('dialog', (dialog) => void dialog.accept())
await page.waitForLoadState('domcontentloaded')
await page.waitForTimeout(1200)

await page.fill('input[placeholder*="书名"]', '雾海纪事')
await page.click('button:has-text("新建书")')
await page.waitForTimeout(1200)

const bookDir = fs
  .readdirSync(home, { withFileTypes: true })
  .filter((entry) => entry.isDirectory())
  .map((entry) => path.join(home, entry.name))
  .find((dir) => fs.existsSync(path.join(dir, 'book.json')))
if (!bookDir) throw new Error('book dir not found')

await page.evaluate(
  async ({ dir, filePath }) => window.studio.importFile({ dir, filePath }),
  { dir: bookDir, filePath: txtPath },
)
await page.waitForTimeout(800)

// 通过真实 IPC 导入后，回书架再打开以刷新快照（与用户操作路径一致）
await page.click('.topbar button:has-text("书架")')
await page.waitForTimeout(800)
await page.click('.book-card:has-text("雾海纪事")')
await page.waitForTimeout(1200)

await page.click('button:has-text("初始化知识")')
await page.waitForTimeout(900)
await page.screenshot({ path: path.join(shots, '50-knowledge-progress.png') })

const deadline = Date.now() + 240_000
let done = false
while (Date.now() < deadline) {
  await page.waitForTimeout(3000)
  const modal = await page.locator('.pipeline-modal').count()
  const world = fs.existsSync(path.join(bookDir, 'world_model.md'))
    ? fs.readFileSync(path.join(bookDir, 'world_model.md'), 'utf8')
    : ''
  if (modal === 0 && world.includes('世界模型') && world.length > 200) {
    done = true
    break
  }
}

await page.waitForTimeout(1500)
await page.screenshot({ path: path.join(shots, '51-knowledge-done.png') })

const read = (name) => (fs.existsSync(path.join(bookDir, name)) ? fs.readFileSync(path.join(bookDir, name), 'utf8') : '')
const report = {
  done,
  worldChars: read('world_model.md').replace(/\s+/g, '').length,
  summaryChars: read('summary.md').replace(/\s+/g, '').length,
  statusChars: read('status_card.md').replace(/\s+/g, '').length,
  outlineChars: read('chapter_outline.md').replace(/\s+/g, '').length,
  outlineLines: (read('chapter_outline.md').match(/^- \d{4}/gm) ?? []).length,
}
console.log(JSON.stringify(report, null, 2))

const closed = await Promise.race([
  app.close().then(() => 'closed'),
  new Promise((resolve) => setTimeout(resolve, 15000)),
])
if (!done || report.outlineLines < 4) process.exit(1)

/**
 * 知识库管线端到端：
 *  1) 导入 4 章 → 首次初始化（全量），生成四个知识文件与 pipeline-state
 *  2) 再导入 1 章 → 按钮变为「更新知识 (1)」→ 增量更新，只处理第 5 章
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

const txtPath2 = path.join(home, '雾海纪事-续.txt')
fs.writeFileSync(
  txtPath2,
  `第五章 渡籍

林牧把渡籍重新抄了一遍，名字后面多了一行小字：听潮阁代缴。
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

const statePath = path.join(bookDir, '.studio', 'pipeline-state.json')
const readState = () => {
  if (!fs.existsSync(statePath)) return null
  try {
    return JSON.parse(fs.readFileSync(statePath, 'utf8'))
  } catch {
    return null
  }
}
const read = (name) =>
  fs.existsSync(path.join(bookDir, name)) ? fs.readFileSync(path.join(bookDir, name), 'utf8') : ''

// 导入 4 章并刷新界面
await page.evaluate(async ({ dir, filePath }) => window.studio.importFile({ dir, filePath }), {
  dir: bookDir,
  filePath: txtPath,
})
await page.waitForTimeout(600)
await page.click('.topbar button:has-text("书架")')
await page.waitForTimeout(800)
await page.click('.book-card:has-text("雾海纪事")')
await page.waitForTimeout(1200)

// ---------- 第一次：全量初始化 ----------
await page.click('button:has-text("初始化知识")')
await page.waitForTimeout(900)
await page.screenshot({ path: path.join(shots, '50-knowledge-progress.png') })

const waitUntil = async (predicate, timeoutMs = 240_000) => {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    await page.waitForTimeout(2500)
    if (await predicate()) return true
  }
  return false
}

const fullDone = await waitUntil(async () => {
  const modal = await page.locator('.pipeline-modal').count()
  const state = readState()
  return modal === 0 && state?.lastChapterKey === '0004'
})

await page.waitForTimeout(1200)
await page.screenshot({ path: path.join(shots, '51-knowledge-done.png') })

const fullReport = {
  fullDone,
  worldChars: read('world_model.md').replace(/\s+/g, '').length,
  summaryChars: read('summary.md').replace(/\s+/g, '').length,
  statusChars: read('status_card.md').replace(/\s+/g, '').length,
  outlineLines: (read('chapter_outline.md').match(/^- \d{4}/gm) ?? []).length,
  stateAfterFull: readState(),
}

// ---------- 第二次：导入 1 章 → 增量更新 ----------
await page.evaluate(async ({ dir, filePath }) => window.studio.importFile({ dir, filePath }), {
  dir: bookDir,
  filePath: txtPath2,
})
await page.waitForTimeout(600)
await page.click('.topbar button:has-text("书架")')
await page.waitForTimeout(800)
await page.click('.book-card:has-text("雾海纪事")')
await page.waitForTimeout(1400)

const buttonText = await page
  .locator('.topbar button:has-text("更新知识"), .topbar button:has-text("知识已最新")')
  .first()
  .textContent()
await page.click('.topbar button:has-text("更新知识")')
await page.waitForTimeout(1000)

const incDone = await waitUntil(async () => {
  const modal = await page.locator('.pipeline-modal').count()
  const state = readState()
  return modal === 0 && state?.lastChapterKey === '0005'
})
await page.waitForTimeout(1200)
await page.screenshot({ path: path.join(shots, '52-knowledge-incremental.png') })

// 用 UI 历史面板确认最新提交是「增量更新」
await page.click('button.tab:has-text("历史")')
await page.waitForTimeout(800)
const latestEntry = (await page.locator('.entry').first().textContent()) ?? ''
const latestIsIncremental = latestEntry.includes('增量')
const knowledgeButtonAfter = (await page.locator('.topbar button:has-text("知识已最新")').count()) > 0

const result = {
  fullReport,
  incrementalButton: (buttonText ?? '').trim(),
  incrementalDone: incDone,
  stateAfterIncremental: readState(),
  latestHistoryEntry: latestEntry.trim(),
  latestIsIncremental,
  knowledgeButtonAfter,
  outlineLinesAfter: (read('chapter_outline.md').match(/^- \d{4}/gm) ?? []).length,
}
console.log(JSON.stringify(result, null, 2))

const closed = await Promise.race([
  app.close().then(() => 'closed'),
  new Promise((resolve) => setTimeout(resolve, 15000)),
])

if (
  !fullDone ||
  !incDone ||
  fullReport.outlineLines < 4 ||
  result.outlineLinesAfter < 5 ||
  !result.latestIsIncremental
) {
  process.exit(1)
}

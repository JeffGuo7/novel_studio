/**
 * 写作统计端到端（不花钱）：
 * 建书 → 导入两章 → 打开统计弹窗 → 校验今日/总字数/进度 → 设置每日目标 → 校验磁盘与 UI。
 */
import { _electron as electron } from 'playwright'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const projectRoot = path.resolve(__dirname, '..')
const runId = Date.now().toString(36)
const home = path.join(projectRoot, '..', '.tmp', `stats-home-${runId}`)
const userData = path.join(projectRoot, '..', '.tmp', `stats-userdata-${runId}`)
const shots = path.join(projectRoot, '.runtime', 'shots')
fs.mkdirSync(home, { recursive: true })
fs.mkdirSync(userData, { recursive: true })
fs.mkdirSync(shots, { recursive: true })

const env = {
  ...process.env,
  NOVEL_STUDIO_HOME: home,
  NOVEL_STUDIO_USER_DATA: userData,
  NOVEL_STUDIO_SKIP_LOCAL_ENV: '1',
}
delete env.ELECTRON_RUN_AS_NODE

const app = await electron.launch({ args: ['.'], cwd: projectRoot, env })
const page = await app.firstWindow()
page.on('dialog', (dialog) => void dialog.accept())
await page.waitForLoadState('domcontentloaded')
await page.waitForTimeout(1200)

await page.fill('.shelf__create input:first-child', '统计测试书')
await page.click('button:has-text("新建书")')
await page.waitForTimeout(1200)

const bookDir = fs
  .readdirSync(home, { withFileTypes: true })
  .filter((entry) => entry.isDirectory())
  .map((entry) => path.join(home, entry.name))
  .find((dir) => fs.existsSync(path.join(dir, 'book.json')))

await page.evaluate(
  async ({ dir }) =>
    window.studio.importText({
      dir,
      text: `第一章 雾夜\n\n${'雾从水面长出来。'.repeat(30)}\n\n第二章 七日\n\n${'封条贴在船头。'.repeat(20)}\n`,
      title: '统计样本',
    }),
  { dir: bookDir },
)
await page.waitForTimeout(800)

await page.click('.topbar button:has-text("统计")')
await page.waitForSelector('.stats-modal')
await page.waitForTimeout(600)
const summaryText = (await page.locator('.stats-summary').innerText()).replace(/\s+/g, ' ')
const values = await page.locator('.stats-card__value').allTextContents()
const progressVisible = await page.locator('.stats-progress').isVisible().catch(() => false)

await page.fill('.stats-goal__input', '1000')
await page.click('.stats-goal button:has-text("保存目标")')
await page.waitForTimeout(900)
await page.screenshot({ path: path.join(shots, '78-stats.png') })

const statsFile = path.join(bookDir, '.studio', 'stats.json')
const statsJson = fs.existsSync(statsFile) ? JSON.parse(fs.readFileSync(statsFile, 'utf8')) : null
const todayWords = values[0]?.replace(/[^\d]/g, '')
const totalWords = values[1]?.replace(/[^\d]/g, '')

const result = {
  summaryText,
  todayWords: Number(todayWords),
  totalWords: Number(totalWords),
  progressVisible,
  goalSaved: statsJson?.goalWords,
  dailyEntries: statsJson?.daily ? Object.values(statsJson.daily).reduce((sum, value) => sum + Number(value), 0) : 0,
  bookTitle: '统计测试书',
}
console.log(JSON.stringify(result, null, 2))

await Promise.race([
  app.close().then(() => 'closed'),
  new Promise((resolve) => setTimeout(() => resolve('timeout'), 15_000)),
])
const ok =
  result.todayWords > 0 &&
  result.totalWords > 0 &&
  result.totalWords >= result.todayWords &&
  result.dailyEntries >= result.todayWords &&
  result.progressVisible &&
  result.goalSaved === 1000
if (!ok) process.exit(1)

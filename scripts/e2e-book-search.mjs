/**
 * 全书搜索 / 替换端到端（不花钱）：
 * 导入 2 章 → Ctrl+F 打开搜索 → 搜索「雾」→ 全部替换为「霭」→ 校验书稿、提交、结果刷新。
 *
 * 注意：scripts/e2e-search.mjs 是 Agent 的 search_story 端到端，这里是作者侧的全文搜索。
 */
import { _electron as electron } from 'playwright'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const projectRoot = path.resolve(__dirname, '..')
const runId = Date.now().toString(36)
const home = path.join(projectRoot, '..', '.tmp', `booksearch-home-${runId}`)
const userData = path.join(projectRoot, '..', '.tmp', `booksearch-userdata-${runId}`)
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

await page.fill('input[placeholder*="书名"]', '搜索测试')
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
      text: '第一章 雾夜\n\n雾从水面长出来，雾里有灯。\n\n第二章 七日\n\n镇渊司的封条贴在船头，雾更浓了。\n',
      title: '搜索样本',
    }),
  { dir: bookDir },
)
await page.waitForTimeout(800)
await page.click('.topbar button:has-text("书架")')
await page.waitForTimeout(600)
await page.click('.book-card:has-text("搜索测试")')
await page.waitForTimeout(1200)

// Ctrl+F 打开搜索
await page.keyboard.press('Control+f')
await page.waitForSelector('.search-modal')
const openedByShortcut = await page.locator('.search-modal').isVisible()

await page.fill('.search-bar input', '雾')
await page.waitForSelector('.search-group', { timeout: 5000 })
await page.waitForTimeout(400)
const groupCount = await page.locator('.search-group').count()
const countText = (await page.locator('.search-count').innerText()).replace(/\s+/g, ' ')
await page.screenshot({ path: path.join(shots, '73-search-results.png') })

// 全部替换
await page.fill('.search-replace input', '霭')
await page.click('.search-replace button:has-text("全部替换")')
await page.waitForTimeout(1500)
const afterReport = await page.evaluate(async (dir) => {
  const result = await window.studio.openBook(dir)
  if (!result.ok) return null
  const history = await window.studio.history({ dir, depth: 5 })
  return {
    titles: result.data.chapters.map((chapter) => chapter.title),
    commits: history.ok ? history.data.map((commit) => ({ kind: commit.kind, summary: commit.summary })) : [],
  }
}, bookDir)

const chapterFiles = fs.readdirSync(path.join(bookDir, 'chapters'))
const allContent = chapterFiles
  .map((name) => fs.readFileSync(path.join(bookDir, 'chapters', name), 'utf8'))
  .join('\n')

// 关闭后再次 Ctrl+F，确认还能打开
await page.keyboard.press('Escape')
await page.waitForTimeout(300)
await page.keyboard.press('Control+f')
await page.waitForTimeout(400)
const reopened = await page.locator('.search-modal').isVisible()
await page.screenshot({ path: path.join(shots, '74-search-replace.png') })

const result = {
  openedByShortcut,
  groupCount,
  countText,
  remainingMatches: (allContent.match(/雾/g) ?? []).length,
  replacedCount: (allContent.match(/霭/g) ?? []).length,
  hasReplaceCommit: afterReport?.commits.some((commit) => commit.kind === '替换') ?? false,
  reopened,
}
console.log(JSON.stringify(result, null, 2))

await Promise.race([
  app.close().then(() => 'closed'),
  new Promise((resolve) => setTimeout(() => resolve('timeout'), 15_000)),
])
const ok =
  openedByShortcut &&
  groupCount >= 2 &&
  result.remainingMatches === 0 &&
  result.replacedCount >= 3 &&
  result.hasReplaceCommit &&
  reopened
if (!ok) process.exit(1)

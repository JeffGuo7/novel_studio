/**
 * 删除端到端：删章节（留 Git 记录）+ 删整本书（进 .trash 回收站）。不消耗模型 token。
 */
import { _electron as electron } from 'playwright'
import path from 'node:path'
import fs from 'node:fs'
import { fileURLToPath } from 'node:url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const projectRoot = path.resolve(__dirname, '..')
const runId = Date.now().toString(36)
const home = path.join(projectRoot, '..', '.tmp', `del-home-${runId}`)
const userData = path.join(projectRoot, '..', '.tmp', `del-userdata-${runId}`)
fs.mkdirSync(home, { recursive: true })
fs.mkdirSync(userData, { recursive: true })

const env = { ...process.env, NOVEL_STUDIO_HOME: home, NOVEL_STUDIO_USER_DATA: userData }
delete env.ELECTRON_RUN_AS_NODE

const app = await electron.launch({ args: ['.'], cwd: projectRoot, env })
const page = await app.firstWindow()
page.on('dialog', (dialog) => void dialog.accept())
await page.waitForLoadState('domcontentloaded')
await page.waitForTimeout(1200)

await page.fill('input[placeholder*="书名"]', '删除测试书')
await page.click('button:has-text("新建书")')
await page.waitForTimeout(1200)

const bookDir = fs
  .readdirSync(home, { withFileTypes: true })
  .filter((entry) => entry.isDirectory())
  .map((entry) => path.join(home, entry.name))
  .find((dir) => fs.existsSync(path.join(dir, 'book.json')))
if (!bookDir) throw new Error('book dir not found')

await page.evaluate(
  async ({ dir }) =>
    window.studio.importText({
      dir,
      title: '删除样本',
      text: '第一章 一\n\n正文一。\n\n第二章 二\n\n正文二。\n',
    }),
  { dir: bookDir },
)
await page.waitForTimeout(600)

// 重新打开书，让快照刷新
await page.click('.topbar button:has-text("书架")')
await page.waitForTimeout(600)
await page.click('.book-card:has-text("删除测试书")')
await page.waitForTimeout(1200)

const before = await page.locator('.sidebar .tree-item').count()
await page.locator('.sidebar .tree-item').first().click()
await page.waitForTimeout(800)
await page.click('button[aria-label="删除本章"]')
await page.waitForTimeout(1500)
const after = await page.locator('.sidebar .tree-item').count()

const deletedCommit = fs.existsSync(path.join(bookDir, '.git'))
  ? true
  : false
const remainingFiles = fs
  .readdirSync(path.join(bookDir, 'chapters'))
  .filter((name) => name.endsWith('.md'))

// 回书架删整本书
await page.click('.topbar button:has-text("书架")')
await page.waitForTimeout(800)
await page.hover('.book-card-wrap')
await page.click('.book-card__delete')
await page.waitForTimeout(1200)
const shelfCards = await page.locator('.book-card').count()
const trash = path.join(home, '.trash')
const trashed = fs.existsSync(trash)
  ? fs.readdirSync(trash).filter((name) => fs.existsSync(path.join(trash, name, 'book.json'))).length
  : 0

const result = {
  chaptersBefore: before,
  chaptersAfter: after,
  remainingChapterFiles: remainingFiles.length,
  shelfCardsAfterBookDelete: shelfCards,
  trashedBooks: trashed,
  gitExists: deletedCommit,
}
console.log(JSON.stringify(result, null, 2))

const closed = await Promise.race([
  app.close().then(() => 'closed'),
  new Promise((resolve) => setTimeout(() => resolve('timeout'), 15_000)),
])

if (
  before - after !== 1 ||
  remainingFiles.length !== 1 ||
  shelfCards !== 0 ||
  trashed !== 1
) {
  process.exit(1)
}

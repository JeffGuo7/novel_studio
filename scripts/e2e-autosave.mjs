/**
 * 自动存档 / 崩溃恢复端到端（不花钱）：
 * 编辑章节 → 等待自动存档 → 关闭应用（模拟崩溃/退出）→ 重新打开 → 恢复自动存档 → 保存 → 自动存档清除。
 */
import { _electron as electron } from 'playwright'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const projectRoot = path.resolve(__dirname, '..')
const runId = Date.now().toString(36)
const home = path.join(projectRoot, '..', '.tmp', `autosave-home-${runId}`)
const userData = path.join(projectRoot, '..', '.tmp', `autosave-userdata-${runId}`)
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

async function launch() {
  const app = await electron.launch({ args: ['.'], cwd: projectRoot, env })
  const page = await app.firstWindow()
  page.on('dialog', (dialog) => void dialog.accept())
  await page.waitForLoadState('domcontentloaded')
  await page.waitForTimeout(1200)
  return { app, page }
}

async function close(app) {
  await Promise.race([
    app.close().then(() => 'closed'),
    new Promise((resolve) => setTimeout(() => resolve('timeout'), 15_000)),
  ])
}

// 1. 建书 + 导入章节
const first = await launch()
await first.page.fill('input[placeholder*="书名"]', '自动存档测试')
await first.page.click('button:has-text("新建书")')
await first.page.waitForTimeout(1200)
const bookDir = fs
  .readdirSync(home, { withFileTypes: true })
  .filter((entry) => entry.isDirectory())
  .map((entry) => path.join(home, entry.name))
  .find((dir) => fs.existsSync(path.join(dir, 'book.json')))
await first.page.evaluate(
  async ({ dir }) =>
    window.studio.importText({
      dir,
      text: '第一章 雾夜\n\n雾从水面长出来。\n',
      title: '自动存档样本',
    }),
  { dir: bookDir },
)
await first.page.waitForTimeout(800)
await first.page.click('.topbar button:has-text("书架")')
await first.page.waitForTimeout(600)
await first.page.click('.book-card:has-text("自动存档测试")')
await first.page.waitForTimeout(1200)

// 2. 编辑并等待自动存档
const marker = '这一段是崩溃前没有手动保存的内容。'
await first.page.click('.doc-header button:has-text("编辑")')
await first.page.waitForTimeout(300)
await first.page.locator('textarea.editor').fill(`# 第 1 章 雾夜\n\n雾从水面长出来。\n\n${marker}\n`)
await first.page.waitForTimeout(4000)

const autosaveFile = path.join(bookDir, '.studio', 'autosave', 'entries.json')
const autosaveAfterEdit = fs.existsSync(autosaveFile)
  ? JSON.parse(fs.readFileSync(autosaveFile, 'utf8'))
  : null
const savedBeforeClose = Boolean(
  autosaveAfterEdit?.entries?.some((entry) => entry.content.includes(marker)),
)
await first.page.screenshot({ path: path.join(shots, '71-autosave-dirty.png') })
await close(first.app)

// 3. 重新打开：应提示恢复
const second = await launch()
await second.page.click('.book-card:has-text("自动存档测试")')
await second.page.waitForTimeout(1500)
const bannerVisible = await second.page.locator('.autosave-banner').isVisible().catch(() => false)
const bannerText = bannerVisible ? await second.page.locator('.autosave-banner').innerText() : ''
await second.page.screenshot({ path: path.join(shots, '72-autosave-banner.png') })

let restored = false
if (bannerVisible) {
  await second.page.click('.autosave-banner button:has-text("恢复")')
  await second.page.waitForTimeout(500)
  restored = await second.page.locator('textarea.editor').evaluate(
    (element, expected) => element.value.includes(expected),
    marker,
  )
  // 保存后自动存档应清除
  await second.page.keyboard.press('Control+s')
  await second.page.waitForTimeout(1500)
}
const autosaveAfterSave = fs.existsSync(autosaveFile)
  ? JSON.parse(fs.readFileSync(autosaveFile, 'utf8'))
  : { entries: [] }
const chapterFiles = fs.existsSync(path.join(bookDir, 'chapters'))
  ? fs.readdirSync(path.join(bookDir, 'chapters')).filter((name) => name.endsWith('.md'))
  : []
const chapterContent = chapterFiles.length > 0
  ? fs.readFileSync(path.join(bookDir, 'chapters', chapterFiles[0]), 'utf8')
  : ''

const result = {
  savedBeforeClose,
  autosaveEntryCount: autosaveAfterEdit?.entries?.length ?? 0,
  bannerVisible,
  bannerText: bannerText.replace(/\s+/g, ' ').slice(0, 80),
  restored,
  autosaveClearedAfterSave: autosaveAfterSave.entries.length === 0,
  chapterSavedMarker: chapterContent.includes(marker),
}
console.log(JSON.stringify(result, null, 2))
await close(second.app)

const ok =
  savedBeforeClose &&
  bannerVisible &&
  restored &&
  result.autosaveClearedAfterSave &&
  result.chapterSavedMarker
if (!ok) process.exit(1)

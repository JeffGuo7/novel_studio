/**
 * 章节管理端到端（不花钱）：
 * 导入 3 章 → 菜单插入 → 上移 → 合并 → 光标拆分 → 重新编号，并校验页面与磁盘结构。
 */
import { _electron as electron } from 'playwright'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const projectRoot = path.resolve(__dirname, '..')
const runId = Date.now().toString(36)
const home = path.join(projectRoot, '..', '.tmp', `chapters-home-${runId}`)
const userData = path.join(projectRoot, '..', '.tmp', `chapters-userdata-${runId}`)
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

await page.fill('input[placeholder*="书名"]', '章节管理测试')
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
      text: `第一章 雾夜\n\n雾从水面长出来。\n\n第二章 七日\n\n封条贴在船头。\n\n第三章 来信\n\n青衫人放下一封信。\n`,
      title: '章节样本',
    }),
  { dir: bookDir },
)
await page.waitForTimeout(800)
await page.click('.topbar button:has-text("书架")')
await page.waitForTimeout(600)
await page.click('.book-card:has-text("章节管理测试")')
await page.waitForTimeout(1200)

const chapters = async () =>
  page.evaluate(async (dir) => {
    const result = await window.studio.openBook(dir)
    return result.ok ? result.data.chapters.map((chapter) => ({ key: chapter.key, title: chapter.title })) : []
  }, bookDir)

// 打开章节菜单
await page.click('.tree-item:has-text("雾夜")')
await page.waitForTimeout(400)
await page.click('button[aria-label="章节操作"]')
await page.waitForSelector('.menu-panel')
const menuItems = await page.locator('.menu-panel button').allTextContents()
await page.screenshot({ path: path.join(shots, '70-chapter-menu.png') })

// 在下方插入
await page.click('.menu-panel button:has-text("在下方插入章节")')
await page.waitForSelector('.insert-modal')
await page.fill('.insert-modal input', '插曲')
await page.click('.insert-modal button:has-text("插入章节")')
await page.waitForTimeout(1000)
const afterInsert = await chapters()

// 选中插曲并上移
await page.click('.tree-item:has-text("插曲")')
await page.waitForTimeout(400)
await page.click('button[aria-label="章节操作"]')
await page.click('.menu-panel button:has-text("上移一章")')
await page.waitForTimeout(1000)
const afterMove = await chapters()

// 合并插曲到下一章
await page.click('.tree-item:has-text("插曲")')
await page.waitForTimeout(300)
await page.click('button[aria-label="章节操作"]')
await page.click('.menu-panel button:has-text("合并到下一章")')
await page.waitForTimeout(1000)
const afterMerge = await chapters()
const mergedContent =
  afterMerge.length > 0
    ? await page.evaluate(async (dir) => {
        const result = await window.studio.openBook(dir)
        if (!result.ok) return ''
        const file = await window.studio.readFile({ dir, path: result.data.chapters[0].path })
        return file.ok ? file.data.content : ''
      }, bookDir)
    : ''

// 选中第一章节，进入编辑模式，把光标放到正文中间并拆分
await page.click('.tree-item:has-text("插曲")')
await page.waitForTimeout(300)
await page.click('.doc-header button:has-text("编辑")')
await page.waitForTimeout(300)
const splitOk = await page.evaluate(() => {
  const textarea = document.querySelector('textarea.editor')
  if (!textarea) return false
  const offset = Math.floor(textarea.value.length * 0.55)
  textarea.focus()
  textarea.setSelectionRange(offset, offset)
  return true
})
await page.click('button[aria-label="章节操作"]')
if (splitOk) {
  await page.click('.menu-panel button:has-text("从光标处拆分")')
  await page.waitForTimeout(1200)
}
const afterSplit = await chapters()

// 重新编号
await page.locator('.tree-item').first().click()
await page.waitForTimeout(300)
await page.click('button[aria-label="章节操作"]')
await page.click('.menu-panel button:has-text("重新编号全部章节")')
await page.waitForTimeout(1200)
const afterRenumber = await chapters()

const result = {
  menuItems,
  afterInsert,
  afterMove,
  afterMerge,
  mergedHasNextText: mergedContent.includes('雾从水面长出来'),
  afterSplit,
  afterRenumber,
}
console.log(JSON.stringify(result, null, 2))

const ok =
  menuItems.length >= 7 &&
  afterInsert.length === 4 &&
  afterInsert.map((item) => item.title).join(',').includes('插曲') &&
  afterMove[0]?.title === '插曲' &&
  afterMerge.length === 3 &&
  result.mergedHasNextText &&
  afterSplit.length === 4 &&
  afterRenumber.every((item, index) => item.key === String(index + 1).padStart(4, '0')) &&
  afterRenumber[0]?.title === '插曲'

await Promise.race([
  app.close().then(() => 'closed'),
  new Promise((resolve) => setTimeout(() => resolve('timeout'), 15_000)),
])
if (!ok) process.exit(1)

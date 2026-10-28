/**
 * 书架体验端到端（不花钱）：
 * 建两本书 → 搜索过滤 → 按书名排序 → 编辑书籍信息 → 上传封面 → 校验磁盘与 UI。
 */
import { _electron as electron } from 'playwright'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const projectRoot = path.resolve(__dirname, '..')
const runId = Date.now().toString(36)
const home = path.join(projectRoot, '..', '.tmp', `shelf-home-${runId}`)
const userData = path.join(projectRoot, '..', '.tmp', `shelf-userdata-${runId}`)
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

async function createBook(title) {
  await page.fill('.shelf__create input:first-child', title)
  await page.click('button:has-text("新建书")')
  await page.waitForTimeout(1200)
  await page.click('.topbar button:has-text("书架")')
  await page.waitForTimeout(700)
}

await createBook('雾海纪事')
await createBook('临渊行')
const cardCount = await page.locator('.book-card').count()

// 搜索
await page.fill('.shelf__search input', '临渊')
await page.waitForTimeout(300)
const filteredCount = await page.locator('.book-card').count()
const filteredTitle = (await page.locator('.book-card h3').first().innerText()).trim()
await page.fill('.shelf__search input', '')
await page.waitForTimeout(300)

// 按书名排序（临渊行拼音 L 在 雾 W 前）
await page.selectOption('.shelf__sort', 'title')
await page.waitForTimeout(300)
const firstByTitle = (await page.locator('.book-card h3').first().innerText()).trim()

// 打开一本书（记录最近打开），返回书架
await page.click('.book-card:has-text("临渊行")')
await page.waitForTimeout(900)
await page.click('.topbar button:has-text("书架")')
await page.waitForTimeout(800)
const lastOpened = await page.evaluate(async () => {
  const books = await window.studio.listBooks()
  return books.ok ? books.data.map((book) => ({ title: book.meta.title, lastOpenedAt: book.lastOpenedAt })) : []
})

// 编辑书籍信息
await page.click('button[aria-label="编辑《临渊行》"]', { force: true })
await page.waitForSelector('.book-info-modal')
await page.fill('#book-title', '临渊行·改')
await page.fill('#book-author', '测试作者')
await page.fill('#book-desc', '一句话简介：雾海尽头的渡船。')
await page.click('.book-info-modal button:has-text("保存")')
await page.waitForTimeout(1200)
const editedTitle = (await page.locator('.book-card h3').first().innerText()).trim()
const editedDesc = (await page.locator('.book-card__desc').first().innerText()).trim()

// 上传封面（直接调 IPC，避免系统文件对话框）
const pngPath = path.join(projectRoot, '..', '.tmp', `shelf-cover-${runId}.png`)
fs.writeFileSync(
  pngPath,
  Buffer.from(
    'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==',
    'base64',
  ),
)
const bookDir = fs
  .readdirSync(home, { withFileTypes: true })
  .filter((entry) => entry.isDirectory())
  .map((entry) => path.join(home, entry.name))
  .find((dir) => fs.readFileSync(path.join(dir, 'book.json'), 'utf8').includes('临渊行·改'))
const coverResult = await page.evaluate(
  async ({ dir, pngPath }) => window.studio.setBookCover({ dir, filePath: pngPath }),
  { dir: bookDir, pngPath },
)
await page.evaluate(() => window.location.reload())
await page.waitForTimeout(1500)
const coverRendered = await page.locator('.book-card__cover').count()
await page.screenshot({ path: path.join(shots, '77-bookshelf.png') })

const meta = JSON.parse(fs.readFileSync(path.join(bookDir, 'book.json'), 'utf8'))
const result = {
  cardCount,
  filteredCount,
  filteredTitle,
  firstByTitle,
  lastOpenedRecorded: lastOpened.some((book) => book.title === '临渊行' && Boolean(book.lastOpenedAt)),
  editedTitle,
  editedDesc,
  coverOk: Boolean(coverResult.ok && coverResult.data?.snapshot?.coverDataUrl),
  coverRendered,
  metaTitle: meta.title,
  metaAuthor: meta.author,
  metaDescription: meta.description,
  metaCover: meta.cover,
}
console.log(JSON.stringify(result, null, 2))

await Promise.race([
  app.close().then(() => 'closed'),
  new Promise((resolve) => setTimeout(() => resolve('timeout'), 15_000)),
])
const ok =
  cardCount === 2 &&
  filteredCount === 1 &&
  filteredTitle === '临渊行' &&
  firstByTitle === '临渊行' &&
  result.lastOpenedRecorded &&
  editedTitle === '临渊行·改' &&
  result.coverOk &&
  coverRendered >= 1 &&
  meta.title === '临渊行·改' &&
  meta.author === '测试作者' &&
  meta.cover === 'cover.png'
if (!ok) process.exit(1)

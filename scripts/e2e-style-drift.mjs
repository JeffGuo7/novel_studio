/**
 * 文风漂移端到端（不消耗模型 token）：
 * 导入两章（一章贴合指纹、一章明显偏离）→ 用应用自身算出的指标生成基线指纹 →
 * 选中贴合章节应无提示，选中偏离章节出现「文风漂移」提示与详情弹窗。
 */
import { _electron as electron } from 'playwright'
import path from 'node:path'
import fs from 'node:fs'
import { fileURLToPath } from 'node:url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const projectRoot = path.resolve(__dirname, '..')
const runId = Date.now().toString(36)
const home = path.join(projectRoot, '..', '.tmp', `sd-home-${runId}`)
const userData = path.join(projectRoot, '..', '.tmp', `sd-userdata-${runId}`)
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

await page.fill('input[placeholder*="书名"]', '文风测试书')
await page.click('button:has-text("新建书")')
await page.waitForTimeout(1200)

const bookDir = fs
  .readdirSync(home, { withFileTypes: true })
  .filter((entry) => entry.isDirectory())
  .map((entry) => path.join(home, entry.name))
  .find((dir) => fs.existsSync(path.join(dir, 'book.json')))
if (!bookDir) throw new Error('book dir not found')

const text = `第一章 雾夜渡客

雾从水面长出来。

林牧把篙插进水里。

「渡么？」

他没有回答。

第二章 长夜

林牧把船停在水面中央，抬头看着雾里那一盏忽明忽暗的灯，心里想着父亲当年离开时的样子，很久都没有说话，也没有回头，只是把篙横在船头，任水流一点一点把船推向岸边。

他没有动。
`

await page.evaluate(
  async ({ dir, text }) => window.studio.importText({ dir, text, title: '文风样本' }),
  { dir: bookDir, text },
)

// 用应用自身的指标计算生成基线：先读第一章正文，再让 style.drift 返回它的 current
const baseline = await page.evaluate(
  async ({ dir }) => {
    const book = await window.studio.openBook(dir)
    if (!book.ok) throw new Error('openBook failed')
    const chapter = book.data.chapters[0]
    const file = await window.studio.readFile({ dir, path: chapter.path })
    if (!file.ok) throw new Error('readFile failed')
    const drift = await window.studio.style.drift({
      dir,
      path: chapter.path,
      content: file.data.content,
    })
    if (!drift.ok) throw new Error('drift failed')
    return drift.data.current
  },
  { dir: bookDir },
)

const fingerprint = `# 文风指纹

## 量化指标

| 指标 | 值 |
|---|---|
| 统计章节 | 2 章 |
| 正文字数（不含空白） | ${baseline.totalChars} 字 |
| 平均句长 | ${baseline.avgSentenceChars} 字 |
| 平均段长 | ${baseline.avgParagraphChars} 字 |
| 对话占比 | ${baseline.dialogueRatio}% |
| 每 100 字标点数 | ${baseline.punctuationPer100} |
| 人称倾向 | 第三人称 |
| 高频意象 / 用词 | 雾、渡 |
`
await page.evaluate(
  async ({ dir, content }) => window.studio.saveFile({ dir, path: 'style_fingerprint.md', content }),
  { dir: bookDir, content: fingerprint },
)

// 回书架再打开，让快照里带上知识文件
await page.click('.topbar button:has-text("书架")')
await page.waitForTimeout(800)
await page.click('.book-card:has-text("文风测试书")')
await page.waitForTimeout(1200)

const chapterItems = page.locator('.sidebar .tree-item')
await chapterItems.nth(0).click()
await page.waitForTimeout(1600)
const fitPill = await page.locator('.drift-pill').count()

await chapterItems.nth(1).click()
await page.waitForTimeout(1600)
const driftPill = await page.locator('.drift-pill').count()
const driftText = ((await page.locator('.drift-pill').first().textContent().catch(() => '')) ?? '').trim()
await page.screenshot({ path: path.join(shots, '55-style-drift.png') })

if (driftPill > 0) {
  await page.locator('.drift-pill').first().click()
  await page.waitForTimeout(600)
}
const modalVisible = await page.locator('.drift-modal').count()
const driftRows = await page.locator('.drift-row').count()
await page.screenshot({ path: path.join(shots, '56-style-drift-detail.png') })
if (modalVisible > 0) {
  await page.click('.drift-modal button:has-text("知道了")')
  await page.waitForTimeout(300)
}

const result = {
  baseline,
  fitChapterWarnings: fitPill,
  driftChapterPill: driftPill,
  driftText,
  modalVisible: modalVisible > 0,
  driftRows,
}
console.log(JSON.stringify(result, null, 2))

const closed = await Promise.race([
  app.close().then(() => 'closed'),
  new Promise((resolve) => setTimeout(() => resolve('timeout'), 15_000)),
])

if (fitPill !== 0 || driftPill < 1 || !modalVisible || driftRows < 1) process.exit(1)

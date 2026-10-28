/**
 * 导出端到端（不花钱）：
 * 建书 → 导入 3 章 → 打开导出弹窗 → 直接调用 IPC 导出 Markdown/TXT/EPUB → 校验文件与 EPUB 结构。
 */
import { _electron as electron } from 'playwright'
import AdmZip from 'adm-zip'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const projectRoot = path.resolve(__dirname, '..')
const runId = Date.now().toString(36)
const home = path.join(projectRoot, '..', '.tmp', `export-home-${runId}`)
const userData = path.join(projectRoot, '..', '.tmp', `export-userdata-${runId}`)
const shots = path.join(projectRoot, '.runtime', 'shots')
const outDir = path.join(projectRoot, '..', '.tmp', `export-out-${runId}`)
fs.mkdirSync(home, { recursive: true })
fs.mkdirSync(userData, { recursive: true })
fs.mkdirSync(shots, { recursive: true })
fs.mkdirSync(outDir, { recursive: true })

const env = {
  ...process.env,
  NOVEL_STUDIO_HOME: home,
  NOVEL_STUDIO_USER_DATA: userData,
  NOVEL_STUDIO_SKIP_LOCAL_ENV: '1',
}
delete env.ELECTRON_RUN_AS_NODE

const app = await electron.launch({ args: ['.'], cwd: projectRoot, env })
const page = await app.firstWindow()
await page.waitForLoadState('domcontentloaded')
await page.waitForTimeout(1200)

await page.fill('input[placeholder*="书名"]', '导出测试书')
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
      text: `第一章 雾夜渡客\n\n雾从水面长出来。林牧把篙插进水里。\n\n第二章 七日之限\n\n镇渊司的封条贴在船头。\n\n第三章 听潮阁来信\n\n青衫人把一封信放在桌上。\n`,
      title: '导出样本',
    }),
  { dir: bookDir },
)
await page.waitForTimeout(800)
await page.click('.topbar button:has-text("书架")')
await page.waitForTimeout(600)
await page.click('.book-card:has-text("导出测试书")')
await page.waitForTimeout(1200)

await page.click('.topbar button:has-text("导出")')
await page.waitForSelector('.export-modal')
await page.waitForTimeout(400)
const formatCount = await page.locator('.export-format').count()
await page.screenshot({ path: path.join(shots, '69-export-modal.png') })
await page.keyboard.press('Escape')
await page.waitForTimeout(300)

const formats = [
  ['md', 'book.md'],
  ['txt', 'book.txt'],
  ['epub', 'book.epub'],
]
const reports = {}
for (const [format, name] of formats) {
  reports[format] = await page.evaluate(
    async ({ dir, format, filePath }) => window.studio.exportBook({ dir, format, filePath }),
    { dir: bookDir, format, filePath: path.join(outDir, name) },
  )
}

const mdPath = path.join(outDir, 'book.md')
const txtPath = path.join(outDir, 'book.txt')
const epubPath = path.join(outDir, 'book.epub')
const md = fs.existsSync(mdPath) ? fs.readFileSync(mdPath, 'utf8') : ''
const txt = fs.existsSync(txtPath) ? fs.readFileSync(txtPath, 'utf8') : ''
const epubSize = fs.existsSync(epubPath) ? fs.statSync(epubPath).size : 0
const zip = epubSize > 0 ? new AdmZip(epubPath) : null
const entries = zip ? zip.getEntries() : []
const opf = zip?.getEntry('OEBPS/content.opf')?.getData().toString('utf8') ?? ''

const result = {
  formatCount,
  mdOk: Boolean(reports.md?.ok) && md.includes('雾从水面长出来') && md.includes('第 3 章'),
  txtOk: Boolean(reports.txt?.ok) && txt.includes('雾从水面长出来') && !txt.includes('**'),
  epubOk: Boolean(reports.epub?.ok) && epubSize > 0,
  epubEntries: entries.length,
  mimetypeFirst: entries[0]?.entryName === 'mimetype',
  mimetypeStored: entries[0]?.header.method === 0,
  epubHasOpf: opf.includes('<dc:title>导出测试书</dc:title>'),
  chapterXhtml: entries.filter((entry) => entry.entryName.includes('chapter-')).length,
}
console.log(JSON.stringify(result, null, 2))

await Promise.race([
  app.close().then(() => 'closed'),
  new Promise((resolve) => setTimeout(() => resolve('timeout'), 15_000)),
])

if (
  formatCount !== 3 ||
  !result.mdOk ||
  !result.txtOk ||
  !result.epubOk ||
  !result.mimetypeFirst ||
  !result.mimetypeStored ||
  !result.epubHasOpf ||
  result.chapterXhtml !== 3
) {
  process.exit(1)
}

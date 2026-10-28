/**
 * 一致性检查端到端（真实模型，低成本）：
 * 建书 + 写入带明显矛盾的章节/人物卡 → 打开一致性检查 → 等待报告 → 校验报告文件与 UI。
 * 不进入 CI（需要 API Key）。
 */
import { _electron as electron } from 'playwright'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const projectRoot = path.resolve(__dirname, '..')

function envKey() {
  if (process.env.DEEPSEEK_API_KEY) return process.env.DEEPSEEK_API_KEY
  const file = path.join(projectRoot, '.env.local')
  if (!fs.existsSync(file)) return ''
  const match = fs.readFileSync(file, 'utf8').match(/^\s*DEEPSEEK_API_KEY\s*=\s*(.+)$/m)
  return match ? match[1].trim() : ''
}

const key = envKey()
if (!key) {
  console.log('SKIP: 没有 DEEPSEEK_API_KEY')
  process.exit(0)
}

const runId = Date.now().toString(36)
const home = path.join(projectRoot, '..', '.tmp', `review-home-${runId}`)
const userData = path.join(projectRoot, '..', '.tmp', `review-userdata-${runId}`)
const shots = path.join(projectRoot, '.runtime', 'shots')
fs.mkdirSync(home, { recursive: true })
fs.mkdirSync(userData, { recursive: true })
fs.mkdirSync(shots, { recursive: true })

const env = {
  ...process.env,
  NOVEL_STUDIO_HOME: home,
  NOVEL_STUDIO_USER_DATA: userData,
  DEEPSEEK_API_KEY: key,
}
delete env.ELECTRON_RUN_AS_NODE
delete env.NOVEL_STUDIO_SKIP_LOCAL_ENV

const app = await electron.launch({ args: ['.'], cwd: projectRoot, env })
const page = await app.firstWindow()
page.on('dialog', (dialog) => void dialog.accept())
await page.waitForLoadState('domcontentloaded')
await page.waitForTimeout(1200)

await page.fill('input[placeholder*="书名"]', '一致性检查测试')
await page.click('button:has-text("新建书")')
await page.waitForTimeout(1200)

const bookDir = fs
  .readdirSync(home, { withFileTypes: true })
  .filter((entry) => entry.isDirectory())
  .map((entry) => path.join(home, entry.name))
  .find((dir) => fs.existsSync(path.join(dir, 'book.json')))

fs.writeFileSync(
  path.join(bookDir, 'chapters', '0001_第1章.md'),
  '# 第 1 章\n\n林牧今年二十五岁，是雾海渡口最年轻的渡人。\n\n他随身的铜哨是父亲留下的。\n',
  'utf8',
)
fs.writeFileSync(
  path.join(bookDir, 'chapters', '0002_第2章.md'),
  '# 第 2 章\n\n三个月后，林牧刚满二十岁，铜哨在渡船失事时丢了。\n',
  'utf8',
)
fs.writeFileSync(
  path.join(bookDir, 'characters.md'),
  '# 人物卡\n\n## 林牧\n\n- 年龄：二十岁\n- 随身物：父亲留下的铜哨\n',
  'utf8',
)

await page.click('.topbar button:has-text("书架")')
await page.waitForTimeout(600)
await page.click('.book-card:has-text("一致性检查测试")')
await page.waitForTimeout(1200)

await page.click('.topbar button:has-text("一致性")')
await page.waitForSelector('.review-modal')
await page.click('.review-modal button:has-text("开始检查")')
await page.waitForSelector('.review-summary', { timeout: 180_000 })
await page.waitForTimeout(800)
const summary = (await page.locator('.review-summary').innerText()).replace(/\s+/g, ' ')
const issueCount = await page.locator('.review-issue').count()
const pathText = (await page.locator('.review-report-path').innerText().catch(() => '')) || ''
await page.screenshot({ path: path.join(shots, '76-review-report.png') })

const reportDir = path.join(bookDir, '.studio', 'reviews')
const reportFiles = fs.existsSync(reportDir) ? fs.readdirSync(reportDir) : []
const reportText = reportFiles.length > 0 ? fs.readFileSync(path.join(reportDir, reportFiles[0]), 'utf8') : ''
const result = { summary, issueCount, reportPath: pathText.trim(), reportFiles: reportFiles.length, reportHasHeader: reportText.includes('一致性检查报告') }
console.log(JSON.stringify(result, null, 2))

await Promise.race([
  app.close().then(() => 'closed'),
  new Promise((resolve) => setTimeout(resolve, 15_000)),
])
if (!result.summary || reportFiles.length === 0 || !result.reportHasHeader) process.exit(1)

/**
 * 预算 80% 预警 UI 验证（不消耗模型 token）：
 * 预先写入一份「已花费 $0.45 / 预算 $0.50」的会话，打开书 → 助手，
 * 断言出现 90% 预警横幅、点「调高预算」能打开配置弹窗。
 */
import { _electron as electron } from 'playwright'
import path from 'node:path'
import fs from 'node:fs'
import { fileURLToPath } from 'node:url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const projectRoot = path.resolve(__dirname, '..')
const runId = Date.now().toString(36)
const home = path.join(projectRoot, '..', '.tmp', `bw-home-${runId}`)
const userData = path.join(projectRoot, '..', '.tmp', `bw-userdata-${runId}`)
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

await page.fill('input[placeholder*="书名"]', '预算测试书')
await page.click('button:has-text("新建书")')
await page.waitForTimeout(1200)

const bookDir = fs
  .readdirSync(home, { withFileTypes: true })
  .filter((entry) => entry.isDirectory())
  .map((entry) => path.join(home, entry.name))
  .find((dir) => fs.existsSync(path.join(dir, 'book.json')))
if (!bookDir) throw new Error('book dir not found')

// 伪造一份已花费 0.45 / 0.50（90%）的会话
const sessionDir = path.join(bookDir, '.studio', 'agent')
fs.mkdirSync(sessionDir, { recursive: true })
fs.writeFileSync(
  path.join(sessionDir, 'session.json'),
  JSON.stringify(
    {
      version: 1,
      updatedAt: new Date().toISOString(),
      messages: [
        { role: 'system', content: '系统提示' },
        {
          role: 'user',
          content: [{ type: 'text', text: '继续写下一章' }],
          timestamp: Date.now() - 60_000,
        },
        {
          role: 'assistant',
          content: [{ type: 'text', text: '好的，我先读一下上下文。' }],
          timestamp: Date.now() - 30_000,
        },
      ],
      cost: 0.45,
      chapterCosts: {},
    },
    null,
    2,
  ),
  'utf8',
)

// 回书架再打开，让快照与 Agent 会话重新加载
await page.click('.topbar button:has-text("书架")')
await page.waitForTimeout(800)
await page.click('.book-card:has-text("预算测试书")')
await page.waitForTimeout(1000)
await page.click('button.tab:has-text("助手")')

await page.waitForSelector('.assistant__budgetwarn', { timeout: 20_000 })
const warnText = ((await page.locator('.assistant__budgetwarn').textContent()) ?? '').trim()
await page.screenshot({ path: path.join(shots, '54-budget-warning.png') })

// 「调高预算」应能打开本机配置
await page.click('.assistant__budgetwarn button:has-text("调高预算")')
await page.waitForTimeout(800)
const settingsOpened = await page.locator('.settings-modal').count()
await page.click('button[aria-label="关闭"]')
await page.waitForTimeout(300)

const result = {
  warnVisible: warnText.length > 0,
  warnText,
  settingsOpened: settingsOpened > 0,
}
console.log(JSON.stringify(result, null, 2))

const closed = await Promise.race([
  app.close().then(() => 'closed'),
  new Promise((resolve) => setTimeout(() => resolve('timeout'), 15_000)),
])

if (!result.warnVisible || !warnText.includes('90%') || !result.settingsOpened) process.exit(1)

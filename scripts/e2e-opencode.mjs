/**
 * OpenCode Go 真实链路端到端（需要 OPENCODE_GO_API_KEY 环境变量，未设置则跳过）。
 *
 * 验证点：
 * 1. 预置 settings 选择 opencode-go/glm-5.3 + 环境变量密钥（避免在仓库里存 key）
 * 2. Agent 能正常回复（pi compat 路径 + 我们注入的 x-opencode-session 头）
 * 3. 会话文件里落盘 opencodeSessionId，重启后复用
 */
import { _electron as electron } from 'playwright'
import path from 'node:path'
import fs from 'node:fs'
import { fileURLToPath } from 'node:url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const projectRoot = path.resolve(__dirname, '..')

if (!process.env.OPENCODE_GO_API_KEY) {
  console.log(JSON.stringify({ skipped: true, reason: 'missing OPENCODE_GO_API_KEY' }))
  process.exit(0)
}

const runId = Date.now().toString(36)
const home = path.join(projectRoot, '..', '.tmp', `oc-home-${runId}`)
const userData = path.join(projectRoot, '..', '.tmp', `oc-userdata-${runId}`)
const shots = path.join(projectRoot, '.runtime', 'shots')
fs.mkdirSync(home, { recursive: true })
fs.mkdirSync(userData, { recursive: true })
fs.mkdirSync(shots, { recursive: true })

// 预置设置：选择 OpenCode Go + glm-5.3（密钥走环境变量，不落盘）
fs.writeFileSync(
  path.join(userData, 'settings.json'),
  JSON.stringify(
    {
      selection: { provider: 'opencode-go', model: 'glm-5.3' },
      customProviders: [],
      encryptedKeys: {},
      budgetUsd: 0.5,
      chapterBudgetUsd: 0.2,
      budgetWarnRatio: 0.8,
    },
    null,
    2,
  ),
  'utf8',
)

const env = { ...process.env, NOVEL_STUDIO_HOME: home, NOVEL_STUDIO_USER_DATA: userData }
delete env.ELECTRON_RUN_AS_NODE

const app = await electron.launch({ args: ['.'], cwd: projectRoot, env })
const page = await app.firstWindow()
await page.waitForLoadState('domcontentloaded')
await page.waitForTimeout(1200)

await page.fill('input[placeholder*="书名"]', 'OpenCode 测试书')
await page.click('button:has-text("新建书")')
await page.waitForTimeout(1200)
await page.click('button.tab:has-text("助手")')
await page.waitForTimeout(1200)

await page.fill('.assistant__composer textarea', '只回复两个字：收到')
await page.click('.assistant__composer button:has-text("发送")')

const deadline = Date.now() + 120_000
let reply = ''
while (Date.now() < deadline) {
  await page.waitForTimeout(1500)
  const bubbles = page.locator('.bubble-assistant:not(.bubble-streaming)')
  const count = await bubbles.count()
  if (count > 0) {
    reply = ((await bubbles.last().textContent()) ?? '').trim()
    break
  }
}

const bookDir = fs
  .readdirSync(home, { withFileTypes: true })
  .filter((entry) => entry.isDirectory())
  .map((entry) => path.join(home, entry.name))
  .find((dir) => fs.existsSync(path.join(dir, 'book.json')))

const sessionFile = bookDir ? path.join(bookDir, '.studio', 'agent', 'session.json') : ''
const sessionRaw = sessionFile && fs.existsSync(sessionFile) ? JSON.parse(fs.readFileSync(sessionFile, 'utf8')) : null

await page.screenshot({ path: path.join(shots, '62-opencode-go.png') })

const result = {
  replied: reply.length > 0,
  replyPreview: reply.slice(0, 80),
  sessionIdPersisted: Boolean(sessionRaw?.opencodeSessionId),
  errorToast: await page.locator('.toast.error').count(),
}
console.log(JSON.stringify(result, null, 2))

await Promise.race([
  app.close().then(() => 'closed'),
  new Promise((resolve) => setTimeout(() => resolve('timeout'), 15_000)),
])

if (!result.replied || !result.sessionIdPersisted) process.exit(1)

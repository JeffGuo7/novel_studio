/**
 * 会话持久化 + 预算熔断端到端：
 * 1) 跑一轮对话 → 关掉应用 → 重开 → Agent 记忆恢复
 * 2) 把预算调到低于已花费 → 面板进入「预算已用尽」封锁态
 */
import { _electron as electron } from 'playwright'
import path from 'node:path'
import fs from 'node:fs'
import { fileURLToPath } from 'node:url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const projectRoot = path.resolve(__dirname, '..')
const runId = Date.now().toString(36)
const home = path.join(projectRoot, '..', '.tmp', `sess-home-${runId}`)
const userData = path.join(projectRoot, '..', '.tmp', `sess-userdata-${runId}`)
const shots = path.join(projectRoot, '.runtime', 'shots')
fs.mkdirSync(home, { recursive: true })
fs.mkdirSync(userData, { recursive: true })
fs.mkdirSync(shots, { recursive: true })

function envKey() {
  if (process.env.DEEPSEEK_API_KEY) return process.env.DEEPSEEK_API_KEY
  const file = path.join(projectRoot, '.env.local')
  if (!fs.existsSync(file)) return ''
  const match = fs.readFileSync(file, 'utf8').match(/^\s*DEEPSEEK_API_KEY\s*=\s*(.+)$/m)
  return match ? match[1].trim() : ''
}

const baseEnv = { ...process.env, NOVEL_STUDIO_HOME: home, NOVEL_STUDIO_USER_DATA: userData }
delete baseEnv.ELECTRON_RUN_AS_NODE
if (envKey()) baseEnv.DEEPSEEK_API_KEY = envKey()

const exeLaunch = { args: ['.'], cwd: projectRoot, env: baseEnv }

async function launch() {
  const app = await electron.launch(exeLaunch)
  const page = await app.firstWindow()
  await page.waitForLoadState('domcontentloaded')
  await page.waitForTimeout(1200)
  return { app, page }
}

function findBookDir() {
  const entry = fs
    .readdirSync(home, { withFileTypes: true })
    .filter((item) => item.isDirectory())
    .map((item) => path.join(home, item.name))
    .find((dir) => fs.existsSync(path.join(dir, 'book.json')))
  if (!entry) throw new Error('未找到书目录')
  return entry
}

// ---------- 第一次启动：建书 + 一轮对话 ----------
let { app, page } = await launch()
await page.fill('input[placeholder*="书名"]', '会话测试书')
await page.click('button:has-text("新建书")')
await page.waitForTimeout(1200)

const bookDir = findBookDir()
fs.writeFileSync(
  path.join(bookDir, 'world_model.md'),
  '# 世界模型\n\n- 北境渡口每七日一场大雾，雾里会走出不属于这个世界的东西。\n- 主角林牧是最后一代渡人，规矩：雾里有人招手，不能应。\n',
)

await page.click('button.tab:has-text("助手")')
await page.waitForTimeout(1200)
await page.fill('.assistant__composer textarea', '用一句话概括这个世界的核心冲突。不要写文件。')
await page.click('.assistant__composer button:has-text("发送")')

const sessionFile = path.join(bookDir, '.studio', 'agent', 'session.json')
const deadline = Date.now() + 180_000
let firstOk = false
while (Date.now() < deadline) {
  await page.waitForTimeout(2000)
  const streaming = await page.locator('.bubble-streaming').count()
  const bubbles = await page.locator('.bubble-assistant').count()
  if (bubbles > 0 && streaming === 0) {
    firstOk = true
    break
  }
}
await page.waitForTimeout(2500)
const sessionExists = fs.existsSync(sessionFile)
const sessionRaw = sessionExists ? JSON.parse(fs.readFileSync(sessionFile, 'utf8')) : null
await page.screenshot({ path: path.join(shots, '30-session-first-run.png') })
await app.close()

// ---------- 第二次启动：记忆恢复 ----------
;({ app, page } = await launch())
await page.click('.book-card:has-text("会话测试书")')
await page.waitForTimeout(1200)
await page.click('button.tab:has-text("助手")')
await page.waitForTimeout(2000)

const restoredNote = await page.locator('.assistant__note').first().textContent().catch(() => null)
const restoredVisible = Boolean(restoredNote && restoredNote.includes('已恢复'))
await page.screenshot({ path: path.join(shots, '31-session-restored.png') })

// 把预算调到低于已花费 → 触发封锁
await page.click('button:has-text("配置")')
await page.waitForTimeout(800)
const budgetInput = page.locator('.settings-row:has-text("会话预算") input')
await budgetInput.fill('0.0001')
await page.click('.settings-actions button:has-text("保存")')
await page.waitForTimeout(2500)
const blockedVisible = (await page.locator('.assistant__blocked').count()) > 0
const textareaDisabled = await page.locator('.assistant__composer textarea').isDisabled()
await page.screenshot({ path: path.join(shots, '32-session-budget-blocked.png') })
await app.close()

const result = {
  firstTurnFinished: firstOk,
  sessionFileExists: sessionExists,
  sessionMessages: sessionRaw?.messages?.length ?? 0,
  sessionCost: sessionRaw?.cost ?? 0,
  restoredVisible,
  restoredNote,
  blockedVisible,
  textareaDisabled,
}
console.log(JSON.stringify(result, null, 2))
if (!firstOk || !sessionExists || !restoredVisible || !blockedVisible) process.exit(1)

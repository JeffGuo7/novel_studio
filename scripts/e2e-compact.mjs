/**
 * /compact 端到端（真实模型，一次摘要调用）：
 * 预置一段长对话 → 打开助手 → 点「压缩」→ 校验摘要落盘、UI 提示、token 下降。
 */
import { _electron as electron } from 'playwright'
import path from 'node:path'
import fs from 'node:fs'
import { fileURLToPath } from 'node:url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const projectRoot = path.resolve(__dirname, '..')
const runId = Date.now().toString(36)
const home = path.join(projectRoot, '..', '.tmp', `cp-home-${runId}`)
const userData = path.join(projectRoot, '..', '.tmp', `cp-userdata-${runId}`)
const shots = path.join(projectRoot, '.runtime', 'shots')
fs.mkdirSync(home, { recursive: true })
fs.mkdirSync(userData, { recursive: true })
fs.mkdirSync(shots, { recursive: true })

const env = { ...process.env, NOVEL_STUDIO_HOME: home, NOVEL_STUDIO_USER_DATA: userData }
delete env.ELECTRON_RUN_AS_NODE
const keyFile = path.join(projectRoot, '.env.local')
if (fs.existsSync(keyFile)) {
  const match = fs.readFileSync(keyFile, 'utf8').match(/^\s*DEEPSEEK_API_KEY\s*=\s*(.+)$/m)
  if (match) env.DEEPSEEK_API_KEY = match[1].trim()
}

const app = await electron.launch({ args: ['.'], cwd: projectRoot, env })
const page = await app.firstWindow()
await page.waitForLoadState('domcontentloaded')
await page.waitForTimeout(1200)

await page.fill('input[placeholder*="书名"]', '压缩测试书')
await page.click('button:has-text("新建书")')
await page.waitForTimeout(1200)

const bookDir = fs
  .readdirSync(home, { withFileTypes: true })
  .filter((entry) => entry.isDirectory())
  .map((entry) => path.join(home, entry.name))
  .find((dir) => fs.existsSync(path.join(dir, 'book.json')))
if (!bookDir) throw new Error('book dir not found')

// 预置 80 条历史（约 2 万 token 级），确保有足够旧消息可压缩
const filler = '雾从水面升起来，林牧把船撑离岸边，远处的灯影在水里晃了一下。'.repeat(4)
const messages = []
for (let round = 0; round < 40; round += 1) {
  messages.push({
    role: 'user',
    content: [{ type: 'text', text: `第 ${round + 1} 轮：继续写，主角林牧，不要写心理独白。${filler}` }],
    timestamp: Date.now() - (80 - round * 2) * 60_000,
  })
  messages.push({
    role: 'assistant',
    content: [{ type: 'text', text: `第 ${round + 1} 轮收到，我会按你的要求写，并保持短句。${filler}` }],
    timestamp: Date.now() - (79 - round * 2) * 60_000,
  })
}
const sessionDir = path.join(bookDir, '.studio', 'agent')
fs.mkdirSync(sessionDir, { recursive: true })
fs.writeFileSync(
  path.join(sessionDir, 'session.json'),
  JSON.stringify({ version: 1, updatedAt: new Date().toISOString(), messages, cost: 0.001, chapterCosts: {} }, null, 2),
  'utf8',
)

// 回书架再打开，让 Agent Host 重新加载会话
await page.click('.topbar button:has-text("书架")')
await page.waitForTimeout(800)
await page.click('.book-card:has-text("压缩测试书")')
await page.waitForTimeout(1200)
await page.click('button.tab:has-text("助手")')
await page.waitForTimeout(2500)

await page.click('.assistant__head button:has-text("压缩")')
await page.waitForTimeout(1500)

let note = ''
const deadline = Date.now() + 120_000
while (Date.now() < deadline) {
  await page.waitForTimeout(1000)
  const notes = page.locator('.assistant__note')
  const count = await notes.count()
  for (let index = 0; index < count; index += 1) {
    const text = (await notes.nth(index).textContent()) ?? ''
    if (text.includes('已压缩')) {
      note = text.trim()
      break
    }
  }
  if (note) break
}
await page.screenshot({ path: path.join(shots, '63-compact.png') })

// 压缩后再发一条，验证 transformContext 用摘要替换旧消息后模型仍能正常对话
const assistantBubblesBefore = await page.locator('.bubble-assistant:not(.bubble-streaming)').count()
await page.fill('.assistant__composer textarea', '只回复一个字：好')
await page.click('.assistant__composer button:has-text("发送")')
const replyDeadline = Date.now() + 90_000
let replied = false
while (Date.now() < replyDeadline) {
  await page.waitForTimeout(1500)
  if ((await page.locator('.bubble-assistant:not(.bubble-streaming)').count()) > assistantBubblesBefore) {
    replied = true
    break
  }
}

const errorToast = ((await page.locator('.toast.error').first().textContent().catch(() => '')) ?? '').trim()
const sessionAfter = JSON.parse(fs.readFileSync(path.join(sessionDir, 'session.json'), 'utf8'))
const result = {
  note,
  errorToast,
  repliedAfterCompaction: replied,
  compactionSaved: Boolean(sessionAfter.compaction?.summary),
  coveredMessages: sessionAfter.compaction?.coveredMessages ?? 0,
  summaryChars: sessionAfter.compaction?.summary?.length ?? 0,
}
console.log(JSON.stringify(result, null, 2))

const closed = await Promise.race([
  app.close().then(() => 'closed'),
  new Promise((resolve) => setTimeout(() => resolve('timeout'), 15_000)),
])

if (!note || !result.compactionSaved || result.coveredMessages <= 0 || !result.repliedAfterCompaction) {
  process.exit(1)
}

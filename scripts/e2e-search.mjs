/**
 * 剧情检索端到端（真实模型）：
 * 导入 12 章 → 让 Agent 回答「第 7 章里林牧在听潮阁遇见了谁？」
 * → 它应当调用 search_story 检索并回答。
 */
import { _electron as electron } from 'playwright'
import path from 'node:path'
import fs from 'node:fs'
import { fileURLToPath } from 'node:url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const projectRoot = path.resolve(__dirname, '..')
const runId = Date.now().toString(36)
const home = path.join(projectRoot, '..', '.tmp', `search-e2e-home-${runId}`)
const userData = path.join(projectRoot, '..', '.tmp', `search-e2e-userdata-${runId}`)
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

// 12 章，第 7 章埋一个只有检索才能答对的事实
const names = ['雾夜渡客', '七日之限', '听潮阁来信', '雾里的名字', '渡籍', '长夜', '听潮阁之约', '青袍人', '封条', '渡口', '旧信', '灯影']
const text = names
  .map((title, index) => {
    const number = index + 1
    const filler = `这是第 ${number} 章的正文内容，林牧在渡口处理日常事务，天气阴沉，水面上有雾。`
    const special =
      number === 7
        ? '林牧在听潮阁遇见了阿九，阿九交给他一枚刻着“归”字的铜哨。'
        : number === 3
          ? '青衫人送来一封信，信来自听潮阁。'
          : ''
    return `第${number}章 ${title}\n\n${filler}${special}`
  })
  .join('\n\n')

const app = await electron.launch({ args: ['.'], cwd: projectRoot, env })
const page = await app.firstWindow()
await page.waitForLoadState('domcontentloaded')
await page.waitForTimeout(1200)

await page.fill('input[placeholder*="书名"]', '检索测试书')
await page.click('button:has-text("新建书")')
await page.waitForTimeout(1200)

const bookDir = fs
  .readdirSync(home, { withFileTypes: true })
  .filter((entry) => entry.isDirectory())
  .map((entry) => path.join(home, entry.name))
  .find((dir) => fs.existsSync(path.join(dir, 'book.json')))
if (!bookDir) throw new Error('book dir not found')

await page.evaluate(
  async ({ dir, text }) => window.studio.importText({ dir, text, title: '检索样本' }),
  { dir: bookDir, text },
)
await page.waitForTimeout(800)

// 回书架再打开，刷新章节快照
await page.click('.topbar button:has-text("书架")')
await page.waitForTimeout(600)
await page.click('.book-card:has-text("检索测试书")')
await page.waitForTimeout(1200)
await page.click('button.tab:has-text("助手")')
await page.waitForTimeout(1500)

await page.fill(
  '.assistant__composer textarea',
  '只做一个动作：调用 search_story 工具，query 填「铜哨」，limit 5。然后把返回结果里和第 7 章有关的原文片段贴给我。不要读章节，不要写文件，不要反问。',
)
await page.click('.assistant__composer button:has-text("发送")')

// 等 Agent 真正跑完（停止按钮消失 + 状态回到就绪），避免在落盘前读 session
const deadline = Date.now() + 180_000
let idle = false
while (Date.now() < deadline) {
  await page.waitForTimeout(1500)
  const stopButtons = await page.locator('.assistant__head button:has-text("停止")').count()
  if (stopButtons === 0) {
    idle = true
    break
  }
}
await page.waitForTimeout(2000)

const bubbles = page.locator('.bubble-assistant:not(.bubble-streaming)')
const reply = ((await bubbles.last().textContent().catch(() => '')) ?? '').trim()
const toolTraces = await page.locator('.tool-trace').allTextContents()
const searchTrace = toolTraces.find((text) => text.includes('检索')) ?? ''
await page.screenshot({ path: path.join(shots, '64-search-story.png') })

const sessionFile = path.join(bookDir, '.studio', 'agent', 'session.json')
const sessionRaw = fs.existsSync(sessionFile)
  ? JSON.parse(fs.readFileSync(sessionFile, 'utf8'))
  : { messages: [] }
const toolNames = (sessionRaw.messages ?? [])
  .flatMap((message) => (Array.isArray(message.content) ? message.content : []))
  .filter((block) => block?.type === 'toolCall')
  .map((block) => block.name)

const result = {
  idle,
  replied: reply.length > 0,
  replyPreview: reply.slice(0, 120),
  searchTrace,
  usedSearchStory: toolNames.includes('search_story'),
  toolNames,
}
console.log(JSON.stringify(result, null, 2))

await Promise.race([
  app.close().then(() => 'closed'),
  new Promise((resolve) => setTimeout(() => resolve('timeout'), 15_000)),
])

const usedSearch = result.usedSearchStory || Boolean(result.searchTrace)
if (!result.replied || !usedSearch) process.exit(1)

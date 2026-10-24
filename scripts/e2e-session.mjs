/**
 * 端到端：会话持久化 + 历史渲染 + 单章预算熔断
 * 1) 建书 → 新建章节 → 让 Agent 在该章里回答一句 → 关应用
 * 2) 重开：历史对话气泡恢复、session.json 里有单章成本
 * 3) 把单章预算调到低于已花费 → 该章进入封锁态
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

const log = (...args) => console.log('[e2e]', ...args)

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

async function launch() {
  const app = await electron.launch({ args: ['.'], cwd: projectRoot, env: baseEnv })
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

/** 先等 Agent 真正开工（thinking/tool/流式），再等它收工，避免发送瞬间空窗导致误判 */
async function waitForReply(page, timeoutMs = 180_000) {
  const deadline = Date.now() + timeoutMs
  let sawActive = false
  while (Date.now() < deadline) {
    await page.waitForTimeout(1000)
    const active =
      (await page.locator('.dot-thinking').count()) > 0 ||
      (await page.locator('.dot-tool').count()) > 0 ||
      (await page.locator('.bubble-streaming').count()) > 0
    if (active) sawActive = true
    if (sawActive && !active) return true
  }
  return false
}

async function closeApp(app) {
  try {
    await Promise.race([app.close(), new Promise((resolve) => setTimeout(resolve, 15_000))])
  } catch {
    // 忽略关闭异常
  }
}

// ---------- 第一次启动 ----------
let { app, page } = await launch()
await page.fill('input[placeholder*="书名"]', '会话测试书')
await page.click('button:has-text("新建书")')
await page.waitForTimeout(1200)
log('book created')

const bookDir = findBookDir()
fs.writeFileSync(
  path.join(bookDir, 'world_model.md'),
  '# 世界模型\n\n- 北境渡口每七日一场大雾，雾里会走出不属于这个世界的东西。\n- 主角林牧是最后一代渡人，规矩：雾里有人招手，不能应。\n',
)

await page.click('button:has-text("新建章节")')
await page.waitForTimeout(1000)
await page.click('button.tab:has-text("助手")')
await page.waitForTimeout(1200)
const chapterPill = (await page.locator('.assistant__head .pill').allTextContents()).join(' ')
log('chapter pill:', chapterPill)

await page.fill('.assistant__composer textarea', '用一句话概括这个世界的核心冲突。不要写文件。')
await page.click('.assistant__composer button:has-text("发送")')
log('prompt sent')
const replied = await waitForReply(page)
log('replied:', replied)
await page.waitForTimeout(2500)
await page.screenshot({ path: path.join(shots, '30-session-first-run.png') })
await closeApp(app)
log('first app closed')

const sessionFile = path.join(bookDir, '.studio', 'agent', 'session.json')
const sessionRaw = fs.existsSync(sessionFile) ? JSON.parse(fs.readFileSync(sessionFile, 'utf8')) : null
const chapterCost = sessionRaw?.chapterCosts?.['0001'] ?? 0
log('session messages:', sessionRaw?.messages?.length ?? 0, '| chapter cost:', chapterCost)

// ---------- 第二次启动 ----------
;({ app, page } = await launch())
await page.click('.book-card:has-text("会话测试书")')
await page.waitForTimeout(1200)
await page.click('button.tab:has-text("助手")')
await page.waitForTimeout(2500)

const historyBubbles =
  (await page.locator('.bubble-user').count()) + (await page.locator('.bubble-assistant').count())
log('history bubbles:', historyBubbles)
await page.screenshot({ path: path.join(shots, '31-session-history.png') })

// 选中第 1 章（未成章），再把单章预算压到低于已花费
await page.click('.tree-item:has-text("未成章")')
await page.waitForTimeout(800)
await page.click('button:has-text("配置")')
await page.waitForTimeout(900)
await page.fill('.settings-row:has-text("单章预算") input', '0.0001')
await page.click('.settings-actions button:has-text("保存")')
await page.waitForTimeout(3000)

const blockedText = await page.locator('.assistant__blocked').first().textContent().catch(() => '')
const blockedChapterVisible = Boolean(blockedText && blockedText.includes('第 1 章'))
const textareaDisabled = await page.locator('.assistant__composer textarea').isDisabled()
await page.screenshot({ path: path.join(shots, '32-session-chapter-budget.png') })
await closeApp(app)
log('second app closed')

const result = {
  chapterPill,
  replied,
  sessionMessages: sessionRaw?.messages?.length ?? 0,
  chapterCost: Number(chapterCost.toFixed(6)),
  historyBubbles,
  blockedChapterVisible,
  blockedText: blockedText ?? '',
  textareaDisabled,
}
console.log(JSON.stringify(result, null, 2))
if (chapterCost <= 0 || historyBubbles < 2 || !blockedChapterVisible) process.exit(1)

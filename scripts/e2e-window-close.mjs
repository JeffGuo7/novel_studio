/**
 * 回归测试：Agent 推流中销毁窗口，主进程不能抛 "Object has been destroyed"。
 *
 * 复现路径：打发一条消息 → 等推流开始 → destroy 窗口（webContents 立刻销毁）
 * → 本应安静退出，不允许出现主进程未捕获异常（main-error.log 里不能有该错误）。
 *
 * 成本：一次很小的 deepseek-flash 调用。
 */
import { _electron as electron } from 'playwright'
import path from 'node:path'
import fs from 'node:fs'
import { fileURLToPath } from 'node:url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const projectRoot = path.resolve(__dirname, '..')
const runId = Date.now().toString(36)
const home = path.join(projectRoot, '..', '.tmp', `wc-home-${runId}`)
const userData = path.join(projectRoot, '..', '.tmp', `wc-userdata-${runId}`)
fs.mkdirSync(home, { recursive: true })
fs.mkdirSync(userData, { recursive: true })

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

await page.fill('input[placeholder*="书名"]', '关窗测试')
await page.click('button:has-text("新建书")')
await page.waitForTimeout(1200)

await page.click('button.tab:has-text("助手")')
await page.waitForTimeout(1200)
await page.fill('.assistant__composer textarea', '写一段 300 字左右的小说开头，关于雾里的渡船。')
await page.click('.assistant__composer button:has-text("发送")')

// 等推流真正开始，再多等一会儿，让增量事件持续（这才是关窗时暴露竞态的时机）
let streaming = false
const deadline = Date.now() + 60_000
while (Date.now() < deadline) {
  await page.waitForTimeout(300)
  if ((await page.locator('.bubble-streaming').count()) > 0) {
    streaming = true
    break
  }
}
await page.waitForTimeout(1500)

// 模拟用户点窗口关闭按钮：此时 webContents 销毁，但 Agent 子进程可能还在推流
await app.evaluate(({ BrowserWindow }) => {
  const win = BrowserWindow.getAllWindows()[0]
  if (win) win.close()
})

// 等待应用自行退出
await Promise.race([
  app.waitForEvent('close').then(() => true),
  new Promise((resolve) => setTimeout(() => resolve(false), 12_000)),
])

await new Promise((resolve) => setTimeout(resolve, 800))
if (!closed) {
  try {
    await app.close()
  } catch {
    // 已经退出
  }
}

const errorLog = path.join(userData, 'main-error.log')
const logText = fs.existsSync(errorLog) ? fs.readFileSync(errorLog, 'utf8') : ''
const hasDestroyedError = logText.includes('Object has been destroyed')
const hasAnyError = logText.trim().length > 0

const result = {
  streamingStarted: streaming,
  appExited: closed,
  errorLogExists: fs.existsSync(errorLog),
  hasDestroyedError,
  hasAnyError,
  logHead: logText.trim().split('\n').slice(0, 4).join(' | '),
}
console.log(JSON.stringify(result, null, 2))

if (!streaming || !closed || hasDestroyedError) process.exit(1)

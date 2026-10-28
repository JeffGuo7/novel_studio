/**
 * 真实模型连接测试（花钱极少：约 8 token）：
 * 打开设置 → 填代理 → 点「测试连接」→ 断言成功，并检查延迟。
 * 需要 .env.local 里的 DEEPSEEK_API_KEY 或环境变量；不进入 CI。
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
const home = path.join(projectRoot, '..', '.tmp', `conn-home-${runId}`)
const userData = path.join(projectRoot, '..', '.tmp', `conn-userdata-${runId}`)
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

await page.click('button:has-text("本机配置")')
await page.waitForSelector('.settings-modal')
await page.waitForTimeout(600)
const proxy = process.env.TEST_PROXY ?? 'http://127.0.0.1:7890'
await page.fill('.settings-proxy-input', proxy)
await page.click('.settings-test-btn')
await page.waitForSelector('.settings-test-result', { timeout: 45_000 })
await page.waitForTimeout(500)
const text = ((await page.locator('.settings-test-result').innerText()) ?? '').trim()
const ok = await page.locator('.settings-test-result.is-ok').count()
await page.screenshot({ path: path.join(shots, '75-connection-test.png') })
console.log(JSON.stringify({ proxy, text, success: ok > 0 }, null, 2))

await Promise.race([
  app.close().then(() => 'closed'),
  new Promise((resolve) => setTimeout(() => resolve('timeout'), 15_000)),
])
if (ok === 0) process.exit(1)

/**
 * 写作模式端到端（不花钱、不联网）：
 * 建书 → 打开助手 → 选择「润色」→ 校验激活态与说明 → 刷新后 localStorage 仍记住模式。
 */
import { _electron as electron } from 'playwright'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const projectRoot = path.resolve(__dirname, '..')
const runId = Date.now().toString(36)
const home = path.join(projectRoot, '..', '.tmp', `modes-home-${runId}`)
const userData = path.join(projectRoot, '..', '.tmp', `modes-userdata-${runId}`)
const shots = path.join(projectRoot, '.runtime', 'shots')
fs.mkdirSync(home, { recursive: true })
fs.mkdirSync(userData, { recursive: true })
fs.mkdirSync(shots, { recursive: true })

const env = {
  ...process.env,
  NOVEL_STUDIO_HOME: home,
  NOVEL_STUDIO_USER_DATA: userData,
  NOVEL_STUDIO_SKIP_LOCAL_ENV: '1',
}
delete env.ELECTRON_RUN_AS_NODE

const app = await electron.launch({ args: ['.'], cwd: projectRoot, env })
const page = await app.firstWindow()
page.on('dialog', (dialog) => void dialog.accept())
await page.waitForLoadState('domcontentloaded')
await page.waitForTimeout(1200)

await page.fill('.shelf__create input:first-child', '模式测试书')
await page.click('button:has-text("新建书")')
await page.waitForTimeout(1400)
await page.click('.tab:has-text("助手")')
await page.waitForTimeout(2200)

const modeCount = await page.locator('.assistant__mode').count()
await page.click('.assistant__mode:has-text("润色")')
await page.waitForTimeout(400)
const activeLabel = (await page.locator('.assistant__mode.is-active').innerText()).trim()
const hint = (await page.locator('.assistant__mode-hint').innerText()).trim()
await page.screenshot({ path: path.join(shots, '80-agent-modes.png') })

// 刷新 renderer，模式应从 localStorage 恢复
await page.evaluate(() => window.location.reload())
await page.waitForTimeout(1600)
await page.click('.book-card:has-text("模式测试书")')
await page.waitForTimeout(1400)
await page.click('.tab:has-text("助手")')
await page.waitForTimeout(1800)
const activeAfterReload = (await page.locator('.assistant__mode.is-active').innerText()).trim()

const result = { modeCount, activeLabel, hint, activeAfterReload }
console.log(JSON.stringify(result, null, 2))

await Promise.race([
  app.close().then(() => 'closed'),
  new Promise((resolve) => setTimeout(() => resolve('timeout'), 15_000)),
])
if (modeCount !== 5 || activeLabel !== '润色' || !hint.includes('语言表达') || activeAfterReload !== '润色') {
  process.exit(1)
}

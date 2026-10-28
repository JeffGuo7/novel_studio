/**
 * 套餐内计费展示端到端（不花钱、不联网）：
 * 预置 settings 选择 opencode-go（套餐内）→ 打开书与助手面板 → 断言显示「套餐内 · 已用 N 轮」，
 * 且不出现美元预算进度。Agent host 启动只解析模型，不会发请求。
 */
import { _electron as electron } from 'playwright'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const projectRoot = path.resolve(__dirname, '..')
const runId = Date.now().toString(36)
const home = path.join(projectRoot, '..', '.tmp', `billing-home-${runId}`)
const userData = path.join(projectRoot, '..', '.tmp', `billing-userdata-${runId}`)
const shots = path.join(projectRoot, '.runtime', 'shots')
fs.mkdirSync(home, { recursive: true })
fs.mkdirSync(userData, { recursive: true })
fs.mkdirSync(shots, { recursive: true })
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
      proxyUrl: '',
      autoBackup: false,
      autoBackupIntervalDays: 3,
      backupKeep: 5,
    },
    null,
    2,
  ),
  'utf8',
)

const env = {
  ...process.env,
  NOVEL_STUDIO_HOME: home,
  NOVEL_STUDIO_USER_DATA: userData,
  NOVEL_STUDIO_SKIP_LOCAL_ENV: '1',
}
delete env.ELECTRON_RUN_AS_NODE
delete env.OPENCODE_GO_API_KEY

const app = await electron.launch({ args: ['.'], cwd: projectRoot, env })
const page = await app.firstWindow()
page.on('dialog', (dialog) => void dialog.accept())
await page.waitForLoadState('domcontentloaded')
await page.waitForTimeout(1200)

await page.fill('.shelf__create input:first-child', '套餐计费测试')
await page.click('button:has-text("新建书")')
await page.waitForTimeout(1400)
await page.click('.tab:has-text("助手")')
await page.waitForTimeout(2600)

const footer = ((await page.locator('.assistant__composer-foot').innerText()) ?? '').replace(/\s+/g, ' ')
const modelPill = await page.locator('.assistant__head .pill').allTextContents()
const warningVisible = await page.locator('.assistant__budgetwarn').isVisible().catch(() => false)
await page.screenshot({ path: path.join(shots, '79-billing.png') })

const result = {
  footer,
  modelPill: modelPill.map((item) => item.trim()),
  subscriptionShown: footer.includes('套餐内') && footer.includes('轮'),
  noDollarBudget: !footer.includes('$'),
  warningVisible,
}
console.log(JSON.stringify(result, null, 2))

await Promise.race([
  app.close().then(() => 'closed'),
  new Promise((resolve) => setTimeout(() => resolve('timeout'), 15_000)),
])
if (!result.subscriptionShown || !result.noDollarBudget || result.warningVisible) process.exit(1)

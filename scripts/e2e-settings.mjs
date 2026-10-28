/**
 * 设置页：版本/更新检查（dev 模式）、书库备份 zip、健康检查、恢复跳过同名书。
 * 不花钱、不联网（更新检查在 dev 模式直接返回）。
 */
import { _electron as electron } from 'playwright'
import path from 'node:path'
import fs from 'node:fs'
import AdmZip from 'adm-zip'
import { fileURLToPath } from 'node:url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const projectRoot = path.resolve(__dirname, '..')
const runId = Date.now().toString(36)
const home = path.join(projectRoot, '..', '.tmp', `set-home-${runId}`)
const userData = path.join(projectRoot, '..', '.tmp', `set-userdata-${runId}`)
const shots = path.join(projectRoot, '.runtime', 'shots')
const zipFile = path.join(projectRoot, '..', '.tmp', `settings-backup-${runId}.zip`)
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
await page.waitForLoadState('domcontentloaded')
await page.waitForTimeout(1200)

await page.fill('input[placeholder*="书名"]', '备份 UI 测试书')
await page.click('button:has-text("新建书")')
await page.waitForTimeout(1200)

const bookDir = fs
  .readdirSync(home, { withFileTypes: true })
  .filter((entry) => entry.isDirectory())
  .map((entry) => path.join(home, entry.name))
  .find((dir) => fs.existsSync(path.join(dir, 'book.json')))
if (!bookDir) throw new Error('book dir not found')

const title = path.basename(bookDir).replace(/_[0-9a-f]+$/, '')
const zipReport = await page.evaluate(
  async ({ zipFile }) => window.studio.backup.export({ filePath: zipFile }),
  { zipFile },
)
const health = await page.evaluate(async () => window.studio.backup.health())
const update = await page.evaluate(async () => window.studio.update.check())
const restore = await page.evaluate(
  async ({ zipFile }) => window.studio.backup.restore({ filePath: zipFile }),
  { zipFile },
)
const zipEntries = new AdmZip(zipFile).getEntries().length

await page.click('.topbar button:has-text("配置")')
await page.waitForTimeout(800)
const sectionTitles = await page.locator('.settings-section__title').allTextContents()
const versionText = (await page.locator('.settings-version').textContent()) ?? ''

// 代理设置 + 连接测试（没有 API Key 时应提示配置不完整，不联网）
await page.fill('.settings-proxy-input', '127.0.0.1:7890')
await page.click('.settings-test-btn')
await page.waitForSelector('.settings-test-result', { timeout: 15_000 })
const testConnectionText = ((await page.locator('.settings-test-result').innerText()) ?? '').trim()
await page.click('.settings-actions button:has-text("保存")')
await page.waitForTimeout(800)
const settingsJson = JSON.parse(fs.readFileSync(path.join(userData, 'settings.json'), 'utf8'))
await page.click('.topbar button:has-text("配置")')
await page.waitForTimeout(800)
const proxyValue = await page.inputValue('.settings-proxy-input')
await page.keyboard.press('Escape')
await page.waitForTimeout(400)
await page.screenshot({ path: path.join(shots, '68-settings-update.png') })
await page.keyboard.press('Escape')
await page.waitForTimeout(400)
const escClosed = (await page.locator('.settings-modal').count()) === 0

const logDir = path.join(userData, 'logs')
const logFiles = fs.existsSync(logDir) ? fs.readdirSync(logDir).filter((name) => name.endsWith('.log')) : []
const logText = logFiles.length > 0 ? fs.readFileSync(path.join(logDir, logFiles[0]), 'utf8') : ''
const result = {
  logFileCreated: logFiles.length > 0,
  logHasStartup: logText.includes('应用启动'),
  zipOk: zipReport.data?.report?.books === 1 && fs.existsSync(zipFile),
  zipEntries,
  healthOk: health.data?.books === 1 && health.data?.broken?.length === 0,
  devUpdate: update.data?.dev === true && update.data?.hasUpdate === false,
  restoreSkippedSameBook: restore.data?.report?.restored?.length === 0 && restore.data?.report?.skipped?.length === 1,
  sectionTitles: sectionTitles.map((text) => text.trim()),
  versionText: versionText.trim(),
  escClosed,
  testConnectionText,
  proxySaved: settingsJson.proxyUrl,
  proxyReloaded: proxyValue,
  title,
}
console.log(JSON.stringify(result, null, 2))

await Promise.race([
  app.close().then(() => 'closed'),
  new Promise((resolve) => setTimeout(() => resolve('timeout'), 15_000)),
])

if (
  !result.zipOk ||
  !result.healthOk ||
  !result.devUpdate ||
  !result.restoreSkippedSameBook ||
  !result.escClosed ||
  !result.logHasStartup ||
  !result.testConnectionText.includes('配置不完整') ||
  result.proxySaved !== 'http://127.0.0.1:7890' ||
  result.proxyReloaded !== 'http://127.0.0.1:7890'
) {
  process.exit(1)
}

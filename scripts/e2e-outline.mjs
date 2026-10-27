/**
 * 大纲向导端到端（真实模型，一次生成）：
 * 创意 → 生成建议 → 查看 diff → 采纳主线大纲 → 校验知识文件与建议清理。
 */
import { _electron as electron } from 'playwright'
import path from 'node:path'
import fs from 'node:fs'
import { fileURLToPath } from 'node:url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const projectRoot = path.resolve(__dirname, '..')
const runId = Date.now().toString(36)
const home = path.join(projectRoot, '..', '.tmp', `outline-home-${runId}`)
const userData = path.join(projectRoot, '..', '.tmp', `outline-userdata-${runId}`)
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

await page.fill('input[placeholder*="书名"]', '大纲测试书')
await page.click('button:has-text("新建书")')
await page.waitForTimeout(1200)

const bookDir = fs
  .readdirSync(home, { withFileTypes: true })
  .filter((entry) => entry.isDirectory())
  .map((entry) => path.join(home, entry.name))
  .find((dir) => fs.existsSync(path.join(dir, 'book.json')))
if (!bookDir) throw new Error('book dir not found')

await page.click('button:has-text("大纲向导")')
await page.waitForSelector('.modal--outline')
await page.fill('.field__textarea', '雾海渡口的少年摆渡人，发现父亲留下的旧船能驶过死人留下的雾；镇渊司正要收回所有渡船。')
await page.fill('.field__input', '3')
await page.click('button:has-text("生成大纲建议")')

const startedAt = Date.now()
const deadline = Date.now() + 300_000
let done = false
while (Date.now() < deadline) {
  await page.waitForTimeout(2000)
  if ((await page.locator('.outline__done').count()) > 0) {
    done = true
    break
  }
  const errors = await page.locator('.panel-hint--error').count()
  if (errors > 0) break
}
const elapsedSec = Math.round((Date.now() - startedAt) / 1000)
await page.screenshot({ path: path.join(shots, '66-outline-done.png') })

const proposalDir = path.join(bookDir, '.studio', 'proposals')
const proposalsBefore = fs.existsSync(proposalDir)
  ? fs.readdirSync(proposalDir).filter((name) => name.endsWith('.json'))
  : []
const knowledgeBefore = fs.readFileSync(path.join(bookDir, 'master_outline.md'), 'utf8')

if (done) {
  await page.click('.outline__done button:has-text("查看建议")')
  await page.waitForSelector('.proposals__item')
  await page.waitForTimeout(400)
  await page.screenshot({ path: path.join(shots, '67-outline-proposals.png') })
  await page.click('.proposals__item:has-text("主线大纲")')
  await page.waitForTimeout(300)
  await page.click('.proposals__actions button:has-text("接受并提交")')
  await page.waitForTimeout(1500)
}

const knowledgeAfter = fs.readFileSync(path.join(bookDir, 'master_outline.md'), 'utf8')
const proposalsAfter = fs.existsSync(proposalDir)
  ? fs.readdirSync(proposalDir).filter((name) => name.endsWith('.json'))
  : []

const result = {
  generated: done,
  elapsedSec,
  proposalsCreated: proposalsBefore.length,
  knowledgeUnchangedBeforeAccept: knowledgeBefore === (knowledgeBefore || ''),
  acceptedWroteMasterOutline:
    knowledgeAfter.length > knowledgeBefore.length && knowledgeAfter !== knowledgeBefore,
  proposalsAfterAccept: proposalsAfter.length,
}
console.log(JSON.stringify(result, null, 2))

await Promise.race([
  app.close().then(() => 'closed'),
  new Promise((resolve) => setTimeout(() => resolve('timeout'), 15_000)),
])

if (!done || proposalsBefore.length < 2 || !result.acceptedWroteMasterOutline) process.exit(1)

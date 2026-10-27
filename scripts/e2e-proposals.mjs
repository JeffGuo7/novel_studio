/**
 * AI 知识建议端到端（不调用模型）：预置 proposal → 打开「AI 建议」→ 看 diff → 接受 → 校验知识文件与 Git 提交；再测拒绝。
 */
import { _electron as electron } from 'playwright'
import path from 'node:path'
import fs from 'node:fs'
import { execFileSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const projectRoot = path.resolve(__dirname, '..')
const runId = Date.now().toString(36)
const home = path.join(projectRoot, '..', '.tmp', `prop-home-${runId}`)
const userData = path.join(projectRoot, '..', '.tmp', `prop-userdata-${runId}`)
const shots = path.join(projectRoot, '.runtime', 'shots')
fs.mkdirSync(home, { recursive: true })
fs.mkdirSync(userData, { recursive: true })
fs.mkdirSync(shots, { recursive: true })

const env = { ...process.env, NOVEL_STUDIO_HOME: home, NOVEL_STUDIO_USER_DATA: userData }
delete env.ELECTRON_RUN_AS_NODE

const app = await electron.launch({ args: ['.'], cwd: projectRoot, env })
const page = await app.firstWindow()
await page.waitForLoadState('domcontentloaded')
await page.waitForTimeout(1200)

await page.fill('input[placeholder*="书名"]', '建议测试书')
await page.click('button:has-text("新建书")')
await page.waitForTimeout(1200)

const bookDir = fs
  .readdirSync(home, { withFileTypes: true })
  .filter((entry) => entry.isDirectory())
  .map((entry) => path.join(home, entry.name))
  .find((dir) => fs.existsSync(path.join(dir, 'book.json')))
if (!bookDir) throw new Error('book dir not found')

const proposalsDir = path.join(bookDir, '.studio', 'proposals')
fs.mkdirSync(proposalsDir, { recursive: true })
const proposal = {
  id: `p-${Date.now().toString(36)}-e2e0001`,
  targetPath: 'master_outline.md',
  targetTitle: '主线大纲',
  content: '# 主线大纲\n\n## 读者承诺\n\n- 少年在雾海复仇，最终找回父亲留下的船\n\n## 长线冲突\n\n- 与镇渊司的税权之争\n',
  reason: '补齐主线承诺与长线冲突',
  source: 'agent',
  createdAt: new Date().toISOString(),
}
fs.writeFileSync(path.join(proposalsDir, `${proposal.id}.json`), JSON.stringify(proposal, null, 2), 'utf8')

// 回书架再打开，让 Workbench 重新加载并刷新建议数
await page.click('.topbar button:has-text("书架")')
await page.waitForTimeout(600)
await page.click('.book-card:has-text("建议测试书")')
await page.waitForTimeout(1200)

await page.click('button:has-text("AI 建议")')
await page.waitForSelector('.proposals__item')
await page.waitForTimeout(400)
const diffText = (await page.locator('.proposals__diff').textContent()) ?? ''
await page.screenshot({ path: path.join(shots, '65-proposals.png') })

await page.click('.proposals__actions button:has-text("接受并提交")')
await page.waitForTimeout(1500)

const fileAfter = fs.readFileSync(path.join(bookDir, 'master_outline.md'), 'utf8')
const remaining = fs.readdirSync(proposalsDir).filter((name) => name.endsWith('.json'))
let lastCommit = ''
try {
  lastCommit = execFileSync('git', ['-C', bookDir, 'log', '-1', '--pretty=%s'], { encoding: 'utf8' }).trim()
} catch {
  lastCommit = ''
}

// 第二份建议：测试拒绝
const proposal2 = {
  id: `p-${Date.now().toString(36)}-e2e0002`,
  targetPath: 'status_card.md',
  targetTitle: '状态卡',
  content: '# 状态卡\n\n## 当前时间与地点\n\n- 雾海渡口，夜\n',
  reason: '拒绝测试',
  source: 'agent',
  createdAt: new Date().toISOString(),
}
fs.writeFileSync(path.join(proposalsDir, `${proposal2.id}.json`), JSON.stringify(proposal2, null, 2), 'utf8')
await page.waitForTimeout(500)
await page.click('button:has-text("AI 建议")')
await page.waitForSelector('.proposals__item')
await page.click('.proposals__actions button:has-text("拒绝")')
await page.waitForTimeout(1200)
const remainingAfterReject = fs.readdirSync(proposalsDir).filter((name) => name.endsWith('.json'))

const result = {
  diffShowsProposal: diffText.includes('雾海复仇'),
  acceptedWritesFile: fileAfter.includes('雾海复仇'),
  proposalsCleared: remaining.length === 0,
  commitMessage: lastCommit,
  rejectRemovesProposal: remainingAfterReject.length === 0,
}
console.log(JSON.stringify(result, null, 2))

await Promise.race([
  app.close().then(() => 'closed'),
  new Promise((resolve) => setTimeout(() => resolve('timeout'), 15_000)),
])

if (
  !result.diffShowsProposal ||
  !result.acceptedWritesFile ||
  !result.proposalsCleared ||
  !result.rejectRemovesProposal
) {
  process.exit(1)
}

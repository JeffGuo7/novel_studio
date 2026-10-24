/**
 * Agent 端到端：真实 Electron + DeepSeek，验证「读上下文 → 写草稿 → UI 刷新」。
 * 需要 .env.local 里有 DEEPSEEK_API_KEY。
 */
import { _electron as electron } from 'playwright'
import path from 'node:path'
import fs from 'node:fs'
import { fileURLToPath } from 'node:url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const projectRoot = path.resolve(__dirname, '..')
const runId = Date.now().toString(36)
const home = path.join(projectRoot, '..', '.tmp', `studio-agent-${runId}`)
const shots = path.join(projectRoot, '.runtime', 'shots')
fs.mkdirSync(home, { recursive: true })
fs.mkdirSync(shots, { recursive: true })

const env = { ...process.env }
delete env.ELECTRON_RUN_AS_NODE
env.NOVEL_STUDIO_HOME = home

const app = await electron.launch({ args: ['.'], cwd: projectRoot, env })
const page = await app.firstWindow()
await page.waitForLoadState('domcontentloaded')
await page.waitForTimeout(1000)

await page.fill('input[placeholder*="书名"]', '雾海纪事')
await page.click('button:has-text("新建书")')
await page.waitForTimeout(1200)

// 给这本书填上真实设定（否则 Agent 会按规则拒绝凭空编造）
const bookDir = fs
  .readdirSync(home, { withFileTypes: true })
  .filter((entry) => entry.isDirectory())
  .map((entry) => path.join(home, entry.name))
  .find((dir) => fs.existsSync(path.join(dir, 'book.json')))
if (!bookDir) throw new Error('未找到书目录')

fs.writeFileSync(
  path.join(bookDir, 'world_model.md'),
  `# 世界模型

## 读者承诺与主轴
- 北境渡口「雾海」每七日一场大雾，雾里会走出不属于这个世界的东西。
- 主角林牧是最后一代渡人，靠一条旧船替人渡雾，规矩是：雾里有人招手，不能应。

## 规则体系
- 渡人三条规矩：不应、不回头、不点灯。
- 答了话，就会被记上「名」，名字被记走的人，三天内会从所有人口中消失。

## 势力
- 镇渊司：官府设的渡口管理机构，收三倍渡税，暗地里数雾里出来的「名」。
- 听潮阁：民间渡人组织，在替人渡雾，也在收集被记走的名字。
`,
)

fs.writeFileSync(
  path.join(bookDir, 'chapter_outline.md'),
  `# 逐章大纲

## 第 1 章 雾夜渡客
- 场景：雾夜，旧渡船，镇渊司封条
- 冲突：雾里有人招手，林牧想起规矩
- 转折：船底传来第二次声音，比第一声更近
- 收尾：他攥紧船篙，没有回头
`,
)

fs.writeFileSync(
  path.join(bookDir, 'style_guide.md'),
  `# 文风指南

## 句式与节奏
- 短句为主，画面具体，少用形容词堆砌。
- 对话独立成段，克制。

## 禁忌
- 不要写心理总结式的大段独白。
`,
)

fs.writeFileSync(
  path.join(bookDir, 'status_card.md'),
  `# 状态卡

## 当前时间与地点
- 时间：雾夜，亥时
- 地点：雾海渡口，旧渡船

## 人物状态
- 林牧：二十四岁，渡人，父亲三年前在雾中失踪。

## 最近事件
- 镇渊司收购渡口，林牧被要求七日内补交三倍渡税。
`,
)

await page.click('button.tab:has-text("助手")')
await page.waitForTimeout(1200)
await page.screenshot({ path: path.join(shots, '10-assistant-idle.png') })

await page.fill(
  '.assistant__composer textarea',
  '续写第 1 章《雾夜渡客》，600 字左右，按逐章大纲来写。写完调用 write_draft 保存为 chapterKey=0001 的草稿。',
)
await page.click('.assistant__composer button:has-text("发送")')

const deadline = Date.now() + 240_000
let finished = false
const draftsDirEarly = path.join(bookDir, '.studio', 'drafts', '0001')
while (Date.now() < deadline) {
  await page.waitForTimeout(2000)
  const hasDraft =
    fs.existsSync(draftsDirEarly) && fs.readdirSync(draftsDirEarly).some((name) => name.endsWith('.md'))
  const streaming = await page.locator('.bubble-streaming').count()
  if (hasDraft && streaming === 0) {
    finished = true
    await page.waitForTimeout(4000)
    break
  }
}

await page.waitForTimeout(1500)
await page.screenshot({ path: path.join(shots, '11-assistant-written.png') })

// 草稿落盘校验
const draftsDir = path.join(bookDir, '.studio', 'drafts', '0001')
const draftFiles = fs.existsSync(draftsDir) ? fs.readdirSync(draftsDir).filter((name) => name.endsWith('.md')) : []
const draftSize = draftFiles.length
  ? fs.readFileSync(path.join(draftsDir, draftFiles[draftFiles.length - 1]), 'utf8').replace(/\s+/g, '').length
  : 0

// UI 侧：点左侧「未成章」再切草稿页
const orphan = page.locator('.tree-item:has-text("未成章")')
if ((await orphan.count()) > 0) {
  await orphan.first().click()
  await page.waitForTimeout(900)
  await page.click('button.tab:has-text("草稿")')
  await page.waitForTimeout(700)
}
await page.screenshot({ path: path.join(shots, '12-draft-from-agent.png') })
const draftEntries = await page.locator('.entry').count()

console.log(
  JSON.stringify({ finished, draftFiles: draftFiles.length, draftChars: draftSize, draftEntries }, null, 2),
)
await app.close()
if (!finished || draftFiles.length === 0) process.exit(1)

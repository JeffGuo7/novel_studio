/**
 * 用 Playwright 驱动打包后的 Electron 应用，跑一遍完整闭环并截图。
 * 用法：node scripts/e2e-screenshots.mjs
 * 产物：.runtime/shots/*.png（工作目录下，已 gitignore）
 */
import { _electron as electron } from 'playwright'
import path from 'node:path'
import fs from 'node:fs'
import { fileURLToPath } from 'node:url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const projectRoot = path.resolve(__dirname, '..')
const runId = Date.now().toString(36)
const home = path.join(projectRoot, '..', '.tmp', `studio-home-${runId}`)
const shots = path.join(projectRoot, '.runtime', 'shots')
fs.mkdirSync(home, { recursive: true })
fs.mkdirSync(shots, { recursive: true })

const env = { ...process.env }
delete env.ELECTRON_RUN_AS_NODE
env.NOVEL_STUDIO_HOME = home

const app = await electron.launch({ args: ['.'], cwd: projectRoot, env })
const page = await app.firstWindow()
await page.waitForLoadState('domcontentloaded')
await page.waitForTimeout(1200)

const shot = async (name) => {
  await page.screenshot({ path: path.join(shots, `${name}.png`) })
  console.log('shot:', name)
}

await shot('01-shelf-empty')

await page.fill('input[placeholder*="书名"]', '临渊行')
await page.fill('input[placeholder*="作者"]', '黑山')
await page.click('button:has-text("新建书")')
await page.waitForTimeout(1200)
await shot('02-book-fresh')

await page.click('button:has-text("新建章节")')
await page.waitForTimeout(900)

const chapterText = `# 第 1 章 雾夜渡客

雾是从水面长出来的。

林牧把篙插进水里，听见底下有人说话。声音很轻，像是从很远处传回来，又像是贴着船底在响。

「渡么？」

他没有回答。这样的夜里，答了话的东西，多半不该答。

## 一

镇渊司的封条贴在船头，被雨水泡得发白。
`
await page.fill('textarea.editor', chapterText)
await page.click('button:has-text("保存草稿版本")')
await page.waitForTimeout(700)

await page.fill('textarea.editor', `${chapterText}\n那声音又响了一次，比刚才更近。\n`)
await page.click('button:has-text("保存草稿版本")')
await page.waitForTimeout(700)
await shot('03-draft-versions')

await page.fill('input[placeholder*="归档时"]', '雾夜渡客')
await page.click('button:has-text("归档为第")')
await page.waitForTimeout(1200)
await shot('04-chapter-archived')

// 再写第二章，制造两条历史
await page.click('button:has-text("新建章节")')
await page.waitForTimeout(700)
await page.fill('textarea.editor', '# 第 2 章 七日之限\n\n镇渊司的封条贴在船头，像一张不合时宜的喜帖。\n')
await page.click('button:has-text("保存草稿版本")')
await page.waitForTimeout(500)
await page.fill('input[placeholder*="归档时"]', '七日之限')
await page.click('button:has-text("归档为第")')
await page.waitForTimeout(1000)

await page.click('button.tab:has-text("历史")')
await page.waitForTimeout(600)
await shot('05-history')

await page.locator('.entry').first().click()
await page.waitForTimeout(900)
await shot('06-commit-diff')
await page.click('button[aria-label="关闭"]')
await page.waitForTimeout(400)

await page.click('.topbar button:has-text("书架")')
await page.waitForTimeout(900)
await shot('07-shelf')

await app.close()
console.log('E2E done. home =', home)

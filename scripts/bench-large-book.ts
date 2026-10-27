/**
 * 大书性能基准（本地、不联网）：
 * 生成 1000 章 / ~270 万字，测剧情索引构建、检索、增量更新、上下文包组装。
 *
 * 运行：npm run bench:large
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createBook, createGitPort, removeDirRecursive } from '../src/core'
import { rebuildStoryIndex, searchStory } from '../src/agent/story-index'
import { buildContextPack } from '../src/agent/tools'

const CHAPTERS = Number(process.env.BENCH_CHAPTERS ?? 1000)
const CHARS_PER_CHAPTER = Number(process.env.BENCH_CHARS ?? 2700)

function makeChapter(index: number): string {
  const title = `第 ${index} 章 ${['雾夜', '渡口', '听潮', '封条', '旧信', '灯影'][index % 6]}`
  const sentences = [
    '雾从水面长出来，把岸边的石阶吞掉了一半。',
    '林牧把竹篙插进水里，听见底下有人说话，他没有回答。',
    '镇渊司的青袍人站在船头，封条在风里翻卷，像一张不肯落下的纸。',
    '苏晚在船舱里收拢渔网，灯影在木板上晃了一下，又稳住了。',
    '阿九抱着一摞旧信从石阶上走下来，鞋底沾着湿泥。',
    `第 ${index} 章的雾比昨夜更厚，远处传来一声闷响，像什么东西沉进了水里。`,
  ]
  let text = sentences.join('')
  while (text.length < CHARS_PER_CHAPTER) text += sentences[index % sentences.length]
  return `# ${title}\n\n${text}\n`
}

async function main(): Promise<void> {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'novel-bench-'))
  const git = createGitPort()
  const startedAt = Date.now()
  try {
    const book = await createBook(root, { title: '性能基准书' }, { git })
    const chaptersDir = path.join(book.dir, 'chapters')
    fs.mkdirSync(chaptersDir, { recursive: true })
    const writeStart = performance.now()
    for (let index = 1; index <= CHAPTERS; index += 1) {
      const number = String(index).padStart(4, '0')
      fs.writeFileSync(path.join(chaptersDir, `${number}_第${index}章.md`), makeChapter(index), 'utf8')
    }
    const writeMs = performance.now() - writeStart

    // 首次构建索引
    const buildStart = performance.now()
    rebuildStoryIndex(book.dir)
    const buildMs = performance.now() - buildStart

    // 预热：watcher 就绪后检索走内存索引
    searchStory(book.dir, '雾海渡口', 1)

    // 检索：5 个典型查询
    const queries = ['雾海渡口', '镇渊司封条', '阿九 听潮阁', '林牧 苏晚', '第 500 章 的雾']
    const searchStart = performance.now()
    let totalHits = 0
    for (const query of queries) totalHits += searchStory(book.dir, query, 5).hits.length
    const searchMs = performance.now() - searchStart

    // 修改一章 → 增量更新
    const chapterPath = path.join(chaptersDir, '0500_第500章.md')
    fs.writeFileSync(chapterPath, makeChapter(500) + '新增的一段：林牧在渡口看见了父亲的船。\n', 'utf8')
    await new Promise((resolve) => setTimeout(resolve, 200))
    const incrementalStart = performance.now()
    const incremental = searchStory(book.dir, '父亲 的 船')
    const incrementalMs = performance.now() - incrementalStart

    // 上下文包组装（含上一章正文）
    const packStart = performance.now()
    let packChars = 0
    for (let index = 0; index < 20; index += 1) {
      packChars += buildContextPack(book.dir, '0500').length
    }
    const packMs = (performance.now() - packStart) / 20

    const indexSize = fs.statSync(path.join(book.dir, '.studio', 'index', 'search-index.json')).size
    const totalBytes = fs.readdirSync(chaptersDir).reduce((sum, name) => sum + fs.statSync(path.join(chaptersDir, name)).size, 0)

    console.log(
      JSON.stringify(
        {
          chapters: CHAPTERS,
          chapterBytes: totalBytes,
          generateAndWriteMs: Math.round(writeMs),
          indexBuildMs: Math.round(buildMs),
          indexSizeMB: Number((indexSize / 1024 / 1024).toFixed(2)),
          search5Ms: Number(searchMs.toFixed(1)),
          searchHits: totalHits,
          incrementalUpdateMs: Number(incrementalMs.toFixed(1)),
          incrementalHits: incremental.hits.length,
          contextPackAvgMs: Number(packMs.toFixed(2)),
          contextPackChars: Math.round(packChars / 20),
          totalElapsedMs: Date.now() - startedAt,
        },
        null,
        2,
      ),
    )
  } finally {
    removeDirRecursive(root)
  }
}

void main().catch((err: Error) => {
  console.error(err.message)
  process.exit(1)
})

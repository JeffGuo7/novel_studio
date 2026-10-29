/**
 * 性能回归门槛（CI 用，固定小语料、阈值宽松，只拦灾难性退化）：
 * - 快照（冷/热）、上下文包组装、剧情索引构建、检索；
 * - 语料固定 200 章 × ~600 字，不联网、不花钱，通常 < 5s；
 * - 阈值故意设得比实测宽很多，避免 CI 抖动误报。
 *
 * 运行：npm run check:perf
 * 阈值可用环境变量覆盖：PERF_MAX_WARM_MS / PERF_MAX_COLD_MS / PERF_MAX_PACK_MS / PERF_MAX_SEARCH_MS / PERF_MAX_INDEX_MS
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createBook, createGitPort, removeDirRecursive, snapshotBook } from '../src/core'
import { rebuildStoryIndex, searchStory } from '../src/agent/story-index'
import { buildContextPack } from '../src/agent/tools'

const CHAPTERS = Number(process.env.PERF_CHAPTERS ?? 200)
const CHARS = Number(process.env.PERF_CHARS ?? 600)

function makeChapter(index: number): string {
  const base = [
    '雾从水面长出来，把岸边的石阶吞掉了一半。',
    '林牧把竹篙插进水里，听见底下有人说话，他没有回答。',
    '镇渊司的青袍人站在船头，封条在风里翻卷。',
    '苏晚在船舱里收拢渔网，灯影晃了一下又稳住。',
  ]
  let text = base.join('')
  while (text.length < CHARS) text += base[index % base.length]
  return `# 第 ${index} 章\n\n${text}\n`
}

function avg(values: number[]): number {
  return values.reduce((sum, value) => sum + value, 0) / Math.max(1, values.length)
}

async function main(): Promise<void> {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'novel-perf-gate-'))
  const git = createGitPort()
  try {
    const book = await createBook(root, { title: '性能门槛' }, { git })
    const chaptersDir = path.join(book.dir, 'chapters')
    for (let index = 1; index <= CHAPTERS; index += 1) {
      const number = String(index).padStart(4, '0')
      fs.writeFileSync(path.join(chaptersDir, `${number}_第${index}章.md`), makeChapter(index), 'utf8')
    }

    const coldStart = performance.now()
    await snapshotBook(book.dir, { git })
    const coldMs = performance.now() - coldStart

    const warmRuns: number[] = []
    for (let index = 0; index < 5; index += 1) {
      const start = performance.now()
      await snapshotBook(book.dir, { git })
      warmRuns.push(performance.now() - start)
    }

    const packRuns: number[] = []
    for (let index = 0; index < 10; index += 1) {
      const start = performance.now()
      buildContextPack(book.dir, String(index + 1).padStart(4, '0'))
      packRuns.push(performance.now() - start)
    }

    const buildStart = performance.now()
    rebuildStoryIndex(book.dir)
    const indexMs = performance.now() - buildStart

    searchStory(book.dir, '雾', 5) // 预热
    const searchStart = performance.now()
    for (const query of ['雾', '渡口', '封条', '林牧']) searchStory(book.dir, query, 5)
    const searchMs = performance.now() - searchStart

    const metrics = {
      chapters: CHAPTERS,
      charsPerChapter: CHARS,
      coldSnapshotMs: Number(coldMs.toFixed(1)),
      warmSnapshotAvgMs: Number(avg(warmRuns).toFixed(1)),
      contextPackAvgMs: Number(avg(packRuns).toFixed(1)),
      indexBuildMs: Number(indexMs.toFixed(1)),
      search4QueriesMs: Number(searchMs.toFixed(1)),
    }
    console.log(JSON.stringify(metrics, null, 2))

    const limits = {
      warmSnapshotAvgMs: Number(process.env.PERF_MAX_WARM_MS ?? 1200),
      coldSnapshotMs: Number(process.env.PERF_MAX_COLD_MS ?? 5000),
      contextPackAvgMs: Number(process.env.PERF_MAX_PACK_MS ?? 1200),
      indexBuildMs: Number(process.env.PERF_MAX_INDEX_MS ?? 45_000),
      search4QueriesMs: Number(process.env.PERF_MAX_SEARCH_MS ?? 4000),
    }
    const failures = Object.entries(limits)
      .filter(([key, limit]) => (metrics as Record<string, number>)[key] > limit)
      .map(([key, limit]) => `${key}=${(metrics as Record<string, number>)[key]} > ${limit}`)
    if (failures.length > 0) {
      console.error(`性能回归：${failures.join('；')}`)
      process.exit(1)
    }
    console.log('性能门槛通过')
  } finally {
    removeDirRecursive(root)
  }
}

void main().catch((err: Error) => {
  console.error(`性能门槛执行失败：${err.message}`)
  process.exit(1)
})

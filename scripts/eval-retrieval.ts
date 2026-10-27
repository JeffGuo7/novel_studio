/**
 * 检索质量评估（合成语料，不联网、不花钱）：
 * 生成 120 章中文小说并植入可判定答案，测剧情检索的 hit@1 / hit@5 / MRR。
 *
 * 运行：npm run eval:retrieval
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createBook, createGitPort, removeDirRecursive } from '../src/core'
import { rebuildStoryIndex, searchStory } from '../src/agent/story-index'

const CHAPTERS = Number(process.env.EVAL_CHAPTERS ?? 120)

let seed = 7
const rand = (): number => {
  seed = (seed * 1664525 + 1013904223) % 4294967296
  return seed / 4294967296
}
const pick = <T>(list: T[]): T => list[Math.floor(rand() * list.length)]

const FILLER = [
  '雾从水面长出来，把岸边的石阶吞掉一半。',
  '林牧把竹篙插进水里，听见底下有人说话，他没有回答。',
  '镇渊司的青袍人站在船头，封条在风里翻卷。',
  '苏晚在船舱里收拢渔网，灯影晃了一下又稳住。',
  '阿九抱着一摞旧信从石阶上走下来，鞋底沾着湿泥。',
]
const PLACES = ['雾海渡口', '听潮阁', '镇渊司', '旧码头', '南岸茶棚']
const ITEMS = ['封条', '渡籍', '铜哨', '旧信', '船桨', '渔网']
const FILLERS = ['他沿着岸边慢慢走。', '天色暗得很快。', '远处传来一声闷响。']

function makeChapter(index: number): string {
  const title = `第 ${index} 章 ${pick(PLACES)}`
  const sentences: string[] = []
  for (let i = 0; i < 40; i += 1) {
    const roll = rand()
    if (roll > 0.68) {
      sentences.push(`林牧在${pick(PLACES)}把${pick(ITEMS)}交给${pick(['苏晚', '阿九', '青袍人'])}。`)
    } else {
      sentences.push(pick(rand() > 0.5 ? FILLER : FILLERS))
    }
  }
  return `# ${title}\n\n${sentences.join('')}\n`
}

interface EvalQuery {
  query: string
  chapter: number
  type: string
}

async function main(): Promise<void> {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'novel-eval-'))
  const git = createGitPort()
  try {
    const book = await createBook(root, { title: '检索评估' }, { git })
    const chaptersDir = path.join(book.dir, 'chapters')
    fs.mkdirSync(chaptersDir, { recursive: true })

    // 植入 6 个可唯一命中的事实
    const planted: Array<{ query: string; chapter: number; type: string; text: string }> = [
      { query: '林牧在雾海渡口救下苏晚', chapter: 17, type: 'event', text: '林牧在雾海渡口救下苏晚，把她拖上渡船。' },
      { query: '阿九在听潮阁交出渡籍', chapter: 43, type: 'event', text: '阿九在听潮阁交出渡籍，签下了自己的名字。' },
      { query: '苏晚替林牧挡下封条', chapter: 68, type: 'event', text: '苏晚替林牧挡下镇渊司的封条，肩膀被划开一道口子。' },
      { query: '铜哨在旧码头被找到', chapter: 91, type: 'item', text: '铜哨在旧码头被找到，刻着归字。' },
      { query: '青袍人烧掉旧信', chapter: 104, type: 'event', text: '青袍人烧掉旧信，火光照亮了半张脸。' },
      { query: '林牧在听潮阁见到父亲的船', chapter: 119, type: 'event', text: '林牧在听潮阁见到父亲的船，船头站着一个招手的人。' },
    ]
    for (const item of planted) {
      const file = path.join(chaptersDir, `${String(item.chapter).padStart(4, '0')}_第${item.chapter}章.md`)
      fs.writeFileSync(file, makeChapter(item.chapter) + item.text + '\n', 'utf8')
    }
    for (let index = 1; index <= CHAPTERS; index += 1) {
      if (planted.some((item) => item.chapter === index)) continue
      fs.writeFileSync(
        path.join(chaptersDir, `${String(index).padStart(4, '0')}_第${index}章.md`),
        makeChapter(index),
        'utf8',
      )
    }

    const buildStart = performance.now()
    rebuildStoryIndex(book.dir)
    const buildMs = performance.now() - buildStart

    const queries: EvalQuery[] = [
      ...planted.map((item) => ({ query: item.query, chapter: item.chapter, type: item.type })),
      { query: '渡船', chapter: 17, type: 'entity' },
      { query: '挡下镇渊司的封条', chapter: 68, type: 'phrase' },
      { query: '谁在旧码头找到了铜哨', chapter: 91, type: 'natural' },
      { query: '谁救了苏晚', chapter: 17, type: 'paraphrase' },
    ]

    let hit1 = 0
    let hit5 = 0
    let reciprocalRank = 0
    const searchStart = performance.now()
    const details: Array<{ query: string; type: string; expected: string; hit: number | null }> = []
    for (const item of queries) {
      const expected = String(item.chapter).padStart(4, '0')
      const result = searchStory(book.dir, item.query, 5)
      const rank = result.hits.findIndex((hit) => hit.chapterKey === expected)
      if (rank === 0) hit1 += 1
      if (rank >= 0) hit5 += 1
      if (rank >= 0) reciprocalRank += 1 / (rank + 1)
      details.push({ query: item.query, type: item.type, expected, hit: rank >= 0 ? rank + 1 : null })
    }
    const searchMs = performance.now() - searchStart
    if (hit5 < queries.length) {
      console.error(
        '检索质量回归：hit@5 ' + hit5 + '/' + queries.length + '，低于 100% 门槛',
      )
      process.exitCode = 1
    }
    const indexSize = fs.statSync(path.join(book.dir, '.studio', 'index', 'search-index.json')).size

    console.log(
      JSON.stringify(
        {
          chapters: CHAPTERS,
          queries: queries.length,
          hit1: `${hit1}/${queries.length}`,
          hit5: `${hit5}/${queries.length}`,
          mrr: Number((reciprocalRank / queries.length).toFixed(3)),
          indexBuildMs: Math.round(buildMs),
          avgSearchMs: Number((searchMs / queries.length).toFixed(1)),
          indexSizeMB: Number((indexSize / 1024 / 1024).toFixed(2)),
          details,
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
  console.error(`检索评估失败：${err.message}`)
  process.exit(1)
})

/**
 * 知识库初始化管线：把导入的章节蒸馏成
 * summary.md（剧情总纲）、world_model.md（世界模型）、status_card.md（状态卡）、chapter_outline.md（逐章大纲）。
 *
 * 设计：
 * - 分块调用（按字符数分组），每块产出「摘要 / 设定 / 状态 / 逐章一句话」；
 * - 合并调用只做三次（总纲、世界模型、状态卡），逐章大纲直接从分块结果拼装，不再额外调用；
 * - 所有模型调用通过注入的 complete() 完成，测试时可以替换成 fake。
 */
import fs from 'node:fs'
import path from 'node:path'
import { createGitPort, type GitPort } from '../core/git'
import { ensureDir, writeFileAtomic } from '../core/fsutil'

export interface PipelineChapter {
  key: string
  title: string
  content: string
}

export interface PipelineProgress {
  phase: 'chunk' | 'merge' | 'write'
  current: number
  total: number
  message?: string
}

export interface CompleteResult {
  text: string
  cost: number
  input: number
  output: number
}

export type CompleteFn = (prompt: string) => Promise<CompleteResult>

export interface KnowledgeInitOptions {
  bookDir: string
  bookTitle: string
  chapters: PipelineChapter[]
  complete: CompleteFn
  onProgress?: (progress: PipelineProgress) => void
  git?: GitPort
  /** 单块最大字符数 */
  maxChunkChars?: number
  /** 最多处理多少章（防止一本书把预算打穿） */
  maxChapters?: number
}

export interface KnowledgeInitReport {
  chapters: number
  chunks: number
  cost: number
  inputTokens: number
  outputTokens: number
  files: string[]
  skippedChapters: number
}

const MAX_CHUNK_CHARS = 12_000
const MAX_CHAPTER_CHARS = 8_000
const MAX_CHAPTERS = 240

/** 按字符预算把章节分块 */
export function planChunks(
  chapters: PipelineChapter[],
  maxChunkChars = MAX_CHUNK_CHARS,
): PipelineChapter[][] {
  const chunks: PipelineChapter[][] = []
  let current: PipelineChapter[] = []
  let size = 0
  for (const chapter of chapters) {
    const length = Math.min(chapter.content.length, MAX_CHAPTER_CHARS)
    if (current.length > 0 && size + length > maxChunkChars) {
      chunks.push(current)
      current = []
      size = 0
    }
    current.push(chapter)
    size += length
  }
  if (current.length > 0) chunks.push(current)
  return chunks
}

function chapterBlock(chapter: PipelineChapter): string {
  const content = chapter.content.slice(0, MAX_CHAPTER_CHARS)
  return `### ${chapter.key} ${chapter.title}\n${content}`
}

export function buildChunkPrompt(bookTitle: string, chunk: PipelineChapter[], index: number, total: number): string {
  const body = chunk.map(chapterBlock).join('\n\n')
  return `你是《${bookTitle}》的资料整理助手。下面是第 ${index}/${total} 组章节原文。

请严格按以下四个小节输出 Markdown，不要寒暄：

## 摘要
用 3-5 句话概括这组章节发生了什么（只写事实，不评价）。

## 设定
列出这组章节里出现的世界观信息：地点、势力、规则、物品、关键设定（每条一行，没有就写"无"）。

## 状态
列出这组章节结束时的人物状态与关系变化（每条一行，没有就写"无"）。

## 逐章
每章一行，格式必须是：- <四位数章节号> <章节标题>：<这一章发生了什么，一句话>
例如：- 0001 雾夜渡客：林牧在雾夜摆渡，听见水下有人说话。

章节原文：

${body}`
}

function mergeHeader(bookTitle: string): string {
  return `你是《${bookTitle}》的资料整理助手。下面是按顺序整理的章节要点。`
}

/** 把分块结果里的「逐章」行抽出来，拼成逐章大纲 */
export function extractChapterLines(chunkOutputs: string[], chapters: PipelineChapter[]): string[] {
  const found = new Map<string, string>()
  for (const output of chunkOutputs) {
    const section = output.split(/^##\s*逐章\s*$/m)[1] ?? ''
    for (const line of section.split('\n')) {
      const match = line.match(/^\s*[-*]\s*(\d{4})\s*(.*?)[：:]\s*(.+)$/)
      if (!match) continue
      const key = match[1]
      const summary = match[3].trim()
      if (summary) found.set(key, summary)
    }
  }
  return chapters.map((chapter) => {
    const summary = found.get(chapter.key) ?? '（待补充）'
    return `- ${chapter.key} ${chapter.title}：${summary}`
  })
}

export async function runKnowledgeInit(options: KnowledgeInitOptions): Promise<KnowledgeInitReport> {
  const git = options.git ?? createGitPort()
  const maxChapters = options.maxChapters ?? MAX_CHAPTERS
  const allChapters = options.chapters.filter((chapter) => chapter.content.trim().length > 0)
  const chapters = allChapters.slice(0, maxChapters)
  if (chapters.length === 0) {
    throw new Error('没有可整理的章节')
  }

  const chunks = planChunks(chapters, options.maxChunkChars)
  let cost = 0
  let inputTokens = 0
  let outputTokens = 0

  const complete = async (prompt: string): Promise<string> => {
    const result = await options.complete(prompt)
    cost += result.cost
    inputTokens += result.input
    outputTokens += result.output
    return result.text
  }

  const chunkOutputs: string[] = []
  for (let index = 0; index < chunks.length; index += 1) {
    const chunk = chunks[index]
    options.onProgress?.({
      phase: 'chunk',
      current: index + 1,
      total: chunks.length,
      message: `整理第 ${chunk[0].key}–${chunk[chunk.length - 1].key} 章`,
    })
    const text = await complete(buildChunkPrompt(options.bookTitle, chunk, index + 1, chunks.length))
    chunkOutputs.push(text)
  }

  const merged = chunkOutputs.join('\n\n---\n\n')

  options.onProgress?.({ phase: 'merge', current: 1, total: 3, message: '生成剧情总纲' })
  const summaryText = await complete(
    `${mergeHeader(options.bookTitle)}

请输出一份《剧情总纲》，结构：

# 剧情总纲

## 已发生
按时间顺序列出 8-15 条，每条一句话。

## 当前进度
用 2-3 句话说明故事进行到哪里。

## 待推进
列出 3-5 条明显还没回收的伏笔或冲突。

要求：只写要点里的内容，不要编造；总长不超过 1200 字。

要点：

${merged}`,
  )

  options.onProgress?.({ phase: 'merge', current: 2, total: 3, message: '生成世界模型' })
  const worldText = await complete(
    `${mergeHeader(options.bookTitle)}

请输出一份《世界模型》，结构：

# 世界模型

## 读者承诺与主轴
- 2-3 条

## 力量 / 规则体系
- 3-6 条

## 势力与地理
- 3-6 条

## 硬约束
- 3-6 条（不可撤销的设定、代价、禁忌）

要求：只使用要点中出现的信息；信息不足的小节写"待补充"，不要编造。总长不超过 1500 字。

要点：

${merged}`,
  )

  options.onProgress?.({ phase: 'merge', current: 3, total: 3, message: '生成状态卡' })
  const statusText = await complete(
    `${mergeHeader(options.bookTitle)}

请输出当前时点的《状态卡》，结构：

# 状态卡

## 当前时间与地点
- 1-2 条

## 人物状态
- 每个主要人物一条：名字：位置 / 目标 / 关键关系 / 伤病或代价

## 最近事件
- 最近 3-5 件事，按时间顺序

要求：只使用要点中的信息，不确定的写"待补充"。总长不超过 800 字。

要点：

${merged}`,
  )

  const outlineLines = extractChapterLines(chunkOutputs, chapters)
  const outlineText = `# 逐章大纲\n\n${outlineLines.join('\n')}\n`

  options.onProgress?.({ phase: 'write', current: 1, total: 1, message: '写入知识文件并提交' })

  ensureDir(options.bookDir)
  const files: Array<[string, string]> = [
    ['summary.md', summaryText.trim() + '\n'],
    ['world_model.md', worldText.trim() + '\n'],
    ['status_card.md', statusText.trim() + '\n'],
    ['chapter_outline.md', outlineText],
  ]
  for (const [name, content] of files) {
    writeFileAtomic(path.join(options.bookDir, name), content)
  }
  await git.commitPaths(
    options.bookDir,
    files.map(([name]) => name),
    `[知识] 初始化：剧情总纲 / 世界模型 / 状态卡 / 逐章大纲（${chapters.length} 章）`,
  )

  return {
    chapters: chapters.length,
    chunks: chunks.length,
    cost,
    inputTokens,
    outputTokens,
    files: files.map(([name]) => name),
    skippedChapters: allChapters.length - chapters.length,
  }
}

/** 从书目录读取章节内容，供管线使用 */
export function loadPipelineChapters(bookDir: string): PipelineChapter[] {
  const chaptersDir = path.join(bookDir, 'chapters')
  if (!fs.existsSync(chaptersDir)) return []
  return fs
    .readdirSync(chaptersDir, { withFileTypes: true })
    .filter((entry) => entry.isFile() && entry.name.endsWith('.md'))
    .map((entry) => {
      const match = entry.name.match(/^(\d{4})_(.+)\.md$/)
      if (!match) return null
      return {
        key: match[1],
        title: match[2],
        content: fs.readFileSync(path.join(chaptersDir, entry.name), 'utf8'),
      }
    })
    .filter((item): item is PipelineChapter => item !== null)
    .sort((a, b) => a.key.localeCompare(b.key))
}

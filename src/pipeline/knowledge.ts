/**
 * 知识库管线：把章节蒸馏成
 * summary.md（剧情总纲）、world_model.md（世界模型）、status_card.md（状态卡）、chapter_outline.md（逐章大纲）。
 *
 * 模式：
 * - full：首次初始化，处理全部章节；
 * - incremental：只处理 lastChapterKey 之后的新章节，把新要点合并进已有的知识文件（状态卡滚动更新）。
 *
 * 设计：
 * - 分块调用（按字符数分组），每块产出「摘要 / 设定 / 状态 / 逐章一句话」；
 * - 合并调用只做三次（总纲、世界模型、状态卡），逐章大纲直接从分块结果拼装，不再额外调用；
 * - 所有模型调用通过注入的 complete() 完成，测试时可以替换成 fake。
 */
import fs from 'node:fs'
import path from 'node:path'
import { createGitPort, type GitPort } from '../core/git'
import { ensureDir, readFileOrNull, writeFileAtomic } from '../core/fsutil'

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

export type PipelineMode = 'full' | 'incremental' | 'noop'

export interface PipelineState {
  version: 1
  updatedAt: string
  lastChapterKey: string
  chapterCount: number
  costTotal: number
}

export interface KnowledgePlan {
  mode: PipelineMode
  totalChapters: number
  pendingChapters: number
  lastChapterKey?: string
  knowledgeUpdatedAt?: string
}

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
  /** auto：有状态就走增量；full：强制全量重建 */
  mode?: 'auto' | 'full'
}

export interface KnowledgeInitReport {
  mode: PipelineMode
  chapters: number
  chunks: number
  cost: number
  inputTokens: number
  outputTokens: number
  files: string[]
  skippedChapters: number
  fromChapter?: string
  toChapter?: string
  pendingChapters: number
}

const MAX_CHUNK_CHARS = 12_000
const MAX_CHAPTER_CHARS = 8_000
const MAX_CHAPTERS = 240
const STATE_FILE = path.join('.studio', 'pipeline-state.json')

export function pipelineStatePath(bookDir: string): string {
  return path.join(bookDir, STATE_FILE)
}

export function loadPipelineState(bookDir: string): PipelineState | null {
  const raw = readFileOrNull(pipelineStatePath(bookDir))
  if (!raw) return null
  try {
    const parsed = JSON.parse(raw) as Partial<PipelineState>
    if (!parsed.lastChapterKey) return null
    return {
      version: 1,
      updatedAt: parsed.updatedAt ?? '',
      lastChapterKey: parsed.lastChapterKey,
      chapterCount: Number(parsed.chapterCount ?? 0) || 0,
      costTotal: Number(parsed.costTotal ?? 0) || 0,
    }
  } catch {
    return null
  }
}

function savePipelineState(bookDir: string, state: PipelineState): void {
  ensureDir(path.dirname(pipelineStatePath(bookDir)))
  writeFileAtomic(pipelineStatePath(bookDir), JSON.stringify(state, null, 2) + '\n')
}

/** 只读文件名，用于计划判断（不读正文） */
export function listChapterKeys(bookDir: string): string[] {
  const chaptersDir = path.join(bookDir, 'chapters')
  if (!fs.existsSync(chaptersDir)) return []
  return fs
    .readdirSync(chaptersDir, { withFileTypes: true })
    .filter((entry) => entry.isFile() && /^\d{4}_.+\.md$/.test(entry.name))
    .map((entry) => entry.name.slice(0, 4))
    .sort()
}

export function planKnowledgeUpdate(bookDir: string): KnowledgePlan {
  const keys = listChapterKeys(bookDir)
  const state = loadPipelineState(bookDir)
  if (keys.length === 0) {
    return { mode: 'full', totalChapters: 0, pendingChapters: 0 }
  }
  if (!state) {
    return { mode: 'full', totalChapters: keys.length, pendingChapters: keys.length }
  }
  const pending = keys.filter((key) => key > state.lastChapterKey).length
  return {
    mode: pending > 0 ? 'incremental' : 'noop',
    totalChapters: keys.length,
    pendingChapters: pending,
    lastChapterKey: state.lastChapterKey,
    knowledgeUpdatedAt: state.updatedAt,
  }
}

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
  const map = extractChapterLineMap(chunkOutputs)
  return chapters.map((chapter) => {
    const summary = map.get(chapter.key) ?? '（待补充）'
    return `- ${chapter.key} ${chapter.title}：${summary}`
  })
}

export function extractChapterLineMap(chunkOutputs: string[]): Map<string, string> {
  const found = new Map<string, string>()
  for (const output of chunkOutputs) {
    const section = output.split(/^##\s*逐章\s*$/m)[1] ?? ''
    for (const line of section.split('\n')) {
      const match = line.match(/^\s*[-*]\s*(\d{4})\s*(.*?)[：:]\s*(.+)$/)
      if (!match) continue
      const summary = match[3].trim()
      if (summary) found.set(match[1], summary)
    }
  }
  return found
}

/** 解析已有大纲文件的逐章行 */
export function parseOutlineFile(content: string): Map<string, string> {
  const map = new Map<string, string>()
  for (const line of content.split('\n')) {
    const match = line.match(/^- (\d{4}) (.*?)[：:]\s*(.+)$/)
    if (match) map.set(match[1], match[3].trim())
  }
  return map
}

function buildOutline(map: Map<string, string>, titleByKey: Map<string, string>): string {
  const keys = [...map.keys()].sort()
  const lines = keys.map((key) => `- ${key} ${titleByKey.get(key) ?? ''}：${map.get(key) ?? '（待补充）'}`.replace(/：\s*：/, '：'))
  return `# 逐章大纲\n\n${lines.join('\n')}\n`
}

interface MergePrompts {
  summary: string
  world: string
  status: string
}

function buildMergePrompts(params: {
  bookTitle: string
  mode: 'full' | 'incremental'
  merged: string
  existing: { summary: string; world: string; status: string }
}): MergePrompts {
  const { bookTitle, mode, merged, existing } = params
  const header = mergeHeader(bookTitle)

  if (mode === 'incremental') {
    return {
      summary: `${header}

下面是这本书已有的《剧情总纲》：

${existing.summary}

下面是新增章节的要点：

${merged}

请输出**更新后的完整《剧情总纲》**，结构保持不变：

# 剧情总纲

## 已发生
按时间顺序列出全部关键事件（保留原有条目，把新增事件接在后面）。

## 当前进度
更新为最新进度。

## 待推进
保留仍然成立的伏笔，补充新增的。

要求：必须把「新增章节的要点」里的每一条事件并入「已发生」，不允许只复述已有内容；只写要点里的内容；总长不超过 1800 字。`,
      world: `${header}

下面是已有的《世界模型》：

${existing.world}

下面是新增章节的要点：

${merged}

请输出**更新后的完整《世界模型》**，结构保持不变，只把新增的设定合并进去，不要删掉已有条目：

# 世界模型

## 读者承诺与主轴
## 力量 / 规则体系
## 势力与地理
## 硬约束

要求：必须把「新增章节的要点」里的每一条设定并入结果，不允许只复述已有内容；只使用要点中的信息；总长不超过 2000 字。`,
      status: `${header}

下面是旧的《状态卡》：

${existing.status}

下面是新增章节的要点：

${merged}

请输出**滚动更新后的《状态卡》**（表示最新时点的状态，过时的状态删掉或更新）：

# 状态卡

## 当前时间与地点
## 人物状态
## 最近事件

要求：状态必须推进到最新时点（旧状态过时就更新或删除），纳入新增要点里的状态变化；不确定写"待补充"；总长不超过 900 字。`,
    }
  }

  return {
    summary: `${header}

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
    world: `${header}

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
    status: `${header}

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
  }
}

function noopReport(): KnowledgeInitReport {
  return {
    mode: 'noop',
    chapters: 0,
    chunks: 0,
    cost: 0,
    inputTokens: 0,
    outputTokens: 0,
    files: [],
    skippedChapters: 0,
    pendingChapters: 0,
  }
}

export async function runKnowledgeInit(options: KnowledgeInitOptions): Promise<KnowledgeInitReport> {
  const git = options.git ?? createGitPort()
  const maxChapters = options.maxChapters ?? MAX_CHAPTERS
  const allChapters = options.chapters.filter((chapter) => chapter.content.trim().length > 0).sort((a, b) => a.key.localeCompare(b.key))
  if (allChapters.length === 0) {
    throw new Error('没有可整理的章节')
  }

  const state = loadPipelineState(options.bookDir)
  const forceFull = options.mode === 'full'
  const mode: 'full' | 'incremental' = !forceFull && state ? 'incremental' : 'full'

  const pending = mode === 'incremental' ? allChapters.filter((chapter) => chapter.key > state!.lastChapterKey) : allChapters
  if (mode === 'incremental' && pending.length === 0) {
    return noopReport()
  }

  const targets = pending.slice(0, maxChapters)
  const skipped = pending.length - targets.length
  const chunks = planChunks(targets, options.maxChunkChars)
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
      message: `${mode === 'incremental' ? '更新' : '整理'}第 ${chunk[0].key}–${chunk[chunk.length - 1].key} 章`,
    })
    chunkOutputs.push(await complete(buildChunkPrompt(options.bookTitle, chunk, index + 1, chunks.length)))
  }

  // 调试留痕：记录本次分块输出，出问题可以直接看模型到底返回了什么（.studio 已被忽略）
  try {
    const debugDir = path.join(options.bookDir, '.studio', 'pipeline-debug')
    ensureDir(debugDir)
    writeFileAtomic(
      path.join(debugDir, 'last-run.json'),
      JSON.stringify({ mode, at: new Date().toISOString(), chunkOutputs }, null, 2),
    )
  } catch {
    // 调试文件失败不影响主流程
  }

  const merged = chunkOutputs.join('\n\n---\n\n')
  const existingFiles = {
    summary: readFileOrNull(path.join(options.bookDir, 'summary.md')) ?? '',
    world: readFileOrNull(path.join(options.bookDir, 'world_model.md')) ?? '',
    status: readFileOrNull(path.join(options.bookDir, 'status_card.md')) ?? '',
    outline: readFileOrNull(path.join(options.bookDir, 'chapter_outline.md')) ?? '',
  }

  const prompts = buildMergePrompts({
    bookTitle: options.bookTitle,
    mode,
    merged,
    existing: { summary: existingFiles.summary, world: existingFiles.world, status: existingFiles.status },
  })

  options.onProgress?.({ phase: 'merge', current: 1, total: 3, message: '生成剧情总纲' })
  const summaryText = await complete(prompts.summary)

  options.onProgress?.({ phase: 'merge', current: 2, total: 3, message: '生成世界模型' })
  const worldText = await complete(prompts.world)

  options.onProgress?.({ phase: 'merge', current: 3, total: 3, message: '生成状态卡' })
  const statusText = await complete(prompts.status)

  // 逐章大纲：增量时合并已有行，按章节号排序
  const titleByKey = new Map(allChapters.map((chapter) => [chapter.key, chapter.title]))
  const outlineMap =
    mode === 'incremental' ? parseOutlineFile(existingFiles.outline) : new Map<string, string>()
  for (const [key, summary] of extractChapterLineMap(chunkOutputs)) {
    outlineMap.set(key, summary)
  }
  for (const chapter of targets) {
    if (!titleByKey.has(chapter.key)) titleByKey.set(chapter.key, chapter.title)
    // 模型偶尔漏掉「逐章」小节：至少保证每一章在大纲里有位置，标成待补充
    if (!outlineMap.has(chapter.key)) outlineMap.set(chapter.key, '（待补充）')
  }
  const outlineText = buildOutline(outlineMap, titleByKey)

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
  const fromChapter = targets[0].key
  const toChapter = targets[targets.length - 1].key
  const range = fromChapter === toChapter ? `第 ${fromChapter} 章` : `第 ${fromChapter}–${toChapter} 章`
  const message =
    mode === 'incremental'
      ? `[知识] 增量更新：${range}`
      : `[知识] 初始化：剧情总纲 / 世界模型 / 状态卡 / 逐章大纲（${targets.length} 章）`
  await git.commitPaths(
    options.bookDir,
    files.map(([name]) => name),
    message,
  )

  savePipelineState(options.bookDir, {
    version: 1,
    updatedAt: new Date().toISOString(),
    lastChapterKey: allChapters[allChapters.length - 1].key,
    chapterCount: allChapters.length,
    costTotal: (state?.costTotal ?? 0) + cost,
  })

  return {
    mode,
    chapters: targets.length,
    chunks: chunks.length,
    cost,
    inputTokens,
    outputTokens,
    files: files.map(([name]) => name),
    skippedChapters: skipped,
    fromChapter,
    toChapter,
    pendingChapters: pending.length,
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

/**
 * 一致性检查（只读审稿）：
 * - 把目标章节分批 + 知识设定一起交给模型，找出「设定矛盾 / 时间线冲突 / 人物状态前后不一致 / 剧情硬伤」；
 * - 只输出问题清单，不写正文、不改知识文件、不自动落盘任何书稿；
 * - 报告写到 .studio/reviews/ 下（Markdown，供作者回看），书稿与 Git 历史不变。
 */
import fs from 'node:fs'
import path from 'node:path'
import { KNOWLEDGE_FILES, readFileOrNull } from '../core'
import type {
  ReviewCategory,
  ReviewIssue,
  ReviewReportSummary,
  ReviewSeverity,
} from '../shared/pipeline'
import { loadPipelineChapters, type PipelineChapter } from './knowledge'

export interface ReviewRequest {
  bookDir: string
  bookTitle: string
  fromChapter?: number
  toChapter?: number
  focus?: string
  /** 单次最多检查多少章（默认 120，超出取范围内最近的部分） */
  maxChapters?: number
}

export interface ReviewDeps {
  complete: (prompt: string) => Promise<{ text: string; cost: number; input: number; output: number }>
  onProgress?: (message: string) => void
}

export interface ReviewResult extends ReviewReportSummary {
  /** 供 host 写入 .studio/reviews 的 Markdown 报告 */
  reportMarkdown: string
}

const DEFAULT_MAX_CHAPTERS = 120
const BATCH_CHAPTERS = 6
const BATCH_CHARS = 9_000
const CHAPTER_CAP = 12_000
const KNOWLEDGE_CAP = 10_000
const KNOWLEDGE_FILE_CAP = 1_800
const KNOWLEDGE_KEYS = new Set([
  'world_model.md',
  'status_card.md',
  'characters.md',
  'locations.md',
  'factions.md',
  'chapter_outline.md',
  'volume_summary.md',
  'master_outline.md',
  'arc_outline.md',
  'plot_synopsis.md',
])
const SEVERITIES: ReviewSeverity[] = ['high', 'medium', 'low']
const CATEGORIES: ReviewCategory[] = ['character', 'timeline', 'setting', 'plot', 'other']

function hasMeaningfulContent(content: string): boolean {
  const plain = content.replace(/^#.*$/gm, '').replace(/^\s*[-*+]\s*$/gm, '').replace(/[\s\-*+>#]/g, '')
  return plain.length >= 10
}

function stripFences(text: string): string {
  return text
    .replace(/^\s*```(?:json)?\s*/i, '')
    .replace(/\s*```\s*$/, '')
    .trim()
}

/** 把模型输出解析成问题数组；容忍前后解释文字与代码围栏 */
export function parseReviewIssues(text: string): Array<Record<string, unknown>> {
  const cleaned = stripFences(text)
  const start = cleaned.indexOf('{')
  const end = cleaned.lastIndexOf('}')
  if (start < 0 || end <= start) throw new Error('模型没有返回 JSON 结构')
  let parsed: unknown
  try {
    parsed = JSON.parse(cleaned.slice(start, end + 1))
  } catch (err) {
    throw new Error(`一致性 JSON 解析失败：${(err as Error).message}`)
  }
  const data = parsed as { issues?: unknown }
  if (!Array.isArray(data?.issues)) throw new Error('模型没有返回 issues 数组')
  return data.issues.filter((item): item is Record<string, unknown> => Boolean(item && typeof item === 'object'))
}

function normalizeIssue(
  raw: Record<string, unknown>,
  index: number,
): ReviewIssue | null {
  const title = typeof raw.title === 'string' ? raw.title.trim().slice(0, 160) : ''
  const detail = typeof raw.detail === 'string' ? raw.detail.trim().slice(0, 1_200) : ''
  if (!title || !detail) return null
  const severity = SEVERITIES.includes(raw.severity as ReviewSeverity)
    ? (raw.severity as ReviewSeverity)
    : 'medium'
  const category = CATEGORIES.includes(raw.category as ReviewCategory)
    ? (raw.category as ReviewCategory)
    : 'other'
  const locations = Array.isArray(raw.locations)
    ? raw.locations
        .filter((item): item is string => typeof item === 'string' && item.trim().length > 0)
        .map((item) => item.trim().slice(0, 120))
        .slice(0, 8)
    : []
  const suggestion = typeof raw.suggestion === 'string' ? raw.suggestion.trim().slice(0, 600) : ''
  return {
    id: `issue-${index + 1}`,
    severity,
    category,
    title,
    detail,
    locations,
    ...(suggestion ? { suggestion } : {}),
  }
}

function loadKnowledgeSources(bookDir: string): Array<{ title: string; content: string }> {
  return KNOWLEDGE_FILES.filter((file) => KNOWLEDGE_KEYS.has(file.name))
    .map((file) => ({
      title: file.title,
      content: readFileOrNull(path.join(bookDir, file.name)) ?? '',
    }))
    .filter((file) => hasMeaningfulContent(file.content))
    .map((file) => ({
      title: file.title,
      content: file.content.slice(0, KNOWLEDGE_FILE_CAP),
    }))
}

function knowledgeBlock(sources: Array<{ title: string; content: string }>): string {
  if (sources.length === 0) return '（知识库还没有可用设定）'
  let budget = KNOWLEDGE_CAP
  const blocks: string[] = []
  for (const source of sources) {
    if (budget <= 0) break
    const content = source.content.slice(0, budget)
    budget -= content.length
    blocks.push(`### ${source.title}\n${content}`)
  }
  return blocks.join('\n\n')
}

export function buildReviewPrompt(params: {
  bookTitle: string
  knowledge: string
  chapters: PipelineChapter[]
  focus?: string
  knownIssues?: string[]
}): string {
  const chapterText = params.chapters
    .map((chapter) => {
      const content = chapter.content.trim().slice(0, CHAPTER_CAP)
      return `#### 第 ${Number(chapter.key)} 章 ${chapter.title}\n${content}`
    })
    .join('\n\n')
  const focus = params.focus?.trim()
    ? `\n作者特别关注：${params.focus.trim().slice(0, 500)}\n`
    : ''
  const known =
    params.knownIssues && params.knownIssues.length > 0
      ? `\n已在前几批发现（不要重复报告）：\n${params.knownIssues.map((item) => `- ${item}`).join('\n')}\n`
      : ''
  return `你是资深网文责编，只做「一致性检查」，不改写、不评价文风、不发明新设定。

书名：《${params.bookTitle}》

【设定资料（知识库）】
${params.knowledge}

【本轮待检查章节】
${chapterText}
${focus}${known}
【检查范围】
- 人物：年龄、身份、称谓、能力、关系、随身物品是否前后矛盾；
- 时间线：事件先后、耗时、季节/天气、地点移动是否冲突；
- 设定：力量体系、地理、势力规则是否被违反；
- 剧情：前后因果、伏笔与回收、已知事实是否被推翻。

【硬性要求】
1. 只报告**有文本依据**的问题，必须能指到具体章节/设定卡；推测性的"可能"不要报；
2. 不评价文笔、节奏、爽点，不提修改后的正文；
3. 严重程度：high=直接矛盾/硬伤，medium=可能冲突但需作者确认，low=细节不一致；
4. 严格输出 JSON（不要 Markdown 代码围栏）：
{"issues":[{"severity":"high|medium|low","category":"character|timeline|setting|plot|other","title":"一句话问题","detail":"依据：哪一章/哪张卡写了什么，和哪一处冲突","locations":["第 3 章","人物卡·林牧"],"suggestion":"给作者的核对/修复建议（不要写正文）"}]}
没有问题时输出 {"issues":[]}。`
}

export function buildReviewMarkdown(params: {
  bookTitle: string
  issues: ReviewIssue[]
  checkedChapters: number
  totalChapters: number
  checkedKnowledge: number
  cost: number
  fromChapter?: number
  toChapter?: number
}): string {
  const time = new Date().toISOString()
  const range =
    params.fromChapter || params.toChapter
      ? `第 ${params.fromChapter ?? 1}–${params.toChapter ?? '末'} 章`
      : '全书'
  const lines = [
    `# 一致性检查报告 ·《${params.bookTitle}》`,
    '',
    `- 生成时间：${time}`,
    `- 检查范围：${range}`,
    `- 检查章节：${params.checkedChapters} / ${params.totalChapters} 章`,
    `- 参考知识文件：${params.checkedKnowledge} 份`,
    `- 本次成本：$${params.cost.toFixed(4)}`,
    '',
  ]
  if (params.issues.length === 0) {
    lines.push('没有发现明显的一致性问题。', '')
    return lines.join('\n')
  }
  const labels: Record<ReviewSeverity, string> = { high: '高优先级（直接矛盾/硬伤）', medium: '中优先级（需核对）', low: '低优先级（细节）' }
  for (const severity of SEVERITIES) {
    const group = params.issues.filter((issue) => issue.severity === severity)
    if (group.length === 0) continue
    lines.push(`## ${labels[severity]}（${group.length}）`, '')
    group.forEach((issue, index) => {
      lines.push(`### ${index + 1}. ${issue.title}`, '')
      if (issue.locations.length > 0) lines.push(`- 位置：${issue.locations.join('、')}`)
      lines.push(`- 说明：${issue.detail}`)
      if (issue.suggestion) lines.push(`- 建议：${issue.suggestion}`)
      lines.push('')
    })
  }
  lines.push('> 说明：本报告只做检查，不修改书稿与知识文件；是否修改由作者决定。', '')
  return lines.join('\n')
}

export async function runConsistencyReview(
  request: ReviewRequest,
  deps: ReviewDeps,
): Promise<ReviewResult> {
  const allChapters = loadPipelineChapters(request.bookDir)
  if (allChapters.length === 0) throw new Error('这本书还没有正式章节，无法检查')

  const from = Number.isFinite(request.fromChapter) ? Number(request.fromChapter) : undefined
  const to = Number.isFinite(request.toChapter) ? Number(request.toChapter) : undefined
  let selected = allChapters.filter((chapter) => {
    const number = Number(chapter.key)
    if (from !== undefined && number < from) return false
    if (to !== undefined && number > to) return false
    return true
  })
  if (selected.length === 0) throw new Error('所选章节范围内没有正文')

  const maxChapters = Math.max(6, Math.min(request.maxChapters ?? DEFAULT_MAX_CHAPTERS, 400))
  let truncated = false
  if (selected.length > maxChapters) {
    selected = selected.slice(selected.length - maxChapters)
    truncated = true
  }

  const knowledge = loadKnowledgeSources(request.bookDir)
  const knowledgeText = knowledgeBlock(knowledge)
  deps.onProgress?.(`读取 ${selected.length} 章与 ${knowledge.length} 份设定…`)

  const batches: PipelineChapter[][] = []
  let current: PipelineChapter[] = []
  let currentChars = 0
  for (const chapter of selected) {
    const size = Math.min(chapter.content.length, CHAPTER_CAP)
    if (current.length > 0 && (current.length >= BATCH_CHAPTERS || currentChars + size > BATCH_CHARS)) {
      batches.push(current)
      current = []
      currentChars = 0
    }
    current.push(chapter)
    currentChars += size
  }
  if (current.length > 0) batches.push(current)

  let cost = 0
  let inputTokens = 0
  let outputTokens = 0
  const issues: ReviewIssue[] = []
  const warnings: string[] = []
  const knownTitles: string[] = []

  for (let index = 0; index < batches.length; index += 1) {
    const batch = batches[index]
    const label = `第 ${Number(batch[0].key)}–${Number(batch[batch.length - 1].key)} 章`
    deps.onProgress?.(`检查 ${label}（${index + 1}/${batches.length}）…`)
    const prompt = buildReviewPrompt({
      bookTitle: request.bookTitle,
      knowledge: knowledgeText,
      chapters: batch,
      focus: request.focus,
      knownIssues: knownTitles.slice(-20),
    })
    try {
      const response = await deps.complete(prompt)
      cost += response.cost
      inputTokens += response.input
      outputTokens += response.output
      const rawIssues = parseReviewIssues(response.text)
      for (const raw of rawIssues) {
        const issue = normalizeIssue(raw, issues.length)
        if (!issue) continue
        const key = `${issue.title.replace(/\s+/g, '')}|${issue.locations.slice().sort().join(',')}`
        const exists = issues.find(
          (item) => `${item.title.replace(/\s+/g, '')}|${item.locations.slice().sort().join(',')}` === key,
        )
        if (exists) continue
        issues.push(issue)
        if (knownTitles.length < 40) knownTitles.push(issue.title)
      }
    } catch (err) {
      warnings.push(`${label}：${(err as Error).message}`)
    }
  }

  if (issues.length === 0 && warnings.length === batches.length) {
    throw new Error(`一致性检查失败：${warnings[warnings.length - 1]}`)
  }

  const reportMarkdown = buildReviewMarkdown({
    bookTitle: request.bookTitle,
    issues,
    checkedChapters: selected.length,
    totalChapters: allChapters.length,
    checkedKnowledge: knowledge.length,
    cost,
    fromChapter: from,
    toChapter: to,
  })

  return {
    issues,
    checkedChapters: selected.length,
    totalChapters: allChapters.length,
    truncated,
    checkedKnowledge: knowledge.length,
    batches: batches.length,
    warnings,
    cost,
    inputTokens,
    outputTokens,
    reportMarkdown,
    ...(from !== undefined ? { fromChapter: from } : {}),
    ...(to !== undefined ? { toChapter: to } : {}),
  }
}

/** 供 host 使用的报告写入：.studio/reviews/review-<stamp>.md（不提交 Git） */
export function writeReviewReport(bookDir: string, markdown: string): string {
  const dir = path.join(bookDir, '.studio', 'reviews')
  fs.mkdirSync(dir, { recursive: true })
  const stamp = new Date().toISOString().replace(/[-:T]/g, '').slice(0, 14)
  const file = path.join(dir, `review-${stamp}.md`)
  fs.writeFileSync(file, markdown, 'utf8')
  return path.relative(bookDir, file).replace(/\\/g, '/')
}

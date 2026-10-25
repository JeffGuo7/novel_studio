/**
 * 文风初始化：从已有章节里提取
 * - 文风指南（模型解读：句式、视角、对话、意象、禁忌）
 * - 文风指纹（本地量化指标 + 模型解读）
 *
 * 量化指标不花模型调用，先在本地算好，再让模型基于指标和样本给建议。
 */
import type { PipelineChapter } from './knowledge'

export interface StyleMetrics {
  chapterCount: number
  totalChars: number
  sentenceCount: number
  avgSentenceChars: number
  paragraphCount: number
  avgParagraphChars: number
  dialogueRatio: number
  punctuationPer100: number
  person: 'first' | 'third' | 'mixed' | 'unknown'
  topPhrases: string[]
}

const SENTENCE_END = /[。！？!?…]+/
const STOP_CHARS = new Set(
  '的了是在不我他她它你们这那有和就都而及与着过被把给对从向于为以之所其或也又还很更最没有会能可要中上下里个么什怎'.split(''),
)

/** 去掉 Markdown 标记，只留正文 */
function plainText(content: string): string {
  return content
    .replace(/^#{1,6}\s*/gm, '')
    .replace(/^[>*\-+]\s*/gm, '')
    .replace(/`{1,3}[^`]*`{1,3}/g, '')
    .replace(/\r/g, '')
}

function splitParagraphs(text: string): string[] {
  return text
    .split(/\n{2,}/)
    .map((item) => item.trim())
    .filter(Boolean)
}

function extractTopPhrases(text: string, limit = 12): string[] {
  const counts = new Map<string, number>()
  const cjk = text.replace(/[^\u4e00-\u9fa5]/g, ' ')
  for (const run of cjk.split(/\s+/)) {
    if (run.length < 2) continue
    for (let size = 2; size <= 3; size += 1) {
      for (let index = 0; index + size <= run.length; index += 1) {
        const gram = run.slice(index, index + size)
        if ([...gram].some((char) => STOP_CHARS.has(char))) continue
        counts.set(gram, (counts.get(gram) ?? 0) + 1)
      }
    }
  }
  const sorted = [...counts.entries()].sort((a, b) => b[1] - a[1])
  const picked: string[] = []
  for (const [phrase, count] of sorted) {
    if (count < 3) break
    // 去掉被更长短语完全包含的短词
    if (picked.some((item) => item.includes(phrase) && item !== phrase)) continue
    picked.push(phrase)
    if (picked.length >= limit) break
  }
  return picked
}

export function computeStyleMetrics(chapters: PipelineChapter[]): StyleMetrics {
  const texts = chapters.map((chapter) => plainText(chapter.content))
  const fullText = texts.join('\n\n')
  const totalChars = fullText.replace(/\s/g, '').length

  const sentences = fullText
    .split(SENTENCE_END)
    .map((item) => item.replace(/\s/g, ''))
    .filter((item) => item.length > 0)
  const paragraphs = splitParagraphs(fullText)

  const dialogueMatches = fullText.match(/[「“][^」”]{1,500}[」”]/g) ?? []
  const dialogueChars = dialogueMatches.join('').replace(/\s/g, '').length

  const punctuationMatches = fullText.match(/[，。！？、；：…—,.!?;:]/g) ?? []

  const first = (fullText.match(/[我咱]/g) ?? []).length
  const third = (fullText.match(/[他她]/g) ?? []).length
  let person: StyleMetrics['person'] = 'unknown'
  if (first + third > 0) {
    const ratio = first / (first + third)
    person = ratio > 0.75 ? 'first' : ratio < 0.25 ? 'third' : 'mixed'
  }

  return {
    chapterCount: chapters.length,
    totalChars,
    sentenceCount: sentences.length,
    avgSentenceChars: sentences.length ? Math.round((totalChars / sentences.length) * 10) / 10 : 0,
    paragraphCount: paragraphs.length,
    avgParagraphChars: paragraphs.length
      ? Math.round((totalChars / paragraphs.length) * 10) / 10
      : 0,
    dialogueRatio: totalChars ? Math.round((dialogueChars / totalChars) * 1000) / 10 : 0,
    punctuationPer100: totalChars
      ? Math.round((punctuationMatches.length / totalChars) * 1000) / 10
      : 0,
    person,
    topPhrases: extractTopPhrases(fullText),
  }
}

function personLabel(person: StyleMetrics['person']): string {
  switch (person) {
    case 'first':
      return '第一人称'
    case 'third':
      return '第三人称'
    case 'mixed':
      return '混合（人称为主，需模型确认）'
    default:
      return '未识别'
  }
}

export function renderMetricsTable(metrics: StyleMetrics): string {
  return [
    '| 指标 | 值 |',
    '|---|---|',
    `| 统计章节 | ${metrics.chapterCount} 章 |`,
    `| 正文字数（不含空白） | ${metrics.totalChars} 字 |`,
    `| 平均句长 | ${metrics.avgSentenceChars} 字 |`,
    `| 平均段长 | ${metrics.avgParagraphChars} 字 |`,
    `| 对话占比 | ${metrics.dialogueRatio}% |`,
    `| 每 100 字标点数 | ${metrics.punctuationPer100} |`,
    `| 人称倾向 | ${personLabel(metrics.person)} |`,
    `| 高频意象 / 用词 | ${metrics.topPhrases.slice(0, 10).join('、') || '—'} |`,
  ].join('\n')
}

/**
 * 抽样：开头一章取前 2k，中间两处各 2k，结尾一章取后 4k。
 * 文风分析不需要整本，抽样足够稳定，也避免成本随书变长。
 */
export function sampleStyleText(chapters: PipelineChapter[], maxChars = 12_000): string {
  if (chapters.length === 0) return ''
  const take = (chapter: PipelineChapter, from: 'head' | 'tail', limit: number): string => {
    const content = plainText(chapter.content)
    return from === 'head' ? content.slice(0, limit) : content.slice(Math.max(0, content.length - limit))
  }
  const parts: string[] = []
  parts.push(take(chapters[0], 'head', 4000))
  if (chapters.length > 2) {
    const middle = chapters[Math.floor(chapters.length / 2)]
    parts.push(take(middle, 'head', 3000))
  }
  if (chapters.length > 1) {
    parts.push(take(chapters[chapters.length - 1], 'tail', 4000))
  }
  return parts.join('\n\n……\n\n').slice(0, maxChars)
}

export function buildStylePrompt(params: {
  bookTitle: string
  metrics: StyleMetrics
  sample: string
}): string {
  const { bookTitle, metrics, sample } = params
  return `你是《${bookTitle}》的文风分析师。下面是本书的量化指标与正文抽样。

量化指标：
${renderMetricsTable(metrics)}

正文抽样：
${sample}

请严格输出两节，不要寒暄：

## 文风指南
### 句式与节奏
（3-5 条：句子长短、断句习惯、段落推进方式）
### 叙事视角与人称
（2-3 条：视角、时间线处理、内心描写尺度）
### 对话
（2-4 条：对话密度、语气、是否用提示语）
### 意象与用词
（3-5 条：反复出现的意象、偏好的动词/名词、忌讳的用词）
### 禁忌写法
（3-5 条：这本书明显不用的写法，续写时必须避免）

## 文风指纹解读
（用 3-5 句话解读上面的量化指标：这种句式/段落/对话比例带来什么阅读感受，续写时应该守住哪些数字）

要求：只基于抽样和指标归纳，不要评价好坏，不要编造书里没有的设定。`
}

/** 把模型输出拆成「文风指南」和「文风指纹解读」两段 */
export function splitStyleOutput(text: string): { guide: string; interpretation: string } {
  const guideIndex = text.indexOf('## 文风指南')
  const fingerprintIndex = text.indexOf('## 文风指纹解读')
  if (guideIndex === -1 && fingerprintIndex === -1) {
    return { guide: text.trim(), interpretation: '' }
  }
  let guide = ''
  let interpretation = ''
  if (guideIndex !== -1) {
    const end = fingerprintIndex > guideIndex ? fingerprintIndex : text.length
    guide = text.slice(guideIndex + '## 文风指南'.length, end).trim()
  }
  if (fingerprintIndex !== -1) {
    interpretation = text.slice(fingerprintIndex + '## 文风指纹解读'.length).trim()
  }
  return { guide, interpretation }
}

export function renderStyleGuide(guide: string): string {
  return `# 文风指南\n\n${guide || '（待补充：需要更多正文才能归纳）'}\n`
}

export function renderStyleFingerprint(metrics: StyleMetrics, interpretation: string): string {
  return `# 文风指纹\n\n## 量化指标\n\n${renderMetricsTable(metrics)}\n\n## 解读\n\n${
    interpretation || '（待补充）'
  }\n\n> 指标由本地统计得出，可随章节更新重新计算；「解读」部分由模型生成。\n`
}

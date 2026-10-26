/**
 * 文风指标的纯函数实现（不依赖 Node / fs），
 * 供知识管线、主进程 IPC、渲染进程共用。
 */
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

export interface StyleDriftWarning {
  field: 'avgSentenceChars' | 'avgParagraphChars' | 'dialogueRatio' | 'punctuationPer100'
  label: string
  baseline: number
  current: number
  /** 相对基线变化的百分比（对话占比使用绝对百分点差） */
  delta: number
  message: string
}

export interface StyleDriftThresholds {
  sentencePct?: number
  paragraphPct?: number
  dialoguePoints?: number
  punctuationPct?: number
}

const SENTENCE_END = /[。！？!?…]+/
const STOP_CHARS = new Set(
  '的了是在不我他她它你们这那有和就都而及与着过被把给对从向于为以之所其或也又还很更最没有会能可要中上下里个么什怎'.split(''),
)

export function plainText(content: string): string {
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
    if (picked.some((item) => item.includes(phrase) && item !== phrase)) continue
    picked.push(phrase)
    if (picked.length >= limit) break
  }
  return picked
}

export interface StyleText {
  content: string
}

export function computeStyleMetrics(
  chapters: Array<{ key?: string; title?: string; content: string }>,
): StyleMetrics {
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
    avgParagraphChars: paragraphs.length ? Math.round((totalChars / paragraphs.length) * 10) / 10 : 0,
    dialogueRatio: totalChars ? Math.round((dialogueChars / totalChars) * 1000) / 10 : 0,
    punctuationPer100: totalChars
      ? Math.round((punctuationMatches.length / totalChars) * 1000) / 10
      : 0,
    person,
    topPhrases: extractTopPhrases(fullText),
  }
}

export function personLabel(person: StyleMetrics['person']): string {
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

/** 从 style_fingerprint.md 的指标表里解析出可比较的数值 */
export function parseFingerprintMetrics(content: string): Partial<StyleMetrics> {
  const result: Partial<StyleMetrics> = {}
  const number = (value: string): number | undefined => {
    const match = value.replace(/[^\d.]/g, '').match(/([\d.]+)/)
    return match ? Number(match[1]) : undefined
  }
  for (const line of content.split('\n')) {
    if (!line.trim().startsWith('|')) continue
    if (line.includes('平均句长')) result.avgSentenceChars = number(line.split('|')[2] ?? line)
    else if (line.includes('平均段长')) result.avgParagraphChars = number(line.split('|')[2] ?? line)
    else if (line.includes('对话占比')) result.dialogueRatio = number(line.split('|')[2] ?? line)
    else if (line.includes('每 100 字标点数')) result.punctuationPer100 = number(line.split('|')[2] ?? line)
  }
  return result
}

function pctDelta(current: number, baseline: number): number {
  if (baseline <= 0) return 0
  return Math.round(((current - baseline) / baseline) * 1000) / 10
}

export function compareStyleMetrics(
  baseline: Partial<StyleMetrics>,
  current: StyleMetrics,
  thresholds: StyleDriftThresholds = {},
): StyleDriftWarning[] {
  const sentencePct = thresholds.sentencePct ?? 30
  const paragraphPct = thresholds.paragraphPct ?? 40
  const dialoguePoints = thresholds.dialoguePoints ?? 15
  const punctuationPct = thresholds.punctuationPct ?? 35
  const warnings: StyleDriftWarning[] = []

  const checkPct = (
    field: 'avgSentenceChars' | 'avgParagraphChars' | 'punctuationPer100',
    label: string,
    limitPct: number,
    unit: string,
  ) => {
    const base = baseline[field]
    if (typeof base !== 'number' || base <= 0) return
    const value = current[field]
    const delta = pctDelta(value, base)
    if (Math.abs(delta) < limitPct) return
    const sign = delta > 0 ? '+' : ''
    warnings.push({
      field,
      label,
      baseline: base,
      current: value,
      delta,
      message: `${label} ${value} ${unit}，文风指纹是 ${base} ${unit}（${sign}${delta}%）`,
    })
  }

  checkPct('avgSentenceChars', '平均句长', sentencePct, '字')
  checkPct('avgParagraphChars', '平均段长', paragraphPct, '字')
  checkPct('punctuationPer100', '每 100 字标点数', punctuationPct, '个')

  if (typeof baseline.dialogueRatio === 'number' && baseline.dialogueRatio > 0) {
    const diff = Math.round((current.dialogueRatio - baseline.dialogueRatio) * 10) / 10
    if (Math.abs(diff) >= dialoguePoints) {
      const sign = diff > 0 ? '+' : ''
      warnings.push({
        field: 'dialogueRatio',
        label: '对话占比',
        baseline: baseline.dialogueRatio,
        current: current.dialogueRatio,
        delta: diff,
        message: `对话占比 ${current.dialogueRatio}%，文风指纹是 ${baseline.dialogueRatio}%（${sign}${diff} 个百分点）`,
      })
    }
  }

  return warnings.sort((a, b) => Math.abs(b.delta) - Math.abs(a.delta))
}

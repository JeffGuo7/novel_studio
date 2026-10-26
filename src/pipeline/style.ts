/**
 * 文风初始化：从已有章节里提取
 * - 文风指南（模型解读：句式、视角、对话、意象、禁忌）
 * - 文风指纹（本地量化指标 + 模型解读）
 *
 * 量化指标与漂移比较的纯函数在 src/shared/style.ts（渲染进程也要用），
 * 这里只保留需要 Node / 提示词的部分。
 */
import { plainText, renderMetricsTable, type StyleMetrics } from '../shared/style'
import type { PipelineChapter } from './knowledge'

export type { StyleMetrics } from '../shared/style'
export {
  compareStyleMetrics,
  computeStyleMetrics,
  parseFingerprintMetrics,
  renderMetricsTable,
} from '../shared/style'

/**
 * 抽样：开头一章取前 4k，中间一章取 3k，结尾一章取后 4k。
 * 文风分析不需要整本，抽样足够稳定，也避免成本随书变长。
 */
export function sampleStyleText(chapters: PipelineChapter[], maxChars = 12_000): string {
  if (chapters.length === 0) return ''
  const take = (chapter: PipelineChapter, from: 'head' | 'tail', limit: number): string => {
    const content = plainText(chapter.content)
    return from === 'head'
      ? content.slice(0, limit)
      : content.slice(Math.max(0, content.length - limit))
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

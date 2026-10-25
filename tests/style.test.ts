import { describe, expect, it } from 'vitest'
import {
  buildStylePrompt,
  computeStyleMetrics,
  renderMetricsTable,
  renderStyleFingerprint,
  renderStyleGuide,
  sampleStyleText,
  splitStyleOutput,
} from '../src/pipeline/style'

const CHAPTERS = [
  {
    key: '0001',
    title: '雾夜渡客',
    content:
      '# 第一章\n\n雾是从水面长出来的。林牧把篙插进水里。\n\n「渡么？」\n\n他没有回答。雾里有人招手。林牧没有回头。\n\n雾越来越浓，林牧握紧了篙。',
  },
  {
    key: '0002',
    title: '七日之限',
    content:
      '# 第二章\n\n镇渊司的封条贴在船头。青袍人说七日内补交三倍渡税。林牧低头看着封条，没有说话。\n\n「七天。」青袍人又说了一遍。',
  },
]

describe('文风量化指标', () => {
  it('统计句长、段长、对话占比与人称', () => {
    const metrics = computeStyleMetrics(CHAPTERS)
    expect(metrics.chapterCount).toBe(2)
    expect(metrics.totalChars).toBeGreaterThan(60)
    expect(metrics.sentenceCount).toBeGreaterThan(3)
    expect(metrics.avgSentenceChars).toBeGreaterThan(0)
    expect(metrics.avgParagraphChars).toBeGreaterThan(metrics.avgSentenceChars)
    expect(metrics.dialogueRatio).toBeGreaterThan(0)
    expect(metrics.punctuationPer100).toBeGreaterThan(0)
    // 文本里大量出现「他」，应判为第三人称
    expect(metrics.person).toBe('third')
  })

  it('高频意象能抓到重复出现的词', () => {
    const metrics = computeStyleMetrics(CHAPTERS)
    expect(metrics.topPhrases.join('、')).toContain('林牧')
  })

  it('指标表与指纹文件包含关键字段', () => {
    const metrics = computeStyleMetrics(CHAPTERS)
    const table = renderMetricsTable(metrics)
    expect(table).toContain('平均句长')
    expect(table).toContain('对话占比')
    expect(table).toContain('人称倾向')

    const fingerprint = renderStyleFingerprint(metrics, '节奏偏快。')
    expect(fingerprint).toContain('# 文风指纹')
    expect(fingerprint).toContain('## 量化指标')
    expect(fingerprint).toContain('## 解读')
    expect(fingerprint).toContain('节奏偏快。')
  })

  it('指南为空时有占位而不是空文件', () => {
    expect(renderStyleGuide('')).toContain('待补充')
  })
})

describe('文风抽样与解析', () => {
  it('抽样不超过上限，且包含开头与结尾', () => {
    const longChapters = CHAPTERS.map((chapter) => ({ ...chapter, content: chapter.content.repeat(200) }))
    const sample = sampleStyleText(longChapters, 5000)
    expect(sample.length).toBeLessThanOrEqual(5000)
    expect(sample).toContain('雾是从水面长出来的')
    expect(sample).toContain('镇渊司的封条')
  })

  it('解析模型输出里的两节', () => {
    const { guide, interpretation } = splitStyleOutput(
      '## 文风指南\n### 句式\n- 短句\n\n## 文风指纹解读\n平均句长 12 字。',
    )
    expect(guide).toContain('短句')
    expect(interpretation).toContain('平均句长 12 字')
  })

  it('模型没按格式输出时整段当指南，解读留空', () => {
    const { guide, interpretation } = splitStyleOutput('就是一段普通文字。')
    expect(guide).toBe('就是一段普通文字。')
    expect(interpretation).toBe('')
  })

  it('提示词包含指标与抽样', () => {
    const metrics = computeStyleMetrics(CHAPTERS)
    const prompt = buildStylePrompt({ bookTitle: '测试书', metrics, sample: '雾从水面长出来。' })
    expect(prompt).toContain('文风指南')
    expect(prompt).toContain('文风指纹解读')
    expect(prompt).toContain('平均句长')
    expect(prompt).toContain('雾从水面长出来')
  })
})

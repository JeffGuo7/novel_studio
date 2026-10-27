/**
 * 实体卡 + 卷摘要：从已整理的逐章大纲 / 总纲 / 旧卡，生成人物 / 地点 / 势力卡与分卷摘要。
 * 只做一次模型调用（成本不随书变长增长），失败时软跳过，不拖垮知识库初始化。
 */
import path from 'node:path'
import { readFileOrNull } from '../core/fsutil'

export interface EntityCards {
  characters: string
  locations: string
  factions: string
  volumeSummary: string
}

export interface EntityRunResult {
  files: Array<[string, string]>
}

const CATEGORY_KEYS = ['characters', 'locations', 'factions', 'volumeSummary'] as const
const FILE_OF: Record<(typeof CATEGORY_KEYS)[number], string> = {
  characters: 'characters.md',
  locations: 'locations.md',
  factions: 'factions.md',
  volumeSummary: 'volume_summary.md',
}

export function buildEntityPrompt(params: {
  bookTitle: string
  chapterOutline: string
  summary: string
  existing: Partial<Record<(typeof CATEGORY_KEYS)[number], string>>
}): string {
  const { bookTitle, chapterOutline, summary, existing } = params
  const previous = CATEGORY_KEYS.map((key) => {
    const content = existing[key]?.trim()
    return content ? `## 现有${FILE_OF[key] === 'characters.md' ? '人物卡' : FILE_OF[key] === 'locations.md' ? '地点卡' : FILE_OF[key] === 'factions.md' ? '势力卡' : '卷摘要'}\n${content}` : ''
  })
    .filter(Boolean)
    .join('\n\n')

  return `你在维护《${bookTitle}》这本书的设定档案。请根据逐章大纲与剧情总纲，整理四份 Markdown 档案。

要求：
1. 只写大纲/总纲里能确认的事实；不确定的不要编造；
2. 人物卡：每个主要人物一节，写身份、目标、与主角关系、当前状态、最近变化；
3. 地点卡：每个关键地点一节，写位置、规则、氛围、与谁相关；
4. 势力卡：每个势力一节，写目标、资源、与主角关系、当前动向；
5. 卷摘要：按已发生的章节规模估算分卷（每 20-30 章一卷），每卷 3-5 条：目标、关键事件、结尾状态、遗留钩子；
6. 如果已有旧档案，在旧档案基础上合并更新，保留仍然有效的信息，不要整份丢弃；
7. 每个字段值必须是完整的 Markdown 文件内容（含一级标题），不是 diff；
8. 如果某类没有足够信息，输出该文件的标题和一行"- （暂无）"。

严格输出 JSON（不要 Markdown 代码围栏）：
{
  "characters": "# 人物卡\\n\\n## ...\\n- 身份：...\\n",
  "locations": "# 地点卡\\n\\n## ...\\n- 位置：...\\n",
  "factions": "# 势力卡\\n\\n## ...\\n- 目标：...\\n",
  "volumeSummary": "# 卷摘要\\n\\n## 第一卷\\n- 目标：...\\n"
}

逐章大纲：
${chapterOutline.slice(0, 20_000) || '（暂无）'}

剧情总纲：
${summary.slice(0, 8_000) || '（暂无）'}
${previous ? `\n\n${previous}` : ''}`
}

function stripFences(text: string): string {
  return text
    .replace(/^\s*```(?:json)?\s*/i, '')
    .replace(/\s*```\s*$/, '')
    .trim()
}

export function parseEntityResponse(text: string): EntityCards {
  const cleaned = stripFences(text)
  const start = cleaned.indexOf('{')
  const end = cleaned.lastIndexOf('}')
  if (start < 0 || end <= start) throw new Error('模型没有返回 JSON 结构')
  let parsed: unknown
  try {
    parsed = JSON.parse(cleaned.slice(start, end + 1))
  } catch (err) {
    throw new Error(`实体卡 JSON 解析失败：${(err as Error).message}`)
  }
  const data = parsed as Record<string, unknown>
  const cards = {} as EntityCards
  for (const key of CATEGORY_KEYS) {
    const value = data[key]
    if (typeof value !== 'string' || !value.trim()) {
      throw new Error(`实体卡缺少字段 ${key}`)
    }
    cards[key] = value.trim() + '\n'
  }
  return cards
}

export async function runEntityCards(
  request: {
    bookDir: string
    bookTitle: string
    chapterOutline: string
    summary: string
  },
  deps: { complete: (prompt: string) => Promise<string> },
): Promise<EntityRunResult> {
  const existing: Partial<Record<(typeof CATEGORY_KEYS)[number], string>> = {}
  for (const key of CATEGORY_KEYS) {
    const content = readFileOrNull(path.join(request.bookDir, FILE_OF[key])) ?? ''
    if (content.trim()) existing[key] = content
  }
  const prompt = buildEntityPrompt({
    bookTitle: request.bookTitle,
    chapterOutline: request.chapterOutline,
    summary: request.summary,
    existing,
  })
  const text = await deps.complete(prompt)
  const cards = parseEntityResponse(text)
  return {
    files: CATEGORY_KEYS.map((key) => [FILE_OF[key], cards[key]] as [string, string]),
  }
}

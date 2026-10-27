/**
 * 大纲生成（一句话创意 → 主线/篇章/世界模型建议）。
 *
 * 只生成 KnowledgeProposal，不直接写知识文件；作者在「AI 建议」里看 diff 后决定。
 * 提示词要求模型返回严格 JSON，解析失败时给出可读错误。
 */
import {
  createKnowledgeProposal,
  readBookFile,
  type KnowledgeProposalInfo,
} from '../core'

export interface OutlineRequest {
  bookDir: string
  bookTitle: string
  premise: string
  volumes: number
}

export interface OutlineResult {
  proposals: KnowledgeProposalInfo[]
  cost: number
  inputTokens: number
  outputTokens: number
}

export interface OutlineParsed {
  masterOutline: string
  arcOutline: string
  worldModel?: string
}

const MAX_PREMISE_CHARS = 4_000

export function buildOutlinePrompt(params: {
  bookTitle: string
  premise: string
  volumes: number
  currentMaster?: string
  currentArc?: string
  currentWorld?: string
}): string {
  const { bookTitle, premise, volumes } = params
  const current = [
    params.currentMaster ? `## 现有主线大纲\n${params.currentMaster}` : '',
    params.currentArc ? `## 现有篇章大纲\n${params.currentArc}` : '',
    params.currentWorld ? `## 现有世界模型\n${params.currentWorld}` : '',
  ]
    .filter(Boolean)
    .join('\n\n')

  return `你是资深网文主编。请根据作者给的创意，为《${bookTitle}》设计一套可执行的大纲。

作者创意：
${premise}

要求：
1. 分 ${volumes} 卷，每卷要有明确目标、核心冲突、关键转折、结尾钩子；
2. 主线要能撑住长篇，承诺要具体（读者能得到什么体验），不要空话；
3. 世界设定只保留与冲突直接相关的部分，不要堆设定名词；
4. 文风要求：中文、克制、具体，不用"史诗""波澜壮阔"这类空词；
5. 严格输出 JSON（不要 Markdown 代码围栏），结构：
{
  "masterOutline": "# 主线大纲\\n\\n## 读者承诺\\n\\n- ...\\n\\n## 长线冲突\\n\\n- ...\\n",
  "arcOutline": "# 篇章大纲\\n\\n## 第一卷 ...\\n\\n- 目标：...\\n- 冲突：...\\n- 转折：...\\n- 钩子：...\\n",
  "worldModel": "# 世界模型\\n\\n## 读者承诺与主轴\\n\\n- ...\\n\\n## 力量 / 规则体系\\n\\n- ...\\n\\n## 势力与地理\\n\\n- ...\\n\\n## 硬约束\\n\\n- ...\\n"
}
字段值必须是完整的 Markdown 文件内容（含标题），不是 diff。${current ? `\n\n${current}\n\n请在此基础上改进，保留仍然有效的部分。` : ''}`
}

function stripFences(text: string): string {
  return text
    .replace(/^\s*```(?:json)?\s*/i, '')
    .replace(/\s*```\s*$/, '')
    .trim()
}

/** 从模型输出里解析 JSON；容忍前后解释文字与代码围栏 */
export function parseOutlineResponse(text: string): OutlineParsed {
  const cleaned = stripFences(text)
  const start = cleaned.indexOf('{')
  const end = cleaned.lastIndexOf('}')
  if (start < 0 || end <= start) throw new Error('模型没有返回 JSON 结构，请重试')
  let parsed: unknown
  try {
    parsed = JSON.parse(cleaned.slice(start, end + 1))
  } catch (err) {
    throw new Error(`大纲 JSON 解析失败：${(err as Error).message}`)
  }
  const data = parsed as { masterOutline?: unknown; arcOutline?: unknown; worldModel?: unknown }
  const masterOutline = typeof data.masterOutline === 'string' ? data.masterOutline.trim() : ''
  const arcOutline = typeof data.arcOutline === 'string' ? data.arcOutline.trim() : ''
  const worldModel = typeof data.worldModel === 'string' ? data.worldModel.trim() : ''
  if (!masterOutline || !arcOutline) {
    throw new Error('模型返回的大纲缺少 masterOutline 或 arcOutline 字段')
  }
  return {
    masterOutline,
    arcOutline,
    ...(worldModel ? { worldModel } : {}),
  }
}

export async function runOutline(
  request: OutlineRequest,
  deps: {
    complete: (prompt: string) => Promise<{ text: string; cost: number; input: number; output: number }>
    onProgress?: (message: string) => void
  },
): Promise<OutlineResult> {
  const premise = request.premise.trim().slice(0, MAX_PREMISE_CHARS)
  if (!premise) throw new Error('创意不能为空')
  const volumes = Math.max(1, Math.min(Math.round(request.volumes) || 3, 8))

  deps.onProgress?.('读取现有知识…')
  const [master, arc, world] = await Promise.all([
    readBookFile(request.bookDir, 'master_outline.md').catch(() => ({ content: '', exists: false })),
    readBookFile(request.bookDir, 'arc_outline.md').catch(() => ({ content: '', exists: false })),
    readBookFile(request.bookDir, 'world_model.md').catch(() => ({ content: '', exists: false })),
  ])

  deps.onProgress?.('生成大纲中（可能需要 20-60 秒）…')
  const prompt = buildOutlinePrompt({
    bookTitle: request.bookTitle,
    premise,
    volumes,
    currentMaster: master.content || undefined,
    currentArc: arc.content || undefined,
    currentWorld: world.content || undefined,
  })
  const response = await deps.complete(prompt)
  const parsed = parseOutlineResponse(response.text)

  deps.onProgress?.('写入建议（等待你确认）…')
  const proposals: KnowledgeProposalInfo[] = [
    createKnowledgeProposal(request.bookDir, {
      targetPath: 'master_outline.md',
      content: parsed.masterOutline,
      reason: '大纲向导：根据创意生成主线大纲',
      source: 'outline',
    }),
    createKnowledgeProposal(request.bookDir, {
      targetPath: 'arc_outline.md',
      content: parsed.arcOutline,
      reason: '大纲向导：根据创意生成分卷大纲',
      source: 'outline',
    }),
  ]
  if (parsed.worldModel) {
    proposals.push(
      createKnowledgeProposal(request.bookDir, {
        targetPath: 'world_model.md',
        content: parsed.worldModel,
        reason: '大纲向导：根据创意生成世界模型',
        source: 'outline',
      }),
    )
  }

  return {
    proposals,
    cost: response.cost,
    inputTokens: response.input,
    outputTokens: response.output,
  }
}

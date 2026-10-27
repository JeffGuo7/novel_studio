/** Agent 会话的持久化：把 pi 的 AgentMessage[] 落到书库 .studio/agent/session.json */
import type { ChatHistoryItem, ChatToolTrace } from '../shared/agent'
import { trimMessagesToBudget, truncateLongValues } from './context-budget'
import type { CompactionState } from './compaction'
import { summarizeToolCall } from './tool-summary'

export interface PersistedSession {
  version: 1
  updatedAt: string
  messages: unknown[]
  /** 累计成本（美元），重启后继续累计，避免靠重启绕过预算 */
  cost: number
  /** 按章节统计的成本（章节 key -> 美元） */
  chapterCosts: Record<string, number>
  /** OpenCode 路由用的会话 id（同一次会话保持稳定） */
  opencodeSessionId?: string
  /** 对话压缩状态（摘要 + 覆盖的消息条数） */
  compaction?: CompactionState
}

const EMPTY: PersistedSession = { version: 1, updatedAt: '', messages: [], cost: 0, chapterCosts: {} }

export function emptySession(): PersistedSession {
  return { ...EMPTY, messages: [], chapterCosts: {} }
}

/** 只保留最近 N 条，且起点必须落在 user 消息上（避免把 assistant toolCall 与 toolResult 拆散） */
export function trimMessages(messages: unknown[], maxMessages = 120): unknown[] {
  if (messages.length <= maxMessages) return messages
  let start = messages.length - maxMessages
  const roleOf = (message: unknown) => (message as { role?: string })?.role
  while (start < messages.length - 1 && roleOf(messages[start]) !== 'user') start += 1
  return messages.slice(start)
}

/**
 * 单条消息里可能塞了整章正文（write_draft 的参数、read_context 的工具结果），
 * 直接存会让会话文件暴涨。统一把超长字符串截断，并留下标记。
 */
export function truncateDeep(value: unknown, limit = 4000, depth = 0): unknown {
  if (depth > 8) return value
  if (typeof value === 'string') {
    return value.length > limit ? `${value.slice(0, limit)}\n…（历史记录已截断）` : value
  }
  if (Array.isArray(value)) return value.map((item) => truncateDeep(item, limit, depth + 1))
  if (value && typeof value === 'object') {
    const result: Record<string, unknown> = {}
    for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
      result[key] = truncateDeep(item, limit, depth + 1)
    }
    return result
  }
  return value
}

/** 序列化前的整理：截断长文本 + 只留最近的消息 */
export function prepareForPersist(
  messages: unknown[],
  cost: number,
  chapterCosts: Record<string, number> = {},
  opencodeSessionId?: string,
  budgetTokens?: number,
  compaction?: CompactionState | null,
): PersistedSession {
  // 有模型预算时按 token 裁剪（模型驱动）；否则退回消息条数上限（兼容老调用）
  const compacted =
    typeof budgetTokens === 'number' && budgetTokens > 0
      ? trimMessagesToBudget(truncateLongValues(messages), budgetTokens).messages
      : truncateDeep(trimMessages(messages)) as unknown[]
  return {
    version: 1,
    updatedAt: new Date().toISOString(),
    messages: compacted as unknown[],
    cost,
    chapterCosts,
    ...(opencodeSessionId ? { opencodeSessionId } : {}),
    ...(compaction && compaction.coveredMessages > 0 ? { compaction } : {}),
  }
}

export function isOverBudget(cost: number, budgetUsd: number, extra = 0): boolean {
  if (!budgetUsd || budgetUsd <= 0) return false
  return cost + extra >= budgetUsd
}

export function addChapterCost(
  costs: Record<string, number>,
  chapterKey: string | undefined,
  cost: number,
): Record<string, number> {
  if (!chapterKey || !cost) return costs
  return { ...costs, [chapterKey]: (costs[chapterKey] ?? 0) + cost }
}

export function chapterCostOf(costs: Record<string, number>, chapterKey?: string): number {
  return chapterKey ? (costs[chapterKey] ?? 0) : 0
}

export function formatUsd(value: number): string {
  return `$${value.toFixed(4)}`
}

/** 从 AgentMessage[] 提取可渲染的对话历史（只保留 user / assistant 的文本） */
type RawBlock = { type?: string; text?: string; id?: string; name?: string; arguments?: unknown }

/**
 * 把持久化的 pi 消息还原成 UI 气泡：
 * - assistant 的 text block → 气泡正文；
 * - assistant 的 toolCall block + 后续 toolResult → 工具轨迹（按调用 id 配对，拿到成功/失败）；
 * - toolResult 不单独显示（它的内容已经反映在工具轨迹和最终回答里）。
 */
export function toChatHistory(messages: unknown[], limit = 40): ChatHistoryItem[] {
  const items: ChatHistoryItem[] = []
  const pendingTools: ChatToolTrace[] = []
  const traceById = new Map<string, ChatToolTrace>()

  const flushTools = () => {
    if (pendingTools.length === 0) return
    const target = [...items].reverse().find((item) => item.role === 'assistant')
    if (target) {
      target.tools = [...(target.tools ?? []), ...pendingTools]
    } else {
      // 这一轮只有工具没有最终回答（比如中途关窗）：也保留轨迹，避免"凭空消失"
      items.push({ role: 'assistant', text: '', timestamp: 0, tools: [...pendingTools] })
    }
    pendingTools.length = 0
  }

  for (const raw of messages) {
    const message = raw as {
      role?: string
      content?: unknown
      timestamp?: number
      toolCallId?: string
      isError?: boolean
    }
    if (message?.role === 'toolResult') {
      const trace = message.toolCallId ? traceById.get(message.toolCallId) : undefined
      if (trace) trace.ok = !message.isError
      continue
    }
    if (message?.role !== 'user' && message?.role !== 'assistant') continue

    const content = message.content
    let text = ''
    const blocks: RawBlock[] = Array.isArray(content) ? (content as RawBlock[]) : []
    if (typeof content === 'string') {
      text = content
    } else {
      text = blocks
        .filter((block) => block?.type === 'text')
        .map((block) => String(block.text ?? ''))
        .join('')
    }

    if (message.role === 'assistant') {
      for (const block of blocks) {
        if (block?.type !== 'toolCall' || !block.name) continue
        const id = block.id ?? `${block.name}-${Date.now()}-${pendingTools.length}`
        const trace: ChatToolTrace = {
          id,
          name: block.name,
          summary: summarizeToolCall(block.name, block.arguments),
          ok: undefined,
        }
        pendingTools.push(trace)
        traceById.set(id, trace)
      }
    }

    const trimmed = text.trim()
    if (!trimmed) continue
    const item: ChatHistoryItem = {
      role: message.role,
      text: trimmed,
      timestamp: Number(message.timestamp ?? 0) || 0,
    }
    if (message.role === 'assistant') {
      item.tools = [...pendingTools]
      pendingTools.length = 0
    } else {
      flushTools()
    }
    items.push(item)
  }
  flushTools()
  return items.slice(-limit)
}

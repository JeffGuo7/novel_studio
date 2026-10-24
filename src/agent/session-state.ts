/** Agent 会话的持久化：把 pi 的 AgentMessage[] 落到书库 .studio/agent/session.json */

export interface PersistedSession {
  version: 1
  updatedAt: string
  messages: unknown[]
  /** 累计成本（美元），重启后继续累计，避免靠重启绕过预算 */
  cost: number
}

const EMPTY: PersistedSession = { version: 1, updatedAt: '', messages: [], cost: 0 }

export function emptySession(): PersistedSession {
  return { ...EMPTY, messages: [] }
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
export function prepareForPersist(messages: unknown[], cost: number): PersistedSession {
  const trimmed = trimMessages(messages)
  return {
    version: 1,
    updatedAt: new Date().toISOString(),
    messages: truncateDeep(trimmed) as unknown[],
    cost,
  }
}

export function isOverBudget(cost: number, budgetUsd: number, extra = 0): boolean {
  if (!budgetUsd || budgetUsd <= 0) return false
  return cost + extra >= budgetUsd
}

export function formatUsd(value: number): string {
  return `$${value.toFixed(4)}`
}

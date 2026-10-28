/**
 * 上下文溢出自动恢复的纯决策逻辑（便于单测；真正的压缩/重试在 host.ts 里执行）。
 */

export type OverflowRecoveryAction = 'none' | 'compact-and-retry' | 'give-up'

export interface OverflowRecoveryDecision {
  action: OverflowRecoveryAction
  reason?: string
}

/** 决定要不要自动压缩并重试；每次用户请求最多自动恢复一次 */
export function decideOverflowRecovery(input: {
  overflowDetected: boolean
  alreadyRetried: boolean
  canCompact: boolean
}): OverflowRecoveryDecision {
  if (!input.overflowDetected) return { action: 'none' }
  if (input.alreadyRetried) {
    return { action: 'give-up', reason: '自动压缩重试后仍然超出上下文，请手动 /compact 或更换更大上下文的模型' }
  }
  if (!input.canCompact) {
    return { action: 'give-up', reason: '当前上下文超限但没有可压缩的历史消息，请缩短本次输入或更换模型' }
  }
  return { action: 'compact-and-retry' }
}

export interface FallbackCompactionPlan {
  coveredMessages: number
  summary: string
}

/**
 * 不调用模型的保底压缩方案：保留 system 前缀 + 最近 keepRecent 条消息，其余折叠成一句摘要。
 * 无法压缩（消息太少）时返回 null。
 */
export function planFallbackCompaction(
  messages: Array<{ role?: string }>,
  keepRecent = 4,
): FallbackCompactionPlan | null {
  let systemCount = 0
  while (systemCount < messages.length && messages[systemCount]?.role === 'system') {
    systemCount += 1
  }
  const keep = Math.max(2, keepRecent)
  const coveredMessages = messages.length - keep
  if (coveredMessages <= systemCount) return null
  return {
    coveredMessages,
    summary:
      '（自动压缩）此前的对话因上下文超限被省略。最近几轮对话仍保留原文；如需完整回顾，请查看会话文件或重新开始对话。',
  }
}

/** 溢出后降低输入预算（0.3–1），避免再次估算偏高 */
export function scaleInputBudget(inputBudgetTokens: number, scale: number): number {
  const safeScale = Number.isFinite(scale) ? Math.min(1, Math.max(0.3, scale)) : 1
  return Math.max(1024, Math.floor(inputBudgetTokens * safeScale))
}

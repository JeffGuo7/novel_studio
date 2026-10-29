/** Agent 运行时与界面之间的契约（main / preload / renderer 共用） */

import type { BillingMode } from './billing'

export type AgentStatus = 'starting' | 'idle' | 'thinking' | 'tool' | 'error'

export interface AgentUsage {
  input: number
  output: number
  cost: number
}

export type BudgetScope = 'session' | 'chapter'

export type AgentEvent =
  | { type: 'status'; status: AgentStatus; detail?: string }
  | { type: 'assistant_delta'; delta: string }
  | { type: 'assistant_done'; text: string }
  | { type: 'tool_start'; tool: string; summary: string }
  | { type: 'tool_end'; tool: string; ok: boolean; summary: string }
  | {
      type: 'turn_end'
      usage?: AgentUsage
      sessionCost?: number
      budgetUsd?: number
      chapterKey?: string
      chapterCost?: number
      chapterBudgetUsd?: number
      /** metered / subscription（套餐内） */
      billing?: BillingMode
      /** 本会话已发起的对话轮次 */
      requests?: number
    }
  | {
      type: 'budget_exceeded'
      scope: BudgetScope
      cost: number
      budgetUsd: number
      chapterKey?: string
    }
  | { type: 'session_restored'; messages: number; cost: number }
  | { type: 'compaction_started' }
  | {
      type: 'compaction_done'
      coveredMessages: number
      summaryChars: number
      tokensBefore: number
      tokensAfter: number
    }
  | {
      type: 'context_overflow'
      stage: 'detected' | 'retrying' | 'recovered' | 'failed'
      message?: string
    }
  | { type: 'book_changed'; reason: string }
  | { type: 'error'; message: string }

export interface AgentInitInfo {
  model: string
  provider: string
  bookTitle: string
  /** 本次会话的累计成本与预算（重启后从会话文件恢复） */
  sessionCost: number
  budgetUsd: number
  /** 单章预算（美元） */
  chapterBudgetUsd: number
  /** 各章已花费 */
  chapterCosts: Record<string, number>
  restoredMessages: number
  /** 已压缩的对话摘要信息（有摘要时出现） */
  compaction?: { coveredMessages: number; summaryChars: number }
  /** 模型上下文窗口（tokens），来自模型目录 */
  contextWindow?: number
  /** 模型单次输出上限（tokens） */
  maxTokens?: number
  /** 应用侧允许用于输入的预算（tokens，扣除输出与安全区） */
  contextBudgetTokens?: number
  /** 计费模式：套餐内不按美元预算硬停 */
  billing?: BillingMode
  /** 本会话已发起的对话轮次（持久化） */
  requests?: number
}

export interface ChatToolTrace {
  id: string
  name: string
  summary: string
  /** 工具执行结果：undefined=还在跑（历史里不应出现） */
  ok?: boolean
}

export interface ChatHistoryItem {
  role: 'user' | 'assistant'
  text: string
  timestamp: number
  /** 这一轮 assistant 消息调用过的工具轨迹（从会话原文还原） */
  tools?: ChatToolTrace[]
}

export interface AgentSendInput {
  bookDir: string
  text: string
  /** 本次对话归属的章节（用于单章成本统计与预算） */
  chapterKey?: string
  /** 写作模式：free / continue / polish / review / expand */
  mode?: string
}

export type AgentOutbound = AgentEvent

export interface AgentInbound {
  type: 'prompt' | 'abort' | 'steer' | 'reset' | 'compact'
  text?: string
  chapterKey?: string
  /** 写作模式（仅 prompt 生效） */
  mode?: string
}

/** Agent 运行时与界面之间的契约（main / preload / renderer 共用） */

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
    }
  | {
      type: 'budget_exceeded'
      scope: BudgetScope
      cost: number
      budgetUsd: number
      chapterKey?: string
    }
  | { type: 'session_restored'; messages: number; cost: number }
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
}

export interface ChatHistoryItem {
  role: 'user' | 'assistant'
  text: string
  timestamp: number
}

export interface AgentSendInput {
  bookDir: string
  text: string
  /** 本次对话归属的章节（用于单章成本统计与预算） */
  chapterKey?: string
}

export type AgentOutbound = AgentEvent

export interface AgentInbound {
  type: 'prompt' | 'abort' | 'steer' | 'reset'
  text?: string
  chapterKey?: string
}

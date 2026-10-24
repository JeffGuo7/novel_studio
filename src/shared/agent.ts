/** Agent 运行时与界面之间的契约（main / preload / renderer 共用） */

export type AgentStatus = 'starting' | 'idle' | 'thinking' | 'tool' | 'error'

export interface AgentUsage {
  input: number
  output: number
  cost: number
}

export type AgentEvent =
  | { type: 'status'; status: AgentStatus; detail?: string }
  | { type: 'assistant_delta'; delta: string }
  | { type: 'assistant_done'; text: string }
  | { type: 'tool_start'; tool: string; summary: string }
  | { type: 'tool_end'; tool: string; ok: boolean; summary: string }
  | { type: 'turn_end'; usage?: AgentUsage; sessionCost?: number; budgetUsd?: number }
  | { type: 'budget_exceeded'; sessionCost: number; budgetUsd: number }
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
  restoredMessages: number
}

export interface AgentSendInput {
  bookDir: string
  text: string
}

export type AgentOutbound = AgentEvent

export interface AgentInbound {
  type: 'prompt' | 'abort' | 'steer' | 'reset'
  text?: string
}

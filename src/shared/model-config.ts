/** 模型配置与会话预算的共享类型（main / renderer / agent host 共用，纯数据） */

export interface CustomProviderConfig {
  /** provider id，自由命名，例如 "my-openai" */
  id: string
  /** pi 的 API 类型：openai-completions / openai-responses / anthropic-messages ... */
  api: string
  baseUrl: string
  supportsVision?: boolean
  reasoning?: boolean
  /** 自定义模型的上下文窗口（tokens）；不填按 128k 兜底 */
  contextWindow?: number
  /** 自定义模型的输出上限（tokens） */
  maxTokens?: number
}

export interface ModelSelection {
  provider: string
  model: string
  /** 自定义 provider 时才需要 */
  providerConfig?: CustomProviderConfig
}

export interface AppSettings {
  selection: ModelSelection
  customProviders: CustomProviderConfig[]
  /** 是否已存有该 provider 的密钥（不回传密钥本身） */
  hasApiKey: boolean
  /** 单次会话（一本书的 Agent 对话）成本上限，美元；<=0 表示不限制 */
  budgetUsd: number
  /** 单章（同一章节的连续 Agent 协作）成本上限，美元；<=0 表示不限制 */
  chapterBudgetUsd: number
  /** 预算预警阈值（0-1），达到后提示；默认 0.8 */
  budgetWarnRatio: number
  /** 应用内代理（模型请求 + 更新检查）；留空表示使用系统代理/直连 */
  proxyUrl: string
}

export interface ProviderSummary {
  id: string
  models: number
  api: string
  baseUrl: string
}

export interface ModelSummary {
  id: string
  name: string
  provider: string
  api: string
  reasoning: boolean
  contextWindow: number
  input: string[]
}

export interface SettingsSaveInput {
  selection: ModelSelection
  customProviders: CustomProviderConfig[]
  budgetUsd?: number
  chapterBudgetUsd?: number
  budgetWarnRatio?: number
  /** 应用内代理；不传表示保持原样，传空串表示清除 */
  proxyUrl?: string
  /** 新密钥；不传表示保持原样，传空串表示清除 */
  apiKey?: string
  /** 密钥属于哪个 provider（默认 selection.provider） */
  apiKeyProvider?: string
}

/** 传给 Agent Host 的运行时配置（经子进程 env 传递，含密钥，不出主进程） */
export interface AgentRuntimeConfig {
  selection: ModelSelection
  apiKey: string
  budgetUsd: number
  chapterBudgetUsd: number
  sessionFile: string
}

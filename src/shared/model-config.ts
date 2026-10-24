/** 模型配置的共享类型（main / renderer / agent host 共用，纯数据） */

export interface CustomProviderConfig {
  /** provider id，自由命名，例如 "my-openai" */
  id: string
  /** pi 的 API 类型：openai-completions / openai-responses / anthropic-messages ... */
  api: string
  baseUrl: string
  supportsVision?: boolean
  reasoning?: boolean
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
  /** 新密钥；不传表示保持原样，传空串表示清除 */
  apiKey?: string
  /** 密钥属于哪个 provider（默认 selection.provider） */
  apiKeyProvider?: string
}

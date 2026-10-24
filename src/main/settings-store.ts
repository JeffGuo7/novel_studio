import { app, safeStorage } from 'electron'
import fs from 'node:fs'
import path from 'node:path'
import type {
  AppSettings,
  CustomProviderConfig,
  ModelSelection,
  SettingsSaveInput,
} from '../shared/model-config'

interface StoredSettings {
  selection: ModelSelection
  customProviders: CustomProviderConfig[]
  /** provider -> 加密后的密钥（safeStorage base64；不可用时 plain: 前缀） */
  encryptedKeys: Record<string, string>
  /** 单次会话成本上限（美元），<=0 不限制 */
  budgetUsd: number
}

const DEFAULT_SELECTION: ModelSelection = { provider: 'deepseek', model: 'deepseek-flash' }
const DEFAULT_BUDGET_USD = 0.5

function settingsPath(): string {
  return path.join(app.getPath('userData'), 'settings.json')
}

function readStored(): StoredSettings {
  try {
    const raw = fs.readFileSync(settingsPath(), 'utf8')
    const parsed = JSON.parse(raw) as Partial<StoredSettings>
    return {
      selection: parsed.selection ?? DEFAULT_SELECTION,
      customProviders: Array.isArray(parsed.customProviders) ? parsed.customProviders : [],
      encryptedKeys: parsed.encryptedKeys && typeof parsed.encryptedKeys === 'object' ? parsed.encryptedKeys : {},
      budgetUsd: typeof parsed.budgetUsd === 'number' ? parsed.budgetUsd : DEFAULT_BUDGET_USD,
    }
  } catch {
    return { selection: DEFAULT_SELECTION, customProviders: [], encryptedKeys: {}, budgetUsd: DEFAULT_BUDGET_USD }
  }
}

function writeStored(data: StoredSettings): void {
  const file = settingsPath()
  fs.mkdirSync(path.dirname(file), { recursive: true })
  const tmp = `${file}.tmp-${process.pid}`
  fs.writeFileSync(tmp, JSON.stringify(data, null, 2) + '\n', 'utf8')
  fs.renameSync(tmp, file)
}

function encrypt(plain: string): string {
  try {
    if (safeStorage.isEncryptionAvailable()) {
      return safeStorage.encryptString(plain).toString('base64')
    }
  } catch {
    // fall through
  }
  return `plain:${Buffer.from(plain, 'utf8').toString('base64')}`
}

function decrypt(stored: string): string {
  if (!stored) return ''
  if (stored.startsWith('plain:')) {
    return Buffer.from(stored.slice('plain:'.length), 'base64').toString('utf8')
  }
  try {
    return safeStorage.decryptString(Buffer.from(stored, 'base64'))
  } catch {
    return ''
  }
}

/** 环境变量兜底：DEEPSEEK_API_KEY / OPENAI_API_KEY / 自定义 provider 的 <ID>_API_KEY */
function envKeyFor(providerId: string): string {
  const envName = `${providerId.replace(/[^a-zA-Z0-9]/g, '_').toUpperCase()}_API_KEY`
  return process.env[envName] ?? ''
}

export function getStoredApiKey(providerId: string): string {
  const stored = readStored().encryptedKeys[providerId]
  if (stored) {
    const value = decrypt(stored)
    if (value) return value
  }
  return envKeyFor(providerId)
}

export function getSettings(): AppSettings {
  const stored = readStored()
  return {
    selection: stored.selection,
    customProviders: stored.customProviders,
    hasApiKey: Boolean(getStoredApiKey(stored.selection.provider)),
    budgetUsd: stored.budgetUsd,
  }
}

export function saveSettings(input: SettingsSaveInput): AppSettings {
  const stored = readStored()
  stored.selection = input.selection
  stored.customProviders = input.customProviders ?? stored.customProviders
  if (typeof input.budgetUsd === 'number') stored.budgetUsd = input.budgetUsd

  if (typeof input.apiKey === 'string') {
    const provider = input.apiKeyProvider || input.selection.provider
    if (input.apiKey.trim()) {
      stored.encryptedKeys[provider] = encrypt(input.apiKey.trim())
    } else {
      delete stored.encryptedKeys[provider]
    }
  }
  writeStored(stored)
  return getSettings()
}

export function getProviderConfig(providerId: string): CustomProviderConfig | undefined {
  return readStored().customProviders.find((item) => item.id === providerId)
}

export function getSelection(): ModelSelection {
  return readStored().selection
}

/** 当前会话成本上限（美元） */
export function getBudgetUsd(): number {
  return readStored().budgetUsd
}

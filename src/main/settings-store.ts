import { app, safeStorage } from 'electron'
import fs from 'node:fs'
import path from 'node:path'
import type {
  AppSettings,
  CustomProviderConfig,
  ModelSelection,
  SettingsSaveInput,
} from '../shared/model-config'
import { normalizeProxyUrl } from '../shared/connection-test'

interface StoredSettings {
  selection: ModelSelection
  customProviders: CustomProviderConfig[]
  /** provider -> 加密后的密钥（safeStorage base64；不可用时 plain: 前缀） */
  encryptedKeys: Record<string, string>
  /** 单次会话成本上限（美元），<=0 不限制 */
  budgetUsd: number
  /** 单章成本上限（美元），<=0 不限制 */
  chapterBudgetUsd: number
  /** 预算预警阈值（0-1），默认 0.8 */
  budgetWarnRatio: number
  /** 应用内代理；空串 = 系统代理 / 直连 */
  proxyUrl: string
  autoBackup: boolean
  autoBackupIntervalDays: number
  backupKeep: number
}

const DEFAULT_SELECTION: ModelSelection = { provider: 'deepseek', model: 'deepseek-flash' }
const DEFAULT_BUDGET_USD = 0.5
const DEFAULT_CHAPTER_BUDGET_USD = 0.2
const DEFAULT_BUDGET_WARN_RATIO = 0.8
const DEFAULT_AUTO_BACKUP = true
const DEFAULT_AUTO_BACKUP_INTERVAL_DAYS = 3
const DEFAULT_BACKUP_KEEP = 5

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
      chapterBudgetUsd:
        typeof parsed.chapterBudgetUsd === 'number'
          ? parsed.chapterBudgetUsd
          : DEFAULT_CHAPTER_BUDGET_USD,
      budgetWarnRatio:
        typeof parsed.budgetWarnRatio === 'number' &&
        parsed.budgetWarnRatio >= 0.5 &&
        parsed.budgetWarnRatio <= 0.95
          ? parsed.budgetWarnRatio
          : DEFAULT_BUDGET_WARN_RATIO,
      proxyUrl: typeof parsed.proxyUrl === 'string' ? normalizeProxyUrl(parsed.proxyUrl) : '',
      autoBackup: typeof parsed.autoBackup === 'boolean' ? parsed.autoBackup : DEFAULT_AUTO_BACKUP,
      autoBackupIntervalDays:
        typeof parsed.autoBackupIntervalDays === 'number'
          ? clamp(parsed.autoBackupIntervalDays, 1, 30)
          : DEFAULT_AUTO_BACKUP_INTERVAL_DAYS,
      backupKeep:
        typeof parsed.backupKeep === 'number'
          ? clamp(parsed.backupKeep, 1, 20)
          : DEFAULT_BACKUP_KEEP,
    }
  } catch {
    return {
      selection: DEFAULT_SELECTION,
      customProviders: [],
      encryptedKeys: {},
      budgetUsd: DEFAULT_BUDGET_USD,
      chapterBudgetUsd: DEFAULT_CHAPTER_BUDGET_USD,
      budgetWarnRatio: DEFAULT_BUDGET_WARN_RATIO,
      proxyUrl: '',
      autoBackup: DEFAULT_AUTO_BACKUP,
      autoBackupIntervalDays: DEFAULT_AUTO_BACKUP_INTERVAL_DAYS,
      backupKeep: DEFAULT_BACKUP_KEEP,
    }
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
    chapterBudgetUsd: stored.chapterBudgetUsd,
    budgetWarnRatio: stored.budgetWarnRatio,
    proxyUrl: stored.proxyUrl,
    autoBackup: stored.autoBackup,
    autoBackupIntervalDays: stored.autoBackupIntervalDays,
    backupKeep: stored.backupKeep,
  }
}

export function saveSettings(input: SettingsSaveInput): AppSettings {
  const stored = readStored()
  stored.selection = input.selection
  stored.customProviders = input.customProviders ?? stored.customProviders
  if (typeof input.budgetUsd === 'number') stored.budgetUsd = input.budgetUsd
  if (typeof input.chapterBudgetUsd === 'number') stored.chapterBudgetUsd = input.chapterBudgetUsd
  if (typeof input.budgetWarnRatio === 'number') {
    stored.budgetWarnRatio = Math.min(0.95, Math.max(0.5, input.budgetWarnRatio))
  }
  if (typeof input.proxyUrl === 'string') stored.proxyUrl = normalizeProxyUrl(input.proxyUrl)
  if (typeof input.autoBackup === 'boolean') stored.autoBackup = input.autoBackup
  if (typeof input.autoBackupIntervalDays === 'number') {
    stored.autoBackupIntervalDays = clamp(input.autoBackupIntervalDays, 1, 30)
  }
  if (typeof input.backupKeep === 'number') stored.backupKeep = clamp(input.backupKeep, 1, 20)

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

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, Math.round(value)))
}

export function getAutoBackupConfig(): { enabled: boolean; intervalDays: number; keep: number } {
  const stored = readStored()
  return {
    enabled: stored.autoBackup,
    intervalDays: stored.autoBackupIntervalDays,
    keep: stored.backupKeep,
  }
}

export function getProxyUrl(): string {
  return readStored().proxyUrl
}

export function getSelection(): ModelSelection {
  return readStored().selection
}

/** 当前会话成本上限（美元） */
export function getBudgetUsd(): number {
  return readStored().budgetUsd
}

/** 单章成本上限（美元） */
export function getChapterBudgetUsd(): number {
  return readStored().chapterBudgetUsd
}

export function getBudgetWarnRatio(): number {
  return readStored().budgetWarnRatio
}

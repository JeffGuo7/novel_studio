/**
 * 工作区 / .studio 的 schema 版本与迁移框架。
 *
 * 为什么需要：
 * - book.json 已有 schemaVersion，但工作区根目录、`.studio`（会话/建议/索引/自动存档/缓存）
 *   没有统一的版本号；将来格式变化时无法安全升级。
 *
 * 设计：
 * - 工作区：<workspace>/workspace.json 记录 { schemaVersion }
 * - 每本书：<book>/.studio/schema.json 记录 { schemaVersion }
 * - 迁移链按版本号顺序执行；升级前把相关元数据复制到备份目录，失败时备份保留、
 *   原始文件不删除，用户数据不会因为升级脚本而消失；
 * - 遇到比当前应用更新的版本：拒绝自动处理并抛出可读错误（提示升级应用）；
 * - 迁移是幂等的：版本号已等于目标版本时直接返回。
 */
import fs from 'node:fs'
import path from 'node:path'
import { CoreError } from './errors'
import { readFileOrNull, removeDirRecursive, writeFileAtomic } from './fsutil'

export const CURRENT_WORKSPACE_SCHEMA = 1
export const CURRENT_STUDIO_SCHEMA = 1

const WORKSPACE_SCHEMA_FILE = 'workspace.json'
const STUDIO_SCHEMA_FILE = path.join('.studio', 'schema.json')
const MAX_BACKUPS = 2

export interface SchemaMigration {
  /** 迁移完成后的目标版本 */
  to: number
  description: string
  run: (context: { workspaceDir?: string; bookDir?: string; backupDir: string }) => void
}

/** 工作区级迁移链（后续版本在此追加） */
export const WORKSPACE_MIGRATIONS: SchemaMigration[] = [
  {
    to: 1,
    description: '初始化工作区 schema 版本文件',
    run: () => {
      // v1 无需改动数据：版本文件本身已由框架写出
    },
  },
]

/** 单本书 .studio 迁移链 */
export const STUDIO_MIGRATIONS: SchemaMigration[] = [
  {
    to: 1,
    description: '初始化 .studio schema 版本文件',
    run: () => {
      // v1 无需改动数据
    },
  },
]

export interface SchemaStatus {
  version: number
  migrated: number
  backupDir?: string
}

export interface WorkspaceSchemaReport {
  workspace: SchemaStatus
  books: number
  migratedBooks: number
  errors: Array<{ book: string; error: string }>
}

export function workspaceSchemaPath(workspaceDir: string): string {
  return path.join(workspaceDir, WORKSPACE_SCHEMA_FILE)
}

export function studioSchemaPath(bookDir: string): string {
  return path.join(bookDir, STUDIO_SCHEMA_FILE)
}

function readSchemaVersion(file: string): number {
  const raw = readFileOrNull(file)
  if (!raw) return 0
  try {
    const parsed = JSON.parse(raw) as { schemaVersion?: unknown }
    const version = Number(parsed?.schemaVersion)
    return Number.isInteger(version) && version >= 0 ? version : 0
  } catch {
    // 损坏的版本文件当作 0，重新迁移；不因此丢掉数据
    return 0
  }
}

function writeSchemaVersion(file: string, version: number, extra: Record<string, unknown> = {}): void {
  writeFileAtomic(
    file,
    JSON.stringify(
      {
        schemaVersion: version,
        updatedAt: new Date().toISOString(),
        ...extra,
      },
      null,
      2,
    ) + '\n',
  )
}

function timestamps(): string {
  return new Date().toISOString().replace(/[-:T]/g, '').slice(0, 14)
}

function copyIntoBackup(sourceAbsolute: string, targetAbsolute: string): void {
  if (!fs.existsSync(sourceAbsolute)) return
  fs.mkdirSync(path.dirname(targetAbsolute), { recursive: true })
  const stat = fs.statSync(sourceAbsolute)
  if (stat.isDirectory()) {
    fs.cpSync(sourceAbsolute, targetAbsolute, { recursive: true })
  } else {
    fs.copyFileSync(sourceAbsolute, targetAbsolute)
  }
}

function pruneBackups(dir: string, keep = MAX_BACKUPS): void {
  if (!fs.existsSync(dir)) return
  const backups = fs
    .readdirSync(dir, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .sort()
  for (const name of backups.slice(0, Math.max(0, backups.length - keep))) {
    try {
      removeDirRecursive(path.join(dir, name))
    } catch {
      // 清理失败不影响迁移
    }
  }
}

interface RunMigrationOptions {
  label: string
  schemaFile: string
  backupsRoot: string
  backupPaths: Array<{ from: string; to: string }>
  migrations: SchemaMigration[]
  currentVersion: number
  workspaceDir?: string
  bookDir?: string
}

/** 执行迁移链（可单测：传入自定义 migrations） */
export function runSchemaMigrations(options: RunMigrationOptions): SchemaStatus {
  const existing = readSchemaVersion(options.schemaFile)
  if (existing > options.currentVersion) {
    throw new CoreError(
      'SCHEMA_TOO_NEW',
      `${options.label} 的数据版本（v${existing}）比当前应用支持的版本（v${options.currentVersion}）更新，请升级 Novel Studio 后再打开。`,
    )
  }
  if (existing === options.currentVersion) return { version: existing, migrated: 0 }

  const pending = options.migrations
    .filter((migration) => migration.to > existing && migration.to <= options.currentVersion)
    .sort((a, b) => a.to - b.to)
  if (pending.length === 0) {
    writeSchemaVersion(options.schemaFile, options.currentVersion)
    return { version: options.currentVersion, migrated: 0 }
  }

  const backupDir = path.join(
    options.backupsRoot,
    `${options.label}-v${existing}-to-v${options.currentVersion}-${timestamps()}`,
  )
  for (const item of options.backupPaths) {
    copyIntoBackup(item.from, path.join(backupDir, item.to))
  }

  for (const migration of pending) {
    migration.run({
      ...(options.workspaceDir ? { workspaceDir: options.workspaceDir } : {}),
      ...(options.bookDir ? { bookDir: options.bookDir } : {}),
      backupDir,
    })
  }
  writeSchemaVersion(options.schemaFile, options.currentVersion)
  pruneBackups(options.backupsRoot)
  return { version: options.currentVersion, migrated: pending.length, backupDir }
}

/** 确保工作区 schema（工作区不存在时返回 v0，不创建目录） */
export function ensureWorkspaceSchema(workspaceDir: string): SchemaStatus {
  if (!fs.existsSync(workspaceDir)) return { version: 0, migrated: 0 }
  const backupsRoot = path.join(workspaceDir, '.schema-backup')
  return runSchemaMigrations({
    label: 'workspace',
    schemaFile: workspaceSchemaPath(workspaceDir),
    backupsRoot,
    backupPaths: [{ from: workspaceSchemaPath(workspaceDir), to: WORKSPACE_SCHEMA_FILE }],
    migrations: WORKSPACE_MIGRATIONS,
    currentVersion: CURRENT_WORKSPACE_SCHEMA,
    workspaceDir,
  })
}

/** 确保单本书的 .studio schema；书目录无 .studio 时先创建 */
export function ensureBookSchema(bookDir: string): SchemaStatus {
  const studioDir = path.join(bookDir, '.studio')
  fs.mkdirSync(studioDir, { recursive: true })
  const backupsRoot = path.join(studioDir, '.schema-backup')
  const files = [
    ['agent/session.json', 'session.json'],
    ['pipeline-state.json', 'pipeline-state.json'],
    ['autosave/entries.json', 'autosave.json'],
    ['cache/chapters.json', 'chapters-cache.json'],
    ['index/meta.json', 'index-meta.json'],
    ['proposals', 'proposals'],
  ] as const
  return runSchemaMigrations({
    label: 'studio',
    schemaFile: studioSchemaPath(bookDir),
    backupsRoot,
    backupPaths: files.map(([from, to]) => ({ from: path.join(studioDir, from), to })),
    migrations: STUDIO_MIGRATIONS,
    currentVersion: CURRENT_STUDIO_SCHEMA,
    bookDir,
  })
}

/** 启动时升级整个工作区；单本失败不影响其它书 */
export function ensureAllSchemas(workspaceDir: string): WorkspaceSchemaReport {
  const errors: WorkspaceSchemaReport['errors'] = []
  let workspace: SchemaStatus = { version: getWorkspaceSchemaVersion(workspaceDir), migrated: 0 }
  try {
    workspace = ensureWorkspaceSchema(workspaceDir)
  } catch (err) {
    errors.push({ book: 'workspace', error: (err as Error).message })
  }
  let books = 0
  let migratedBooks = 0
  if (!fs.existsSync(workspaceDir)) {
    return { workspace, books, migratedBooks, errors }
  }
  for (const entry of fs.readdirSync(workspaceDir, { withFileTypes: true })) {
    if (!entry.isDirectory() || entry.name.startsWith('.')) continue
    const bookDir = path.join(workspaceDir, entry.name)
    if (!fs.existsSync(path.join(bookDir, 'book.json'))) continue
    books += 1
    try {
      const status = ensureBookSchema(bookDir)
      if (status.migrated > 0) migratedBooks += 1
    } catch (err) {
      errors.push({ book: entry.name, error: (err as Error).message })
    }
  }
  return { workspace, books, migratedBooks, errors }
}

/** 只读当前版本（供设置页/诊断展示） */
export function getWorkspaceSchemaVersion(workspaceDir: string): number {
  return readSchemaVersion(workspaceSchemaPath(workspaceDir))
}

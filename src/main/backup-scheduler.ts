/**
 * 自动备份调度（纯函数 + 本地文件操作，便于单测）。
 *
 * - 备份目录：<userData>/backups
 * - 命名：auto-YYYYMMDD-HHmmss.zip（自动）/ manual-*.zip（手动导出由用户选位置，不在此目录）
 * - 保留：只清理 auto-*，保留最近 keep 份；手动备份永不被自动清理
 */
import fs from 'node:fs'
import path from 'node:path'
import type { AutoBackupStatus, BackupFileInfo } from '../shared/types'
import { exportWorkspace, type BackupReport } from './backup-core'

export interface AutoBackupConfig {
  enabled: boolean
  intervalDays: number
  keep: number
}

function pad(value: number): string {
  return String(value).padStart(2, '0')
}

export function autoBackupName(now = new Date()): string {
  return `auto-${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}-${pad(now.getHours())}${pad(now.getMinutes())}${pad(now.getSeconds())}.zip`
}

export function listBackupFiles(root: string): BackupFileInfo[] {
  if (!fs.existsSync(root)) return []
  return fs
    .readdirSync(root, { withFileTypes: true })
    .filter((entry) => entry.isFile() && entry.name.endsWith('.zip'))
    .map((entry) => {
      const file = path.join(root, entry.name)
      const stat = fs.statSync(file)
      return {
        file,
        name: entry.name,
        bytes: stat.size,
        modifiedAt: stat.mtime.toISOString(),
        auto: entry.name.startsWith('auto-'),
      }
    })
    .sort((a, b) => Date.parse(b.modifiedAt) - Date.parse(a.modifiedAt))
}

export function latestAutoBackup(root: string): BackupFileInfo | null {
  return listBackupFiles(root).find((file) => file.auto) ?? null
}

/** 距离上次自动备份是否已经超过间隔（没有备份时视为需要备份） */
export function isAutoBackupDue(lastAtMs: number | null, intervalDays: number, now = Date.now()): boolean {
  if (!Number.isFinite(intervalDays) || intervalDays <= 0) return true
  if (lastAtMs === null) return true
  return now - lastAtMs >= intervalDays * 24 * 60 * 60 * 1000
}

/** 清理超出 keep 的旧 auto-*；返回被删除的文件名 */
export function pruneAutoBackups(root: string, keep: number): string[] {
  const limit = Math.max(1, Math.min(Math.round(keep) || 5, 20))
  const autoFiles = listBackupFiles(root).filter((file) => file.auto)
  const removed: string[] = []
  for (const file of autoFiles.slice(limit)) {
    try {
      fs.unlinkSync(file.file)
      removed.push(file.name)
    } catch {
      // 单个文件删不掉时忽略，下次再试
    }
  }
  return removed
}

export function autoBackupStatus(root: string, config: AutoBackupConfig, now = Date.now()): AutoBackupStatus {
  const latest = latestAutoBackup(root)
  return {
    root,
    enabled: config.enabled,
    intervalDays: config.intervalDays,
    keep: config.keep,
    ...(latest ? { lastBackupAt: latest.modifiedAt } : {}),
    due: config.enabled && isAutoBackupDue(latest ? Date.parse(latest.modifiedAt) : null, config.intervalDays, now),
    backups: listBackupFiles(root),
  }
}

export interface AutoBackupRunResult {
  ran: boolean
  reason?: string
  file?: string
  report?: BackupReport
  pruned: string[]
}

/** 立即执行一次自动备份（不做 due 判断，由调用方决定） */
export function runAutoBackup(workspaceDir: string, root: string, keep: number): AutoBackupRunResult {
  fs.mkdirSync(root, { recursive: true })
  const file = path.join(root, autoBackupName())
  const report = exportWorkspace(workspaceDir, file)
  const pruned = pruneAutoBackups(root, keep)
  return { ran: true, file, report, pruned }
}

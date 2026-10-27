/**
 * 书库备份 / 恢复（本地 zip）。
 *
 * - 备份：把整个工作区（每本书的 Markdown + 嵌套 .git + book.json）打成一个 zip；
 * - 恢复：先解压到临时目录、逐本校验 book.json，再移动到工作区；同名书跳过，绝不覆盖；
 * - 安全：拒绝 zip-slip（绝对路径 / .. / 盘符）条目；恢复只认「含 book.json 的顶层目录」。
 */
import AdmZip from 'adm-zip'
import { removeDirRecursive } from '../core/fsutil'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

export interface BackupManifest {
  format: 'novel-studio-backup'
  version: 1
  exportedAt: string
  books: Array<{ dir: string; title: string; chapters: number }>
}

export interface BackupReport {
  file: string
  books: number
  bytes: number
}

export interface RestoreReport {
  restored: string[]
  skipped: string[]
  errors: string[]
}

export interface HealthReport {
  books: number
  broken: Array<{ dir: string; error: string }>
}

const SKIP_DIRS = new Set(['.trash', '.DS_Store', 'Thumbs.db'])

function listBookDirs(workspaceDir: string): string[] {
  if (!fs.existsSync(workspaceDir)) return []
  return fs
    .readdirSync(workspaceDir, { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && !SKIP_DIRS.has(entry.name) && !entry.name.startsWith('.'))
    .map((entry) => entry.name)
}

function readBookMeta(bookDir: string): { title?: string } | null {
  try {
    const raw = fs.readFileSync(path.join(bookDir, 'book.json'), 'utf8')
    const parsed = JSON.parse(raw) as { title?: string }
    return parsed && typeof parsed.title === 'string' ? parsed : null
  } catch {
    return null
  }
}

function countChapters(bookDir: string): number {
  const chaptersDir = path.join(bookDir, 'chapters')
  if (!fs.existsSync(chaptersDir)) return 0
  return fs.readdirSync(chaptersDir).filter((name) => name.endsWith('.md')).length
}

function addDirToZip(zip: AdmZip, dir: string, relative: string): void {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (SKIP_DIRS.has(entry.name)) continue
    const absolute = path.join(dir, entry.name)
    const rel = relative ? `${relative}/${entry.name}` : entry.name
    if (entry.isDirectory()) addDirToZip(zip, absolute, rel)
    else if (entry.isFile()) zip.addLocalFile(absolute, path.posix.dirname(rel) === '.' ? '' : path.posix.dirname(rel), entry.name)
  }
}

/** 导出整个工作区；使用临时文件 + rename，避免半截 zip */
export function exportWorkspace(workspaceDir: string, targetFile: string): BackupReport {
  if (!fs.existsSync(workspaceDir)) throw new Error('书库目录不存在')
  const zip = new AdmZip()
  const books: BackupManifest['books'] = []
  for (const name of listBookDirs(workspaceDir)) {
    const bookDir = path.join(workspaceDir, name)
    const meta = readBookMeta(bookDir)
    if (!meta) continue
    books.push({ dir: name, title: meta.title ?? name, chapters: countChapters(bookDir) })
    addDirToZip(zip, bookDir, name)
  }
  const manifest: BackupManifest = {
    format: 'novel-studio-backup',
    version: 1,
    exportedAt: new Date().toISOString(),
    books,
  }
  zip.addFile('manifest.json', Buffer.from(JSON.stringify(manifest, null, 2), 'utf8'))
  const tmp = `${targetFile}.tmp-${process.pid}`
  zip.writeZip(tmp)
  fs.renameSync(tmp, targetFile)
  const stat = fs.statSync(targetFile)
  return { file: targetFile, books: books.length, bytes: stat.size }
}

export function assertSafeEntry(entryName: string): void {
  const normalized = entryName.replace(/\\/g, '/')
  if (
    normalized.startsWith('/') ||
    normalized.includes('../') ||
    /^[a-zA-Z]:/.test(normalized) ||
    normalized.includes('..\\')
  ) {
    throw new Error(`备份包含不安全路径：${entryName}`)
  }
}

/** 恢复备份：逐本校验后移动到工作区；同名书跳过，不覆盖现有数据 */
export function restoreWorkspace(zipFile: string, workspaceDir: string): RestoreReport {
  if (!fs.existsSync(zipFile)) throw new Error('备份文件不存在')
  const zip = new AdmZip(zipFile)
  for (const entry of zip.getEntries()) assertSafeEntry(entry.entryName)
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'novel-studio-restore-'))
  const report: RestoreReport = { restored: [], skipped: [], errors: [] }
  try {
    zip.extractAllTo(temp, true)
    fs.mkdirSync(workspaceDir, { recursive: true })
    for (const name of listBookDirs(temp)) {
      const source = path.join(temp, name)
      if (!readBookMeta(source)) {
        report.errors.push(`${name}: 缺少有效的 book.json`)
        continue
      }
      const target = path.join(workspaceDir, name)
      if (fs.existsSync(target)) {
        report.skipped.push(name)
        continue
      }
      fs.renameSync(source, target)
      report.restored.push(name)
    }
    return report
  } finally {
    try {
      removeDirRecursive(temp)
    } catch {
      // 临时目录清理失败不影响结果
    }
  }
}

/** 书库健康检查：book.json 是否可读、章节数是否可统计 */
export function scanWorkspaceHealth(workspaceDir: string): HealthReport {
  const broken: HealthReport['broken'] = []
  let books = 0
  for (const name of listBookDirs(workspaceDir)) {
    const dir = path.join(workspaceDir, name)
    const meta = readBookMeta(dir)
    if (!meta) {
      broken.push({ dir: name, error: 'book.json 缺失或损坏' })
      continue
    }
    books += 1
    try {
      countChapters(dir)
    } catch (err) {
      broken.push({ dir: name, error: `读取章节失败：${(err as Error).message}` })
    }
  }
  return { books, broken }
}

export function defaultBackupName(now = new Date()): string {
  const pad = (value: number): string => String(value).padStart(2, '0')
  return `Novel-Studio-备份-${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}-${pad(now.getHours())}${pad(now.getMinutes())}.zip`
}

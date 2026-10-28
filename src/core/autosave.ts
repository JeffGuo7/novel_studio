/**
 * 编辑器自动存档：防止崩溃/断电丢失未保存的修改。
 *
 * 与草稿 system 的区别：
 * - 草稿是用户主动保存的版本（进 .studio/drafts，有历史、可归档）；
 * - 自动存档只是"防丢盘"的临时快照，只保留最新一份，保存成功/用户丢弃后即删除；
 * - 存放在 .studio/autosave/entries.json（单文件、原子写、最多保留 50 条 / 7 天）。
 */
import path from 'node:path'
import type { AutosaveEntryInfo } from '../shared/types'
import { CoreError } from './errors'
import { readFileOrNull, writeFileAtomic } from './fsutil'

const AUTOSAVE_DIR = path.join('.studio', 'autosave')
const AUTOSAVE_FILE = path.join(AUTOSAVE_DIR, 'entries.json')
const MAX_ENTRIES = 50
const MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000
const ID_RE = /^(chapter:\d{4}|knowledge:[a-z0-9_]+\.md)$/

interface AutosaveFile {
  version: 1
  entries: AutosaveEntryInfo[]
}

export function autosaveFilePath(bookDir: string): string {
  return path.join(bookDir, AUTOSAVE_FILE)
}

export function isValidAutosaveId(id: string): boolean {
  return ID_RE.test(id)
}

function readFileSafe(bookDir: string): AutosaveFile {
  const raw = readFileOrNull(autosaveFilePath(bookDir))
  if (!raw) return { version: 1, entries: [] }
  try {
    const parsed = JSON.parse(raw) as Partial<AutosaveFile>
    if (!Array.isArray(parsed.entries)) return { version: 1, entries: [] }
    return {
      version: 1,
      entries: parsed.entries.filter((entry): entry is AutosaveEntryInfo =>
        Boolean(
          entry &&
            typeof entry.id === 'string' &&
            isValidAutosaveId(entry.id) &&
            typeof entry.content === 'string' &&
            typeof entry.updatedAt === 'string',
        ),
      ),
    }
  } catch {
    return { version: 1, entries: [] }
  }
}

function prune(entries: AutosaveEntryInfo[]): AutosaveEntryInfo[] {
  const now = Date.now()
  return entries
    .filter((entry) => {
      const time = Date.parse(entry.updatedAt)
      return Number.isFinite(time) && now - time <= MAX_AGE_MS
    })
    .sort((a, b) => Date.parse(b.updatedAt) - Date.parse(a.updatedAt))
    .slice(0, MAX_ENTRIES)
}

function writeFileSafe(bookDir: string, entries: AutosaveEntryInfo[]): void {
  writeFileAtomic(autosaveFilePath(bookDir), JSON.stringify({ version: 1, entries }, null, 2))
}

/** 列出自动存档（自动清理过期/非法条目） */
export function listAutosaves(bookDir: string): AutosaveEntryInfo[] {
  const file = readFileSafe(bookDir)
  const pruned = prune(file.entries)
  if (pruned.length !== file.entries.length) writeFileSafe(bookDir, pruned)
  return pruned
}

export function readAutosave(bookDir: string, id: string): AutosaveEntryInfo | null {
  return listAutosaves(bookDir).find((entry) => entry.id === id) ?? null
}

/** 写入/更新一条自动存档 */
export function writeAutosave(
  bookDir: string,
  entry: AutosaveEntryInfo,
): AutosaveEntryInfo {
  if (!isValidAutosaveId(entry.id)) {
    throw new CoreError('INVALID_AUTOSAVE_ID', `自动存档 id 非法：${entry.id}`)
  }
  if (typeof entry.content !== 'string') {
    throw new CoreError('INVALID_AUTOSAVE', '自动存档内容必须是字符串')
  }
  const normalized: AutosaveEntryInfo = {
    ...entry,
    updatedAt: new Date().toISOString(),
    words: entry.content.replace(/\s+/g, '').length,
  }
  const entries = prune([
    normalized,
    ...listAutosaves(bookDir).filter((item) => item.id !== entry.id),
  ])
  writeFileSafe(bookDir, entries)
  return normalized
}

/** 删除一条自动存档（保存成功或用户丢弃时调用） */
export function discardAutosave(bookDir: string, id: string): boolean {
  const entries = listAutosaves(bookDir)
  const next = entries.filter((entry) => entry.id !== id)
  if (next.length === entries.length) return false
  writeFileSafe(bookDir, next)
  return true
}

import fs from 'node:fs'
import path from 'node:path'
import type { DraftInfo, DraftVersion } from '../shared/types'
import { CoreError } from './errors'
import { countWords, ensureDir, readFileOrNull, removeDirRecursive, writeFileAtomic } from './fsutil'

const CHAPTER_KEY_RE = /^\d{4}$/

export function isValidChapterKey(key: string): boolean {
  return CHAPTER_KEY_RE.test(key)
}

export function assertChapterKey(key: string): string {
  if (!isValidChapterKey(key)) {
    throw new CoreError('INVALID_CHAPTER_KEY', `chapter key must be 4 digits, got "${key}"`)
  }
  return key
}

export function draftsRoot(bookDir: string): string {
  return path.join(bookDir, '.studio', 'drafts')
}

export function chapterDraftDir(bookDir: string, chapterKey: string): string {
  return path.join(draftsRoot(bookDir), assertChapterKey(chapterKey))
}

function metaPath(bookDir: string, chapterKey: string): string {
  return path.join(chapterDraftDir(bookDir, chapterKey), 'meta.json')
}

function versionPath(bookDir: string, chapterKey: string, version: number): string {
  return path.join(chapterDraftDir(bookDir, chapterKey), `v${String(version).padStart(3, '0')}.md`)
}

function loadMeta(bookDir: string, chapterKey: string): DraftInfo[] {
  const raw = readFileOrNull(metaPath(bookDir, chapterKey))
  if (!raw) return []
  try {
    const parsed = JSON.parse(raw)
    return Array.isArray(parsed) ? (parsed as DraftInfo[]) : []
  } catch {
    return []
  }
}

function saveMeta(bookDir: string, chapterKey: string, versions: DraftInfo[]): void {
  ensureDir(chapterDraftDir(bookDir, chapterKey))
  writeFileAtomic(metaPath(bookDir, chapterKey), JSON.stringify(versions, null, 2))
}

/** 列出书里所有有草稿的章节 key */
export function listDraftChapterKeys(bookDir: string): string[] {
  const root = draftsRoot(bookDir)
  if (!fs.existsSync(root)) return []
  return fs
    .readdirSync(root, { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && isValidChapterKey(entry.name))
    .map((entry) => entry.name)
    .sort()
}

/** 草稿版本列表（新 -> 旧） */
export function listDrafts(bookDir: string, chapterKey: string): DraftInfo[] {
  return loadMeta(bookDir, chapterKey).sort((a, b) => b.version - a.version)
}

export function saveDraft(
  bookDir: string,
  chapterKey: string,
  content: string,
  meta: { source?: DraftInfo['source']; model?: string; note?: string } = {},
): DraftInfo {
  const versions = loadMeta(bookDir, chapterKey)
  const nextVersion = versions.reduce((max, item) => Math.max(max, item.version), 0) + 1
  const info: DraftInfo = {
    version: nextVersion,
    createdAt: new Date().toISOString(),
    source: meta.source ?? 'human',
    words: countWords(content),
    ...(meta.model ? { model: meta.model } : {}),
    ...(meta.note ? { note: meta.note } : {}),
  }
  ensureDir(chapterDraftDir(bookDir, chapterKey))
  writeFileAtomic(versionPath(bookDir, chapterKey, nextVersion), content)
  saveMeta(bookDir, chapterKey, [...versions, info])
  return info
}

export function readDraft(bookDir: string, chapterKey: string, version: number): DraftVersion {
  const info = loadMeta(bookDir, chapterKey).find((item) => item.version === version)
  if (!info) {
    throw new CoreError('DRAFT_NOT_FOUND', `draft v${version} not found for chapter ${chapterKey}`)
  }
  const content = readFileOrNull(versionPath(bookDir, chapterKey, version))
  if (content === null) {
    throw new CoreError('DRAFT_BROKEN', `draft v${version} file is missing`)
  }
  return { ...info, content }
}

export function latestDraft(bookDir: string, chapterKey: string): DraftVersion | null {
  const versions = listDrafts(bookDir, chapterKey)
  if (versions.length === 0) return null
  return readDraft(bookDir, chapterKey, versions[0].version)
}

export function discardDrafts(bookDir: string, chapterKey: string): number {
  const dir = chapterDraftDir(bookDir, chapterKey)
  const count = loadMeta(bookDir, chapterKey).length
  removeDirRecursive(dir)
  return count
}

/**
 * 章节字数缓存：避免每次快照都重读整本书算字数。
 *
 * 为什么用 size + mtime 而不是内容 hash：hash 需要先读全文，省不掉 IO；
 * 字数只用于展示/统计，允许极小概率的外部同尺寸同时间戳修改不被发现；
 * 应用内所有保存/导入/删除都会更新 mtime，缓存会自然失效。
 *
 * 存储：<book>/.studio/cache/chapters.json（.studio 已被书库 .gitignore 忽略）。
 */
import fs from 'node:fs'
import path from 'node:path'
import { countWords, ensureDir, readFileOrNull, writeFileAtomic } from './fsutil'

const CACHE_FILE = path.join('.studio', 'cache', 'chapters.json')
const CACHE_VERSION = 1

export interface ChapterWordEntry {
  size: number
  mtimeMs: number
  words: number
}

interface ChapterWordCacheFile {
  version: 1
  entries: Record<string, ChapterWordEntry>
}

export function chapterWordCachePath(bookDir: string): string {
  return path.join(bookDir, CACHE_FILE)
}

/** 读取缓存；损坏/版本不符时返回空（下次全量重建） */
export function readChapterWordCache(bookDir: string): Record<string, ChapterWordEntry> {
  const raw = readFileOrNull(chapterWordCachePath(bookDir))
  if (!raw) return {}
  try {
    const parsed = JSON.parse(raw) as Partial<ChapterWordCacheFile>
    if (parsed?.version !== CACHE_VERSION || typeof parsed.entries !== 'object' || !parsed.entries) return {}
    const entries: Record<string, ChapterWordEntry> = {}
    for (const [key, value] of Object.entries(parsed.entries)) {
      const item = value as Partial<ChapterWordEntry> | null
      if (
        item &&
        typeof item.size === 'number' &&
        typeof item.mtimeMs === 'number' &&
        typeof item.words === 'number'
      ) {
        entries[key] = { size: item.size, mtimeMs: item.mtimeMs, words: item.words }
      }
    }
    return entries
  } catch {
    return {}
  }
}

export function writeChapterWordCache(bookDir: string, entries: Record<string, ChapterWordEntry>): void {
  try {
    ensureDir(path.dirname(chapterWordCachePath(bookDir)))
    const payload: ChapterWordCacheFile = { version: CACHE_VERSION, entries }
    writeFileAtomic(chapterWordCachePath(bookDir), JSON.stringify(payload))
  } catch {
    // 缓存写失败不影响主流程
  }
}

/** 计算单个章节字数：缓存命中时零内容读取 */
export function chapterWordsWithCache(
  bookDir: string,
  relPath: string,
  absolutePath: string,
  cache: Record<string, ChapterWordEntry>,
): { words: number; entry: ChapterWordEntry; changed: boolean } {
  const cached = cache[relPath]
  try {
    const stat = fs.statSync(absolutePath)
    if (cached && cached.size === stat.size && cached.mtimeMs === stat.mtimeMs) {
      return { words: cached.words, entry: cached, changed: false }
    }
    const content = readFileOrNull(absolutePath) ?? ''
    const words = countWords(content)
    return {
      words,
      entry: { size: stat.size, mtimeMs: stat.mtimeMs, words },
      changed: true,
    }
  } catch {
    const content = readFileOrNull(absolutePath) ?? ''
    const words = countWords(content)
    return {
      words,
      entry: { size: content.length, mtimeMs: 0, words },
      changed: true,
    }
  }
}

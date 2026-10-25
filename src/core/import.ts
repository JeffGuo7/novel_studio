import fs from 'node:fs'
import path from 'node:path'
import type { BookSnapshot } from '../shared/types'
import { CoreError } from './errors'
import { ensureDir, writeFileAtomic } from './fsutil'
import { createGitPort, type GitPort } from './git'
import { chapterFileName, chapterKeyOf, listChapters, sanitizeChapterTitle, snapshotBook } from './book'

export interface ImportedChapter {
  title: string
  content: string
}

export interface ImportReport {
  source: string
  chapters: number
  words: number
  titles: string[]
  encoding: string
  /** 本次导入涉及的文本源数量（粘贴/多文件时 >1） */
  sources?: number
}

export interface ImportOptions {
  git?: GitPort
}

/** 章节标题行：第 12 章 / 第一章 / 序章 / 楔子 / Chapter 3 */
const HEADING_RE =
  /^\s*(?:第\s*[0-9零一二三四五六七八九十百千万两]+\s*[章节回卷][^\n]{0,40}|序章[^\n]{0,40}|楔子[^\n]{0,40}|Chapter\s+\d+[^\n]{0,60})\s*$/i

const MAX_HEADING_LENGTH = 60

/**
 * 把整段文本切成章节。
 * 命中标题行就开新章；标题之前的内容作为「前言」单独成章（如果有正文的话）。
 */
export function splitTextIntoChapters(text: string, fallbackTitle = '正文'): ImportedChapter[] {
  const normalized = text.replace(/\r\n?/g, '\n')
  const lines = normalized.split('\n')
  const chapters: ImportedChapter[] = []
  let currentTitle: string | null = null
  let buffer: string[] = []

  const flush = (): void => {
    const content = buffer.join('\n').trim()
    if (!content) {
      buffer = []
      return
    }
    chapters.push({ title: currentTitle ?? fallbackTitle, content })
    buffer = []
  }

  for (const line of lines) {
    const trimmed = line.trim()
    const isHeading = trimmed.length > 0 && trimmed.length <= MAX_HEADING_LENGTH && HEADING_RE.test(trimmed)
    if (isHeading) {
      flush()
      currentTitle = trimmed
      buffer.push(line)
      continue
    }
    buffer.push(line)
  }
  flush()

  if (chapters.length === 0) {
    const content = normalized.trim()
    return content ? [{ title: fallbackTitle, content }] : []
  }
  return chapters
}

/**
 * 解码文本文件：优先 UTF-8；出现大量替换字符时回退 GB18030（番茄下载的 txt 常见）。
 * 返回解码文本与命中的编码名。
 */
export function decodeTextBuffer(buffer: Uint8Array): { text: string; encoding: string } {
  const utf8Decoder = new TextDecoder('utf-8', { fatal: false })
  const utf8 = utf8Decoder.decode(buffer)
  const broken = (utf8.match(/\uFFFD/g) ?? []).length

  if (broken === 0) return { text: utf8, encoding: 'utf-8' }

  try {
    const gb = new TextDecoder('gb18030').decode(buffer)
    const gbBroken = (gb.match(/\uFFFD/g) ?? []).length
    if (gbBroken < broken) return { text: gb, encoding: 'gb18030' }
  } catch {
    // 运行环境不支持 gb18030 时保持 UTF-8 结果
  }
  return { text: utf8, encoding: 'utf-8' }
}

function uniqueFileName(bookDir: string, key: string, title: string, taken: Set<string>): string {
  const safeTitle = sanitizeChapterTitle(title) || '未命名'
  let candidate = chapterFileName(key, safeTitle)
  let index = 2
  while (taken.has(candidate) || fs.existsSync(path.join(bookDir, 'chapters', candidate))) {
    candidate = chapterFileName(key, `${safeTitle}-${index}`)
    index += 1
  }
  taken.add(candidate)
  return candidate
}

export interface ImportSource {
  text: string
  source: string
  encoding?: string
  fallbackTitle?: string
}

/**
 * 把一组文本源导入成章节（一次提交，commit 前缀 [导入]）。
 * 每个源内部按标题切章，章节编号跨源连续递增。
 */
export async function importSourcesIntoBook(
  bookDir: string,
  sources: ImportSource[],
  options: ImportOptions = {},
): Promise<{ snapshot: BookSnapshot; report: ImportReport }> {
  const valid = sources.filter((item) => item.text.trim().length > 0)
  if (valid.length === 0) {
    throw new CoreError('EMPTY_IMPORT', '没有可导入的正文')
  }

  const chapters: ImportedChapter[] = []
  for (const source of valid) {
    chapters.push(...splitTextIntoChapters(source.text, source.fallbackTitle ?? '正文'))
  }
  if (chapters.length === 0) {
    throw new CoreError('EMPTY_IMPORT', '文件里没有可导入的正文')
  }

  const git = options.git ?? createGitPort()
  const chaptersDir = path.join(bookDir, 'chapters')
  ensureDir(chaptersDir)

  const existing = listChapters(bookDir)
  let nextNumber = existing.reduce((max, item) => Math.max(max, item.number), 0) + 1
  const taken = new Set<string>()
  const changedPaths: string[] = []
  const titles: string[] = []
  let words = 0

  for (const chapter of chapters) {
    const key = chapterKeyOf(nextNumber)
    nextNumber += 1
    const fileName = uniqueFileName(bookDir, key, chapter.title, taken)
    const relPath = `chapters/${fileName}`
    writeFileAtomic(path.join(bookDir, 'chapters', fileName), `${chapter.content.trim()}\n`)
    changedPaths.push(relPath)
    titles.push(chapter.title)
    words += chapter.content.replace(/\s+/g, '').length
  }

  const sourceNames = valid.map((item) => item.source).filter(Boolean)
  const sourceLabel =
    sourceNames.length <= 2
      ? sourceNames.join('、') || '本地文本'
      : `${sourceNames[0]} 等 ${sourceNames.length} 个文件`

  await git.commitPaths(bookDir, changedPaths, `[导入] 导入 ${chapters.length} 章 · ${sourceLabel}`)

  return {
    snapshot: await snapshotBook(bookDir, { git }),
    report: {
      source: sourceLabel,
      chapters: chapters.length,
      words,
      titles,
      encoding: valid[0].encoding ?? 'utf-8',
      sources: valid.length,
    },
  }
}

/** 把单段文本导入成章节 */
export async function importTextIntoBook(
  bookDir: string,
  input: { text: string; source: string; encoding?: string; fallbackTitle?: string },
  options: ImportOptions = {},
): Promise<{ snapshot: BookSnapshot; report: ImportReport }> {
  return importSourcesIntoBook(bookDir, [input], options)
}

function readSourceFile(filePath: string): ImportSource {
  if (!fs.existsSync(filePath)) {
    throw new CoreError('FILE_NOT_FOUND', `文件不存在：${filePath}`)
  }
  const buffer = fs.readFileSync(filePath)
  const { text, encoding } = decodeTextBuffer(buffer)
  const baseName = path.basename(filePath).replace(/\.(txt|md|text)$/i, '')
  return {
    text,
    source: path.basename(filePath),
    encoding,
    fallbackTitle: baseName || '正文',
  }
}

/** 从单文件导入（自动处理编码） */
export async function importFileIntoBook(
  bookDir: string,
  filePath: string,
  options: ImportOptions = {},
): Promise<{ snapshot: BookSnapshot; report: ImportReport }> {
  return importSourcesIntoBook(bookDir, [readSourceFile(filePath)], options)
}

/** 批量导入多个文件，合成一个 [导入] 提交 */
export async function importManyFilesIntoBook(
  bookDir: string,
  filePaths: string[],
  options: ImportOptions = {},
): Promise<{ snapshot: BookSnapshot; report: ImportReport }> {
  if (filePaths.length === 0) {
    throw new CoreError('EMPTY_IMPORT', '没有选择文件')
  }
  const sources = filePaths.map((filePath) => readSourceFile(filePath))
  return importSourcesIntoBook(bookDir, sources, options)
}

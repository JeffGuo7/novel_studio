/**
 * 全书搜索 / 替换（作者自己用，和 Agent 的 search_story 互补）。
 *
 * - 搜索范围：章节正文 + 知识文件；字面匹配（非正则），默认忽略大小写；
 * - 替换：一次 Git 提交，消息形如 `[替换] "旧" → "新"（N 处 / M 个文件）`；
 * - 只写白名单路径（章节 / 知识文件），不碰 book.json。
 */
import path from 'node:path'
import type { BookSnapshot, BookSearchReport, ReplaceReport, SearchFileResult, SearchMatchInfo } from '../shared/types'
import { CoreError } from './errors'
import { KNOWLEDGE_FILES, assertWritablePath, listChapters, snapshotBook } from './book'
import { readFileOrNull, writeFileAtomic } from './fsutil'
import { createGitPort, type GitPort } from './git'

export interface SearchOptions {
  caseSensitive?: boolean
  includeChapters?: boolean
  includeKnowledge?: boolean
  maxResults?: number
}

export interface ReplaceOptions extends SearchOptions {
  paths?: string[]
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

function matcher(query: string, caseSensitive: boolean): RegExp {
  return new RegExp(escapeRegExp(query), caseSensitive ? 'g' : 'gi')
}

function findMatchesInLine(line: string, regex: RegExp): SearchMatchInfo[] {
  regex.lastIndex = 0
  const matches: SearchMatchInfo[] = []
  let match = regex.exec(line)
  while (match) {
    matches.push({ line: 1, text: line, start: match.index, end: match.index + match[0].length })
    if (match[0].length === 0) regex.lastIndex += 1
    match = regex.exec(line)
  }
  return matches
}

interface CandidateFile {
  path: string
  kind: 'chapter' | 'knowledge'
  title: string
}

function candidateFiles(bookDir: string, options: SearchOptions): CandidateFile[] {
  const includeChapters = options.includeChapters !== false
  const includeKnowledge = options.includeKnowledge !== false
  const files: CandidateFile[] = []
  if (includeChapters) {
    for (const chapter of listChapters(bookDir)) {
      files.push({ path: chapter.path, kind: 'chapter', title: chapter.title })
    }
  }
  if (includeKnowledge) {
    for (const knowledge of KNOWLEDGE_FILES) {
      files.push({ path: knowledge.name, kind: 'knowledge', title: knowledge.title })
    }
  }
  return files
}

/** 在整本书里查找字面字符串 */
export function searchBook(bookDir: string, query: string, options: SearchOptions = {}): BookSearchReport {
  const trimmed = query.trim()
  if (!trimmed) return { query, total: 0, truncated: false, files: [] }
  const regex = matcher(trimmed, options.caseSensitive === true)
  const maxResults = Math.max(1, Math.min(options.maxResults ?? 300, 2000))
  const files: SearchFileResult[] = []
  let total = 0
  let collected = 0
  let truncated = false

  for (const candidate of candidateFiles(bookDir, options)) {
    const content = readFileOrNull(path.join(bookDir, candidate.path))
    if (!content) continue
    const lines = content.split('\n')
    const matches: SearchMatchInfo[] = []
    let count = 0
    lines.forEach((line, index) => {
      const found = findMatchesInLine(line, regex)
      if (found.length === 0) return
      count += found.length
      if (collected + matches.length < maxResults) {
        matches.push(...found.map((item) => ({ ...item, line: index + 1 })))
      }
    })
    if (count === 0) continue
    total += count
    collected += matches.length
    files.push({ path: candidate.path, kind: candidate.kind, title: candidate.title, count, matches })
    if (collected >= maxResults) {
      truncated = true
      break
    }
  }
  return { query: trimmed, total, truncated, files }
}

export interface ReplaceBookOptions extends ReplaceOptions {
  git?: GitPort
}

function replaceInContent(content: string, query: string, replacement: string, caseSensitive: boolean): { content: string; count: number } {
  let count = 0
  const next = content.replace(matcher(query, caseSensitive), () => {
    count += 1
    return replacement
  })
  return { content: next, count }
}

function shortText(value: string, max = 24): string {
  const flat = value.replace(/\s+/g, ' ').trim()
  return flat.length > max ? `${flat.slice(0, max)}…` : flat
}

/** 在指定文件（默认全书）里替换，并提交一次 [替换] */
export async function replaceInBook(
  bookDir: string,
  query: string,
  replacement: string,
  options: ReplaceBookOptions = {},
): Promise<ReplaceReport> {
  const trimmed = query.trim()
  if (!trimmed) throw new CoreError('EMPTY_QUERY', '搜索内容不能为空')
  const git = options.git ?? createGitPort()
  const files = options.paths?.length
    ? options.paths.map((relPath) => {
        assertWritablePath(bookDir, relPath)
        const chapter = listChapters(bookDir).find((item) => item.path === relPath)
        const knowledge = KNOWLEDGE_FILES.find((item) => item.name === relPath)
        return {
          path: relPath,
          kind: chapter ? ('chapter' as const) : ('knowledge' as const),
          title: chapter?.title ?? knowledge?.title ?? relPath,
        }
      })
    : candidateFiles(bookDir, options)

  const changed: Array<{ path: string; count: number; title: string }> = []
  let replacements = 0
  for (const file of files) {
    const content = readFileOrNull(path.join(bookDir, file.path))
    if (!content) continue
    const next = replaceInContent(content, trimmed, replacement, options.caseSensitive === true)
    if (next.count === 0) continue
    writeFileAtomic(path.join(bookDir, file.path), next.content)
    changed.push({ path: file.path, count: next.count, title: file.title })
    replacements += next.count
  }

  let snapshot: BookSnapshot
  if (changed.length === 0) {
    snapshot = await snapshotBook(bookDir, { git })
    return { snapshot, changedFiles: 0, replacements: 0, files: [] }
  }

  const message = `[替换] “${shortText(trimmed)}” → “${shortText(replacement)}”（${replacements} 处 / ${changed.length} 个文件）`
  await git.commitPaths(
    bookDir,
    changed.map((file) => file.path),
    message,
  )
  snapshot = await snapshotBook(bookDir, { git })
  return {
    snapshot,
    changedFiles: changed.length,
    replacements,
    files: changed.map((file) => ({ path: file.path, count: file.count, title: file.title })),
  }
}

/**
 * 章节结构变更（重编号 / 上移下移 / 插入 / 合并 / 拆分）。
 *
 * 设计约束：
 * - 章节顺序由 `0001_标题.md` 的数字前缀决定，任何结构变更都走「一次性重编号」，
 *   保证编号连续、标题与编号一致；
 * - 所有变更在一次 Git 提交里完成（重命名 = 删除 + 新增，历史可从旧提交找回）；
 * - 同步迁移 `.studio` 里的衍生状态：草稿目录、知识管线 chapterHashes、会话 chapterCosts；
 * - 搜索索引是纯派生数据，直接丢弃，下次检索自动重建。
 */
import fs from 'node:fs'
import path from 'node:path'
import type { BookSnapshot } from '../shared/types'
import { CoreError } from './errors'
import { ensureDir, readFileOrNull, removeDirRecursive, removeFile, writeFileAtomic } from './fsutil'
import { createGitPort, type GitPort } from './git'
import {
  chapterFileName,
  chapterKeyOf,
  listChapters,
  snapshotBook,
} from './book'
import { discardDrafts, draftsRoot, listDraftChapterKeys } from './drafts'

function pipelineStatePath(bookDir: string): string {
  return path.join(bookDir, '.studio', 'pipeline-state.json')
}

export interface ReorganizeOptions {
  git?: GitPort
}

export interface ReorganizeResult {
  snapshot: BookSnapshot
  /** 旧 key -> 新 key；被合并/删除的旧 key 也映射到新 key */
  mapping: Record<string, string>
  message: string
}

interface ExistingChapter {
  key: string
  title: string
  path: string
  content: string
}

interface PlannedChapter {
  oldKey: string | null
  title: string
  content: string
}

function gitOf(options: ReorganizeOptions): GitPort {
  return options.git ?? createGitPort()
}

function readExisting(bookDir: string): ExistingChapter[] {
  return listChapters(bookDir).map((chapter) => ({
    key: chapter.key,
    title: chapter.title,
    path: chapter.path,
    content: readFileOrNull(path.join(bookDir, chapter.path)) ?? '',
  }))
}

/** 去掉正文开头的一行 H1 标题（如果有），返回正文主体 */
function bodyWithoutHeading(content: string): string {
  return content.replace(/^\uFEFF/, '').replace(/^#\s+[^\n]*\n?/, '').trim()
}

/** 规范成“# 第 N 章 标题 + 正文” */
function canonicalChapter(number: number, title: string, body: string): string {
  const heading = `# 第 ${number} 章 ${title}`.trim()
  const trimmed = body.trim()
  return trimmed ? `${heading}\n\n${trimmed}\n` : `${heading}\n\n`
}

function draftDir(bookDir: string, key: string): string {
  return path.join(draftsRoot(bookDir), key)
}

function remapDrafts(bookDir: string, mapping: Record<string, string>): void {
  const root = draftsRoot(bookDir)
  if (!fs.existsSync(root)) return
  const oldKeys = listDraftChapterKeys(bookDir)
  const staged: Array<{ key: string; temp: string }> = []
  for (const key of oldKeys) {
    const temp = path.join(root, `__tmp_${key}`)
    try {
      fs.renameSync(draftDir(bookDir, key), temp)
      staged.push({ key, temp })
    } catch {
      // 目录可能刚好被清理，忽略
    }
  }
  for (const item of staged) {
    const targetKey = mapping[item.key]
    if (!targetKey) {
      removeDirRecursive(item.temp)
      continue
    }
    const target = draftDir(bookDir, targetKey)
    removeDirRecursive(target)
    ensureDir(path.dirname(target))
    fs.renameSync(item.temp, target)
  }
}

function remapPipelineState(bookDir: string, mapping: Record<string, string>): void {
  const file = pipelineStatePath(bookDir)
  const raw = readFileOrNull(file)
  if (!raw) return
  try {
    const state = JSON.parse(raw) as {
      chapterHashes?: Record<string, string>
      lastChapterKey?: string
      chapterCount?: number
      [key: string]: unknown
    }
    const hashes: Record<string, string> = {}
    for (const [oldKey, hash] of Object.entries(state.chapterHashes ?? {})) {
      const nextKey = mapping[oldKey]
      if (nextKey) hashes[nextKey] = hash
    }
    const keys = Object.keys(hashes).sort()
    state.chapterHashes = hashes
    state.chapterCount = keys.length
    if (keys.length > 0) state.lastChapterKey = keys[keys.length - 1]
    writeFileAtomic(file, JSON.stringify(state, null, 2))
  } catch {
    // 状态损坏时留给知识管线自己重建
  }
}

function remapSessionCosts(bookDir: string, mapping: Record<string, string>): void {
  const file = path.join(bookDir, '.studio', 'agent', 'session.json')
  const raw = readFileOrNull(file)
  if (!raw) return
  try {
    const session = JSON.parse(raw) as { chapterCosts?: Record<string, number>;[key: string]: unknown }
    if (!session.chapterCosts) return
    const costs: Record<string, number> = {}
    for (const [oldKey, cost] of Object.entries(session.chapterCosts)) {
      const nextKey = mapping[oldKey]
      if (nextKey) costs[nextKey] = Number(((costs[nextKey] ?? 0) + cost).toFixed(6))
    }
    session.chapterCosts = costs
    writeFileAtomic(file, JSON.stringify(session))
  } catch {
    // 会话文件损坏时忽略，下一次启动会重建
  }
}

function clearStoryIndex(bookDir: string): void {
  const dir = path.join(bookDir, '.studio', 'index')
  removeFile(path.join(dir, 'search-index.json'))
  removeFile(path.join(dir, 'meta.json'))
}

function mappingFromPlan(plan: PlannedChapter[]): Record<string, string> {
  const mapping: Record<string, string> = {}
  plan.forEach((item, index) => {
    if (item.oldKey) mapping[item.oldKey] = chapterKeyOf(index + 1)
  })
  return mapping
}

async function applyPlan(
  bookDir: string,
  existing: ExistingChapter[],
  plan: PlannedChapter[],
  message: string,
  options: ReorganizeOptions,
  extraMapping: Record<string, string> = {},
): Promise<ReorganizeResult> {
  if (plan.length === 0) throw new CoreError('PLAN_EMPTY', '章节操作后不能没有章节')
  const git = gitOf(options)
  const chaptersDir = path.join(bookDir, 'chapters')
  ensureDir(chaptersDir)

  // 先按新编号计算目标文件，内容统一规范标题
  const targets = plan.map((item, index) => {
    const number = index + 1
    const fileName = chapterFileName(chapterKeyOf(number), item.title)
    return {
      relPath: `chapters/${fileName}`,
      content: canonicalChapter(number, item.title, item.content),
    }
  })

  // 删除全部旧文件，再写新文件（避免 key 互换时互相覆盖）
  for (const chapter of existing) removeFile(path.join(bookDir, chapter.path))
  for (const target of targets) writeFileAtomic(path.join(bookDir, target.relPath), target.content)

  const mapping = { ...mappingFromPlan(plan), ...extraMapping }
  remapDrafts(bookDir, mapping)
  remapPipelineState(bookDir, mapping)
  remapSessionCosts(bookDir, mapping)
  clearStoryIndex(bookDir)

  const changedPaths = [
    ...existing.map((chapter) => chapter.path),
    ...targets.map((target) => target.relPath),
  ]
  await git.commitPaths(bookDir, changedPaths, message)
  return {
    snapshot: await snapshotBook(bookDir, { git }),
    mapping,
    message,
  }
}

/** 重新连续编号（补齐删除/合并留下的空号） */
export async function renumberChapters(
  bookDir: string,
  options: ReorganizeOptions = {},
): Promise<ReorganizeResult> {
  const existing = readExisting(bookDir)
  if (existing.length === 0) throw new CoreError('NO_CHAPTERS', '还没有章节可重编号')
  const plan = existing.map((chapter) => ({
    oldKey: chapter.key,
    title: chapter.title,
    content: bodyWithoutHeading(chapter.content),
  }))
  return applyPlan(bookDir, existing, plan, '[章节] 重新编号 1-' + plan.length, options)
}

/** 上移 / 下移一章 */
export async function moveChapter(
  bookDir: string,
  chapterKey: string,
  direction: 'up' | 'down',
  options: ReorganizeOptions = {},
): Promise<ReorganizeResult> {
  const existing = readExisting(bookDir)
  const index = existing.findIndex((chapter) => chapter.key === chapterKey)
  if (index < 0) throw new CoreError('CHAPTER_NOT_FOUND', `第 ${Number(chapterKey)} 章不存在`)
  const targetIndex = direction === 'up' ? index - 1 : index + 1
  if (targetIndex < 0 || targetIndex >= existing.length) {
    throw new CoreError('CHAPTER_EDGE', direction === 'up' ? '已经是第一章' : '已经是最后一章')
  }
  const ordered = [...existing]
  ;[ordered[index], ordered[targetIndex]] = [ordered[targetIndex], ordered[index]]
  const plan = ordered.map((chapter) => ({
    oldKey: chapter.key,
    title: chapter.title,
    content: bodyWithoutHeading(chapter.content),
  }))
  const chapter = existing[index]
  const message = `[章节] ${direction === 'up' ? '上移' : '下移'}第 ${chapterKeyOf(index + 1)} 章 ${chapter.title}`
  return applyPlan(bookDir, existing, plan, message, options)
}

/** 在指定章节之后插入新章（afterKey=null 表示插入到最前面） */
export async function insertChapterAfter(
  bookDir: string,
  afterKey: string | null,
  input: { title: string; content?: string },
  options: ReorganizeOptions = {},
): Promise<ReorganizeResult> {
  const title = input.title.trim()
  if (!title) throw new CoreError('INVALID_TITLE', '章节标题不能为空')
  const existing = readExisting(bookDir)
  const index = afterKey ? existing.findIndex((chapter) => chapter.key === afterKey) : -1
  if (afterKey && index < 0) throw new CoreError('CHAPTER_NOT_FOUND', `第 ${Number(afterKey)} 章不存在`)
  const insertAt = afterKey ? index + 1 : 0
  const plan: PlannedChapter[] = existing.map((chapter) => ({
    oldKey: chapter.key,
    title: chapter.title,
    content: bodyWithoutHeading(chapter.content),
  }))
  plan.splice(insertAt, 0, {
    oldKey: null,
    title,
    content: input.content ?? '',
  })
  const message = afterKey
    ? `[章节] 在第 ${chapterKeyOf(index + 1)} 章后插入「${title}」`
    : `[章节] 在最前面插入「${title}」`
  return applyPlan(bookDir, existing, plan, message, options)
}

/** 把当前章合并到下一章（保留当前章标题，下一章正文接在后面） */
export async function mergeChapterIntoNext(
  bookDir: string,
  chapterKey: string,
  options: ReorganizeOptions = {},
): Promise<ReorganizeResult> {
  const existing = readExisting(bookDir)
  const index = existing.findIndex((chapter) => chapter.key === chapterKey)
  if (index < 0) throw new CoreError('CHAPTER_NOT_FOUND', `第 ${Number(chapterKey)} 章不存在`)
  if (index + 1 >= existing.length) throw new CoreError('CHAPTER_EDGE', '已经是最后一章，无法合并到下一章')
  const current = existing[index]
  const next = existing[index + 1]
  const mergedBody = [bodyWithoutHeading(current.content), bodyWithoutHeading(next.content)]
    .filter(Boolean)
    .join('\n\n')
  const plan: PlannedChapter[] = existing.map((chapter) => ({
    oldKey: chapter.key,
    title: chapter.title,
    content: bodyWithoutHeading(chapter.content),
  }))
  plan.splice(index, 2, {
    oldKey: current.key,
    title: current.title,
    content: mergedBody,
  })
  const message = `[章节] 合并第 ${current.key} 章「${current.title}」到下一章「${next.title}」`
  const result = await applyPlan(bookDir, existing, plan, message, options, {
    [next.key]: chapterKeyOf(index + 1),
  })
  discardDrafts(bookDir, result.mapping[current.key])
  return result
}

/** 在内容偏移处拆分当前章（偏移来自编辑器光标） */
export async function splitChapter(
  bookDir: string,
  chapterKey: string,
  offset: number,
  options: ReorganizeOptions = {},
): Promise<ReorganizeResult> {
  const existing = readExisting(bookDir)
  const index = existing.findIndex((chapter) => chapter.key === chapterKey)
  if (index < 0) throw new CoreError('CHAPTER_NOT_FOUND', `第 ${Number(chapterKey)} 章不存在`)
  const chapter = existing[index]
  const length = chapter.content.length
  if (!Number.isInteger(offset) || offset <= 0 || offset >= length) {
    throw new CoreError('INVALID_SPLIT', '拆分位置无效')
  }
  const firstBody = bodyWithoutHeading(chapter.content.slice(0, offset))
  const secondBody = bodyWithoutHeading(chapter.content.slice(offset))
  if (!firstBody || !secondBody) throw new CoreError('INVALID_SPLIT', '拆分后两部分都必须有正文内容')
  const plan: PlannedChapter[] = existing.map((item) => ({
    oldKey: item.key,
    title: item.title,
    content: bodyWithoutHeading(item.content),
  }))
  plan.splice(
    index,
    1,
    { oldKey: chapter.key, title: chapter.title, content: bodyWithoutHeading(firstBody) },
    { oldKey: null, title: `${chapter.title}（续）`, content: bodyWithoutHeading(secondBody) },
  )
  const message = `[章节] 拆分第 ${chapter.key} 章「${chapter.title}」`
  return applyPlan(bookDir, existing, plan, message, options)
}

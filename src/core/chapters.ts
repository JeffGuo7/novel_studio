import path from 'node:path'
import type { BookSnapshot, DraftInfo } from '../shared/types'
import { CoreError } from './errors'
import { countWords, ensureDir, readFileOrNull, removeFile, writeFileAtomic } from './fsutil'
import { createGitPort, type GitPort } from './git'
import {
  chapterFileName,
  chapterKeyOf,
  listChapters,
  nextChapterKey,
  snapshotBook,
} from './book'
import { discardDrafts, latestDraft, listDrafts, saveDraft } from './drafts'

export interface ChapterServiceOptions {
  git?: GitPort
}

function gitOf(options: ChapterServiceOptions): GitPort {
  return options.git ?? createGitPort()
}

/** 从已有章节（或空白模板）种下草稿 v1，作为编辑/续写的起点 */
export function seedDraft(
  bookDir: string,
  chapterKey: string,
  options: ChapterServiceOptions = {},
): DraftInfo {
  const chapters = listChapters(bookDir)
  const existing = chapters.find((item) => item.key === chapterKey)
  const content = existing
    ? (readFileOrNull(path.join(bookDir, existing.path)) ?? '')
    : `# 第 ${Number(chapterKey)} 章\n\n`
  return saveDraft(bookDir, chapterKey, content, {
    source: 'seed',
    note: existing ? '从正史章节创建' : '新建草稿',
  })
}

export function draftHistory(bookDir: string, chapterKey: string): DraftInfo[] {
  return listDrafts(bookDir, chapterKey)
}

/**
 * 草稿归档：把最新草稿写成正史章节并提交，然后清掉草稿。
 * 若同 key 的章节已存在且标题变了，会先删掉旧文件，保持 `序号_标题.md` 命名一致。
 */
export async function promoteDraft(
  bookDir: string,
  chapterKey: string,
  title: string,
  options: ChapterServiceOptions & { note?: string } = {},
): Promise<BookSnapshot> {
  const normalizedTitle = title?.trim()
  if (!normalizedTitle) throw new CoreError('INVALID_TITLE', '章节标题不能为空')

  const draft = latestDraft(bookDir, chapterKey)
  if (!draft) {
    throw new CoreError('NO_DRAFT', `第 ${Number(chapterKey)} 章没有可归档的草稿`)
  }

  const git = gitOf(options)
  const chaptersDir = path.join(bookDir, 'chapters')
  ensureDir(chaptersDir)

  const existing = listChapters(bookDir).find((item) => item.key === chapterKey)
  const targetName = chapterFileName(chapterKey, normalizedTitle)
  const targetRel = `chapters/${targetName}`
  const changedPaths: string[] = []
  if (existing && existing.path !== targetRel) {
    if (removeFile(path.join(bookDir, existing.path))) changedPaths.push(existing.path)
  }
  writeFileAtomic(path.join(bookDir, targetRel), draft.content)
  changedPaths.push(targetRel)

  const message = `[归档] 第${Number(chapterKey)}章 · ${normalizedTitle}${options.note ? `\n\n${options.note}` : ''}`
  await git.commitPaths(bookDir, changedPaths, message)
  discardDrafts(bookDir, chapterKey)
  return snapshotBook(bookDir)
}

/** 新建一章：分配下一个 key 并种下草稿 */
export function createChapterDraft(
  bookDir: string,
  title?: string,
  options: ChapterServiceOptions = {},
): { chapterKey: string; draft: DraftInfo } {
  const chapterKey = nextChapterKey(bookDir)
  const draft = saveDraft(bookDir, chapterKey, `# 第 ${Number(chapterKey)} 章${title ? ` ${title}` : ''}\n\n`, {
    source: 'seed',
    note: '新建草稿',
  })
  return { chapterKey, draft }
}

export { chapterKeyOf, countWords }

/**
 * 删除：章节进 Git 历史（可回滚），整本进回收站（可手动取回）。
 *
 * 设计约束：
 * - 章节删除必须留痕：文件删掉后仍提交一次 [删除]，历史里能找回内容；
 * - 整本书不进 Git（书库根不是仓库），所以用工作区 .trash 软删除，避免手滑直接 rm；
 * - 草稿目录不进 Git，删除章节时一并清掉，避免留下孤儿草稿。
 */
import fs from 'node:fs'
import path from 'node:path'
import { CoreError } from './errors'
import { ensureDir, removeFile } from './fsutil'
import { createGitPort, type GitPort } from './git'
import type { BookSnapshot } from '../shared/types'
import { listChapters, snapshotBook } from './book'
import { discardDrafts } from './drafts'

export interface DeleteChapterResult {
  snapshot: BookSnapshot
  deletedPath: string
  discardedDrafts: number
}

/** 删章节：删文件 + 清草稿 + 一次 [删除] 提交（可从历史找回） */
export async function deleteChapter(
  bookDir: string,
  chapterKey: string,
  options: { git?: GitPort } = {},
): Promise<DeleteChapterResult> {
  const chapter = listChapters(bookDir).find((item) => item.key === chapterKey)
  if (!chapter) {
    throw new CoreError('CHAPTER_NOT_FOUND', `第 ${Number(chapterKey)} 章不存在`)
  }
  const git = options.git ?? createGitPort()
  const discardedDrafts = discardDrafts(bookDir, chapterKey)
  const removed = removeFile(path.join(bookDir, chapter.path))
  if (!removed) {
    throw new CoreError('FILE_NOT_FOUND', `章节文件不存在：${chapter.path}`)
  }
  await git.commitPaths(
    bookDir,
    [chapter.path],
    `[删除] 删除第 ${chapter.number} 章 ${chapter.title}`,
  )
  return {
    snapshot: await snapshotBook(bookDir, { git }),
    deletedPath: chapter.path,
    discardedDrafts,
  }
}

export interface TrashBookResult {
  trashedTo: string
}

export function trashDirOf(workspaceDir: string): string {
  return path.join(workspaceDir, '.trash')
}

/**
 * 整本书移到工作区 .trash/<name>-<时间戳>（同盘 rename，瞬时且可恢复）。
 * 不直接删目录：小说是长期资产，误删成本远高于多一步清理。
 */
export function trashBook(workspaceDir: string, bookDir: string): TrashBookResult {
  const workspace = path.resolve(workspaceDir)
  const target = path.resolve(bookDir)
  if (!target.startsWith(workspace + path.sep)) {
    throw new CoreError('PATH_REJECTED', `书目录不在书库内：${bookDir}`)
  }
  if (!fs.existsSync(path.join(target, 'book.json'))) {
    throw new CoreError('BOOK_NOT_FOUND', `不是一本书：${bookDir}`)
  }
  const trash = trashDirOf(workspace)
  ensureDir(trash)
  const stamp = new Date()
    .toISOString()
    .replace(/[-:T]/g, '')
    .slice(0, 14)
  const baseName = path.basename(target)
  let destination = path.join(trash, `${baseName}-${stamp}`)
  let index = 2
  while (fs.existsSync(destination)) {
    destination = path.join(trash, `${baseName}-${stamp}-${index}`)
    index += 1
  }
  fs.renameSync(target, destination)
  return { trashedTo: destination }
}

/** 回收站里的书目录（按修改时间倒序），用于后续「恢复」入口 */
export function listTrashedBooks(workspaceDir: string): string[] {
  const trash = trashDirOf(workspaceDir)
  if (!fs.existsSync(trash)) return []
  return fs
    .readdirSync(trash, { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && fs.existsSync(path.join(trash, entry.name, 'book.json')))
    .map((entry) => path.join(trash, entry.name))
    .sort((a, b) => fs.statSync(b).mtimeMs - fs.statSync(a).mtimeMs)
}

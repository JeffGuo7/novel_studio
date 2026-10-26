import { describe, expect, it } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import {
  createBook,
  createGitPort,
  deleteChapter,
  importTextIntoBook,
  listBooks,
  listDrafts,
  removeDirRecursive,
  saveDraft,
  trashBook,
  trashDirOf,
} from '../src/core'

const git = createGitPort()

const SAMPLE = `第一章 雾夜渡客

雾从水面长出来。

第二章 七日之限

镇渊司的封条贴在船头。
`

async function setup() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'novel-delete-'))
  const book = await createBook(root, { title: '删除测试书' }, { git })
  await importTextIntoBook(book.dir, { text: SAMPLE, source: '样本.txt' }, { git })
  return { root, book }
}

describe('删除章节', () => {
  it('删文件 + 清草稿 + 生成 [删除] 提交，快照同步更新', async () => {
    const { root, book } = await setup()
    try {
      saveDraft(book.dir, '0001', '草稿正文')
      expect(listDrafts(book.dir, '0001').length).toBe(1)

      const result = await deleteChapter(book.dir, '0001', { git })
      expect(result.deletedPath).toBe('chapters/0001_第一章 雾夜渡客.md')
      expect(result.discardedDrafts).toBe(1)
      expect(result.snapshot.chapters.map((item) => item.key)).toEqual(['0002'])
      expect(fs.existsSync(path.join(book.dir, result.deletedPath))).toBe(false)

      const commits = await git.log(book.dir, { depth: 5 })
      expect(commits[0].kind).toBe('删除')
      expect(commits[0].summary).toContain('雾夜渡客')
      // 内容仍可从历史找回（用删除提交的父提交读取）
      const parent = commits[1]?.oid
      expect(parent).toBeTruthy()
      const previous = await git.readFileAt(book.dir, parent!, result.deletedPath)
      expect(previous).toContain('雾从水面长出来')
    } finally {
      removeDirRecursive(root)
    }
  })

  it('删除不存在的章节直接报错', async () => {
    const { root, book } = await setup()
    try {
      await expect(deleteChapter(book.dir, '0099', { git })).rejects.toThrow()
    } finally {
      removeDirRecursive(root)
    }
  })
})

describe('删除整本书（回收站）', () => {
  it('移到工作区 .trash，书架不再列出，目录仍可访问', async () => {
    const { root, book } = await setup()
    try {
      const result = trashBook(root, book.dir)
      expect(result.trashedTo).toContain(path.join('.trash'))
      expect(fs.existsSync(result.trashedTo)).toBe(true)
      expect(fs.existsSync(path.join(result.trashedTo, 'book.json'))).toBe(true)
      expect(fs.existsSync(book.dir)).toBe(false)

      const books = await listBooks(root, { git })
      expect(books).toHaveLength(0)
      expect(fs.existsSync(trashDirOf(root))).toBe(true)
    } finally {
      removeDirRecursive(root)
    }
  })

  it('拒绝删除书库之外的目录', async () => {
    const { root, book } = await setup()
    const outside = fs.mkdtempSync(path.join(os.tmpdir(), 'novel-outside-'))
    try {
      expect(() => trashBook(root, outside)).toThrow()
      expect(fs.existsSync(book.dir)).toBe(true)
    } finally {
      removeDirRecursive(root)
      removeDirRecursive(outside)
    }
  })
})

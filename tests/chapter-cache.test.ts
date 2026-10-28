import { describe, expect, it } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import {
  chapterWordCachePath,
  createBook,
  createGitPort,
  listChapters,
  removeDirRecursive,
  saveBookFile,
  snapshotBook,
} from '../src/core'

const git = createGitPort()

async function makeBook() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'novel-chapter-cache-'))
  const book = await createBook(root, { title: '缓存测试' }, { git })
  await saveBookFile(book.dir, 'chapters/0001_雾夜.md', '# 第 1 章 雾夜\n\n雾从水面长出来。\n', 'init', { git })
  await saveBookFile(book.dir, 'chapters/0002_七日.md', '# 第 2 章 七日\n\n封条。\n', 'init', { git })
  return { root, book }
}

describe('章节字数缓存', () => {
  it('首次读取构建缓存，字数正确，二次读取不重写缓存', async () => {
    const { root, book } = await makeBook()
    try {
      const chapters = listChapters(book.dir)
      expect(chapters.map((chapter) => chapter.key)).toEqual(['0001', '0002'])
      expect(chapters[0].words).toBeGreaterThan(0)
      expect(fs.existsSync(chapterWordCachePath(book.dir))).toBe(true)

      // 二次读取：缓存命中，不应重写文件（mtime 不变）
      const before = fs.statSync(chapterWordCachePath(book.dir)).mtimeMs
      await new Promise((resolve) => setTimeout(resolve, 20))
      const again = listChapters(book.dir)
      const after = fs.statSync(chapterWordCachePath(book.dir)).mtimeMs
      expect(again[0].words).toBe(chapters[0].words)
      expect(after).toBe(before)
    } finally {
      removeDirRecursive(root)
    }
  })

  it('外部修改章节后按 mtime 失效并更新字数', async () => {
    const { root, book } = await makeBook()
    try {
      expect(listChapters(book.dir)[0].words).toBeGreaterThan(0)
      const file = path.join(book.dir, 'chapters', '0001_雾夜.md')
      fs.writeFileSync(file, `# 第 1 章 雾夜\n\n${'雾'.repeat(200)}\n`, 'utf8')
      const updated = listChapters(book.dir).find((chapter) => chapter.key === '0001')
      expect(updated?.words).toBeGreaterThan(180)
      const cache = JSON.parse(fs.readFileSync(chapterWordCachePath(book.dir), 'utf8'))
      expect(cache.entries['chapters/0001_雾夜.md'].words).toBe(updated?.words)
    } finally {
      removeDirRecursive(root)
    }
  })

  it('删除章节后缓存条目被清理；损坏缓存自动重建', async () => {
    const { root, book } = await makeBook()
    try {
      listChapters(book.dir)
      fs.unlinkSync(path.join(book.dir, 'chapters', '0002_七日.md'))
      expect(listChapters(book.dir).map((chapter) => chapter.key)).toEqual(['0001'])
      const pruned = JSON.parse(fs.readFileSync(chapterWordCachePath(book.dir), 'utf8'))
      expect(pruned.entries['chapters/0002_七日.md']).toBeUndefined()

      fs.writeFileSync(chapterWordCachePath(book.dir), '{broken', 'utf8')
      const recovered = listChapters(book.dir)
      expect(recovered).toHaveLength(1)
      const rewritten = JSON.parse(fs.readFileSync(chapterWordCachePath(book.dir), 'utf8'))
      expect(rewritten.version).toBe(1)
    } finally {
      removeDirRecursive(root)
    }
  })

  it('snapshotBook 使用缓存且字数与章节列表一致', async () => {
    const { root, book } = await makeBook()
    try {
      const snapshot = await snapshotBook(book.dir, { git })
      const chapters = listChapters(book.dir)
      expect(snapshot.chapters.map((chapter) => chapter.words)).toEqual(
        chapters.map((chapter) => chapter.words),
      )
      expect(fs.existsSync(path.join(book.dir, '.studio', 'cache', 'chapters.json'))).toBe(true)
    } finally {
      removeDirRecursive(root)
    }
  })
})

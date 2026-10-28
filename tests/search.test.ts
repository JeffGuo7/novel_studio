import { describe, expect, it } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import {
  createBook,
  createGitPort,
  removeDirRecursive,
  replaceInBook,
  saveBookFile,
  searchBook,
} from '../src/core'

const git = createGitPort()

async function makeBook() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'novel-search-'))
  const book = await createBook(root, { title: '搜索测试', author: '郭宇' }, { git })
  await saveBookFile(
    book.dir,
    'chapters/0001_雾夜.md',
    '# 第 1 章 雾夜\n\n雾从水面长出来，雾里有灯。\n\n林牧把篙插进水里。\n',
    'init',
    { git },
  )
  await saveBookFile(
    book.dir,
    'chapters/0002_七日.md',
    '# 第 2 章 七日\n\n镇渊司的封条贴在船头，雾更浓了。\n',
    'init',
    { git },
  )
  await saveBookFile(
    book.dir,
    'world_model.md',
    '# 世界模型\n\n雾里会走出不属于这个世界的东西。\n',
    'init',
    { git },
  )
  return { root, book }
}

describe('全书搜索', () => {
  it('搜索章节与知识文件，返回行号与匹配位置', async () => {
    const { root, book } = await makeBook()
    try {
      const report = searchBook(book.dir, '雾')
      expect(report.total).toBe(5)
      expect(report.files.map((file) => file.kind)).toEqual(['chapter', 'chapter', 'knowledge'])
      const first = report.files[0]
      expect(first.count).toBe(3)
      expect(first.matches[0].line).toBe(1)
      expect(first.matches[1].line).toBe(3)
      expect(first.matches[1].text.slice(first.matches[1].start, first.matches[1].end)).toBe('雾')
    } finally {
      removeDirRecursive(root)
    }
  })

  it('忽略大小写 / 区分大小写 / 限定范围 / 截断', async () => {
    const { root, book } = await makeBook()
    try {
      await saveBookFile(book.dir, 'chapters/0003_英文.md', '# 第 3 章\n\nMist and mist.\n', 'init', { git })
      expect(searchBook(book.dir, 'mist').total).toBe(2)
      expect(searchBook(book.dir, 'Mist', { caseSensitive: true }).total).toBe(1)
      expect(searchBook(book.dir, '雾', { includeKnowledge: false }).files.every((file) => file.kind === 'chapter')).toBe(true)
      const truncated = searchBook(book.dir, '雾', { maxResults: 1 })
      expect(truncated.truncated).toBe(true)
      expect(truncated.files.reduce((sum, file) => sum + file.matches.length, 0)).toBeLessThanOrEqual(1)
    } finally {
      removeDirRecursive(root)
    }
  })
})

describe('全书替换', () => {
  it('全书替换并生成一次 [替换] 提交', async () => {
    const { root, book } = await makeBook()
    try {
      const before = await git.head(book.dir)
      const report = await replaceInBook(book.dir, '雾', '霭', { git })
      expect(report.replacements).toBe(5)
      expect(report.changedFiles).toBe(3)
      const chapter = fs.readFileSync(path.join(book.dir, 'chapters', '0001_雾夜.md'), 'utf8')
      expect(chapter).toContain('霭从水面长出来')
      expect(chapter).not.toContain('雾')
      const commits = await git.log(book.dir, { depth: 1 })
      expect(commits[0]?.kind).toBe('替换')
      expect(await git.head(book.dir)).not.toBe(before)
    } finally {
      removeDirRecursive(root)
    }
  })

  it('限定文件替换；无匹配不提交；替换串按字面处理', async () => {
    const { root, book } = await makeBook()
    try {
      const report = await replaceInBook(book.dir, '雾', '霭', {
        paths: ['chapters/0001_雾夜.md'],
        git,
      })
      expect(report.replacements).toBe(3)
      expect(report.changedFiles).toBe(1)
      const second = fs.readFileSync(path.join(book.dir, 'chapters', '0002_七日.md'), 'utf8')
      expect(second).toContain('雾更浓了')

      const none = await replaceInBook(book.dir, '不存在的内容', 'x', { git })
      expect(none.changedFiles).toBe(0)
      expect(none.replacements).toBe(0)

      await replaceInBook(book.dir, '霭', '$&X', { git })
      const chapter = fs.readFileSync(path.join(book.dir, 'chapters', '0001_雾夜.md'), 'utf8')
      expect(chapter).toContain('$&X从水面长出来')
      await expect(replaceInBook(book.dir, '   ', 'x', { git })).rejects.toThrow('搜索内容不能为空')
    } finally {
      removeDirRecursive(root)
    }
  })
})

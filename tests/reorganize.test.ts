import { describe, expect, it } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import {
  createBook,
  createGitPort,
  insertChapterAfter,
  listChapters,
  mergeChapterIntoNext,
  moveChapter,
  removeDirRecursive,
  renumberChapters,
  saveBookFile,
  saveDraft,
  splitChapter,
} from '../src/core'

const git = createGitPort()

async function makeBook() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'novel-reorg-'))
  const book = await createBook(root, { title: '重编号测试', author: '郭宇' }, { git })
  for (const [index, title] of ['雾夜', '七日', '来信'].entries()) {
    await saveBookFile(
      book.dir,
      `chapters/000${index + 1}_${title}.md`,
      `# 第 ${index + 1} 章 ${title}\n\n正文${index + 1}。\n`,
      'init',
      { git },
    )
  }
  return { root, book }
}

function writeState(bookDir: string): void {
  const studio = path.join(bookDir, '.studio')
  fs.mkdirSync(path.join(studio, 'pipeline'), { recursive: true })
  fs.mkdirSync(path.join(studio, 'agent'), { recursive: true })
  fs.mkdirSync(path.join(studio, 'index'), { recursive: true })
  fs.writeFileSync(
    path.join(studio, 'pipeline-state.json'),
    JSON.stringify({ version: 1, chapterHashes: { '0001': 'a', '0002': 'b', '0003': 'c' }, chapterCount: 3, lastChapterKey: '0003' }),
  )
  fs.writeFileSync(
    path.join(studio, 'agent', 'session.json'),
    JSON.stringify({ version: 1, messages: [], cost: 0, chapterCosts: { '0002': 0.5 } }),
  )
  fs.writeFileSync(path.join(studio, 'index', 'search-index.json'), '{}')
  fs.writeFileSync(path.join(studio, 'index', 'meta.json'), '{}')
}

describe('章节结构变更', () => {
  it('上移：文件/标题/历史/草稿/管线/会话状态一起迁移', async () => {
    const { root, book } = await makeBook()
    try {
      writeState(book.dir)
      saveDraft(book.dir, '0002', '# 第 2 章 七日\n\n草稿内容\n', { source: 'human' })

      const result = await moveChapter(book.dir, '0002', 'up', { git })
      expect(result.snapshot.chapters.map((chapter) => chapter.title)).toEqual(['七日', '雾夜', '来信'])
      expect(listChapters(book.dir).map((chapter) => chapter.key)).toEqual(['0001', '0002', '0003'])
      const first = fs.readFileSync(path.join(book.dir, result.snapshot.chapters[0].path), 'utf8')
      expect(first).toContain('# 第 1 章 七日')

      // Git 历史里有 [章节] 提交
      const commits = await git.log(book.dir, { depth: 1 })
      expect(commits[0]?.kind).toBe('章节')

      // 草稿目录跟着 0002 -> 0001
      expect(fs.existsSync(path.join(book.dir, '.studio', 'drafts', '0001', 'meta.json'))).toBe(true)
      expect(fs.existsSync(path.join(book.dir, '.studio', 'drafts', '0002'))).toBe(false)

      // 管线 hash 重映射：0001 的 hash 现在是 b
      const state = JSON.parse(fs.readFileSync(path.join(book.dir, '.studio', 'pipeline-state.json'), 'utf8'))
      expect(state.chapterHashes).toEqual({ '0001': 'b', '0002': 'a', '0003': 'c' })

      // 会话成本跟着章节走
      const session = JSON.parse(fs.readFileSync(path.join(book.dir, '.studio', 'agent', 'session.json'), 'utf8'))
      expect(session.chapterCosts).toEqual({ '0001': 0.5 })

      // 搜索索引被清掉（下次检索重建）
      expect(fs.existsSync(path.join(book.dir, '.studio', 'index', 'search-index.json'))).toBe(false)
    } finally {
      removeDirRecursive(root)
    }
  })

  it('插入：在第一章后插入，后续章节顺延，标题编号连续', async () => {
    const { root, book } = await makeBook()
    try {
      const result = await insertChapterAfter(book.dir, '0001', { title: '插曲' }, { git })
      expect(result.snapshot.chapters.map((chapter) => chapter.title)).toEqual(['雾夜', '插曲', '七日', '来信'])
      expect(result.snapshot.chapters.map((chapter) => chapter.key)).toEqual(['0001', '0002', '0003', '0004'])
      const inserted = fs.readFileSync(
        path.join(book.dir, result.snapshot.chapters[1].path),
        'utf8',
      )
      expect(inserted).toContain('# 第 2 章 插曲')
      const commits = await git.log(book.dir, { depth: 1 })
      expect(commits[0]?.summary ?? '').toContain('插入')
    } finally {
      removeDirRecursive(root)
    }
  })

  it('重编号：补齐空号并重写标题编号', async () => {
    const { root, book } = await makeBook()
    try {
      fs.unlinkSync(path.join(book.dir, 'chapters', '0002_七日.md'))
      const result = await renumberChapters(book.dir, { git })
      expect(result.snapshot.chapters.map((chapter) => chapter.key)).toEqual(['0001', '0002'])
      const second = fs.readFileSync(path.join(book.dir, result.snapshot.chapters[1].path), 'utf8')
      expect(second).toContain('# 第 2 章 来信')
    } finally {
      removeDirRecursive(root)
    }
  })

  it('合并：当前章并入下一章，正文都保留，草稿清理', async () => {
    const { root, book } = await makeBook()
    try {
      saveDraft(book.dir, '0001', '草稿', { source: 'human' })
      const result = await mergeChapterIntoNext(book.dir, '0001', { git })
      expect(result.snapshot.chapters.map((chapter) => chapter.title)).toEqual(['雾夜', '来信'])
      const merged = fs.readFileSync(path.join(book.dir, result.snapshot.chapters[0].path), 'utf8')
      expect(merged).toContain('正文1')
      expect(merged).toContain('正文2')
      expect(merged).toContain('# 第 1 章 雾夜')
      expect(fs.existsSync(path.join(book.dir, '.studio', 'drafts', '0001'))).toBe(false)
      expect(result.mapping['0002']).toBe('0001')
    } finally {
      removeDirRecursive(root)
    }
  })

  it('拆分：按偏移拆成两章，第二章节标题带（续）', async () => {
    const { root, book } = await makeBook()
    try {
      const content = fs.readFileSync(path.join(book.dir, 'chapters', '0002_七日.md'), 'utf8')
      const offset = content.indexOf('正文2') + 3
      const result = await splitChapter(book.dir, '0002', offset, { git })
      expect(result.snapshot.chapters.map((chapter) => chapter.title)).toEqual(['雾夜', '七日', '七日（续）', '来信'])
      expect(fs.readFileSync(path.join(book.dir, result.snapshot.chapters[1].path), 'utf8')).toContain('正文2')
      const second = fs.readFileSync(path.join(book.dir, result.snapshot.chapters[2].path), 'utf8')
      expect(second).toContain('# 第 3 章 七日（续）')
    } finally {
      removeDirRecursive(root)
    }
  })

  it('边界：首章不能上移、末章不能合并、非法拆分位置报错', async () => {
    const { root, book } = await makeBook()
    try {
      await expect(moveChapter(book.dir, '0001', 'up', { git })).rejects.toThrow('已经是第一章')
      await expect(mergeChapterIntoNext(book.dir, '0003', { git })).rejects.toThrow('最后一章')
      await expect(splitChapter(book.dir, '0001', 0, { git })).rejects.toThrow('拆分位置无效')
    } finally {
      removeDirRecursive(root)
    }
  })
})

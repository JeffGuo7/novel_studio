import { describe, expect, it } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import {
  clearBookCover,
  createBook,
  createGitPort,
  removeDirRecursive,
  setBookCover,
  snapshotBook,
  touchBookOpened,
  updateBookInfo,
} from '../src/core'

const git = createGitPort()

async function makeBook() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'novel-book-info-'))
  const book = await createBook(root, { title: '原书名', author: '原作者' }, { git })
  return { root, book }
}

const PNG_1PX = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==',
  'base64',
)

describe('书籍信息编辑', () => {
  it('更新书名/作者/简介并留下 [书] 提交', async () => {
    const { root, book } = await makeBook()
    try {
      const snapshot = await updateBookInfo(
        book.dir,
        { title: '新书名', author: '新作者', description: '新的简介。' },
        { git },
      )
      expect(snapshot.meta.title).toBe('新书名')
      expect(snapshot.meta.author).toBe('新作者')
      expect(snapshot.meta.description).toBe('新的简介。')
      const commits = await git.log(book.dir, { depth: 1 })
      expect(commits[0].kind).toBe('书')
      expect(commits[0].summary).toContain('更新书籍信息')

      // 简介清空
      const cleared = await updateBookInfo(book.dir, { description: '' }, { git })
      expect(cleared.meta.description).toBeUndefined()
      await expect(updateBookInfo(book.dir, { title: '   ' }, { git })).rejects.toThrow('书名不能为空')
    } finally {
      removeDirRecursive(root)
    }
  })

  it('打开时间写入 .studio/state.json 并出现在快照里', async () => {
    const { root, book } = await makeBook()
    try {
      expect((await snapshotBook(book.dir, { git })).lastOpenedAt).toBeUndefined()
      touchBookOpened(book.dir)
      const snapshot = await snapshotBook(book.dir, { git })
      expect(snapshot.lastOpenedAt).toBeTruthy()
      const state = JSON.parse(fs.readFileSync(path.join(book.dir, '.studio', 'state.json'), 'utf8'))
      expect(state.lastOpenedAt).toBe(snapshot.lastOpenedAt)
    } finally {
      removeDirRecursive(root)
    }
  })
})

describe('书籍封面', () => {
  it('复制封面、生成 data URL，并在换格式时清理旧文件', async () => {
    const { root, book } = await makeBook()
    const sourcePng = path.join(root, 'cover-source.png')
    const sourceJpg = path.join(root, 'cover-source.jpg')
    fs.writeFileSync(sourcePng, PNG_1PX)
    fs.writeFileSync(sourceJpg, PNG_1PX)
    try {
      const snapshot = await setBookCover(book.dir, sourcePng, { git })
      expect(snapshot.meta.cover).toBe('cover.png')
      expect(snapshot.coverDataUrl?.startsWith('data:image/png;base64,')).toBe(true)
      expect(fs.existsSync(path.join(book.dir, 'cover.png'))).toBe(true)

      const replaced = await setBookCover(book.dir, sourceJpg, { git })
      expect(replaced.meta.cover).toBe('cover.jpg')
      expect(fs.existsSync(path.join(book.dir, 'cover.png'))).toBe(false)
      expect(fs.existsSync(path.join(book.dir, 'cover.jpg'))).toBe(true)

      const cleared = await clearBookCover(book.dir, { git })
      expect(cleared.meta.cover).toBeUndefined()
      expect(cleared.coverDataUrl).toBeUndefined()
      expect(fs.existsSync(path.join(book.dir, 'cover.jpg'))).toBe(false)
    } finally {
      removeDirRecursive(root)
    }
  })

  it('拒绝非图片和超过 2.5MB 的封面', async () => {
    const { root, book } = await makeBook()
    const textFile = path.join(root, 'not-image.txt')
    const bigFile = path.join(root, 'big.png')
    fs.writeFileSync(textFile, 'hello')
    fs.writeFileSync(bigFile, Buffer.alloc(2.6 * 1024 * 1024, 1))
    try {
      await expect(setBookCover(book.dir, textFile, { git })).rejects.toThrow('封面只支持')
      await expect(setBookCover(book.dir, bigFile, { git })).rejects.toThrow('不能超过 2.5MB')
      expect(fs.readFileSync(path.join(book.dir, 'book.json'), 'utf8')).not.toContain('cover')
    } finally {
      removeDirRecursive(root)
    }
  })
})

import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import {
  createBook,
  createChapterDraft,
  createGitPort,
  discardDrafts,
  latestDraft,
  listBooks,
  listChapters,
  listDrafts,
  nextChapterKey,
  promoteDraft,
  readBookFile,
  readDraft,
  removeDirRecursive,
  saveBookFile,
  saveDraft,
  seedDraft,
  snapshotBook,
} from '../src/core'
import type { BookSnapshot } from '../src/shared/types'

const git = createGitPort()

let root = ''

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'novel-studio-test-'))
})

afterEach(() => {
  removeDirRecursive(root)
})

async function makeBook(title = '临渊行'): Promise<BookSnapshot> {
  return createBook(root, { title, author: '测试作者' }, { git })
}

describe('书库与提交', () => {
  it('建书后生成完整布局，并产生初始化提交', async () => {
    const book = await makeBook()
    expect(fs.existsSync(path.join(book.dir, 'book.json'))).toBe(true)
    expect(fs.existsSync(path.join(book.dir, '.git'))).toBe(true)
    expect(book.knowledge.length).toBe(14)
    expect(book.chapters.length).toBe(0)

    const commits = await git.log(book.dir, { depth: 10 })
    expect(commits.length).toBe(1)
    expect(commits[0].kind).toBe('初始化')
  })

  it('保存文件会生成一次提交', async () => {
    const book = await makeBook()
    const content = '# 世界模型\n\n## 硬约束\n\n- 亡者不可复生。\n'
    const result = await saveBookFile(book.dir, 'world_model.md', content, undefined, { git })
    expect(result.oid).toBeTruthy()

    const commits = await git.log(book.dir, { depth: 10 })
    expect(commits.length).toBe(2)
    expect(commits[0].kind).toBe('知识')

    const readBack = await readBookFile(book.dir, 'world_model.md')
    expect(readBack.content).toBe(content)
  })

  it('同长度、同秒内的修改也能提交（绕过 stat 快速判断的回归）', async () => {
    const book = await makeBook()
    const first = await saveBookFile(book.dir, 'world_model.md', '版本一', undefined, { git })
    const second = await saveBookFile(book.dir, 'world_model.md', '版本二', undefined, { git })
    expect(first.oid).toBeTruthy()
    expect(second.oid).toBeTruthy()
    expect(second.oid).not.toBe(first.oid)
    expect(await git.readFileAt(book.dir, second.oid as string, 'world_model.md')).toBe('版本二')
  })

  it('内容没变化时不会产生空提交', async () => {
    const book = await makeBook()
    await saveBookFile(book.dir, 'world_model.md', '不变内容', undefined, { git })
    const before = (await git.log(book.dir, { depth: 20 })).length
    const again = await saveBookFile(book.dir, 'world_model.md', '不变内容', undefined, { git })
    expect(again.oid).toBeNull()
    expect((await git.log(book.dir, { depth: 20 })).length).toBe(before)
  })

  it('拒绝路径穿越和未授权文件', async () => {
    const book = await makeBook()
    await expect(saveBookFile(book.dir, '../evil.md', 'x', undefined, { git })).rejects.toThrow()
    await expect(saveBookFile(book.dir, 'book.json', '{}', undefined, { git })).rejects.toThrow()
    await expect(saveBookFile(book.dir, 'chapters/../../x.md', 'x', undefined, { git })).rejects.toThrow()
  })

  it('书架能列出书目', async () => {
    await makeBook('甲书')
    await createBook(root, { title: '乙书' }, { git })
    const books = await listBooks(root, { git })
    expect(books.map((item) => item.meta.title).sort()).toEqual(['乙书', '甲书'].sort())
  })
})

describe('草稿版本', () => {
  it('同一章节可保留多个草稿版本，按新到旧列出', async () => {
    const book = await makeBook()
    const key = nextChapterKey(book.dir)
    expect(key).toBe('0001')

    saveDraft(book.dir, key, '# 第一版')
    const v2 = saveDraft(book.dir, key, '# 第二版', { source: 'human', note: '改结尾' })

    expect(v2.version).toBe(2)
    const versions = listDrafts(book.dir, key)
    expect(versions.map((item) => item.version)).toEqual([2, 1])
    expect(readDraft(book.dir, key, 1).content).toBe('# 第一版')
    expect(latestDraft(book.dir, key)?.content).toBe('# 第二版')
  })

  it('丢弃草稿不影响正史，也不进 Git 历史', async () => {
    const book = await makeBook()
    const key = nextChapterKey(book.dir)
    saveDraft(book.dir, key, '# 草稿')
    const before = await git.log(book.dir, { depth: 20 })
    discardDrafts(book.dir, key)
    const after = await git.log(book.dir, { depth: 20 })
    expect(listDrafts(book.dir, key)).toEqual([])
    expect(after.length).toBe(before.length)
  })

  it('草稿目录被 gitignore，不会出现在提交里', async () => {
    const book = await makeBook()
    const key = nextChapterKey(book.dir)
    saveDraft(book.dir, key, '# 草稿')
    const files = await git.filesAt(book.dir, 'HEAD')
    expect([...files.keys()].some((file) => file.includes('.studio'))).toBe(false)
  })
})

describe('归档', () => {
  it('草稿归档成正史章节，提交信息带前缀，草稿清空', async () => {
    const book = await makeBook()
    const key = nextChapterKey(book.dir)
    saveDraft(book.dir, key, '# 第 1 章 听潮阁来信\n\n雨从卯时下到巳时。\n')

    const next = await promoteDraft(book.dir, key, '听潮阁来信', { git })
    expect(next.chapters.length).toBe(1)
    expect(next.chapters[0].title).toBe('听潮阁来信')
    expect(fs.existsSync(path.join(book.dir, 'chapters', '0001_听潮阁来信.md'))).toBe(true)
    expect(listDrafts(book.dir, key)).toEqual([])

    const commits = await git.log(book.dir, { depth: 5 })
    expect(commits[0].kind).toBe('归档')
    expect(commits[0].summary).toContain('第1章')
  })

  it('新建章节分配递增编号，且草稿数不影响编号', async () => {
    const book = await makeBook()
    const first = createChapterDraft(book.dir)
    expect(first.chapterKey).toBe('0001')
    const second = createChapterDraft(book.dir)
    expect(second.chapterKey).toBe('0002')
    expect(nextChapterKey(book.dir)).toBe('0003')
  })

  it('从已有章节种草稿时内容与正史一致', async () => {
    const book = await makeBook()
    const key = nextChapterKey(book.dir)
    saveDraft(book.dir, key, '# 正文内容\n')
    await promoteDraft(book.dir, key, '第一章', { git })

    seedDraft(book.dir, key, { git })
    const draft = latestDraft(book.dir, key)
    expect(draft?.content).toBe('# 正文内容\n')
    expect(listChapters(book.dir)[0].hasDraft).toBe(true)
  })
})

describe('历史与回滚', () => {
  it('回滚还原文件内容，但生成新提交而不是改写历史', async () => {
    const book = await makeBook()
    const first = await saveBookFile(book.dir, 'world_model.md', '版本一', undefined, { git })
    await saveBookFile(book.dir, 'world_model.md', '版本二', undefined, { git })

    const beforeLog = await git.log(book.dir, { depth: 20 })
    expect((await readBookFile(book.dir, 'world_model.md')).content).toBe('版本二')

    const result = await git.restoreTo(book.dir, first.oid as string)
    expect(result.changedFiles).toBeGreaterThan(0)
    expect((await readBookFile(book.dir, 'world_model.md')).content).toBe('版本一')

    const afterLog = await git.log(book.dir, { depth: 20 })
    expect(afterLog.length).toBe(beforeLog.length + 1)
    expect(afterLog[0].kind).toBe('还原')
    // 旧版本仍在历史里可读
    const old = await git.readFileAt(book.dir, first.oid as string, 'world_model.md')
    expect(old).toBe('版本一')
  })

  it('可以按文件查历史', async () => {
    const book = await makeBook()
    await saveBookFile(book.dir, 'world_model.md', 'a', undefined, { git })
    await saveBookFile(book.dir, 'summary.md', 'b', undefined, { git })
    const worldHistory = await git.log(book.dir, { depth: 20, filepath: 'world_model.md' })
    expect(worldHistory.length).toBe(2)
    expect(worldHistory.every((item) => item.summary.includes('world_model') || item.kind === '初始化')).toBe(true)
  })

  it('两版之间的 diff 能拿到前后内容', async () => {
    const book = await makeBook()
    const v1 = await saveBookFile(book.dir, 'world_model.md', '旧内容', undefined, { git })
    const v2 = await saveBookFile(book.dir, 'world_model.md', '新内容', undefined, { git })
    const files = await git.diff(book.dir, v1.oid as string, v2.oid as string)
    expect(files.length).toBe(1)
    expect(files[0].before).toBe('旧内容')
    expect(files[0].after).toBe('新内容')
  })
})

describe('书快照推导', () => {
  it('章节状态从文件系统推导，无需状态库', async () => {
    const book = await makeBook()
    const key = nextChapterKey(book.dir)
    saveDraft(book.dir, key, '# 草稿')
    const withDraft = await snapshotBook(book.dir, { git })
    expect(withDraft.orphanDraftKeys).toEqual([key])

    const afterArchive = await promoteDraft(book.dir, key, '第一章', { git })
    expect(afterArchive.orphanDraftKeys).toEqual([])
    expect(afterArchive.chapters[0].hasDraft).toBe(false)
  })
})

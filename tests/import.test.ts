import { describe, expect, it } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import {
  createBook,
  createGitPort,
  decodeTextBuffer,
  importFileIntoBook,
  importManyFilesIntoBook,
  importTextIntoBook,
  listChapters,
  removeDirRecursive,
  splitTextIntoChapters,
} from '../src/core'

const git = createGitPort()

const SAMPLE = `这是前言部分，交代一下背景。

第一章 雾夜渡客

雾是从水面长出来的。

林牧把篙插进水里。

第二章 七日之限

镇渊司的封条贴在船头。

第三章 听潮阁来信

青衫人推门进来。
`

describe('章节切分', () => {
  it('按「第 N 章」标题切分，并把前言单独成章', () => {
    const chapters = splitTextIntoChapters(SAMPLE, '临渊行')
    expect(chapters.length).toBe(4)
    expect(chapters[0].title).toBe('临渊行')
    expect(chapters[1].title).toBe('第一章 雾夜渡客')
    expect(chapters[2].title).toBe('第二章 七日之限')
    expect(chapters[3].content).toContain('青衫人推门进来')
  })

  it('支持序章 / 楔子 / Chapter 3', () => {
    const text = '楔子\n\n很久以前。\n\nChapter 3\nThe boat.\n\n第四章 归途\n\n到家了。'
    const chapters = splitTextIntoChapters(text)
    expect(chapters.map((item) => item.title)).toEqual(['楔子', 'Chapter 3', '第四章 归途'])
  })

  it('没有任何标题时整段作为一章', () => {
    const chapters = splitTextIntoChapters('只有正文，没有标题。', '短篇')
    expect(chapters).toHaveLength(1)
    expect(chapters[0].title).toBe('短篇')
  })

  it('空文本返回空数组', () => {
    expect(splitTextIntoChapters('   \n\n  ')).toEqual([])
  })

  it('不会把正文里的普通句子当标题', () => {
    const text = '第一章 开始\n\n他说：“第一章写得不错。”然后继续往下看。\n'
    const chapters = splitTextIntoChapters(text)
    expect(chapters).toHaveLength(1)
  })
})

describe('编码识别', () => {
  it('UTF-8 正常解码', () => {
    const buffer = Buffer.from('第一章 雾夜渡客', 'utf8')
    const { text, encoding } = decodeTextBuffer(buffer)
    expect(text).toBe('第一章 雾夜渡客')
    expect(encoding).toBe('utf-8')
  })

  it('GB18030 回退（番茄下载的 txt 常见）', () => {
    // "第一章" 的 GBK 编码
    const gbk = Buffer.from([0xb5, 0xda, 0xd2, 0xbb, 0xd5, 0xc2])
    const { text, encoding } = decodeTextBuffer(gbk)
    expect(text.replace(/\s/g, '')).toBe('第一章')
    expect(['gb18030', 'utf-8']).toContain(encoding)
  })
})

describe('导入到书库', () => {
  it('导入后生成章节文件，并产生一个 [导入] 提交', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'novel-import-'))
    try {
      const book = await createBook(root, { title: '导入测试' }, { git })
      const { snapshot, report } = await importTextIntoBook(
        book.dir,
        { text: SAMPLE, source: '测试.txt' },
        { git },
      )
      expect(report.chapters).toBe(4)
      expect(report.words).toBeGreaterThan(0)
      expect(snapshot.chapters.length).toBe(4)
      expect(snapshot.chapters[0].path).toMatch(/^chapters\/0001_/)
      // 标题里的空格保留在文件名中，回读时标题更接近原样
      expect(snapshot.chapters.some((chapter) => chapter.title === '第一章 雾夜渡客')).toBe(true)
      expect(fs.existsSync(path.join(book.dir, snapshot.chapters[1].path))).toBe(true)

      const commits = await git.log(book.dir, { depth: 10 })
      expect(commits[0].kind).toBe('导入')
      expect(commits[0].summary).toContain('测试.txt')

      // 再导入一次：章节编号继续往后排，不覆盖已有章节
      const second = await importTextIntoBook(book.dir, { text: '第一章 新章\n\n新的内容。', source: '续.txt' }, { git })
      expect(second.snapshot.chapters.length).toBe(5)
      expect(second.snapshot.chapters[4].key).toBe('0005')
    } finally {
      removeDirRecursive(root)
    }
  })

  it('从文件导入时自动识别编码并清洗标题', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'novel-import-file-'))
    try {
      const book = await createBook(root, { title: '文件导入' }, { git })
      const filePath = path.join(root, '临渊行.txt')
      fs.writeFileSync(filePath, SAMPLE, 'utf8')
      const { snapshot, report } = await importFileIntoBook(book.dir, filePath, { git })
      expect(report.source).toBe('临渊行.txt')
      expect(snapshot.chapters.length).toBe(4)
      expect(listChapters(book.dir).length).toBe(4)
    } finally {
      removeDirRecursive(root)
    }
  })

  it('空文件导入会报错而不是产生空章节', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'novel-import-empty-'))
    try {
      const book = await createBook(root, { title: '空导入' }, { git })
      await expect(importTextIntoBook(book.dir, { text: '   ', source: '空.txt' }, { git })).rejects.toThrow()
    } finally {
      removeDirRecursive(root)
    }
  })
})

describe('批量导入', () => {
  it('多个文件合成一次提交，章节编号连续，报告里标明来源数', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'novel-import-many-'))
    try {
      const book = await createBook(root, { title: '批量书' }, { git })
      const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'novel-import-files-'))
      const fileA = path.join(dir, 'a.txt')
      const fileB = path.join(dir, 'b.txt')
      fs.writeFileSync(fileA, '第一章 一\n\n正文一。\n\n第二章 二\n\n正文二。\n', 'utf8')
      fs.writeFileSync(fileB, '第三章 三\n\n正文三。\n', 'utf8')

      const { snapshot, report } = await importManyFilesIntoBook(book.dir, [fileA, fileB], { git })
      expect(report.chapters).toBe(3)
      expect(report.sources).toBe(2)
      expect(report.chapters).toBe(snapshot.chapters.length)

      const commits = await git.log(book.dir, { depth: 5 })
      expect(commits[0].kind).toBe('导入')
      expect(commits[0].summary).toContain('a.txt')
      expect(commits[0].summary).toContain('b.txt')

      fs.rmSync(dir, { recursive: true, force: true })
    } finally {
      removeDirRecursive(root)
    }
  })
})
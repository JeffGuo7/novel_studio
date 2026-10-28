import { describe, expect, it } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import AdmZip from 'adm-zip'
import {
  createBook,
  createGitPort,
  loadExportBook,
  removeDirRecursive,
  saveBookFile,
} from '../src/core'
import {
  buildMergedMarkdown,
  buildPlainText,
  escapeHtml,
  markdownToXhtml,
  stripMarkdown,
} from '../src/core/export'
import { buildEpub } from '../src/main/export-epub'

const git = createGitPort()

async function makeBook() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'novel-export-'))
  const book = await createBook(root, { title: '雾海纪事', author: '郭宇' }, { git })
  await saveBookFile(
    book.dir,
    'chapters/0001_雾夜渡客.md',
    '# 第 1 章 雾夜渡客\n\n**雾**从水面长出来。\n\n> 他说：不要回头。\n\n- 第一句\n- 第二句\n',
    'init',
    { git },
  )
  await saveBookFile(
    book.dir,
    'chapters/0002_七日之限.md',
    '# 第 2 章 七日之限\n\n镇渊司的封条贴在船头。\n\n<script>alert(1)</script>\n',
    'init',
    { git },
  )
  return { root, book }
}

describe('Markdown / 纯文本导出', () => {
  it('读取整本书并按章节顺序', async () => {
    const { root, book } = await makeBook()
    try {
      const data = loadExportBook(book.dir)
      expect(data.title).toBe('雾海纪事')
      expect(data.author).toBe('郭宇')
      expect(data.chapters.map((chapter) => chapter.key)).toEqual(['0001', '0002'])
      expect(data.chapters[0].content).toContain('从水面长出来')
    } finally {
      removeDirRecursive(root)
    }
  })

  it('合并 Markdown 含书名、作者与章节分隔', async () => {
    const { root, book } = await makeBook()
    try {
      const markdown = buildMergedMarkdown(loadExportBook(book.dir))
      expect(markdown).toContain('# 雾海纪事')
      expect(markdown).toContain('作者：郭宇')
      expect(markdown.indexOf('第 1 章')).toBeLessThan(markdown.indexOf('第 2 章'))
      expect(markdown).toContain('\n\n---\n\n')
    } finally {
      removeDirRecursive(root)
    }
  })

  it('纯文本去掉 Markdown 标记但保留正文', async () => {
    const { root, book } = await makeBook()
    try {
      const text = buildPlainText(loadExportBook(book.dir))
      expect(text).toContain('雾从水面长出来')
      expect(text).toContain('他说：不要回头。')
      expect(text).not.toContain('**')
      expect(text).not.toMatch(/^#/m)
      expect(text).toContain('第 1 章 雾夜渡客')
    } finally {
      removeDirRecursive(root)
    }
  })

  it('stripMarkdown 处理标题/引用/列表/链接/加粗', () => {
    const text = stripMarkdown(
      '# 标题\n\n> 引用\n\n- 列表\n\n**加粗**与[链接](https://example.com)\n\n---\n',
    )
    expect(text).toContain('标题')
    expect(text).toContain('引用')
    expect(text).toContain('加粗与链接')
    expect(text).not.toContain('**')
    expect(text).not.toContain('https://example.com')
  })
})

describe('EPUB XHTML 生成', () => {
  it('转标题/段落/引用/列表并转义 HTML', () => {
    const html = markdownToXhtml('# 第 1 章 开头\n\n**雾**从水面长出来。\n\n> 不要回头。\n\n- 甲\n- 乙')
    expect(html).toContain('<h1>第 1 章 开头</h1>')
    expect(html).toContain('<strong>雾</strong>')
    expect(html).toContain('<blockquote><p>不要回头。</p></blockquote>')
    expect(html).toContain('<ul><li>甲</li><li>乙</li></ul>')

    const escaped = markdownToXhtml('正文 <script>alert(1)</script>')
    expect(escaped).toContain('&lt;script&gt;')
    expect(escaped).not.toContain('<script>')
    expect(escapeHtml(`'"&<>`)).toBe('&#39;&quot;&amp;&lt;&gt;')
  })
})

describe('EPUB 打包', () => {
  it('生成合规的最小 EPUB 3 结构', async () => {
    const { root, book } = await makeBook()
    try {
      const buffer = await buildEpub(loadExportBook(book.dir))
      const zip = new AdmZip(buffer)
      const entries = zip.getEntries()
      const names = entries.map((entry) => entry.entryName)

      expect(names[0]).toBe('mimetype')
      expect(entries[0].header.method).toBe(0)
      expect(zip.getEntry('mimetype')?.getData().toString('utf8')).toBe('application/epub+zip')
      expect(names).toEqual(
        expect.arrayContaining([
          'META-INF/container.xml',
          'OEBPS/content.opf',
          'OEBPS/nav.xhtml',
          'OEBPS/style.css',
          'OEBPS/chapter-0001.xhtml',
          'OEBPS/chapter-0002.xhtml',
        ]),
      )

      const container = zip.getEntry('META-INF/container.xml')?.getData().toString('utf8') ?? ''
      expect(container).toContain('OEBPS/content.opf')

      const opf = zip.getEntry('OEBPS/content.opf')?.getData().toString('utf8') ?? ''
      expect(opf).toContain('<dc:title>雾海纪事</dc:title>')
      expect(opf).toContain('<dc:creator>郭宇</dc:creator>')
      expect(opf).toContain('urn:uuid:')
      expect(opf.match(/<itemref /g)?.length).toBe(2)

      const nav = zip.getEntry('OEBPS/nav.xhtml')?.getData().toString('utf8') ?? ''
      expect(nav).toContain('第 1 章 雾夜渡客')
      expect(nav).toContain('第 2 章 七日之限')

      const chapter2 = zip.getEntry('OEBPS/chapter-0002.xhtml')?.getData().toString('utf8') ?? ''
      expect(chapter2).toContain('&lt;script&gt;')
      expect(chapter2).not.toContain('<script>alert')
    } finally {
      removeDirRecursive(root)
    }
  })
})

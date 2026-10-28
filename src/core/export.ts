/**
 * 书籍导出：把整本书拼成 Markdown / 纯文本，或为 EPUB 准备章节 HTML。
 *
 * 只做纯文本处理，不依赖 Electron；EPUB 的 zip 容器在 main/export-epub.ts 里组装。
 */
import path from 'node:path'
import { listChapters } from './book'
import { readFileOrNull } from './fsutil'

export interface ExportChapter {
  key: string
  number: number
  title: string
  content: string
}

export interface ExportBook {
  title: string
  author: string
  chapters: ExportChapter[]
}

function readBookMeta(bookDir: string): { title: string; author: string } {
  const raw = readFileOrNull(path.join(bookDir, 'book.json'))
  if (!raw) throw new Error('缺少 book.json，无法导出')
  try {
    const parsed = JSON.parse(raw) as { title?: string; author?: string }
    return { title: parsed.title?.trim() || '未命名', author: parsed.author?.trim() || '佚名' }
  } catch {
    throw new Error('book.json 损坏，无法导出')
  }
}

/** 读取整本书的导出数据（按章节号排序，跳过空章节） */
export function loadExportBook(bookDir: string): ExportBook {
  const meta = readBookMeta(bookDir)
  const chapters = listChapters(bookDir)
    .map((chapter) => {
      const content = readFileOrNull(path.join(bookDir, chapter.path)) ?? ''
      return {
        key: chapter.key,
        number: chapter.number,
        title: chapter.title,
        content: content.trim(),
      }
    })
    .filter((chapter) => chapter.content.length > 0)
  if (chapters.length === 0) throw new Error('这本书还没有可导出的正文')
  return { ...meta, chapters }
}

/** 去除 Markdown 标记，得到可直接阅读/贴到平台的纯文本 */
export function stripMarkdown(markdown: string): string {
  const text = markdown
    .replace(/\r\n/g, '\n')
    .replace(/^#{1,6}\s*/gm, '')
    .replace(/^>\s?/gm, '')
    .replace(/^[-*+]\s+/gm, '')
    .replace(/^\d+\.\s+/gm, '')
    .replace(/^---+$/gm, '')
    .replace(/!\[[^\]]*\]\([^)]*\)/g, '')
    .replace(/\[([^\]]+)\]\([^)]*\)/g, '$1')
    .replace(/(\*\*|__)(.*?)\1/g, '$2')
    .replace(/(\*|_)(.*?)\1/g, '$2')
    .replace(/`([^`]+)`/g, '$1')
    .replace(/~~(.*?)~~/g, '$1')
  return text
    .split('\n')
    .map((line) => line.trimEnd())
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim()
}

/** 合并为单个 Markdown 文件 */
export function buildMergedMarkdown(book: ExportBook): string {
  const header = `# ${book.title}\n\n作者：${book.author}\n\n> 导出自 Novel Studio · ${new Date().toISOString().slice(0, 10)}\n`
  const body = book.chapters
    .map((chapter) => {
      const content = chapter.content.replace(/^\uFEFF/, '').trim()
      // 章节文件通常自带 "# 第 N 章 标题"；若没有则补一个
      const hasHeading = /^#\s+\S/m.test(content.split('\n')[0] ?? '')
      return `\n\n---\n\n${hasHeading ? content : `# 第 ${chapter.number} 章 ${chapter.title}\n\n${content}`}`
    })
    .join('')
  return `${header}${body}\n`
}

/** 合并为纯文本（TXT） */
export function buildPlainText(book: ExportBook): string {
  const header = `${book.title}\n作者：${book.author}\n\n`
  const body = book.chapters
    .map((chapter) => {
      const content = stripMarkdown(chapter.content)
      const hasHeading = /^第\s*\d+\s*章/.test(content.split('\n')[0] ?? '')
      const heading = hasHeading ? '' : `第 ${chapter.number} 章 ${chapter.title}\n\n`
      return `\n\n${heading}${content}\n`
    })
    .join('')
  return `${header}${body}`
}

export function escapeHtml(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;')
}

function inlineHtml(escaped: string): string {
  return escaped
    .replace(/!\[[^\]]*\]\([^)]*\)/g, '')
    .replace(/\[([^\]]+)\]\([^)]*\)/g, '$1')
    .replace(/(\*\*|__)(.+?)\1/g, '<strong>$2</strong>')
    .replace(/(\*|_)(.+?)\1/g, '<em>$2</em>')
    .replace(/`([^`]+)`/g, '<code>$1</code>')
    .replace(/~~(.+?)~~/g, '$1')
}

/** 把章节 Markdown 转成 EPUB 可用的 XHTML 片段（无外部依赖，够小说用） */
export function markdownToXhtml(markdown: string): string {
  const lines = markdown.replace(/\r\n/g, '\n').split('\n')
  const output: string[] = []
  let paragraph: string[] = []
  let list: { type: 'ul' | 'ol'; items: string[] } | null = null
  let quote: string[] = []

  const flushParagraph = (): void => {
    if (paragraph.length === 0) return
    output.push(`<p>${inlineHtml(escapeHtml(paragraph.join(' ')))}</p>`)
    paragraph = []
  }
  const flushList = (): void => {
    if (!list) return
    output.push(
      `<${list.type}>${list.items.map((item) => `<li>${inlineHtml(escapeHtml(item))}</li>`).join('')}</${list.type}>`,
    )
    list = null
  }
  const flushQuote = (): void => {
    if (quote.length === 0) return
    output.push(`<blockquote><p>${inlineHtml(escapeHtml(quote.join(' ')))}</p></blockquote>`)
    quote = []
  }
  const flushAll = (): void => {
    flushParagraph()
    flushList()
    flushQuote()
  }

  for (const rawLine of lines) {
    const line = rawLine.trim()
    if (!line) {
      flushAll()
      continue
    }
    const heading = line.match(/^(#{1,6})\s+(.*)$/)
    if (heading) {
      flushAll()
      const level = heading[1].length
      output.push(`<h${level}>${inlineHtml(escapeHtml(heading[2]))}</h${level}>`)
      continue
    }
    if (/^---+$/.test(line)) {
      flushAll()
      output.push('<hr/>')
      continue
    }
    const quoteMatch = line.match(/^>\s?(.*)$/)
    if (quoteMatch) {
      flushParagraph()
      flushList()
      quote.push(quoteMatch[1])
      continue
    }
    const unordered = line.match(/^[-*+]\s+(.*)$/)
    const ordered = line.match(/^\d+\.\s+(.*)$/)
    if (unordered || ordered) {
      flushParagraph()
      flushQuote()
      const type = unordered ? 'ul' : 'ol'
      if (!list || list.type !== type) {
        flushList()
        list = { type, items: [] }
      }
      list.items.push((unordered ?? ordered)![1])
      continue
    }
    flushList()
    flushQuote()
    paragraph.push(line)
  }
  flushAll()
  return output.join('\n')
}

/** 生成单章 XHTML 文档 */
export function chapterXhtml(chapter: ExportChapter): string {
  return `<?xml version="1.0" encoding="utf-8"?>
<!DOCTYPE html>
<html xmlns="http://www.w3.org/1999/xhtml" xmlns:epub="http://www.idpf.org/2007/ops" lang="zh-CN" xml:lang="zh-CN">
<head>
  <meta charset="utf-8"/>
  <title>第 ${chapter.number} 章 ${escapeHtml(chapter.title)}</title>
  <link rel="stylesheet" type="text/css" href="style.css"/>
</head>
<body>
${markdownToXhtml(chapter.content)}
</body>
</html>
`
}

import fs from 'node:fs'
import path from 'node:path'
import { Type } from '@earendil-works/pi-ai'
import type { AgentTool } from '@earendil-works/pi-agent-core'
import {
  createGitPort,
  KNOWLEDGE_FILES,
  KNOWLEDGE_NAMES,
  listChapters,
  listDrafts,
  nextChapterKey,
  parseChapterFileName,
  saveDraft,
} from '../core'

const TRIM_MARK = '\n\n…（此处已截断）'

function trimTo(text: string, limit: number): string {
  if (text.length <= limit) return text
  return text.slice(0, limit) + TRIM_MARK
}

function ok(text: string, details: Record<string, unknown> = {}): {
  content: { type: 'text'; text: string }[]
  details: Record<string, unknown>
} {
  return { content: [{ type: 'text', text }], details }
}

function fail(message: string) {
  return { content: [{ type: 'text' as const, text: `错误：${message}` }], isError: true, details: {} }
}

function readOr(bookDir: string, relPath: string, fallback = ''): string {
  try {
    return fs.readFileSync(path.join(bookDir, relPath), 'utf8')
  } catch {
    return fallback
  }
}

export function buildContextPack(bookDir: string, chapterKey?: string): string {
  const chapters = listChapters(bookDir)
  const target = chapterKey ? chapters.find((item) => item.key === chapterKey) : undefined
  const index = target ? chapters.findIndex((item) => item.key === target.key) : chapters.length
  const previous = index > 0 ? chapters[index - 1] : undefined
  const targetKey = chapterKey ?? nextChapterKey(bookDir)

  const sections: string[] = []
  sections.push(`# 上下文包（目标章节：第 ${Number(targetKey)} 章）`)
  sections.push(`## 世界模型\n${trimTo(readOr(bookDir, 'world_model.md'), 1800)}`)
  sections.push(`## 当前状态卡\n${trimTo(readOr(bookDir, 'status_card.md'), 900)}`)
  sections.push(`## 剧情总纲\n${trimTo(readOr(bookDir, 'summary.md'), 1400)}`)
  sections.push(`## 逐章大纲\n${trimTo(readOr(bookDir, 'chapter_outline.md'), 1800)}`)
  sections.push(`## 文风指南\n${trimTo(readOr(bookDir, 'style_guide.md'), 800)}`)
  sections.push(`## 文风指纹\n${trimTo(readOr(bookDir, 'style_fingerprint.md'), 700)}`)
  if (target) {
    const current = readOr(bookDir, target.path)
    sections.push(`## 本章已有草稿（可能为空）\n${trimTo(current, 2500)}`)
  }
  if (previous) {
    const prev = readOr(bookDir, previous.path)
    sections.push(`## 上一章正文（第 ${previous.number} 章 ${previous.title}）\n${trimTo(prev, 2600)}`)
  }
  return sections.join('\n\n')
}

export function createNovelTools(bookDir: string): AgentTool[] {
  const git = createGitPort()

  const readContext: AgentTool = {
    name: 'read_context',
    label: '读取上下文包',
    description:
      '读取当前书的创作上下文：世界模型、状态卡、剧情总纲、逐章大纲、文风指南、目标章节已有草稿、上一章正文。写正文前先调用。',
    parameters: Type.Object({
      chapterKey: Type.Optional(Type.String({ description: '目标章节 key，四位数字，如 0012' })),
    }),
    execute: async (_id, rawParams) => {
      const params = rawParams as { chapterKey?: string }
      try {
        return ok(buildContextPack(bookDir, params.chapterKey))
      } catch (err) {
        return fail((err as Error).message)
      }
    },
  }

  const listChapterTool: AgentTool = {
    name: 'list_chapters',
    label: '列出章节',
    description: '列出书里已有的正式章节（key、标题、字数）以及下一章可以用的编号。',
    parameters: Type.Object({}),
    execute: async () => {
      const chapters = listChapters(bookDir)
      const nextKey = nextChapterKey(bookDir)
      const lines = chapters.map((c) => `${c.key}｜${c.title}｜${c.words} 字｜${c.path}`)
      return ok(
        `共 ${chapters.length} 章。下一章 key：${nextKey}\n` + (lines.length ? lines.join('\n') : '（还没有正式章节）'),
      )
    },
  }

  const readChapter: AgentTool = {
    name: 'read_chapter',
    label: '读章节',
    description: '按章节 key 读取正式章节正文。',
    parameters: Type.Object({
      chapterKey: Type.String({ description: '四位数字章节 key，如 0003' }),
    }),
    execute: async (_id, rawParams) => {
      const params = rawParams as { chapterKey: string }
      const chapter = listChapters(bookDir).find((item) => item.key === params.chapterKey)
      if (!chapter) return fail(`没有第 ${Number(params.chapterKey)} 章的正文`)
      return ok(readOr(bookDir, chapter.path))
    },
  }

  const readKnowledge: AgentTool = {
    name: 'read_knowledge',
    label: '读知识文件',
    description: `读取知识文件，可选值：${KNOWLEDGE_FILES.map((f) => f.name).join(', ')}`,
    parameters: Type.Object({
      name: Type.String({ description: '知识文件名，例如 world_model.md' }),
    }),
    execute: async (_id, rawParams) => {
      const params = rawParams as { name: string }
      if (!KNOWLEDGE_NAMES.has(params.name)) return fail(`不支持的知识文件：${params.name}`)
      return ok(readOr(bookDir, params.name))
    },
  }

  const writeDraft: AgentTool = {
    name: 'write_draft',
    label: '写草稿',
    description:
      '把一章完整正文写成新的草稿版本（不会进入正史，作者确认后才归档）。同一章重复调用会生成新版本。',
    parameters: Type.Object({
      chapterKey: Type.String({ description: '四位数字章节 key' }),
      content: Type.String({ description: '完整章节正文（Markdown）' }),
      note: Type.Optional(Type.String({ description: '这一版的简短说明，例如「按审核意见重写结尾」' })),
    }),
    execute: async (_id, rawParams) => {
      const params = rawParams as { chapterKey: string; content: string; note?: string }
      try {
        const info = saveDraft(bookDir, params.chapterKey, params.content, {
          source: 'ai',
          model: process.env.NOVEL_STUDIO_MODEL,
          note: params.note,
        })
        return ok(`已保存草稿 v${info.version}（${info.words} 字）。正史没有变化，等待作者确认归档。`, {
          version: info.version,
          words: info.words,
        })
      } catch (err) {
        return fail((err as Error).message)
      }
    },
  }

  const listDraftTool: AgentTool = {
    name: 'list_drafts',
    label: '列草稿',
    description: '列出某章节已有的草稿版本（新到旧）。',
    parameters: Type.Object({
      chapterKey: Type.String({ description: '四位数字章节 key' }),
    }),
    execute: async (_id, rawParams) => {
      const params = rawParams as { chapterKey: string }
      const drafts = listDrafts(bookDir, params.chapterKey)
      if (drafts.length === 0) return ok('该章节还没有草稿。')
      return ok(drafts.map((d) => `v${d.version}｜${d.words} 字｜${d.source}${d.note ? `｜${d.note}` : ''}`).join('\n'))
    },
  }

  const historyTool: AgentTool = {
    name: 'book_history',
    label: '查看历史',
    description: '查看正史的最近提交历史（只读，用于了解已归档到哪一步）。',
    parameters: Type.Object({
      limit: Type.Optional(Type.Number({ description: '条数，默认 10' })),
    }),
    execute: async (_id, rawParams) => {
      const params = rawParams as { limit?: number }
      const commits = await git.log(bookDir, { depth: params.limit ?? 10 })
      if (commits.length === 0) return ok('还没有提交历史。')
      return ok(commits.map((c) => `${c.short}｜${c.kind}｜${c.summary}`).join('\n'))
    },
  }

  return [readContext, listChapterTool, readChapter, readKnowledge, writeDraft, listDraftTool, historyTool]
}

export function summarizeToolCall(name: string, args: unknown): string {
  const data = (args ?? {}) as Record<string, unknown>
  switch (name) {
    case 'read_context':
      return data.chapterKey ? `读取第 ${Number(data.chapterKey)} 章上下文` : '读取全书上下文'
    case 'list_chapters':
      return '查看章节列表'
    case 'read_chapter':
      return `读取第 ${Number(data.chapterKey)} 章正文`
    case 'read_knowledge':
      return `读取 ${String(data.name)}`
    case 'write_draft': {
      const content = typeof data.content === 'string' ? data.content : ''
      return `写入草稿（${content.replace(/\s+/g, '').length} 字）`
    }
    case 'list_drafts':
      return `查看第 ${Number(data.chapterKey)} 章草稿`
    case 'book_history':
      return '查看正史历史'
    default:
      return name
  }
}

/** 章节 key 是否是合法 4 位数字 */
export function isChapterKey(value: string): boolean {
  return /^\d{4}$/.test(value)
}

export { parseChapterFileName }

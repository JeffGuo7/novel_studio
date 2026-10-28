import fs from 'node:fs'
import path from 'node:path'
import { Type } from '@earendil-works/pi-ai'
import type { AgentTool } from '@earendil-works/pi-agent-core'
import type { ContextPackLimits } from './context-budget'
import { searchStory } from './story-index'
import { DEFAULT_PACK_LIMITS } from './context-budget'
import {
  createGitPort,
  createKnowledgeProposal,
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

export function buildContextPack(
  bookDir: string,
  chapterKey?: string,
  limits: ContextPackLimits = DEFAULT_PACK_LIMITS,
): string {
  const chapters = listChapters(bookDir)
  const target = chapterKey ? chapters.find((item) => item.key === chapterKey) : undefined
  const index = target ? chapters.findIndex((item) => item.key === target.key) : chapters.length
  const previous = index > 0 ? chapters[index - 1] : undefined
  const targetKey = chapterKey ?? nextChapterKey(bookDir)

  const sections: string[] = []
  sections.push(`# 上下文包（目标章节：第 ${Number(targetKey)} 章）`)
  sections.push(`## 世界模型\n${trimTo(readOr(bookDir, 'world_model.md'), limits.world)}`)
  sections.push(`## 当前状态卡\n${trimTo(readOr(bookDir, 'status_card.md'), limits.status)}`)
  sections.push(`## 剧情总纲\n${trimTo(readOr(bookDir, 'summary.md'), limits.summary)}`)
  sections.push(`## 逐章大纲\n${trimTo(readOr(bookDir, 'chapter_outline.md'), limits.outline)}`)
  sections.push(`## 文风指南\n${trimTo(readOr(bookDir, 'style_guide.md'), limits.style)}`)
  sections.push(`## 文风指纹\n${trimTo(readOr(bookDir, 'style_fingerprint.md'), limits.fingerprint)}`)
  sections.push(`## 人物卡\n${trimTo(readOr(bookDir, 'characters.md'), limits.characters)}`)
  sections.push(`## 地点卡\n${trimTo(readOr(bookDir, 'locations.md'), limits.locations)}`)
  sections.push(`## 势力卡\n${trimTo(readOr(bookDir, 'factions.md'), limits.factions)}`)
  sections.push(`## 卷摘要\n${trimTo(readOr(bookDir, 'volume_summary.md'), limits.volumes)}`)
  if (target) {
    const current = readOr(bookDir, target.path)
    sections.push(`## 本章已有草稿（可能为空）\n${trimTo(current, limits.current)}`)
  }
  if (previous) {
    const prev = readOr(bookDir, previous.path)
    sections.push(`## 上一章正文（第 ${previous.number} 章 ${previous.title}）\n${trimTo(prev, limits.previous)}`)
  }
  return sections.join('\n\n')
}

export function createNovelTools(
  bookDir: string,
  options: { packLimits?: ContextPackLimits } = {},
): AgentTool[] {
  const git = createGitPort()
  const packLimits = options.packLimits ?? DEFAULT_PACK_LIMITS

  const readContext: AgentTool = {
    name: 'read_context',
    label: '读取上下文包',
    description:
      '读取当前书的创作上下文：世界模型、状态卡、剧情总纲、人物/地点/势力卡、卷摘要、逐章大纲、文风指南、目标章节已有草稿、上一章正文。写正文前先调用。',
    parameters: Type.Object({
      chapterKey: Type.Optional(Type.String({ description: '目标章节 key，四位数字，如 0012' })),
    }),
    execute: async (_id, rawParams) => {
      const params = rawParams as { chapterKey?: string }
      try {
        return ok(buildContextPack(bookDir, params.chapterKey, packLimits))
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

  const searchStoryTool: AgentTool = {
    name: 'search_story',
    label: '检索剧情',
    description:
      '在全书正式章节和知识文件里做关键词检索（人物名、地名、物品、事件片段、设定卡）。写新章节前如果想回忆很久以前的情节，先检索，命中后再用 read_chapter 读完整章节；设定/人物卡命中时用 read_knowledge 读全文。不要凭印象编造旧情节。',
    parameters: Type.Object({
      query: Type.String({ description: '检索关键词，2-6 个字效果最好，如「雾海渡口」「镇渊司封条」' }),
      limit: Type.Optional(Type.Number({ description: '返回片段数，默认 5，最多 8' })),
      scope: Type.Optional(
        Type.String({
          description: "检索范围：'all'（默认，章节+知识文件）/ 'chapter'（只看章节）/ 'knowledge'（只看知识文件）",
        }),
      ),
      chapterFrom: Type.Optional(Type.Number({ description: '只查第 N 章之后（含），给出范围时默认排除知识文件' })),
      chapterTo: Type.Optional(Type.Number({ description: '只查第 N 章之前（含）' })),
    }),
    execute: async (_id, rawParams) => {
      const params = rawParams as {
        query: string
        limit?: number
        scope?: string
        chapterFrom?: number
        chapterTo?: number
      }
      const query = String(params.query ?? '').trim()
      if (!query) return fail('检索关键词不能为空')
      const scope =
        params.scope === 'chapter' || params.scope === 'knowledge' ? params.scope : 'all'
      try {
        const result = searchStory(bookDir, query, params.limit ?? 5, {
          kind: scope,
          fromChapter: Number.isFinite(params.chapterFrom) ? Number(params.chapterFrom) : undefined,
          toChapter: Number.isFinite(params.chapterTo) ? Number(params.chapterTo) : undefined,
        })
        if (result.hits.length === 0) {
          return ok(
            result.totalChapters === 0 && result.totalKnowledge === 0
              ? '这本书还没有可检索的正文或知识文件。'
              : `没有检索到「${query}」相关片段。可以换个人物名/地名/物品名再试，或调整 scope/章节范围。`,
            { query, hits: [] },
          )
        }
        const lines = result.hits.map((hit) => {
          if (hit.kind === 'knowledge') {
            return `[知识 ${hit.sourceTitle}]（相关度 ${hit.score}）\n${hit.preview}\n`
          }
          return `[章节 ${hit.sourceKey}] ${hit.sourceTitle}（相关度 ${hit.score}）\n${hit.preview}\n`
        })
        return ok(
          `检索「${query}」：命中 ${result.hits.length} 个片段（章节 ${result.totalChapters} 章 / 知识 ${result.totalKnowledge} 份 / 索引 ${result.indexedChunks} 块）\n\n${lines.join('\n')}\n需要完整上下文时：章节用 read_chapter 读取，设定卡用 read_knowledge 读取。`,
          { query, hits: result.hits },
        )
      } catch (err) {
        return fail((err as Error).message)
      }
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

  const proposeKnowledge: AgentTool = {
    name: 'propose_knowledge',
    label: '提知识建议',
    description:
      '对知识文件（主线大纲/篇章大纲/逐章大纲/世界模型/状态卡/剧情总纲/人物卡/地点卡/势力卡/卷摘要/文风指南/错误档案等）提出修改建议。你只能写"建议"，不能直接改知识文件；作者会在界面上看 diff 后决定是否采纳。content 必须是完整的目标文件内容（含标题与 Markdown 结构），不是 diff。',
    parameters: Type.Object({
      target: Type.String({
        description: '目标知识文件名，如 master_outline.md / arc_outline.md / chapter_outline.md / world_model.md / status_card.md / summary.md / style_guide.md',
      }),
      content: Type.String({ description: '建议后的完整文件内容（Markdown 全文）' }),
      reason: Type.Optional(Type.String({ description: '一句话说明为什么建议这样改' })),
    }),
    execute: async (_id, rawParams) => {
      const params = rawParams as { target: string; content: string; reason?: string }
      try {
        const proposal = createKnowledgeProposal(bookDir, {
          targetPath: String(params.target ?? ''),
          content: String(params.content ?? ''),
          reason: params.reason,
          source: 'agent',
        })
        return ok(
          `已生成对「${proposal.targetTitle}」的建议（id: ${proposal.id}）。` +
            '这还只是建议：请在界面「AI 建议」里查看 diff，点「接受」后才会写入正史。',
          { proposalId: proposal.id, targetPath: proposal.targetPath },
        )
      } catch (err) {
        return fail((err as Error).message)
      }
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

  return [
    readContext,
    listChapterTool,
    readChapter,
    searchStoryTool,
    readKnowledge,
    proposeKnowledge,
    writeDraft,
    listDraftTool,
    historyTool,
  ]
}

export { summarizeToolCall } from './tool-summary'

/** 章节 key 是否是合法 4 位数字 */
export function isChapterKey(value: string): boolean {
  return /^\d{4}$/.test(value)
}

export { parseChapterFileName }

import { describe, expect, it } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { Agent } from '@earendil-works/pi-agent-core'
import {
  createModels,
  fauxAssistantMessage,
  fauxProvider,
  fauxText,
  fauxToolCall,
} from '@earendil-works/pi-ai'
import { createBook, createGitPort, importTextIntoBook, listDrafts, nextChapterKey, readDraft, removeDirRecursive } from '../src/core'
import { createNovelAgent } from '../src/agent/create-agent'

/**
 * 用 pi 的 fauxProvider 做确定性测试：不联网、不烧 token。
 * 验证「模型要求写草稿 → 工具真的落盘 → 正史保持不变」。
 */
describe('Agent 工具链路（faux provider）', () => {
  it('write_draft 把内容写成草稿版本，且不产生 Git 提交', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'novel-agent-faux-'))
    const git = createGitPort()
    try {
      const book = await createBook(root, { title: '测试书' }, { git })
      const chapterKey = nextChapterKey(book.dir)

      const faux = fauxProvider({ tokensPerSecond: 400 })
      const models = createModels()
      models.setProvider(faux.provider)
      const model = faux.getModel()

      faux.setResponses([
        fauxAssistantMessage(
          [
            fauxToolCall('write_draft', {
              chapterKey,
              content: '# 第 1 章 测试\n\n雾从水面站起来。\n\n林牧没有说话。\n',
              note: 'faux 草稿',
            }),
          ],
          { stopReason: 'toolUse' },
        ),
        fauxAssistantMessage([fauxText('草稿已写入，等你确认。')]),
      ])

      const agent = createNovelAgent({
        bookDir: book.dir,
        bookTitle: book.meta.title,
        model,
        streamFn: models.streamSimple.bind(models),
        nextChapterKey: chapterKey,
      })
      await agent.prompt('写第 1 章，写完保存草稿')
      await agent.waitForIdle()

      const drafts = listDrafts(book.dir, chapterKey)
      expect(drafts.length).toBe(1)
      expect(drafts[0].source).toBe('ai')
      const draft = readDraft(book.dir, chapterKey, drafts[0].version)
      expect(draft.content).toContain('雾从水面站起来')

      // 正史没有变化：仍然只有初始化那一个提交，也没有章节文件
      const commits = await git.log(book.dir, { depth: 10 })
      expect(commits.length).toBe(1)
      expect(commits[0].kind).toBe('初始化')
      expect(fs.existsSync(path.join(book.dir, 'chapters'))).toBe(true)
      expect(fs.readdirSync(path.join(book.dir, 'chapters'))).toEqual([])
    } finally {
      removeDirRecursive(root)
    }
  })

  it('工具被调用后 Agent 会继续产出收尾回复', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'novel-agent-faux2-'))
    const git = createGitPort()
    try {
      const book = await createBook(root, { title: '测试书二' }, { git })
      const faux = fauxProvider({ tokensPerSecond: 400 })
      const models = createModels()
      models.setProvider(faux.provider)
      const agent = createNovelAgent({
        bookDir: book.dir,
        bookTitle: book.meta.title,
        model: faux.getModel(),
        streamFn: models.streamSimple.bind(models),
      })

      faux.setResponses([
        fauxAssistantMessage([fauxToolCall('list_chapters', {})], { stopReason: 'toolUse' }),
        fauxAssistantMessage([fauxText('目前还没有正式章节。')]),
      ])
      await agent.prompt('现在有几章？')
      await agent.waitForIdle()

      const texts = agent.state.messages
        .filter((message) => message.role === 'assistant')
        .flatMap((message) => (Array.isArray(message.content) ? message.content : []))
        .filter((block) => block.type === 'text')
        .map((block) => (block as { text: string }).text)
      expect(texts.join('')).toContain('还没有正式章节')
    } finally {
      removeDirRecursive(root)
    }
  })
})

describe('Agent 实例', () => {
  it('是 pi 的 Agent，且工具数量符合预期', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'novel-agent-faux3-'))
    const git = createGitPort()
    try {
      const book = await createBook(root, { title: '工具检查' }, { git })
      const faux = fauxProvider()
      const models = createModels()
      models.setProvider(faux.provider)
      const agent = createNovelAgent({
        bookDir: book.dir,
        bookTitle: book.meta.title,
        model: faux.getModel(),
        streamFn: models.streamSimple.bind(models),
      })
      expect(agent).toBeInstanceOf(Agent)
      expect(agent.state.tools.length).toBe(9)
      const names = agent.state.tools.map((tool) => tool.name).sort()
      expect(names).toEqual(
        ['book_history', 'list_chapters', 'list_drafts', 'propose_knowledge', 'read_chapter', 'read_context', 'read_knowledge', 'search_story', 'write_draft'].sort(),
      )
    } finally {
      removeDirRecursive(root)
    }
  })
})

describe('search_story 在 Agent 循环里', () => {
  it('模型发起检索 → 工具返回章节片段 → 继续回答', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'novel-agent-search-'))
    const git = createGitPort()
    try {
      const book = await createBook(root, { title: '检索书' }, { git })
      await importTextIntoBook(
        book.dir,
        {
          source: '样本.txt',
          text: '第一章 雾夜渡客\n\n雾从水面长出来。林牧在雾海渡口救下苏晚。\n\n第二章 七日之限\n\n镇渊司的封条贴在船头。\n',
        },
        { git },
      )

      const faux = fauxProvider({ tokensPerSecond: 400 })
      const models = createModels()
      models.setProvider(faux.provider)
      faux.setResponses([
        fauxAssistantMessage([fauxToolCall('search_story', { query: '雾海渡口', limit: 3 })], {
          stopReason: 'toolUse',
        }),
        fauxAssistantMessage([fauxText('检索到了：第 1 章，林牧在雾海渡口救下苏晚。')]),
      ])

      const agent = createNovelAgent({
        bookDir: book.dir,
        bookTitle: book.meta.title,
        model: faux.getModel(),
        streamFn: models.streamSimple.bind(models),
      })
      await agent.prompt('回忆一下第 1 章发生了什么')
      await agent.waitForIdle()

      const toolResults = agent.state.messages.filter(
        (message) => (message as { role?: string }).role === 'toolResult',
      )
      expect(toolResults.length).toBe(1)
      const text = JSON.stringify((toolResults[0] as { content?: unknown }).content)
      expect(text).toContain('0001')
      expect(text).toContain('雾海渡口')
      expect(text).toContain('read_chapter')
    } finally {
      removeDirRecursive(root)
    }
  })
})
describe('propose_knowledge 在 Agent 循环里', () => {
  it('模型只能写建议文件，知识文件保持原样', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'novel-agent-proposal-'))
    const git = createGitPort()
    try {
      const book = await createBook(root, { title: '建议书' }, { git })
      const faux = fauxProvider({ tokensPerSecond: 400 })
      const models = createModels()
      models.setProvider(faux.provider)
      faux.setResponses([
        fauxAssistantMessage(
          [
            fauxToolCall('propose_knowledge', {
              target: 'master_outline.md',
              content: '# 主线大纲\n\n## 读者承诺\n\n- 少年在雾海复仇\n',
              reason: '补齐主线',
            }),
          ],
          { stopReason: 'toolUse' },
        ),
        fauxAssistantMessage([fauxText('建议已生成，请你在界面里确认。')]),
      ])
      const agent = createNovelAgent({
        bookDir: book.dir,
        bookTitle: book.meta.title,
        model: faux.getModel(),
        streamFn: models.streamSimple.bind(models),
      })
      await agent.prompt('帮我补一下主线大纲')
      await agent.waitForIdle()

      const { listKnowledgeProposals, readBookFile } = await import('../src/core')
      const proposals = listKnowledgeProposals(book.dir)
      expect(proposals).toHaveLength(1)
      expect(proposals[0].targetPath).toBe('master_outline.md')
      expect(proposals[0].content).toContain('雾海复仇')

      const current = await readBookFile(book.dir, 'master_outline.md', undefined, { git })
      expect(current.content).not.toContain('雾海复仇')
    } finally {
      removeDirRecursive(root)
    }
  })
})
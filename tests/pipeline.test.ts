import { describe, expect, it } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import {
  createBook,
  createGitPort,
  importTextIntoBook,
  readBookFile,
  removeDirRecursive,
} from '../src/core'
import {
  extractChapterLines,
  loadPipelineChapters,
  planChunks,
  runKnowledgeInit,
  type CompleteFn,
} from '../src/pipeline/knowledge'

const git = createGitPort()

const SAMPLE = `第一章 雾夜渡客

雾是从水面长出来的。林牧把篙插进水里。

第二章 七日之限

镇渊司的封条贴在船头。

第三章 听潮阁来信

青衫人推门进来。
`

describe('分块与逐章提取', () => {
  it('按字符预算分块，不把章节拆开', () => {
    const chapters = [
      { key: '0001', title: '一', content: 'x'.repeat(5000) },
      { key: '0002', title: '二', content: 'x'.repeat(5000) },
      { key: '0003', title: '三', content: 'x'.repeat(5000) },
    ]
    const chunks = planChunks(chapters, 12000)
    expect(chunks.length).toBe(2)
    expect(chunks[0].map((item) => item.key)).toEqual(['0001', '0002'])
    expect(chunks[1].map((item) => item.key)).toEqual(['0003'])
  })

  it('从分块结果里抽出逐章行，缺失时补占位', () => {
    const chunks = ['## 逐章\n- 0001 雾夜渡客：林牧夜里摆渡。\n- 0002 七日之限：收到封条。']
    const chapters = [
      { key: '0001', title: '雾夜渡客', content: '' },
      { key: '0002', title: '七日之限', content: '' },
      { key: '0003', title: '听潮阁来信', content: '' },
    ]
    const lines = extractChapterLines(chunks, chapters)
    expect(lines[0]).toBe('- 0001 雾夜渡客：林牧夜里摆渡。')
    expect(lines[2]).toBe('- 0003 听潮阁来信：（待补充）')
  })
})

function makeFakeComplete(): { complete: CompleteFn; calls: () => number } {
  let calls = 0
  const complete: CompleteFn = async (prompt) => {
    calls += 1
    const keys = [...prompt.matchAll(/### (\d{4}) /g)].map((match) => match[1])
    if (keys.length > 0) {
      return {
        text: `## 摘要\n这段发生了什么。\n\n## 设定\n- 雾海渡口\n\n## 状态\n- 林牧：在船上\n\n## 逐章\n${keys
          .map((key) => `- ${key} 章节：第 ${Number(key)} 章的摘要。`)
          .join('\n')}`,
        cost: 0.001,
        input: 1000,
        output: 200,
      }
    }
    if (prompt.includes('剧情总纲')) {
      return { text: '# 剧情总纲\n\n## 已发生\n- 林牧在雾夜摆渡。\n', cost: 0.002, input: 500, output: 100 }
    }
    if (prompt.includes('世界模型')) {
      return { text: '# 世界模型\n\n## 硬约束\n- 应声会被记名。\n', cost: 0.002, input: 500, output: 100 }
    }
    return { text: '# 状态卡\n\n## 人物状态\n- 林牧：船上\n', cost: 0.002, input: 500, output: 100 }
  }
  return { complete, calls: () => calls }
}

describe('知识库初始化', () => {
  it('分块蒸馏 → 合并 → 写入四个知识文件，并只产生一个 [知识] 提交', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'novel-pipeline-'))
    try {
      const book = await createBook(root, { title: '管线测试' }, { git })
      await importTextIntoBook(book.dir, { text: SAMPLE, source: '样本.txt' }, { git })

      const chapters = loadPipelineChapters(book.dir)
      expect(chapters.length).toBe(3)

      const fake = makeFakeComplete()
      const progress: string[] = []
      const report = await runKnowledgeInit({
        bookDir: book.dir,
        bookTitle: book.meta.title,
        chapters,
        complete: fake.complete,
        onProgress: (item) => progress.push(item.phase),
        git,
      })

      expect(report.chapters).toBe(3)
      expect(report.chunks).toBe(1)
      expect(report.files).toEqual(['summary.md', 'world_model.md', 'status_card.md', 'chapter_outline.md'])
      expect(report.cost).toBeCloseTo(0.001 + 0.002 * 3)

      const summary = await readBookFile(book.dir, 'summary.md')
      expect(summary.content).toContain('剧情总纲')
      const outline = await readBookFile(book.dir, 'chapter_outline.md')
      expect(outline.content).toContain('- 0001')
      expect(outline.content).toContain('第 1 章的摘要')

      const commits = await git.log(book.dir, { depth: 5 })
      expect(commits[0].kind).toBe('知识')
      expect(commits[0].summary).toContain('剧情总纲')
      // 进度事件覆盖三个阶段
      expect(progress).toContain('chunk')
      expect(progress).toContain('merge')
      expect(progress).toContain('write')
      // 3 个 chunk 调用 + 3 个合并调用
      expect(fake.calls()).toBe(4)
    } finally {
      removeDirRecursive(root)
    }
  })

  it('超过 maxChapters 时只处理前 N 章，并报告被跳过的数量', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'novel-pipeline-cap-'))
    try {
      const book = await createBook(root, { title: '上限测试' }, { git })
      await importTextIntoBook(book.dir, { text: SAMPLE, source: '样本.txt' }, { git })
      const chapters = loadPipelineChapters(book.dir)
      const fake = makeFakeComplete()
      const report = await runKnowledgeInit({
        bookDir: book.dir,
        bookTitle: book.meta.title,
        chapters,
        complete: fake.complete,
        git,
        maxChapters: 2,
      })
      expect(report.chapters).toBe(2)
      expect(report.skippedChapters).toBe(1)
    } finally {
      removeDirRecursive(root)
    }
  })

  it('没有章节时直接报错', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'novel-pipeline-empty-'))
    try {
      const book = await createBook(root, { title: '空书' }, { git })
      await expect(
        runKnowledgeInit({
          bookDir: book.dir,
          bookTitle: book.meta.title,
          chapters: [],
          complete: async () => ({ text: '', cost: 0, input: 0, output: 0 }),
          git,
        }),
      ).rejects.toThrow()
    } finally {
      removeDirRecursive(root)
    }
  })
})

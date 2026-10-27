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
  loadPipelineState,
  pipelineStatePath,
  planChunks,
  planKnowledgeUpdate,
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

const MORE = `第四章 雾里的名字

林牧在雾中看见父亲的船。

第五章  hath 归来

听潮阁的人又来了。
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

function makeFakeComplete(): {
  complete: CompleteFn
  calls: () => number
  prompts: string[]
} {
  let calls = 0
  const prompts: string[] = []
  const complete: CompleteFn = async (prompt) => {
    calls += 1
    prompts.push(prompt)
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
    if (prompt.includes('人物卡') && prompt.includes('volumeSummary')) {
      return {
        text: JSON.stringify({
          characters: '# 人物卡\n\n## 林牧\n- 身份：摆渡人\n- 目标：离开雾海\n',
          locations: '# 地点卡\n\n## 雾海渡口\n- 位置：雾海南岸\n',
          factions: '# 势力卡\n\n## 镇渊司\n- 目标：收税\n',
          volumeSummary: '# 卷摘要\n\n## 第一卷\n- 目标：离开渡口\n',
        }),
        cost: 0.001,
        input: 600,
        output: 300,
      }
    }
    if (prompt.includes('剧情总纲')) {
      return { text: '# 剧情总纲\n\n## 已发生\n- 林牧在雾夜摆渡。\n', cost: 0.002, input: 500, output: 100 }
    }
    if (prompt.includes('世界模型')) {
      return { text: '# 世界模型\n\n## 硬约束\n- 应声会被记名。\n', cost: 0.002, input: 500, output: 100 }
    }
    if (prompt.includes('文风指南')) {
      return {
        text: '## 文风指南\n### 句式与节奏\n- 短句为主，句长偏短。\n\n### 禁忌写法\n- 不要大段心理独白。\n\n## 文风指纹解读\n平均句长偏短，阅读节奏快；对话占比低，以叙述推进。',
        cost: 0.001,
        input: 300,
        output: 120,
      }
    }
    return { text: '# 状态卡\n\n## 人物状态\n- 林牧：船上\n', cost: 0.002, input: 500, output: 100 }
  }
  return { complete, calls: () => calls, prompts }
}

async function setupBook(root: string) {
  const book = await createBook(root, { title: '管线测试' }, { git })
  await importTextIntoBook(book.dir, { text: SAMPLE, source: '样本.txt' }, { git })
  return book
}

describe('知识库初始化（全量）', () => {
  it('分块蒸馏 → 合并 → 写入四个知识文件，并只产生一个 [知识] 提交', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'novel-pipeline-'))
    try {
      const book = await setupBook(root)
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

      expect(report.mode).toBe('full')
      expect(report.chapters).toBe(3)
      expect(report.chunks).toBe(1)
      expect(report.files).toEqual([
        'summary.md',
        'world_model.md',
        'status_card.md',
        'chapter_outline.md',
        'style_guide.md',
        'style_fingerprint.md',
        'characters.md',
        'locations.md',
        'factions.md',
        'volume_summary.md',
      ])
      expect(report.cost).toBeCloseTo(0.001 + 0.002 * 3 + 0.001 + 0.001)

      const summary = await readBookFile(book.dir, 'summary.md')
      expect(summary.content).toContain('剧情总纲')
      const outline = await readBookFile(book.dir, 'chapter_outline.md')
      expect(outline.content).toContain('- 0001')
      expect(outline.content).toContain('第 1 章的摘要')

      const commits = await git.log(book.dir, { depth: 5 })
      expect(commits[0].kind).toBe('知识')
      expect(commits[0].summary).toContain('剧情总纲')
      expect(progress).toContain('chunk')
      expect(progress).toContain('merge')
      expect(progress).toContain('style')
      expect(progress).toContain('entity')
      expect(progress).toContain('write')
      expect(fake.calls()).toBe(6)

      // 状态文件记录了进度
      const state = loadPipelineState(book.dir)
      expect(state?.lastChapterKey).toBe('0003')
      expect(state?.chapterCount).toBe(3)
      expect(fs.existsSync(pipelineStatePath(book.dir))).toBe(true)
    } finally {
      removeDirRecursive(root)
    }
  })

  it('超过 maxChapters 时只处理前 N 章，并报告被跳过的数量', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'novel-pipeline-cap-'))
    try {
      const book = await setupBook(root)
      const fake = makeFakeComplete()
      const report = await runKnowledgeInit({
        bookDir: book.dir,
        bookTitle: book.meta.title,
        chapters: loadPipelineChapters(book.dir),
        complete: fake.complete,
        git,
        maxChapters: 2,
      })
      expect(report.chapters).toBe(2)
      expect(report.skippedChapters).toBe(1)
      expect(report.mode).toBe('full')
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

describe('知识库增量更新', () => {
  it('第二次运行只处理新增章节，合并进已有文件并滚动状态卡', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'novel-pipeline-inc-'))
    try {
      const book = await setupBook(root)
      const fake = makeFakeComplete()
      await runKnowledgeInit({
        bookDir: book.dir,
        bookTitle: book.meta.title,
        chapters: loadPipelineChapters(book.dir),
        complete: fake.complete,
        git,
      })
      const summaryAfterFull = (await readBookFile(book.dir, 'summary.md')).content

      // 追加两章
      await importTextIntoBook(book.dir, { text: MORE, source: '续.txt' }, { git })
      const plan = planKnowledgeUpdate(book.dir)
      expect(plan.mode).toBe('incremental')
      expect(plan.pendingChapters).toBe(2)

      const fake2 = makeFakeComplete()
      const report = await runKnowledgeInit({
        bookDir: book.dir,
        bookTitle: book.meta.title,
        chapters: loadPipelineChapters(book.dir),
        complete: fake2.complete,
        git,
      })
      expect(report.mode).toBe('incremental')
      expect(report.chapters).toBe(2)
      expect(report.fromChapter).toBe('0004')
      expect(report.toChapter).toBe('0005')
      // 只有新章节进了分块提示词
      const chunkPrompts = fake2.prompts.filter((prompt) => prompt.includes('章节原文'))
      expect(chunkPrompts.length).toBe(1)
      expect(chunkPrompts[0]).toContain('### 0004')
      expect(chunkPrompts[0]).not.toContain('### 0001')
      // 合并提示词里包含已有总纲
      expect(fake2.prompts.some((prompt) => prompt.includes(summaryAfterFull.split('\n')[1] ?? '剧情总纲'))).toBe(true)

      const state = loadPipelineState(book.dir)
      expect(state?.lastChapterKey).toBe('0005')
      const commits = await git.log(book.dir, { depth: 5 })
      expect(commits[0].summary).toContain('增量')
    } finally {
      removeDirRecursive(root)
    }
  })

  it('没有新增章节时返回 noop，不写文件也不提交', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'novel-pipeline-noop-'))
    try {
      const book = await setupBook(root)
      const fake = makeFakeComplete()
      await runKnowledgeInit({
        bookDir: book.dir,
        bookTitle: book.meta.title,
        chapters: loadPipelineChapters(book.dir),
        complete: fake.complete,
        git,
      })
      const commitsBefore = (await git.log(book.dir, { depth: 20 })).length
      const report = await runKnowledgeInit({
        bookDir: book.dir,
        bookTitle: book.meta.title,
        chapters: loadPipelineChapters(book.dir),
        complete: makeFakeComplete().complete,
        git,
      })
      expect(report.mode).toBe('noop')
      expect(report.chapters).toBe(0)
      expect((await git.log(book.dir, { depth: 20 })).length).toBe(commitsBefore)
    } finally {
      removeDirRecursive(root)
    }
  })

  it('mode=full 时强制全量重建', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'novel-pipeline-forcefull-'))
    try {
      const book = await setupBook(root)
      const fake = makeFakeComplete()
      await runKnowledgeInit({
        bookDir: book.dir,
        bookTitle: book.meta.title,
        chapters: loadPipelineChapters(book.dir),
        complete: fake.complete,
        git,
      })
      const report = await runKnowledgeInit({
        bookDir: book.dir,
        bookTitle: book.meta.title,
        chapters: loadPipelineChapters(book.dir),
        complete: makeFakeComplete().complete,
        git,
        mode: 'full',
      })
      expect(report.mode).toBe('full')
      expect(report.chapters).toBe(3)
    } finally {
      removeDirRecursive(root)
    }
  })
})

describe('章节改写 / 删除检测', () => {
  it('修改已归档章节 → 计划为 rebuild；运行时整本重建并记录新 hash', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'novel-pipeline-mod-'))
    try {
      const book = await setupBook(root)
      await runKnowledgeInit({
        bookDir: book.dir,
        bookTitle: book.meta.title,
        chapters: loadPipelineChapters(book.dir),
        complete: makeFakeComplete().complete,
        git,
      })

      // 直接改写一章正文
      const chaptersDir = path.join(book.dir, 'chapters')
      const firstFile = fs.readdirSync(chaptersDir).sort()[0]
      fs.writeFileSync(
        path.join(chaptersDir, firstFile),
        '# 第一章\n\n完全改写过的正文。林牧这次说话了。\n',
        'utf8',
      )

      const plan = planKnowledgeUpdate(book.dir)
      expect(plan.mode).toBe('rebuild')
      expect(plan.modified).toContain('0001')
      expect(plan.deleted).toEqual([])

      const report = await runKnowledgeInit({
        bookDir: book.dir,
        bookTitle: book.meta.title,
        chapters: loadPipelineChapters(book.dir),
        complete: makeFakeComplete().complete,
        git,
      })
      expect(report.mode).toBe('full')
      expect(report.rebuiltBecause).toBe('modified')
      expect(report.modifiedChapters).toBe(1)

      const commits = await git.log(book.dir, { depth: 5 })
      expect(commits[0].summary).toContain('重建')

      // 状态里的 hash 已更新，再算计划应为 noop
      const state = loadPipelineState(book.dir)
      expect(state?.chapterHashes['0001']).toBeTruthy()
      expect(planKnowledgeUpdate(book.dir).mode).toBe('noop')
    } finally {
      removeDirRecursive(root)
    }
  })

  it('删除已归档章节 → 计划为 rebuild 并列出被删章节', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'novel-pipeline-del-'))
    try {
      const book = await setupBook(root)
      await runKnowledgeInit({
        bookDir: book.dir,
        bookTitle: book.meta.title,
        chapters: loadPipelineChapters(book.dir),
        complete: makeFakeComplete().complete,
        git,
      })
      const chaptersDir = path.join(book.dir, 'chapters')
      const lastFile = fs.readdirSync(chaptersDir).sort().reverse()[0]
      fs.unlinkSync(path.join(chaptersDir, lastFile))

      const plan = planKnowledgeUpdate(book.dir)
      expect(plan.mode).toBe('rebuild')
      expect(plan.deleted.length).toBe(1)
      expect(plan.totalChapters).toBe(2)
    } finally {
      removeDirRecursive(root)
    }
  })
})
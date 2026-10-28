import { describe, expect, it } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createBook, createGitPort, removeDirRecursive, saveBookFile } from '../src/core'
import {
  buildReviewPrompt,
  parseReviewIssues,
  runConsistencyReview,
  writeReviewReport,
} from '../src/pipeline/review'

const git = createGitPort()

async function makeBook(chapterCount = 8) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'novel-review-'))
  const book = await createBook(root, { title: '一致性测试书', author: '郭宇' }, { git })
  for (let index = 1; index <= chapterCount; index += 1) {
    await saveBookFile(
      book.dir,
      `chapters/${String(index).padStart(4, '0')}_第${index}章.md`,
      `# 第 ${index} 章\n\n林牧第 ${index} 次来到雾海渡口。\n`,
      'init',
      { git },
    )
  }
  await saveBookFile(
    book.dir,
    'characters.md',
    '# 人物卡\n\n## 林牧\n\n- 二十岁，雾海渡口最后一代渡人。\n',
    'init',
    { git },
  )
  return { root, book }
}

describe('一致性检查提示词与解析', () => {
  it('提示词包含设定、章节、重点与 JSON 要求', () => {
    const prompt = buildReviewPrompt({
      bookTitle: '测试书',
      knowledge: '### 人物卡\n林牧二十岁',
      chapters: [{ key: '0001', title: '第一章', content: '正文内容' }],
      focus: '林牧年龄',
      knownIssues: ['上一批的问题'],
    })
    expect(prompt).toContain('人物卡')
    expect(prompt).toContain('第 1 章')
    expect(prompt).toContain('林牧年龄')
    expect(prompt).toContain('上一批的问题')
    expect(prompt).toContain('"issues"')
  })

  it('解析容忍围栏与解释文字，过滤无效项', () => {
    const issues = parseReviewIssues(
      '这里是结果：\n```json\n{"issues":[{"severity":"high","category":"timeline","title":"时间矛盾","detail":"依据","locations":["第 1 章"],"suggestion":"建议"} , {"title":""}]}\n```',
    )
    expect(issues).toHaveLength(2)
    expect(issues[0].title).toBe('时间矛盾')
  })
})

describe('一致性检查执行', () => {
  it('分批检查、合并去重、统计成本与批次', async () => {
    const { root, book } = await makeBook(8)
    try {
      const prompts: string[] = []
      const result = await runConsistencyReview(
        { bookDir: book.dir, bookTitle: '一致性测试书' },
        {
          complete: async (prompt) => {
            prompts.push(prompt)
            const first = prompts.length === 1
            return {
              text: JSON.stringify({
                issues: [
                  {
                    severity: first ? 'high' : 'medium',
                    category: 'timeline',
                    title: '渡口时间线冲突',
                    detail: '第 1 章与第 2 章的时间不一致。',
                    locations: ['第 1 章', '第 2 章'],
                  },
                  ...(first
                    ? []
                    : [
                        {
                          severity: 'low',
                          category: 'other',
                          title: '称谓不一致',
                          detail: '同一人物称谓不同。',
                          locations: ['第 7 章'],
                        },
                      ]),
                ],
              }),
              cost: 0.001,
              input: 100,
              output: 20,
            }
          },
        },
      )
      expect(prompts.length).toBeGreaterThanOrEqual(2)
      expect(result.batches).toBeGreaterThanOrEqual(2)
      expect(result.issues).toHaveLength(2)
      expect(result.issues.map((issue) => issue.title)).toEqual(['渡口时间线冲突', '称谓不一致'])
      expect(result.cost).toBeGreaterThan(0)
      expect(result.checkedChapters).toBe(8)
      expect(result.reportMarkdown).toContain('一致性检查报告')
      expect(result.reportMarkdown).toContain('渡口时间线冲突')
    } finally {
      removeDirRecursive(root)
    }
  })

  it('单批失败只记 warning，不中断整体检查', async () => {
    const { root, book } = await makeBook(8)
    try {
      let call = 0
      const result = await runConsistencyReview(
        { bookDir: book.dir, bookTitle: '一致性测试书' },
        {
          complete: async () => {
            call += 1
            if (call === 1) throw new Error('模型返回格式错误')
            return {
              text: '{"issues":[{"severity":"medium","category":"setting","title":"设定冲突","detail":"依据","locations":["第 8 章"]}]}',
              cost: 0.001,
              input: 10,
              output: 5,
            }
          },
        },
      )
      expect(result.warnings).toHaveLength(1)
      expect(result.issues[0].title).toBe('设定冲突')
    } finally {
      removeDirRecursive(root)
    }
  })

  it('所有批次失败时报错；空书报错', async () => {
    const { root, book } = await makeBook(2)
    try {
      await expect(
        runConsistencyReview(
          { bookDir: book.dir, bookTitle: '一致性测试书' },
          {
            complete: async () => {
              throw new Error('boom')
            },
          },
        ),
      ).rejects.toThrow('一致性检查失败')
    } finally {
      removeDirRecursive(root)
    }

    const emptyRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'novel-review-empty-'))
    try {
      const empty = await createBook(emptyRoot, { title: '空书' }, { git })
      await expect(
        runConsistencyReview(
          { bookDir: empty.dir, bookTitle: '空书' },
          { complete: async () => ({ text: '{"issues":[]}', cost: 0, input: 0, output: 0 }) },
        ),
      ).rejects.toThrow('还没有正式章节')
    } finally {
      removeDirRecursive(emptyRoot)
    }
  })

  it('章节范围过滤只把范围内的章节发给模型', async () => {
    const { root, book } = await makeBook(6)
    try {
      let captured = ''
      const result = await runConsistencyReview(
        { bookDir: book.dir, bookTitle: '一致性测试书', fromChapter: 3, toChapter: 4 },
        {
          complete: async (prompt) => {
            captured = prompt
            return { text: '{"issues":[]}', cost: 0.0001, input: 10, output: 2 }
          },
        },
      )
      expect(captured).toContain('第 3 章')
      expect(captured).toContain('第 4 章')
      expect(captured).not.toContain('第 5 章')
      expect(result.checkedChapters).toBe(2)
      expect(result.fromChapter).toBe(3)
      expect(result.toChapter).toBe(4)
    } finally {
      removeDirRecursive(root)
    }
  })

  it('报告写入 .studio/reviews 且不修改书稿', async () => {
    const { root, book } = await makeBook(2)
    try {
      const before = fs.readFileSync(path.join(book.dir, 'chapters', fs.readdirSync(path.join(book.dir, 'chapters'))[0]), 'utf8')
      const result = await runConsistencyReview(
        { bookDir: book.dir, bookTitle: '一致性测试书' },
        {
          complete: async () => ({
            text: '{"issues":[{"severity":"high","category":"plot","title":"因果冲突","detail":"依据","locations":["第 1 章"]}]}',
            cost: 0.001,
            input: 10,
            output: 5,
          }),
        },
      )
      const relative = writeReviewReport(book.dir, result.reportMarkdown)
      expect(relative.startsWith('.studio/reviews/review-')).toBe(true)
      const saved = fs.readFileSync(path.join(book.dir, relative), 'utf8')
      expect(saved).toContain('因果冲突')
      const chapterFiles = fs.readdirSync(path.join(book.dir, 'chapters'))
      const after = fs.readFileSync(path.join(book.dir, 'chapters', chapterFiles[0]), 'utf8')
      expect(after).toBe(before)
    } finally {
      removeDirRecursive(root)
    }
  })
})

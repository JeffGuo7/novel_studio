import { describe, expect, it } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import {
  createBook,
  createGitPort,
  removeDirRecursive,
  saveBookFile,
} from '../src/core'
import {
  buildEntityPrompt,
  parseEntityResponse,
  runEntityCards,
} from '../src/pipeline/entities'
import { buildContextPack, createNovelTools } from '../src/agent/tools'
import { contextPackLimitsForBudget, resolveModelBudget } from '../src/agent/context-budget'

const git = createGitPort()

const CARDS = {
  characters: '# 人物卡\n\n## 林牧\n- 身份：摆渡人\n- 目标：离开雾海\n',
  locations: '# 地点卡\n\n## 雾海渡口\n- 位置：雾海南岸\n',
  factions: '# 势力卡\n\n## 镇渊司\n- 目标：收税\n',
  volumeSummary: '# 卷摘要\n\n## 第一卷\n- 目标：离开渡口\n',
}

describe('实体卡提示词与解析', () => {
  it('提示词包含逐章大纲、总纲与旧卡', () => {
    const prompt = buildEntityPrompt({
      bookTitle: '雾海',
      chapterOutline: '- 0001 林牧救下苏晚',
      summary: '- 林牧在雾夜摆渡',
      existing: { characters: '# 人物卡\n- 苏晚：青袍人' },
    })
    expect(prompt).toContain('雾海')
    expect(prompt).toContain('林牧救下苏晚')
    expect(prompt).toContain('苏晚：青袍人')
    expect(prompt).toContain('volumeSummary')
    expect(prompt).toContain('人物卡')
  })

  it('解析纯 JSON 与代码围栏，缺字段时报错', () => {
    const parsed = parseEntityResponse(JSON.stringify(CARDS))
    expect(parsed.characters).toContain('林牧')
    expect(parsed.volumeSummary).toContain('第一卷')

    const fenced = parseEntityResponse('```json\n' + JSON.stringify(CARDS) + '\n```')
    expect(fenced.locations).toContain('雾海渡口')

    expect(() => parseEntityResponse(JSON.stringify({ characters: 'x' }))).toThrow(/缺少字段/)
    expect(() => parseEntityResponse('没有 JSON')).toThrow(/JSON/)
  })
})

describe('runEntityCards', () => {
  it('生成四份档案文件内容，并带上旧卡', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'novel-entities-'))
    try {
      const book = await createBook(root, { title: '实体书' }, { git })
      await saveBookFile(book.dir, 'characters.md', '# 人物卡\n\n## 苏晚\n- 身份：青袍人\n', 'init', { git })

      let captured = ''
      const result = await runEntityCards(
        {
          bookDir: book.dir,
          bookTitle: book.meta.title,
          chapterOutline: '- 0001 林牧救下苏晚',
          summary: '- 林牧在雾夜摆渡',
        },
        {
          complete: async (prompt) => {
            captured = prompt
            return JSON.stringify(CARDS)
          },
        },
      )

      expect(captured).toContain('苏晚')
      expect(result.files).toHaveLength(4)
      const names = result.files.map(([name]) => name)
      expect(names).toEqual(['characters.md', 'locations.md', 'factions.md', 'volume_summary.md'])
      expect(result.files[0][1]).toContain('林牧')
    } finally {
      removeDirRecursive(root)
    }
  })
})

describe('上下文包包含设定卡与卷摘要', () => {
  it('新章节会注入人物/地点/势力卡与卷摘要', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'novel-pack-entities-'))
    try {
      const book = await createBook(root, { title: '上下文书' }, { git })
      await saveBookFile(book.dir, 'characters.md', '# 人物卡\n\n## 林牧\n- 目标：离开雾海\n', 'init', { git })
      await saveBookFile(book.dir, 'locations.md', '# 地点卡\n\n## 雾海渡口\n- 位置：南岸\n', 'init', { git })
      await saveBookFile(book.dir, 'factions.md', '# 势力卡\n\n## 镇渊司\n- 目标：收税\n', 'init', { git })
      await saveBookFile(book.dir, 'volume_summary.md', '# 卷摘要\n\n## 第一卷\n- 目标：离开渡口\n', 'init', { git })

      const pack = buildContextPack(book.dir)
      expect(pack).toContain('## 人物卡')
      expect(pack).toContain('林牧')
      expect(pack).toContain('## 地点卡')
      expect(pack).toContain('## 势力卡')
      expect(pack).toContain('## 卷摘要')
      expect(pack).toContain('离开渡口')
    } finally {
      removeDirRecursive(root)
    }
  })

  it('上下文包预算为设定卡分配了额度并随模型放大', () => {
    const small = contextPackLimitsForBudget(resolveModelBudget({ contextWindow: 8_000, maxTokens: 4_096 } as never))
    const large = contextPackLimitsForBudget(resolveModelBudget({ contextWindow: 1_000_000, maxTokens: 16_384 } as never))
    expect(small.characters).toBeGreaterThan(0)
    expect(large.characters).toBeGreaterThan(small.characters)
    expect(large.volumes).toBeGreaterThan(small.volumes)
    expect(large.locations).toBeGreaterThan(0)
    expect(large.factions).toBeGreaterThan(0)
  })
})

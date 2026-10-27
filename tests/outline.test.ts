import { describe, expect, it } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import {
  createBook,
  createGitPort,
  listKnowledgeProposals,
  readBookFile,
  removeDirRecursive,
  saveBookFile,
} from '../src/core'
import { buildOutlinePrompt, parseOutlineResponse, runOutline } from '../src/pipeline/outline'

const git = createGitPort()

const VALID = JSON.stringify({
  masterOutline: '# 主线大纲\n\n## 读者承诺\n\n- 雾海求生\n',
  arcOutline: '# 篇章大纲\n\n## 第一卷\n\n- 目标：离开渡口\n',
  worldModel: '# 世界模型\n\n## 硬约束\n\n- 雾里不能点火\n',
})

describe('大纲提示词与解析', () => {
  it('提示词包含创意、卷数与现有大纲', () => {
    const prompt = buildOutlinePrompt({
      bookTitle: '雾海',
      premise: '摆渡少年与父亲的船',
      volumes: 4,
      currentMaster: '旧主线',
    })
    expect(prompt).toContain('雾海')
    expect(prompt).toContain('摆渡少年与父亲的船')
    expect(prompt).toContain('分 4 卷')
    expect(prompt).toContain('旧主线')
    expect(prompt).toContain('masterOutline')
    expect(prompt).toContain('arcOutline')
  })

  it('解析纯 JSON / 代码围栏 / 前后解释文字', () => {
    expect(parseOutlineResponse(VALID).arcOutline).toContain('第一卷')
    expect(parseOutlineResponse('```json\n' + VALID + '\n```').masterOutline).toContain('雾海求生')
    expect(parseOutlineResponse(`这是大纲：\n${VALID}\n希望有帮助`).worldModel).toContain('不能点火')
  })

  it('缺字段或没有 JSON 时给出可读错误', () => {
    expect(() => parseOutlineResponse('没有 JSON')).toThrow(/JSON/)
    expect(() => parseOutlineResponse(JSON.stringify({ masterOutline: 'x' }))).toThrow(/arcOutline/)
  })
})

describe('runOutline', () => {
  it('生成 3 条建议，不改知识文件，不产生正史提交', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'novel-outline-'))
    try {
      const book = await createBook(root, { title: '大纲书' }, { git })
      await saveBookFile(book.dir, 'master_outline.md', '# 主线大纲\n\n- 旧内容\n', 'init', { git })

      const result = await runOutline(
        { bookDir: book.dir, bookTitle: book.meta.title, premise: '少年复仇', volumes: 3 },
        {
          complete: async () => ({ text: VALID, cost: 0.004, input: 1200, output: 900 }),
          onProgress: () => undefined,
        },
      )

      expect(result.proposals).toHaveLength(3)
      expect(result.proposals.map((item) => item.targetPath).sort()).toEqual([
        'arc_outline.md',
        'master_outline.md',
        'world_model.md',
      ])
      expect(result.cost).toBeCloseTo(0.004)

      const proposals = listKnowledgeProposals(book.dir)
      expect(proposals).toHaveLength(3)
      expect(proposals.every((item) => item.source === 'outline')).toBe(true)

      const current = await readBookFile(book.dir, 'master_outline.md', undefined, { git })
      expect(current.content).toContain('旧内容')
      expect(current.content).not.toContain('雾海求生')
    } finally {
      removeDirRecursive(root)
    }
  })

  it('创意为空时拒绝', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'novel-outline-empty-'))
    try {
      const book = await createBook(root, { title: '大纲书' }, { git })
      await expect(
        runOutline(
          { bookDir: book.dir, bookTitle: book.meta.title, premise: '   ', volumes: 3 },
          { complete: async () => ({ text: VALID, cost: 0, input: 0, output: 0 }) },
        ),
      ).rejects.toThrow(/创意/)
    } finally {
      removeDirRecursive(root)
    }
  })
})

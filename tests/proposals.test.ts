import { describe, expect, it } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import {
  acceptKnowledgeProposal,
  createBook,
  createGitPort,
  createKnowledgeProposal,
  listKnowledgeProposals,
  readBookFile,
  readKnowledgeProposal,
  rejectKnowledgeProposal,
  removeDirRecursive,
  saveBookFile,
} from '../src/core'

const git = createGitPort()

async function setup() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'novel-proposal-'))
  const book = await createBook(root, { title: '建议测试书' }, { git })
  return { root, book }
}

describe('AI 知识建议', () => {
  it('创建、列出、读取建议，写入 .studio（不进正史）', async () => {
    const { root, book } = await setup()
    try {
      const proposal = createKnowledgeProposal(book.dir, {
        targetPath: 'master_outline.md',
        content: '# 主线大纲\n\n## 读者承诺\n\n- 少年复仇\n',
        reason: '补齐主线',
      })
      expect(proposal.id).toMatch(/^p-/)
      expect(proposal.targetTitle).toBe('主线大纲')

      const list = listKnowledgeProposals(book.dir)
      expect(list).toHaveLength(1)
      expect(list[0].reason).toBe('补齐主线')

      const read = readKnowledgeProposal(book.dir, proposal.id)
      expect(read?.content).toContain('少年复仇')

      // 正文文件尚未变化
      const current = await readBookFile(book.dir, 'master_outline.md', undefined, { git })
      expect(current.content).not.toContain('少年复仇')

      // 藏在 .studio（书库 .gitignore 忽略），不进入正史提交
      const status = await git.status(book.dir)
      expect(status.some((change) => change.path.includes('proposals'))).toBe(false)
    } finally {
      removeDirRecursive(root)
    }
  })

  it('只允许对白名单知识文件提建议', async () => {
    const { root, book } = await setup()
    try {
      expect(() =>
        createKnowledgeProposal(book.dir, { targetPath: 'chapters/0001_x.md', content: 'x' }),
      ).toThrow(/只能对知识文件/)
      expect(() =>
        createKnowledgeProposal(book.dir, { targetPath: '../evil.md', content: 'x' }),
      ).toThrow(/只能对知识文件/)
      expect(() =>
        createKnowledgeProposal(book.dir, { targetPath: 'master_outline.md', content: '   ' }),
      ).toThrow(/不能为空/)
    } finally {
      removeDirRecursive(root)
    }
  })

  it('拒绝建议会删除文件', async () => {
    const { root, book } = await setup()
    try {
      const proposal = createKnowledgeProposal(book.dir, {
        targetPath: 'world_model.md',
        content: '# 世界模型\n',
      })
      expect(rejectKnowledgeProposal(book.dir, proposal.id)).toBe(true)
      expect(listKnowledgeProposals(book.dir)).toHaveLength(0)
      expect(rejectKnowledgeProposal(book.dir, proposal.id)).toBe(false)
    } finally {
      removeDirRecursive(root)
    }
  })

  it('采纳建议会写入知识文件并产生一条 Git 提交', async () => {
    const { root, book } = await setup()
    try {
      // 先有一版旧内容，确保采纳能产生 diff
      await saveBookFile(book.dir, 'world_model.md', '# 世界模型\n\n- 旧设定\n', 'init', { git })
      const proposal = createKnowledgeProposal(book.dir, {
        targetPath: 'world_model.md',
        content: '# 世界模型\n\n## 硬约束\n\n- 不能飞\n',
        reason: '补充硬约束',
      })

      const accepted = await acceptKnowledgeProposal(book.dir, proposal.id, { git })
      expect(accepted.oid).toBeTruthy()
      expect(accepted.path).toBe('world_model.md')

      const current = await readBookFile(book.dir, 'world_model.md', undefined, { git })
      expect(current.content).toContain('不能飞')
      expect(listKnowledgeProposals(book.dir)).toHaveLength(0)

      const commits = await git.log(book.dir, { depth: 1 })
      expect(commits[0].message).toContain('采纳 AI 建议')
    } finally {
      removeDirRecursive(root)
    }
  })

  it('内容与现有文件一致时采纳不产生新提交', async () => {
    const { root, book } = await setup()
    try {
      const content = '# 世界模型\n\n- 同样内容\n'
      await saveBookFile(book.dir, 'world_model.md', content, 'init', { git })
      const proposal = createKnowledgeProposal(book.dir, { targetPath: 'world_model.md', content })
      const accepted = await acceptKnowledgeProposal(book.dir, proposal.id, { git })
      expect(accepted.oid).toBeNull()
    } finally {
      removeDirRecursive(root)
    }
  })
})

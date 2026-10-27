import { describe, expect, it } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import {
  applyCompaction,
  buildCompactionPrompt,
  buildSummaryMessage,
  COMPACTION_MARKER,
  formatMessagesForSummary,
  selectCompactionSplit,
  type CompactionState,
} from '../src/agent/compaction'
import { estimateTokens } from '../src/agent/context-budget'
import { loadSession, saveSession } from '../src/agent/session-store'

const messages = [
  { role: 'system', content: 'SYSTEM' },
  { role: 'user', content: [{ type: 'text', text: '写第 1 章，主角叫林牧' }] },
  { role: 'assistant', content: [{ type: 'text', text: '好的，我先读上下文' }] },
  { role: 'toolResult', content: [{ type: 'text', text: '上下文很长'.repeat(100) }] },
  { role: 'user', content: [{ type: 'text', text: '继续写第 2 章' }] },
  { role: 'assistant', content: [{ type: 'text', text: '第 2 章写好了' }] },
  { role: 'user', content: [{ type: 'text', text: '再改一下结尾' }] },
  { role: 'assistant', content: [{ type: 'text', text: '改好了' }] },
]

describe('压缩切分', () => {
  it('切分点对齐到 user，且保留最近若干轮', () => {
    const split = selectCompactionSplit(messages, 40, estimateTokens)
    expect(split).toBeGreaterThan(1)
    expect((messages[split] as { role?: string }).role).toBe('user')
    // 最近一条 user 不能被切掉
    expect(split).toBeLessThan(messages.length)
  })

  it('对话很短、预算充足且没有可压缩轮次时返回 -1', () => {
    const short = messages.slice(0, 4)
    expect(selectCompactionSplit(short, 100_000, estimateTokens)).toBe(-1)
  })

  it('预算很宽时长对话仍会保留最近几轮并压缩更早内容', () => {
    const long = [messages[0]]
    for (let index = 0; index < 20; index += 1) {
      long.push({ role: 'user', content: [{ type: 'text', text: `问题 ${index}` }] })
      long.push({ role: 'assistant', content: [{ type: 'text', text: `回答 ${index}` }] })
    }
    const split = selectCompactionSplit(long, 100_000, estimateTokens)
    expect(split).toBeGreaterThan(1)
    expect((long[split] as { role?: string }).role).toBe('user')
    expect(long.length - split).toBeLessThanOrEqual(12)
  })

  it('只有 system 时返回 -1', () => {
    expect(selectCompactionSplit([messages[0]], 10, estimateTokens)).toBe(-1)
  })
})

describe('应用压缩', () => {
  const compaction: CompactionState = {
    summary: '## 写作目标\n- 写第 1-2 章',
    coveredMessages: 5,
    createdAt: '2026-01-01T00:00:00.000Z',
  }

  it('保留 system、插入摘要、接上未覆盖的消息', () => {
    const result = applyCompaction(messages, compaction) as Array<{ role?: string; content?: unknown }>
    expect(result[0]).toMatchObject({ role: 'system' })
    expect(result[1]).toMatchObject({ role: 'user' })
    const text = JSON.stringify(result[1].content)
    expect(text).toContain(COMPACTION_MARKER)
    expect(text).toContain('写第 1-2 章')
    // 未覆盖的消息从第 5 条开始
    expect(result[2]).toBe(messages[5])
    expect(result.length).toBe(2 + (messages.length - 5))
  })

  it('没有压缩状态时原样返回', () => {
    expect(applyCompaction(messages, null)).toBe(messages)
  })

  it('摘要消息本身是 user 角色（模型可见）', () => {
    expect(buildSummaryMessage('摘要')).toMatchObject({ role: 'user' })
  })
})

describe('摘要提示词与转录', () => {
  it('转录跳过 system，并截断超长消息', () => {
    const transcript = formatMessagesForSummary(messages, 20)
    expect(transcript).not.toContain('SYSTEM')
    expect(transcript).toContain('【作者】')
    expect(transcript).toContain('…（截断）')
  })

  it('提示词包含固定结构与上一版摘要', () => {
    const prompt = buildCompactionPrompt({
      bookTitle: '测试书',
      transcript: '【作者】\n写第 1 章',
      previousSummary: '上一版摘要：主角林牧',
    })
    expect(prompt).toContain('测试书')
    expect(prompt).toContain('## 写作目标')
    expect(prompt).toContain('## 未解决伏笔')
    expect(prompt).toContain('上一版摘要：主角林牧')
    expect(prompt).toContain('写第 1 章')
  })
})

describe('压缩状态持久化', () => {
  it('会话文件能保存并读回 compaction', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'novel-compact-'))
    const file = path.join(dir, 'session.json')
    try {
      saveSession(file, messages, 0.01, {}, 'sid-12345678', 4000, {
        summary: '摘要正文',
        coveredMessages: 5,
        createdAt: '2026-01-01T00:00:00.000Z',
      })
      const loaded = loadSession(file)
      expect(loaded.compaction).toMatchObject({ summary: '摘要正文', coveredMessages: 5 })
    } finally {
      fs.rmSync(dir, { recursive: true, force: true })
    }
  })
})

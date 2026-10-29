import { describe, expect, it } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import {
  AGENT_MODES,
  buildModePrompt,
  getAgentMode,
  normalizeAgentMode,
  stripModePrefix,
} from '../src/shared/agent-modes'
import { createNovelAgent } from '../src/agent/create-agent'
import { toChatHistory } from '../src/agent/session-state'

const noStream = (() => {
  throw new Error('not used')
}) as never

describe('写作模式定义', () => {
  it('合法模式与未知模式归一化', () => {
    expect(normalizeAgentMode('polish')).toBe('polish')
    expect(normalizeAgentMode('review')).toBe('review')
    expect(normalizeAgentMode('unknown')).toBe('free')
    expect(normalizeAgentMode(undefined)).toBe('free')
    expect(AGENT_MODES.map((mode) => mode.id)).toEqual(['free', 'continue', 'polish', 'review', 'expand'])
    expect(getAgentMode('review').readOnly).toBe(true)
    expect(getAgentMode('polish').readOnly).toBeUndefined()
  })

  it('prompt 包装与去前缀往返一致', () => {
    const text = '把这一段写得更紧张一点。'
    for (const mode of AGENT_MODES) {
      const prompt = buildModePrompt(text, mode.id)
      if (mode.id === 'free') {
        expect(prompt).toBe(text)
      } else {
        expect(prompt).toContain(`[写作模式：${mode.label}]`)
        expect(prompt).toContain(mode.instruction)
        expect(prompt.endsWith(text)).toBe(true)
      }
      expect(stripModePrefix(prompt)).toBe(text)
    }
    expect(stripModePrefix('普通消息，没有模式前缀')).toBe('普通消息，没有模式前缀')
  })

  it('聊天历史显示时去掉模式前缀', () => {
    const history = toChatHistory([
      { role: 'user', content: buildModePrompt('原话', 'polish'), timestamp: 1 },
      { role: 'assistant', content: [{ type: 'text', text: '润色后的正文' }], timestamp: 2 },
    ])
    expect(history[0].text).toBe('原话')
    expect(history[1].text).toBe('润色后的正文')
  })
})

describe('审稿模式只读约束', () => {
  it('写草稿/提知识建议被拦截，其它模式允许', async () => {
    const bookDir = fs.mkdtempSync(path.join(os.tmpdir(), 'novel-modes-'))
    let mode: 'review' | 'continue' = 'review'
    try {
      const agent = createNovelAgent({
        bookDir,
        bookTitle: '模式测试',
        model: { contextWindow: 8000, maxTokens: 1000 },
        streamFn: noStream,
        getMode: () => mode,
      })
      const beforeToolCall = agent.beforeToolCall as unknown as (context: {
        toolCall: { name: string }
      }) => Promise<{ block?: boolean } | undefined>
      expect((await beforeToolCall({ toolCall: { name: 'write_draft' } }))?.block).toBe(true)
      expect((await beforeToolCall({ toolCall: { name: 'propose_knowledge' } }))?.block).toBe(true)
      expect(await beforeToolCall({ toolCall: { name: 'read_context' } })).toBeUndefined()

      mode = 'continue'
      expect(await beforeToolCall({ toolCall: { name: 'write_draft' } })).toBeUndefined()
    } finally {
      fs.rmSync(bookDir, { recursive: true, force: true })
    }
  })
})

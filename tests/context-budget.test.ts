import { describe, expect, it } from 'vitest'
import {
  CONTEXT_SAFETY_TOKENS,
  contextPackLimitsForBudget,
  estimateMessagesTokens,
  estimateTokens,
  resolveModelBudget,
  trimMessagesToBudget,
  truncateLongValues,
} from '../src/agent/context-budget'

const zh = '雾从水面长出来。林牧把篙插进水里。'

describe('模型驱动的上下文预算', () => {
  it('8k 小模型：输入预算为正且小于窗口，输出按窗口推算', () => {
    const budget = resolveModelBudget({ contextWindow: 8_192, maxTokens: 4_096 })
    expect(budget.contextWindow).toBe(8_192)
    expect(budget.maxOutputTokens).toBe(4_096)
    expect(budget.safetyTokens).toBeGreaterThanOrEqual(CONTEXT_SAFETY_TOKENS)
    expect(budget.inputBudgetTokens).toBeGreaterThan(0)
    expect(budget.inputBudgetTokens).toBeLessThan(8_192)
    expect(budget.packBudgetTokens).toBeLessThanOrEqual(24_000)
  })

  it('128k 与 1M 模型：预算随窗口放大，但没有无限膨胀', () => {
    const mid = resolveModelBudget({ contextWindow: 128_000, maxTokens: 8_192 })
    const huge = resolveModelBudget({ contextWindow: 1_000_000, maxTokens: 128_000 })
    expect(mid.inputBudgetTokens).toBeGreaterThan(100_000)
    expect(huge.inputBudgetTokens).toBeGreaterThan(mid.inputBudgetTokens)
    expect(huge.packBudgetTokens).toBe(24_000) // 有上限，避免一次工具结果吃掉全书上下文
    expect(huge.historyBudgetTokens).toBeGreaterThan(mid.historyBudgetTokens)
  })

  it('缺少模型元数据时退回 128k 兜底', () => {
    expect(resolveModelBudget(null).contextWindow).toBe(128_000)
    expect(resolveModelBudget({}).contextWindow).toBe(128_000)
  })

  it('上下文包分节上限随模型预算增加，且中文按保守 token 估算', () => {
    const small = contextPackLimitsForBudget(resolveModelBudget({ contextWindow: 8_192 }))
    const large = contextPackLimitsForBudget(resolveModelBudget({ contextWindow: 200_000 }))
    expect(small.world).toBeLessThan(large.world)
    expect(small.current).toBeLessThan(large.current)
    for (const value of Object.values(large)) expect(value).toBeGreaterThan(0)
  })

  it('中文 token 估算比 pi 的默认估算更保守', () => {
    const tokens = estimateTokens(zh)
    // 中文按 1.6 字/token ≈ 13 tokens；pi 的 3.5 字/token 会低估
    expect(tokens).toBeGreaterThanOrEqual(Math.ceil(zh.length / 2))
  })

  it('消息 token 估算能覆盖 toolCall / toolResult', () => {
    const messages = [
      { role: 'user', content: [{ type: 'text', text: zh }] },
      { role: 'assistant', content: [{ type: 'toolCall', name: 'read_context', arguments: { chapterKey: '0001' } }] },
      { role: 'toolResult', content: [{ type: 'text', text: '上下文'.repeat(100) }] },
    ]
    expect(estimateMessagesTokens(messages)).toBeGreaterThan(estimateMessagesTokens([messages[0]]))
  })
})

describe('按预算裁剪历史', () => {
  function turn(index: number) {
    return [
      { role: 'user', content: [{ type: 'text', text: `问题 ${index}：继续写` }] },
      { role: 'assistant', content: [{ type: 'toolCall', name: 'read_context', arguments: { chapterKey: '0001' } }] },
      { role: 'toolResult', content: [{ type: 'text', text: '上下文'.repeat(50) }] },
      { role: 'assistant', content: [{ type: 'text', text: `回答 ${index}` }] },
    ]
  }

  it('裁剪后从 user 开始，不拆散 toolCall/toolResult，system 保留', () => {
    const system = { role: 'system', content: 'SYSTEM' }
    const messages = [system, ...turn(1), ...turn(2), ...turn(3), ...turn(4)]
    const result = trimMessagesToBudget(messages, 300)
    expect(result.trimmed).toBe(true)
    expect(result.messages[0]).toMatchObject({ role: 'system' })
    expect(result.messages[1]).toMatchObject({ role: 'user' })
    expect(result.estimatedTokens).toBeLessThanOrEqual(300 + 160) // 保留完整 turn 时允许略超
    // toolResult 前面必须是承载 toolCall 的 assistant
    const roles = result.messages.map((item) => (item as { role?: string }).role)
    for (let i = 1; i < roles.length; i += 1) {
      if (roles[i] === 'toolResult') expect(roles[i - 1]).toBe('assistant')
    }
  })

  it('预算很小时至少保留最后一条 user 之后的内容', () => {
    const messages = [...turn(1), ...turn(2)]
    const result = trimMessagesToBudget(messages, 200)
    expect(result.messages.length).toBeGreaterThan(0)
    expect((result.messages[result.messages.length - 1] as { role?: string }).role).toBe('assistant')
  })

  it('未超预算时原样返回', () => {
    const messages = turn(1)
    const result = trimMessagesToBudget(messages, 10_000)
    expect(result.trimmed).toBe(false)
    expect(result.messages).toHaveLength(messages.length)
  })

  it('超长消息按预算截断', () => {
    const long = { role: 'toolResult', content: [{ type: 'text', text: 'x'.repeat(20_000) }] }
    const [trimmed] = truncateLongValues([long], 2_000) as Array<{ content: Array<{ text: string }> }>
    expect(trimmed.content[0].text.length).toBeLessThan(2_100)
    expect(trimmed.content[0].text).toContain('截断')
  })
})

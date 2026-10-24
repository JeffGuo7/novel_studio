import { describe, expect, it } from 'vitest'
import {
  isOverBudget,
  prepareForPersist,
  trimMessages,
  truncateDeep,
} from '../src/agent/session-state'

const msg = (role: string, text: string) => ({ role, content: [{ type: 'text', text }], timestamp: 1 })

describe('会话裁剪', () => {
  it('保留最近 N 条，并且起点必须落在 user 上（不拆散 toolCall/toolResult）', () => {
    const messages = [
      msg('user', 'u1'),
      msg('assistant', 'a1'),
      msg('toolResult', 't1'),
      msg('assistant', 'a2'),
      msg('user', 'u2'),
      msg('assistant', 'a3'),
    ]
    const trimmed = trimMessages(messages, 4) as Array<{ role: string }>
    expect(trimmed.length).toBeLessThanOrEqual(4)
    expect(trimmed[0].role).toBe('user')
    expect((trimmed[0] as unknown as { content: Array<{ text: string }> }).content[0].text).toBe('u2')
  })

  it('消息数没超上限时原样返回', () => {
    const messages = [msg('user', 'u1'), msg('assistant', 'a1')]
    expect(trimMessages(messages, 10)).toEqual(messages)
  })
})

describe('超长内容截断', () => {
  it('深层字符串会被截断并留标记', () => {
    const long = 'x'.repeat(9000)
    const result = truncateDeep({ a: [{ b: long }] }, 100) as { a: Array<{ b: string }> }
    expect(result.a[0].b.length).toBeLessThan(200)
    expect(result.a[0].b).toContain('已截断')
  })

  it('prepareForPersist 同时做裁剪与截断，并带上成本', () => {
    const messages = Array.from({ length: 200 }, (_, index) => msg(index % 2 === 0 ? 'user' : 'assistant', 'y'.repeat(5000)))
    const payload = prepareForPersist(messages, 0.0123)
    expect(payload.messages.length).toBeLessThanOrEqual(120)
    expect(payload.cost).toBeCloseTo(0.0123)
    expect(JSON.stringify(payload).length).toBeLessThan(1_500_000)
  })
})

describe('预算判断', () => {
  it('未设置预算时不限制', () => {
    expect(isOverBudget(999, 0)).toBe(false)
    expect(isOverBudget(999, -1)).toBe(false)
  })

  it('达到或超过预算即熔断', () => {
    expect(isOverBudget(0.49, 0.5)).toBe(false)
    expect(isOverBudget(0.5, 0.5)).toBe(true)
    expect(isOverBudget(0.6, 0.5)).toBe(true)
  })

  it('可以按「当前 + 本次」预估是否超预算', () => {
    expect(isOverBudget(0.45, 0.5, 0.02)).toBe(false)
    expect(isOverBudget(0.49, 0.5, 0.02)).toBe(true)
  })
})

import { describe, expect, it } from 'vitest'
import {
  addChapterCost,
  chapterCostOf,
  isOverBudget,
  prepareForPersist,
  toChatHistory,
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

describe('单章成本', () => {
  it('按章节累计，未指定章节时不记录', () => {
    let costs = addChapterCost({}, '0001', 0.01)
    costs = addChapterCost(costs, '0001', 0.02)
    costs = addChapterCost(costs, '0002', 0.005)
    costs = addChapterCost(costs, undefined, 0.9)
    expect(Object.keys(costs).sort()).toEqual(['0001', '0002'])
    expect(costs['0001']).toBeCloseTo(0.03)
    expect(costs['0002']).toBeCloseTo(0.005)
    expect(chapterCostOf(costs, '0001')).toBeCloseTo(0.03)
    expect(chapterCostOf(costs, '0002')).toBeCloseTo(0.005)
    expect(chapterCostOf(costs, undefined)).toBe(0)
    expect(chapterCostOf(costs, '0003')).toBe(0)
  })

  it('单章预算独立于会话预算', () => {
    const chapterBudget = 0.2
    expect(isOverBudget(0.19, chapterBudget)).toBe(false)
    expect(isOverBudget(0.2, chapterBudget)).toBe(true)
    // 会话预算可以更大，互不影响
    expect(isOverBudget(0.2, 0.5)).toBe(false)
  })

  it('prepareForPersist 会把单章成本一起存下来', () => {
    const payload = prepareForPersist([msg('user', 'hi')], 0.02, { '0001': 0.02 })
    expect(payload.chapterCosts).toEqual({ '0001': 0.02 })
  })
})

describe('会话历史还原', () => {
  it('只保留 user / assistant 的文本，跳过工具结果与空消息', () => {
    const messages = [
      msg('user', '写第 1 章'),
      { role: 'assistant', content: [{ type: 'toolCall', name: 'read_context', arguments: {} }] },
      msg('toolResult', '很长的工具输出'),
      msg('assistant', '草稿写好了'),
      msg('user', '   '),
    ]
    const history = toChatHistory(messages)
    expect(history.map((item) => item.role)).toEqual(['user', 'assistant'])
    expect(history[0].text).toBe('写第 1 章')
    expect(history[1].text).toBe('草稿写好了')
  })

  it('限制返回条数（保留最近的）', () => {
    const messages = Array.from({ length: 100 }, (_, index) =>
      msg(index % 2 === 0 ? 'user' : 'assistant', `m${index}`),
    )
    const history = toChatHistory(messages, 10)
    expect(history.length).toBe(10)
    expect(history[0].text).toBe('m90')
  })

  it('兼容 content 为纯字符串的消息', () => {
    const history = toChatHistory([{ role: 'user', content: '纯字符串', timestamp: 123 }])
    expect(history).toEqual([{ role: 'user', text: '纯字符串', timestamp: 123 }])
  })
})

describe('历史工具轨迹', () => {
  it('把 toolCall 与 toolResult 配对，还原摘要和成功/失败', () => {
    const messages = [
      msg('user', '写第 2 章'),
      {
        role: 'assistant',
        content: [
          { type: 'toolCall', id: 'c1', name: 'read_context', arguments: { chapterKey: '0002' } },
          { type: 'toolCall', id: 'c2', name: 'write_draft', arguments: { content: '雾从水面长出来' } },
        ],
      },
      { role: 'toolResult', toolCallId: 'c1', isError: false, content: [{ type: 'text', text: '上下文' }] },
      { role: 'toolResult', toolCallId: 'c2', isError: true, content: [{ type: 'text', text: '写入失败' }] },
      msg('assistant', '写好了'),
    ]
    const history = toChatHistory(messages)
    expect(history).toHaveLength(2)
    const tools = history[1].tools ?? []
    expect(tools).toHaveLength(2)
    expect(tools[0]).toMatchObject({ name: 'read_context', summary: '读取第 2 章上下文', ok: true })
    expect(tools[1]).toMatchObject({ name: 'write_draft', summary: '写入草稿（7 字）', ok: false })
  })

  it('只有工具、没有最终回答的轮次也会保留轨迹', () => {
    const messages = [
      msg('user', '开始'),
      { role: 'assistant', content: [{ type: 'toolCall', id: 'x', name: 'list_chapters', arguments: {} }] },
      { role: 'toolResult', toolCallId: 'x', isError: false, content: [{ type: 'text', text: 'ok' }] },
    ]
    const history = toChatHistory(messages)
    expect(history).toHaveLength(2)
    expect(history[1]).toMatchObject({ role: 'assistant', text: '' })
    expect(history[1].tools?.[0]?.summary).toBe('查看章节列表')
  })

  it('没有 toolCall id 的旧会话也不会丢轨迹', () => {
    const messages = [
      msg('user', '开始'),
      { role: 'assistant', content: [{ type: 'toolCall', name: 'read_knowledge', arguments: { name: 'world_model.md' } }] },
      msg('assistant', '完成'),
    ]
    const history = toChatHistory(messages)
    expect(history[1].tools?.[0]).toMatchObject({
      name: 'read_knowledge',
      summary: '读取 world_model.md',
    })
  })
})
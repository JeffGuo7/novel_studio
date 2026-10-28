import { describe, expect, it } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { isContextOverflow } from '@earendil-works/pi-ai/compat'
import {
  decideOverflowRecovery,
  planFallbackCompaction,
  scaleInputBudget,
} from '../src/agent/overflow-recovery'
import { createNovelAgent } from '../src/agent/create-agent'

function assistant(overrides: Record<string, unknown>) {
  return {
    role: 'assistant',
    content: [],
    stopReason: 'stop',
    usage: { input: 100, output: 10, cacheRead: 0 },
    ...overrides,
  } as never
}

describe('溢出恢复决策', () => {
  it('未检测到溢出时不动', () => {
    expect(decideOverflowRecovery({ overflowDetected: false, alreadyRetried: false, canCompact: true }).action).toBe('none')
  })

  it('第一次溢出且可压缩时压缩重试', () => {
    expect(decideOverflowRecovery({ overflowDetected: true, alreadyRetried: false, canCompact: true }).action).toBe(
      'compact-and-retry',
    )
  })

  it('已重试过 / 不可压缩时放弃并给出提示', () => {
    const retried = decideOverflowRecovery({ overflowDetected: true, alreadyRetried: true, canCompact: true })
    expect(retried.action).toBe('give-up')
    expect(retried.reason).toContain('仍然')
    const noHistory = decideOverflowRecovery({ overflowDetected: true, alreadyRetried: false, canCompact: false })
    expect(noHistory.action).toBe('give-up')
    expect(noHistory.reason).toContain('没有可压缩')
  })

  it('保底压缩保留 system 前缀和最近消息', () => {
    const messages = [
      { role: 'system' },
      ...Array.from({ length: 10 }, (_, index) => ({ role: index % 2 === 0 ? 'user' : 'assistant' })),
    ]
    const plan = planFallbackCompaction(messages, 4)
    expect(plan?.coveredMessages).toBe(7)
    expect(plan?.summary).toContain('自动压缩')
    expect(planFallbackCompaction([{ role: 'system' }, { role: 'user' }], 4)).toBeNull()
  })

  it('输入预算缩放有下限', () => {
    expect(scaleInputBudget(10_000, 0.5)).toBe(5_000)
    expect(scaleInputBudget(10_000, 0.1)).toBe(3_000)
    expect(scaleInputBudget(10_000, 1)).toBe(10_000)
    expect(scaleInputBudget(100, 0.3)).toBe(1024)
  })
})

describe('pi 溢出检测', () => {
  it('识别供应商溢出错误，排除限流错误', () => {
    expect(isContextOverflow(assistant({ stopReason: 'error', errorMessage: 'prompt is too long: 213462 tokens > 200000 maximum' }))).toBe(true)
    expect(isContextOverflow(assistant({ stopReason: 'error', errorMessage: 'Your input exceeds the context window of this model' }))).toBe(true)
    expect(isContextOverflow(assistant({ stopReason: 'error', errorMessage: '429 rate limit exceeded' }))).toBe(false)
  })

  it('静默溢出：usage 超过 contextWindow 也识别', () => {
    expect(
      isContextOverflow(assistant({ usage: { input: 9000, output: 10, cacheRead: 0 } }), 8000),
    ).toBe(true)
  })
})

describe('溢出后缩小 transformContext 预算', () => {
  it('相同历史下 scale=0.5 保留更少内容', async () => {
    const bookDir = fs.mkdtempSync(path.join(os.tmpdir(), 'novel-overflow-'))
    try {
      let scale = 1
      const agent = createNovelAgent({
        bookDir,
        bookTitle: '测试',
        model: { contextWindow: 8000, maxTokens: 1000 },
        getBudgetScale: () => scale,
        streamFn: (() => {
          throw new Error('not used')
        }) as never,
      })
      const messages = Array.from({ length: 60 }, (_, index) => ({
        role: 'user',
        content: `第 ${index} 段：${'雾从水面长出来。'.repeat(40)}`,
        timestamp: Date.now(),
      }))
      const transform = agent.transformContext as unknown as (input: unknown[]) => Promise<unknown[]>
      const full = await transform(messages)
      scale = 0.5
      const reduced = await transform(messages)
      expect(reduced.length).toBeLessThan(full.length)
    } finally {
      fs.rmSync(bookDir, { recursive: true, force: true })
    }
  })
})

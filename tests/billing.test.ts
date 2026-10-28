import { describe, expect, it } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { providerBilling, shouldEnforceBudget } from '../src/shared/billing'
import { prepareForPersist } from '../src/agent/session-state'
import { loadSession, sessionFilePath, saveSession } from '../src/agent/session-store'

describe('计费模式识别', () => {
  it('OpenCode Go 视为套餐内，其它按量计费', () => {
    expect(providerBilling('opencode-go')).toBe('subscription')
    expect(providerBilling('opencode')).toBe('metered')
    expect(providerBilling('deepseek')).toBe('metered')
    expect(providerBilling(undefined)).toBe('metered')
    expect(shouldEnforceBudget('subscription')).toBe(false)
    expect(shouldEnforceBudget('metered')).toBe(true)
  })
})

describe('会话轮次持久化', () => {
  it('prepareForPersist 保存 requests', () => {
    const payload = prepareForPersist([], 0.5, { '0001': 0.5 }, undefined, 1000, null, 7)
    expect(payload.requests).toBe(7)
    expect(prepareForPersist([], 0, {}, undefined, 1000, null, 0).requests).toBeUndefined()
  })

  it('saveSession / loadSession 往返保存轮次', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'novel-billing-session-'))
    try {
      const file = sessionFilePath(path.join(root, 'book'))
      saveSession(file, [], 0.12, { '0001': 0.12 }, 'sid', 1000, null, 3)
      const loaded = loadSession(file)
      expect(loaded.requests).toBe(3)
      expect(loaded.cost).toBeCloseTo(0.12)
      expect(loaded.chapterCosts).toEqual({ '0001': 0.12 })
    } finally {
      fs.rmSync(root, { recursive: true, force: true })
    }
  })
})

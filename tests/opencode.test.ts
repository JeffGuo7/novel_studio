import { describe, expect, it } from 'vitest'
import {
  isOpenCodeModel,
  normalizeOpenCodeSessionId,
  withOpenCodeHeaders,
} from '../src/agent/opencode'

describe('OpenCode 模型识别', () => {
  it('内置 provider 与自定义 baseUrl 都能识别', () => {
    expect(isOpenCodeModel({ provider: 'opencode', baseUrl: 'https://opencode.ai/inference/v1' })).toBe(true)
    expect(isOpenCodeModel({ provider: 'opencode-go', baseUrl: 'https://opencode.ai/inference/go/v1' })).toBe(true)
    expect(isOpenCodeModel({ provider: 'custom', baseUrl: 'https://opencode.ai/inference/go/openai/v1' })).toBe(true)
  })

  it('其他 provider 不受影响', () => {
    expect(isOpenCodeModel({ provider: 'deepseek', baseUrl: 'https://api.deepseek.com/v1' })).toBe(false)
    expect(isOpenCodeModel(null)).toBe(false)
    expect(isOpenCodeModel({})).toBe(false)
    expect(isOpenCodeModel({ baseUrl: 'not-a-url' })).toBe(false)
  })
})

describe('OpenCode 请求头注入', () => {
  it('注入 session 与自定义 UA，同时保留调用方其它 options', async () => {
    let captured: Record<string, unknown> = {}
    const wrapped = withOpenCodeHeaders(((_m: unknown, _c: unknown, options?: Record<string, unknown>) => {
      captured = options ?? {}
      return 'done'
    }) as never, 'sid-12345678', 'NovelStudio/0.15.0')

    const result = wrapped({}, { messages: [] }, { apiKey: 'k', temperature: 0.3 } as never)
    expect(result).toBe('done')
    expect(captured.apiKey).toBe('k')
    expect(captured.temperature).toBe(0.3)
    expect((captured.headers as Record<string, string>)['x-opencode-session']).toBe('sid-12345678')
    expect((captured.headers as Record<string, string>)['User-Agent']).toBe('NovelStudio/0.15.0')
  })

  it('允许调用方覆盖 user agent，原有 headers 不丢', () => {
    let captured: Record<string, unknown> = {}
    const wrapped = withOpenCodeHeaders(((_m: unknown, _c: unknown, options?: Record<string, unknown>) => {
      captured = options ?? {}
      return null
    }) as never, 'sid-abcdefgh')

    wrapped({}, {}, { headers: { 'X-Trace': '1' } } as never)
    const headers = captured.headers as Record<string, string>
    expect(headers['X-Trace']).toBe('1')
    expect(headers['x-opencode-session']).toBe('sid-abcdefgh')
    expect(headers['User-Agent']).toBe('NovelStudio')
  })

  it('session id 取值安全', () => {
    expect(normalizeOpenCodeSessionId('550e8400-e29b-41d4-a716-446655440000')).toBe(
      '550e8400-e29b-41d4-a716-446655440000',
    )
    expect(normalizeOpenCodeSessionId('  abc12345  ')).toBe('abc12345')
    expect(normalizeOpenCodeSessionId('short')).toBeNull()
    expect(normalizeOpenCodeSessionId('bad session id!!')).toBeNull()
    expect(normalizeOpenCodeSessionId(undefined)).toBeNull()
    expect(normalizeOpenCodeSessionId(42)).toBeNull()
  })
})

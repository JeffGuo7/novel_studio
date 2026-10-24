import { describe, expect, it } from 'vitest'
import { createCustomModel, resolveModel } from '../src/agent/model-registry'

describe('模型解析（pi 目录 + 自定义 provider）', () => {
  it('内置 provider 从 pi 目录解析', () => {
    const model = resolveModel({ provider: 'deepseek', model: 'deepseek-flash' }) as { id: string; provider: string }
    expect(model).not.toBeNull()
    expect(model.id).toBe('deepseek-flash')
    expect(model.provider).toBe('deepseek')
  })

  it('内置目录里没有的模型，有 baseUrl 时按自定义 provider 生成', () => {
    const model = resolveModel({
      provider: 'my-openai',
      model: 'gpt-x',
      providerConfig: { id: 'my-openai', api: 'openai-completions', baseUrl: 'https://example.com/v1' },
    }) as { id: string; provider: string; baseUrl: string; api: string; input: string[] }
    expect(model.id).toBe('gpt-x')
    expect(model.provider).toBe('my-openai')
    expect(model.baseUrl).toBe('https://example.com/v1')
    expect(model.api).toBe('openai-completions')
    expect(model.input).toEqual(['text'])
  })

  it('未知模型且没有自定义配置时返回 null', () => {
    expect(resolveModel({ provider: 'deepseek', model: 'no-such-model' })).toBeNull()
  })

  it('自定义 provider 可以声明视觉输入', () => {
    const model = createCustomModel('v', 'vision-x', {
      id: 'v',
      api: 'openai-completions',
      baseUrl: 'https://example.com/v1',
      supportsVision: true,
    })
    expect(model.input).toEqual(['text', 'image'])
  })

  it('默认 api 回落到 openai-completions', () => {
    const model = createCustomModel('v', 'm', { id: 'v', api: '', baseUrl: 'https://example.com/v1' })
    expect(model.api).toBe('openai-completions')
  })
})

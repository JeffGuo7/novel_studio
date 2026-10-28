import { describe, expect, it } from 'vitest'
import {
  classifyConnectionError,
  connectionErrorMessage,
  normalizeProxyUrl,
} from '../src/shared/connection-test'

describe('代理地址归一化', () => {
  it('留空 / 带协议 / 不带协议 / 前后空格', () => {
    expect(normalizeProxyUrl('')).toBe('')
    expect(normalizeProxyUrl('   ')).toBe('')
    expect(normalizeProxyUrl(' http://127.0.0.1:7890 ')).toBe('http://127.0.0.1:7890')
    expect(normalizeProxyUrl('127.0.0.1:7890')).toBe('http://127.0.0.1:7890')
    expect(normalizeProxyUrl('https://proxy.example.com:8080')).toBe('https://proxy.example.com:8080')
  })
})

describe('连接错误分类', () => {
  it('鉴权 / 网络 / 模型 / 配置 / 未知', () => {
    expect(classifyConnectionError('401 Unauthorized')).toBe('auth')
    expect(classifyConnectionError('invalid api key')).toBe('auth')
    expect(classifyConnectionError('getaddrinfo ENOTFOUND api.deepseek.com')).toBe('network')
    expect(classifyConnectionError('request timed out')).toBe('network')
    expect(classifyConnectionError('404 model not found')).toBe('model')
    expect(classifyConnectionError('API key not configured')).toBe('config')
    expect(classifyConnectionError('boom')).toBe('unknown')
  })

  it('每类都有可操作提示', () => {
    expect(connectionErrorMessage('auth')).toContain('API Key')
    expect(connectionErrorMessage('network')).toContain('代理')
    expect(connectionErrorMessage('model')).toContain('模型')
    expect(connectionErrorMessage('config')).toContain('配置')
    expect(connectionErrorMessage('unknown')).toContain('连接失败')
  })
})

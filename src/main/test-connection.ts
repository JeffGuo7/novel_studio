import { app, utilityProcess } from 'electron'
import path from 'node:path'
import type { TestConnectionResult } from '../shared/connection-test'
import { getProxyUrl, getSelection, getStoredApiKey } from './settings-store'

function resolveHostPath(): string {
  if (app.isPackaged) return path.join(process.resourcesPath, 'agent', 'test-host.mjs')
  return path.join(__dirname, '../agent/test-host.mjs')
}

/**
 * 用一次性 utilityProcess 测试当前模型是否可用：
 * - 不经过主进程（主进程不直接调用模型）；
 * - 不读写书库、不创建会话，只发一个最小请求；
 * - 30 秒超时，进程退出也能得到明确错误。
 */
export async function testModelConnection(): Promise<TestConnectionResult> {
  const selection = getSelection()
  const provider = selection.providerConfig?.id ?? selection.provider
  const model = selection.model
  const apiKey = getStoredApiKey(provider)
  if (!apiKey) {
    return {
      ok: false,
      provider,
      model,
      latencyMs: 0,
      error: '还没有配置 API Key',
      category: 'config',
    }
  }

  return new Promise<TestConnectionResult>((resolve) => {
    let settled = false
    const finish = (result: TestConnectionResult): void => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      child.kill()
      resolve(result)
    }

    const child = utilityProcess.fork(resolveHostPath(), [], {
      stdio: 'inherit',
      env: {
        ...process.env,
        NOVEL_STUDIO_TEST_CONFIG: JSON.stringify({ selection, apiKey }),
        NOVEL_STUDIO_PROXY: getProxyUrl(),
        NOVEL_STUDIO_APP_VERSION: app.getVersion(),
      },
    })

    const timer = setTimeout(() => {
      finish({
        ok: false,
        provider,
        model,
        latencyMs: 30_000,
        error: '连接超时（30 秒）',
        category: 'network',
      })
    }, 30_000)

    child.on('message', (message: unknown) => {
      const payload = message as { type?: string; result?: TestConnectionResult }
      if (payload?.type === 'test-result' && payload.result) finish(payload.result)
    })
    child.on('exit', (code) => {
      finish({
        ok: false,
        provider,
        model,
        latencyMs: 0,
        error: `测试进程退出（code ${code}）`,
        category: 'unknown',
      })
    })
  })
}

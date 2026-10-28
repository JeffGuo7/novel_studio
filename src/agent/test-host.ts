/**
 * 一次性的模型连接测试 utilityProcess：
 *   主进程传入 NOVEL_STUDIO_TEST_CONFIG（selection + apiKey）与 NOVEL_STUDIO_PROXY，
 *   解析模型 → 发一个最小请求 → 把结果 postMessage 回主进程后退出。
 * 不读写书库、不创建会话，成本约等于一个 8 token 的请求。
 */
import { completeSimple } from '@earendil-works/pi-ai/compat'
import type { ModelSelection } from '../shared/model-config'
import type { TestConnectionResult } from '../shared/connection-test'
import { classifyConnectionError } from '../shared/connection-test'
import { resolveModel } from './model-registry'
import { applyProxyFromEnv } from './proxy'

interface ParentPort {
  postMessage(message: unknown): void
  on(event: 'message', listener: (event: { data: unknown }) => void): void
}

const parentPort = (process as unknown as { parentPort?: ParentPort }).parentPort

function respond(result: TestConnectionResult): void {
  parentPort?.postMessage({ type: 'test-result', result })
  setTimeout(() => process.exit(0), 60)
}

function configError(provider: string, model: string, message: string): TestConnectionResult {
  return {
    ok: false,
    provider,
    model,
    latencyMs: 0,
    error: message,
    category: 'config',
  }
}

async function main(): Promise<void> {
  const raw = process.env.NOVEL_STUDIO_TEST_CONFIG
  if (!raw) {
    respond(configError('', '', '缺少测试配置'))
    return
  }
  let parsed: { selection?: ModelSelection; apiKey?: string }
  try {
    parsed = JSON.parse(raw) as { selection?: ModelSelection; apiKey?: string }
  } catch {
    respond(configError('', '', '测试配置无法解析'))
    return
  }
  const selection = parsed.selection
  if (!selection?.provider || !selection.model) {
    respond(configError('', '', '还没有选择模型'))
    return
  }
  const provider = selection.providerConfig?.id ?? selection.provider
  const modelName = selection.model
  if (!parsed.apiKey) {
    respond(configError(provider, modelName, '还没有配置 API Key'))
    return
  }
  applyProxyFromEnv()
  const model = resolveModel(selection)
  if (!model) {
    respond(configError(provider, modelName, `模型不可用：${provider}/${modelName}`))
    return
  }

  const started = Date.now()
  try {
    await completeSimple(
      model as never,
      { messages: [{ role: 'user', content: 'ping', timestamp: Date.now() }] } as never,
      { apiKey: parsed.apiKey, maxTokens: 8 } as never,
    )
    respond({
      ok: true,
      provider,
      model: modelName,
      latencyMs: Date.now() - started,
    })
  } catch (err) {
    const message = (err as Error).message || String(err)
    const category = classifyConnectionError(message)
    respond({
      ok: false,
      provider,
      model: modelName,
      latencyMs: Date.now() - started,
      error: message.slice(0, 400),
      category,
    })
  }
}

void main()

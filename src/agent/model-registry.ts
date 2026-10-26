/**
 * 模型注册表：借 pi-ai 的 compat 目录（getModel）+ 自定义 provider 兜底。
 *
 * 说明：compat 入口被 pi 标记为「临时兼容层」，未来会被 ModelManager 取代；
 * 所以这里收敛成唯一适配点，将来只需替换本文件，不影响 Agent 与 UI。
 */
import { getModel, streamSimple } from '@earendil-works/pi-ai/compat'
import type { CustomProviderConfig, ModelSelection } from '../shared/model-config'

/** pi 的模型对象是纯数据；自定义 provider 按 s-loop 的做法拼一个同构对象 */
export function createCustomModel(providerId: string, modelId: string, config: CustomProviderConfig) {
  return {
    id: modelId,
    name: modelId,
    api: config.api || 'openai-completions',
    provider: providerId,
    baseUrl: config.baseUrl || '',
    reasoning: Boolean(config.reasoning),
    input: config.supportsVision ? ['text', 'image'] : ['text'],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: Number(config.contextWindow) > 0 ? Number(config.contextWindow) : 128000,
    contextLength: Number(config.contextWindow) > 0 ? Number(config.contextWindow) : 128000,
    maxTokens: Number(config.maxTokens) > 0 ? Number(config.maxTokens) : 131072,
  }
}

/** 解析出要用的模型：内置目录优先，其次自定义 provider */
export function resolveModel(selection: ModelSelection): unknown | null {
  // provider 在类型上是内置 provider 的联合类型；自定义 provider 运行时才出现，故收窄为 never
  const builtIn = getModel(selection.provider as never, selection.model)
  if (builtIn) return builtIn
  const config = selection.providerConfig
  if (config && (config.baseUrl || config.api)) {
    return createCustomModel(selection.provider, selection.model, config)
  }
  return null
}

/** compat 的全局 stream 实现：按 model.api 懒加载对应 SDK */
export const defaultStreamFn = streamSimple

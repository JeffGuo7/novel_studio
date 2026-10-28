/**
 * 连接测试与代理设置的纯函数（main / host / renderer 共用，可直接单测）。
 */
export type ConnectionErrorCategory = 'auth' | 'network' | 'model' | 'config' | 'unknown'

export interface TestConnectionResult {
  ok: boolean
  provider: string
  model: string
  latencyMs: number
  error?: string
  category?: ConnectionErrorCategory
}

/** 允许留空；支持 http(s)://host:port 或 host:port，统一补 http:// */
export function normalizeProxyUrl(value: string | undefined | null): string {
  const trimmed = (value ?? '').trim()
  if (!trimmed) return ''
  if (/^https?:\/\//i.test(trimmed)) return trimmed
  return `http://${trimmed}`
}

/** 把错误文本归类，供设置页给出可操作提示 */
export function classifyConnectionError(message: string): ConnectionErrorCategory {
  const text = message.toLowerCase()
  if (/not configured|missing|缺少|未配置/.test(text)) return 'config'
  if (/401|403|unauthorized|forbidden|invalid api key|authentication|api key/.test(text)) {
    return 'auth'
  }
  if (/404|not found|does not exist|unknown model|model.*not (found|available)|no such model/.test(text)) {
    return 'model'
  }
  if (/enotfound|econnrefused|econnreset|etimedout|timed? ?out|network|fetch failed|socket|tls|certificate|proxy/.test(text)) {
    return 'network'
  }
  return 'unknown'
}

export function connectionErrorMessage(category: ConnectionErrorCategory): string {
  switch (category) {
    case 'auth':
      return '鉴权失败：请检查 API Key 是否正确、是否有该模型的权限'
    case 'network':
      return '网络不通：检查代理设置、网络连接，或供应商服务是否可用'
    case 'model':
      return '模型不可用：该模型可能已下线或当前账号无权访问，换一个模型试试'
    case 'config':
      return '配置不完整：请选择模型并填写 API Key'
    default:
      return '连接失败：请检查模型配置或稍后重试'
  }
}

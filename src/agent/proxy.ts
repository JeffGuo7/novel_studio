/**
 * 在 utilityProcess 里为 Node fetch/undici 设置代理。
 * 代理来自主进程注入的 NOVEL_STUDIO_PROXY（设置页配置），留空则不干预。
 */
import { ProxyAgent, setGlobalDispatcher } from 'undici'
import { normalizeProxyUrl } from '../shared/connection-test'

export function applyProxyFromEnv(): string {
  const proxyUrl = normalizeProxyUrl(process.env.NOVEL_STUDIO_PROXY)
  if (!proxyUrl) return ''
  try {
    setGlobalDispatcher(new ProxyAgent(proxyUrl))
    return proxyUrl
  } catch {
    return ''
  }
}

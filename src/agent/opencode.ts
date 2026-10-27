/**
 * OpenCode（Zen / Go）接入适配。
 *
 * 背景：OpenCode Go 的推理接口除了 Bearer token，还要求
 * `x-opencode-session`（每次对话稳定）与自定义 User-Agent；缺少 session 头时返回
 * 400 MissingSessionID。pi 的 compat 入口（我们用的 streamSimple）不走它的
 * opencode provider 包装器，所以需要在这里补头。
 */

const OPENCODE_HOST = 'opencode.ai'

interface ModelLike {
  provider?: string
  baseUrl?: string
}

/** 判断某个模型是否走 OpenCode 推理端点（内置 provider 或自定义 baseUrl） */
export function isOpenCodeModel(model: unknown): boolean {
  if (!model || typeof model !== 'object') return false
  const candidate = model as ModelLike
  if (candidate.provider === 'opencode' || candidate.provider === 'opencode-go') return true
  return typeof candidate.baseUrl === 'string' && candidate.baseUrl.includes(OPENCODE_HOST)
}

export interface OpenCodeRequestOptions {
  headers?: Record<string, string>
  [key: string]: unknown
}

/**
 * 给 stream/streamSimple 包一层：注入 OpenCode 需要的路由头。
 * 保留调用方已有的 headers，并允许调用方覆盖（比如测试或未来的 beta 头）。
 */
export function withOpenCodeHeaders(
  streamFn: (
    model: unknown,
    context: unknown,
    options?: OpenCodeRequestOptions,
  ) => unknown,
  sessionId: string,
  userAgent = 'NovelStudio',
): typeof streamFn {
  return (model, context, options = {}) =>
    streamFn(model, context, {
      ...options,
      headers: {
        ...options.headers,
        'x-opencode-session': sessionId,
        'User-Agent': userAgent,
      },
    })
}

/** 会话 id 只允许安全字符，避免 URL/日志里出问题 */
export function normalizeOpenCodeSessionId(value: unknown): string | null {
  if (typeof value !== 'string') return null
  const trimmed = value.trim()
  if (!/^[A-Za-z0-9._:-]{8,128}$/.test(trimmed)) return null
  return trimmed
}

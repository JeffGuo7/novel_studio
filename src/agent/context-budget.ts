/**
 * 上下文预算：上下限完全由「模型自身」的 contextWindow / maxTokens 推导，不再写死字符数。
 *
 * pi 已经提供：
 * - 输出侧 `clampMaxTokensToContext()` / `buildBaseOptions()`（streamSimple 内部会按
 *   contextWindow 夹 maxTokens，并预留 4096 safety tokens）；
 * - 输入侧没有自动裁剪，官方扩展点是 Agent 的 `transformContext` 钩子。
 *
 * 本模块负责输入侧：
 * 1. 用 pi 的 `estimateTextTokens()` 做基准，但对中文做保守修正（中文 token/字符比更低）；
 * 2. 从模型元数据推导 inputBudget / packBudget / historyBudget；
 * 3. 给 buildContextPack 分配各小节字符上限；
 * 4. 按预算裁剪历史消息（保留 user 边界与 toolCall/toolResult 配对）。
 */
import { estimateTextTokens } from '@earendil-works/pi-ai/utils/estimate'

export interface ModelBudget {
  /** 模型上下文窗口（tokens） */
  contextWindow: number
  /** 单次输出上限（tokens），来自 model.maxTokens 或按窗口推算 */
  maxOutputTokens: number
  /** 预留给 tokenizer 误差/工具 schema 的安全区 */
  safetyTokens: number
  /** 允许用于「输入」的 tokens 上限 */
  inputBudgetTokens: number
  /** 一次 read_context 上下文包允许的 tokens */
  packBudgetTokens: number
  /** 历史对话允许的 tokens */
  historyBudgetTokens: number
}

/** 上下文包里各小节允许的字符数 */
export interface ContextPackLimits {
  world: number
  status: number
  summary: number
  outline: number
  style: number
  fingerprint: number
  current: number
  previous: number
}

export const DEFAULT_CONTEXT_WINDOW = 128_000
/** 和 pi 的 CONTEXT_SAFETY_TOKENS 保持一致，另外给中文估算误差留一点 */
export const CONTEXT_SAFETY_TOKENS = 6_144

/** 保守的中文 token 估算：CJK 按 1.6 字/token，其余按 4 字/token */
export function estimateTokensCjkAware(text: string): number {
  if (!text) return 0
  let cjk = 0
  let other = 0
  for (const char of text) {
    if (/[\u2e80-\u9fff\uf900-\ufaff\u3000-\u303f\uff00-\uffef]/.test(char)) cjk += 1
    else other += 1
  }
  return Math.ceil(cjk / 1.6 + other / 4)
}

/**
 * 通用 token 估算：取「pi 官方估算」与「中文保守估算」的较大者。
 * pi 的常量是 3.5 字符/token，对中文会低估，所以这里取 max 保证不溢出。
 */
export function estimateTokens(text: string): number {
  return Math.max(estimateTextTokens(text), estimateTokensCjkAware(text))
}

function estimateJsonTokens(value: unknown): number {
  try {
    return estimateTokens(JSON.stringify(value) ?? '')
  } catch {
    return 0
  }
}

/** 估算消息数组（pi AgentMessage / LLM Message 都能吃） */
export function estimateMessagesTokens(messages: unknown[]): number {
  let total = 0
  for (const raw of messages) {
    if (!raw || typeof raw !== 'object') continue
    const message = raw as { role?: string; content?: unknown; toolName?: string; name?: string }
    total += 4 // 每条消息的 role / 分隔开销
    const content = message.content
    if (typeof content === 'string') {
      total += estimateTokens(content)
      continue
    }
    if (!Array.isArray(content)) continue
    for (const block of content) {
      if (!block || typeof block !== 'object') continue
      const item = block as { type?: string; text?: string; thinking?: string; name?: string; arguments?: unknown; content?: unknown }
      switch (item.type) {
        case 'text':
          total += estimateTokens(String(item.text ?? ''))
          break
        case 'thinking':
          total += estimateTokens(String(item.thinking ?? ''))
          break
        case 'toolCall':
          total += estimateTokens(String(item.name ?? '')) + estimateJsonTokens(item.arguments)
          break
        case 'image':
          total += 1_600
          break
        default:
          if (item.content) total += estimateMessagesTokens([{ content: item.content }])
          break
      }
    }
  }
  return total
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value))
}

/** 根据模型元数据推导上下文预算（这是唯一的"上下限来源"） */
export function resolveModelBudget(model: {
  contextWindow?: number
  maxTokens?: number
} | null | undefined): ModelBudget {
  const contextWindow =
    model && typeof model.contextWindow === 'number' && model.contextWindow > 0
      ? Math.floor(model.contextWindow)
      : DEFAULT_CONTEXT_WINDOW

  const maxOutputTokens =
    model && typeof model.maxTokens === 'number' && model.maxTokens > 0
      ? Math.min(Math.floor(model.maxTokens), Math.floor(contextWindow * 0.5))
      : clamp(Math.floor(contextWindow * 0.1), 2_048, 16_384)

  const safetyTokens = Math.max(CONTEXT_SAFETY_TOKENS, Math.floor(contextWindow * 0.02))
  const inputBudgetTokens = Math.max(2_048, contextWindow - maxOutputTokens - safetyTokens)

  // 上下文包只占输入预算的一部分：它是一次工具结果，后面还会继续对话
  const packBudgetTokens = clamp(Math.floor(inputBudgetTokens * 0.32), 1_200, 24_000)
  // 历史对话保留的部分；剩余留给系统提示、工具结果和 Q&A
  const historyBudgetTokens = clamp(Math.floor(inputBudgetTokens * 0.45), 1_500, 120_000)

  return {
    contextWindow,
    maxOutputTokens,
    safetyTokens,
    inputBudgetTokens,
    packBudgetTokens,
    historyBudgetTokens,
  }
}

const PACK_WEIGHTS = {
  world: 0.18,
  status: 0.1,
  summary: 0.14,
  outline: 0.18,
  style: 0.1,
  fingerprint: 0.06,
  current: 0.14,
  previous: 0.1,
} as const

const PACK_MIN_CHARS = {
  world: 240,
  status: 160,
  summary: 200,
  outline: 240,
  style: 140,
  fingerprint: 100,
  current: 300,
  previous: 300,
} as const

/**
 * 把 packBudgetTokens 换算成各小节字符上限。
 * 中文按 1.6 字/token 保守换算；模型窗口越大，上下文包越大。
 */
export function contextPackLimitsForBudget(budget: ModelBudget): ContextPackLimits {
  const packChars = Math.floor(budget.packBudgetTokens * 1.6)
  const limits = {} as ContextPackLimits
  let remaining = packChars
  const keys = Object.keys(PACK_WEIGHTS) as Array<keyof ContextPackLimits>
  for (const key of keys) {
    const allocated = Math.max(PACK_MIN_CHARS[key], Math.floor(packChars * PACK_WEIGHTS[key]))
    const value = Math.min(allocated, Math.max(PACK_MIN_CHARS[key], remaining))
    limits[key] = value
    remaining -= value
  }
  return limits
}

export const DEFAULT_PACK_LIMITS: ContextPackLimits = contextPackLimitsForBudget(resolveModelBudget(null))

export interface TrimResult {
  messages: unknown[]
  estimatedTokens: number
  trimmed: boolean
}

function isToolResult(message: { role?: string }): boolean {
  return message?.role === 'toolResult'
}

function isToolCallAssistant(message: { role?: string; content?: unknown }): boolean {
  if (message?.role !== 'assistant' || !Array.isArray(message.content)) return false
  return message.content.some((block) => (block as { type?: string })?.type === 'toolCall')
}

/**
 * 按 token 预算裁剪历史消息：
 * - system 消息永远保留；
 * - 裁剪起点落在 user 消息上，不拆散 toolCall/toolResult；
 * - 预算极小时至少保留最后一条 user 及其之后的消息。
 */
export function trimMessagesToBudget(messages: unknown[], budgetTokens: number): TrimResult {
  if (messages.length === 0) return { messages: [], estimatedTokens: 0, trimmed: false }

  const budget = Math.max(256, budgetTokens)
  const kept: unknown[] = []
  let used = 0
  let index = messages.length - 1

  while (index >= 0) {
    const message = messages[index] as { role?: string; content?: unknown }
    // system 单独处理，不参与这个循环（通常只有一条且在开头）
    if (message?.role === 'system') {
      index -= 1
      continue
    }
    const cost = estimateMessagesTokens([message])
    if (used + cost > budget) break

    // toolResult 必须和承载它的 assistant toolCall 一起保留，否则模型会拒收
    if (isToolResult(message)) {
      const previous = messages[index - 1] as { role?: string; content?: unknown } | undefined
      if (!previous || !isToolCallAssistant(previous)) break
      const pairCost = estimateMessagesTokens([previous])
      if (used + cost + pairCost > budget) break
      // unshift 顺序：先放 toolResult，再放 assistant，保证 assistant 在前
      kept.unshift(message)
      kept.unshift(previous)
      used += cost + pairCost
      index -= 2
      continue
    }

    kept.unshift(message)
    used += cost
    index -= 1
  }

  // 预算极小、一条都没放下时：至少保留最后一条 user 及其之后的消息
  if (kept.length === 0) {
    let lastUser = -1
    for (let i = messages.length - 1; i >= 0; i -= 1) {
      if ((messages[i] as { role?: string })?.role === 'user') {
        lastUser = i
        break
      }
    }
    if (lastUser >= 0) kept.push(...messages.slice(lastUser))
  }

  const systems = messages.filter(
    (message) => (message as { role?: string })?.role === 'system',
  )
  // 把开头的 system 前缀补回来（消息顺序：system 在最前）
  const leadingSystem: unknown[] = []
  for (const message of messages) {
    if ((message as { role?: string })?.role !== 'system') break
    leadingSystem.push(message)
  }
  void systems

  // 找到预算内的最早 user 边界，避免历史从 assistant 中间开始
  let cut = 0
  while (cut < kept.length && (kept[cut] as { role?: string })?.role !== 'user') cut += 1
  const sliced = cut < kept.length ? kept.slice(cut) : kept
  const finalMessages = [...leadingSystem, ...sliced]
  return {
    messages: finalMessages,
    estimatedTokens: estimateMessagesTokens(finalMessages),
    trimmed: finalMessages.length < messages.length,
  }
}

/** 裁剪单条超长消息（工具结果、整章正文），保留标记 */
export function truncateLongValues(messages: unknown[], maxChars = 6_000): unknown[] {
  return messages.map((raw) => {
    if (!raw || typeof raw !== 'object') return raw
    const message = raw as { content?: unknown }
    if (!Array.isArray(message.content)) return raw
    const content = message.content.map((block) => {
      if (!block || typeof block !== 'object') return block
      const item = block as { type?: string; text?: string; content?: unknown }
      if (item.type === 'text' && typeof item.text === 'string' && item.text.length > maxChars) {
        return { ...item, text: `${item.text.slice(0, maxChars)}\n\n…（已按模型上下文预算截断）` }
      }
      if (item.type === 'toolResult' && typeof item.content === 'string' && item.content.length > maxChars) {
        return { ...item, content: `${item.content.slice(0, maxChars)}\n\n…（已截断）` }
      }
      return item
    })
    return { ...message, content }
  })
}

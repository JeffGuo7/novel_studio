/**
 * Agent Host：跑在 Electron utilityProcess 里的 pi 运行时。
 * 职责：模型调用、工具执行、事件上报、会话持久化与成本熔断。
 *
 * 与主进程的协议（process.parentPort）：
 *   接收：{ type: 'prompt' | 'steer' | 'abort' | 'reset', text? }
 *   发送：{ type: 'ready', info } | { type: 'event', event } | { type: 'fatal', message }
 *
 * 运行时配置通过环境变量 NOVEL_STUDIO_RUNTIME_CONFIG 传入（JSON，含密钥）。
 */
import { setDefaultStreamFn } from '@earendil-works/pi-agent-core'
import crypto from 'node:crypto'
import { nextChapterKey } from '../core'
import type { AgentEvent, AgentInitInfo, AgentInbound } from '../shared/agent'
import type { AgentRuntimeConfig } from '../shared/model-config'
import { createNovelAgent } from './create-agent'
import { resolveModelBudget, trimMessagesToBudget } from './context-budget'
import { defaultStreamFn, resolveModel } from './model-registry'
import { isOpenCodeModel, normalizeOpenCodeSessionId, withOpenCodeHeaders } from './opencode'
import { addChapterCost, chapterCostOf, isOverBudget } from './session-state'
import { clearSession, loadSession, saveSession } from './session-store'
import { summarizeToolCall } from './tools'

interface ParentPort {
  postMessage(message: unknown): void
  on(event: 'message', listener: (event: { data: unknown }) => void): void
}

const parentPort = (process as unknown as { parentPort?: ParentPort }).parentPort

// pi 的全局默认 stream（compat 版 streamSimple，按 model.api 懒加载对应实现）
setDefaultStreamFn(defaultStreamFn as never)

function post(message: unknown): void {
  parentPort?.postMessage(message)
}

function emit(event: AgentEvent): void {
  post({ type: 'event', event })
}

function fatal(message: string): void {
  post({ type: 'fatal', message })
  emit({ type: 'status', status: 'error', detail: message })
}

function parseRuntimeConfig(): AgentRuntimeConfig | null {
  const raw = process.env.NOVEL_STUDIO_RUNTIME_CONFIG
  if (!raw) return null
  try {
    const parsed = JSON.parse(raw) as Partial<AgentRuntimeConfig>
    if (!parsed.selection?.provider || !parsed.selection?.model || !parsed.sessionFile) return null
    return {
      selection: parsed.selection,
      apiKey: parsed.apiKey ?? '',
      budgetUsd: Number(parsed.budgetUsd ?? 0) || 0,
      chapterBudgetUsd: Number(parsed.chapterBudgetUsd ?? 0) || 0,
      sessionFile: parsed.sessionFile,
    }
  } catch {
    return null
  }
}

function extractText(message: unknown): string {
  const content = (message as { content?: Array<{ type?: string; text?: string }> })?.content
  if (!Array.isArray(content)) return ''
  return content
    .filter((block) => block?.type === 'text' && typeof block.text === 'string')
    .map((block) => block.text)
    .join('')
}

function mapUsage(message: unknown): { input: number; output: number; cost: number } | undefined {
  const usage = (message as { usage?: Record<string, unknown> })?.usage
  if (!usage) return undefined
  const cost = usage.cost as { total?: number } | undefined
  return {
    input: Number(usage.input ?? 0),
    output: Number(usage.output ?? 0),
    cost: Number(cost?.total ?? 0),
  }
}

async function main(): Promise<void> {
  const bookDir = process.env.NOVEL_STUDIO_BOOK_DIR
  const bookTitle = process.env.NOVEL_STUDIO_BOOK_TITLE || '未命名'

  if (!bookDir) {
    fatal('缺少 NOVEL_STUDIO_BOOK_DIR')
    return
  }

  const runtimeConfig = parseRuntimeConfig()
  if (!runtimeConfig) {
    fatal('缺少运行时配置（NOVEL_STUDIO_RUNTIME_CONFIG）')
    return
  }

  const model = resolveModel(runtimeConfig.selection)
  if (!model) {
    fatal(`模型不可用：${runtimeConfig.selection.provider}/${runtimeConfig.selection.model}`)
    return
  }

  let chapterKey = ''
  try {
    chapterKey = nextChapterKey(bookDir)
  } catch (err) {
    fatal(`读取书库失败：${(err as Error).message}`)
    return
  }

  // ---- 会话恢复 ----
  const session = loadSession(runtimeConfig.sessionFile)
  // OpenCode 要求每次对话带稳定 session id；存在会话文件里，重启后保持不变
  const opencodeSessionId =
    normalizeOpenCodeSessionId(session.opencodeSessionId) ?? crypto.randomUUID()
  const userAgent = `NovelStudio/${process.env.NOVEL_STUDIO_APP_VERSION ?? 'dev'}`
  let sessionCost = session.cost
  let chapterCosts: Record<string, number> = session.chapterCosts
  let activeChapter: string | undefined
  let blockedSession = isOverBudget(sessionCost, runtimeConfig.budgetUsd)
  let blockedChapter: string | undefined

  // 上下文上下限完全来自模型：contextWindow - maxTokens - safety
  const contextBudget = resolveModelBudget(
    model as { contextWindow?: number; maxTokens?: number },
  )
  const restored = trimMessagesToBudget(session.messages, contextBudget.inputBudgetTokens)

  const agent = createNovelAgent({
    bookDir,
    bookTitle,
    model,
    budget: contextBudget,
    ...(isOpenCodeModel(model)
      ? { streamFn: withOpenCodeHeaders(defaultStreamFn as never, opencodeSessionId, userAgent) }
      : {}),
    getApiKey: () => runtimeConfig.apiKey,
    nextChapterKey: chapterKey,
    initialMessages: restored.messages,
  })

  const persist = (): void => {
    saveSession(
      runtimeConfig.sessionFile,
      agent.state.messages,
      sessionCost,
      chapterCosts,
      opencodeSessionId,
      contextBudget.historyBudgetTokens,
    )
  }

  agent.subscribe((event: { type: string; [key: string]: unknown }) => {
    try {
      switch (event.type) {
        case 'agent_start':
          emit({ type: 'status', status: 'thinking' })
          break
        case 'message_update': {
          const update = event.assistantMessageEvent as { type?: string; delta?: string } | undefined
          if (update?.type === 'text_delta' && typeof update.delta === 'string') {
            emit({ type: 'assistant_delta', delta: update.delta })
          }
          break
        }
        case 'message_end': {
          const message = event.message as { role?: string } | undefined
          if (message?.role === 'assistant') {
            emit({ type: 'assistant_done', text: extractText(message) })
            const usage = mapUsage(message)
            if (usage) {
              sessionCost += usage.cost
              chapterCosts = addChapterCost(chapterCosts, activeChapter, usage.cost)
              const chapterCost = chapterCostOf(chapterCosts, activeChapter)
              emit({
                type: 'turn_end',
                usage,
                sessionCost,
                budgetUsd: runtimeConfig.budgetUsd,
                chapterKey: activeChapter,
                chapterCost,
                chapterBudgetUsd: runtimeConfig.chapterBudgetUsd,
              })
              if (!blockedSession && isOverBudget(sessionCost, runtimeConfig.budgetUsd)) {
                blockedSession = true
                emit({
                  type: 'budget_exceeded',
                  scope: 'session',
                  cost: sessionCost,
                  budgetUsd: runtimeConfig.budgetUsd,
                })
              } else if (
                activeChapter &&
                isOverBudget(chapterCost, runtimeConfig.chapterBudgetUsd)
              ) {
                blockedChapter = activeChapter
                emit({
                  type: 'budget_exceeded',
                  scope: 'chapter',
                  cost: chapterCost,
                  budgetUsd: runtimeConfig.chapterBudgetUsd,
                  chapterKey: activeChapter,
                })
              }
            }
          }
          break
        }
        case 'tool_execution_start': {
          const toolName = String(event.toolName ?? '')
          const summary = summarizeToolCall(toolName, event.args)
          emit({ type: 'tool_start', tool: toolName, summary })
          emit({ type: 'status', status: 'tool', detail: summary })
          break
        }
        case 'tool_execution_end': {
          const toolName = String(event.toolName ?? '')
          const isError = Boolean(event.isError)
          emit({ type: 'tool_end', tool: toolName, ok: !isError, summary: toolName })
          if (toolName === 'write_draft' && !isError) {
            emit({ type: 'book_changed', reason: 'draft' })
          }
          break
        }
        case 'agent_end':
          persist()
          if (blockedSession || blockedChapter) agent.abort()
          emit({ type: 'status', status: 'idle' })
          break
        default:
          break
      }
    } catch (err) {
      fatal(`事件转发失败：${(err as Error).message}`)
    }
  })

  parentPort?.on('message', (message) => {
    const data = message.data as AgentInbound
    void (async () => {
      try {
        if (data.type === 'prompt' && data.text) {
          const targetChapter = data.chapterKey || activeChapter
          if (blockedSession) {
            emit({
              type: 'error',
              message: `本会话预算已用完（$${sessionCost.toFixed(4)} / $${runtimeConfig.budgetUsd.toFixed(2)}），请在「本机配置」里调高预算或点「重置」开始新会话。`,
            })
            return
          }
          if (
            targetChapter &&
            isOverBudget(chapterCostOf(chapterCosts, targetChapter), runtimeConfig.chapterBudgetUsd)
          ) {
            blockedChapter = targetChapter
            emit({
              type: 'budget_exceeded',
              scope: 'chapter',
              cost: chapterCostOf(chapterCosts, targetChapter),
              budgetUsd: runtimeConfig.chapterBudgetUsd,
              chapterKey: targetChapter,
            })
            return
          }
          activeChapter = targetChapter
          if (agent.state.isStreaming) {
            agent.steer({ role: 'user', content: data.text, timestamp: Date.now() })
            return
          }
          emit({ type: 'status', status: 'thinking' })
          await agent.prompt(data.text)
          await agent.waitForIdle()
          persist()
        } else if (data.type === 'steer' && data.text) {
          agent.steer({ role: 'user', content: data.text, timestamp: Date.now() })
        } else if (data.type === 'abort') {
          agent.abort()
          persist()
          emit({ type: 'status', status: 'idle' })
        } else if (data.type === 'reset') {
          agent.reset()
          clearSession(runtimeConfig.sessionFile)
          sessionCost = 0
          chapterCosts = {}
          activeChapter = undefined
          blockedSession = false
          blockedChapter = undefined
          emit({ type: 'session_restored', messages: 0, cost: 0 })
          emit({ type: 'status', status: 'idle' })
        }
      } catch (err) {
        emit({ type: 'error', message: (err as Error).message })
        emit({ type: 'status', status: 'error' })
      }
    })()
  })

  const info: AgentInitInfo = {
    model: runtimeConfig.selection.model,
    provider: runtimeConfig.selection.provider,
    bookTitle,
    sessionCost,
    budgetUsd: runtimeConfig.budgetUsd,
    chapterBudgetUsd: runtimeConfig.chapterBudgetUsd,
    chapterCosts,
    restoredMessages: session.messages.length,
    contextWindow: contextBudget.contextWindow,
    maxTokens: contextBudget.maxOutputTokens,
    contextBudgetTokens: contextBudget.inputBudgetTokens,
  }
  post({ type: 'ready', info })
}

process.on('uncaughtException', (err) => {
  fatal(`未捕获异常：${err.message}`)
})
process.on('unhandledRejection', (reason) => {
  fatal(`未处理的 Promise 拒绝：${String(reason)}`)
})

void main().catch((err: Error) => fatal(err.message))

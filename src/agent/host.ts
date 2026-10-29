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
import { completeSimple, isContextOverflow } from '@earendil-works/pi-ai/compat'
import crypto from 'node:crypto'
import { nextChapterKey } from '../core'
import type { AgentEvent, AgentInitInfo, AgentInbound } from '../shared/agent'
import type { AgentRuntimeConfig } from '../shared/model-config'
import { createNovelAgent } from './create-agent'
import {
  applyCompaction,
  buildCompactionPrompt,
  formatMessagesForSummary,
  selectCompactionSplit,
  type CompactionState,
} from './compaction'
import {
  estimateMessagesTokens,
  estimateTokens,
  resolveModelBudget,
} from './context-budget'
import { defaultStreamFn, resolveModel } from './model-registry'
import { decideOverflowRecovery, planFallbackCompaction } from './overflow-recovery'
import { applyProxyFromEnv } from './proxy'
import { isOpenCodeModel, normalizeOpenCodeSessionId, withOpenCodeHeaders } from './opencode'
import { addChapterCost, chapterCostOf, isOverBudget } from './session-state'
import { providerBilling, shouldEnforceBudget } from '../shared/billing'
import { buildModePrompt, normalizeAgentMode, type AgentMode } from '../shared/agent-modes'
import { clearSession, loadSession, saveSession } from './session-store'
import { summarizeToolCall } from './tools'

interface ParentPort {
  postMessage(message: unknown): void
  on(event: 'message', listener: (event: { data: unknown }) => void): void
}

const parentPort = (process as unknown as { parentPort?: ParentPort }).parentPort

// 应用内代理（模型请求走这里配置的 http 代理；留空不干预）
applyProxyFromEnv()

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
  const billing = providerBilling(
    runtimeConfig.selection.providerConfig?.id ?? runtimeConfig.selection.provider,
  )
  const enforceBudget = shouldEnforceBudget(billing)
  let requests = Number(session.requests ?? 0) || 0
  let currentMode: AgentMode = 'free'
  let activeChapter: string | undefined
  let blockedSession = enforceBudget && isOverBudget(sessionCost, runtimeConfig.budgetUsd)
  let blockedChapter: string | undefined
  /** 溢出自动恢复状态：每次用户请求最多恢复一次 */
  let overflowDetected = false
  let overflowRetried = false
  let budgetScale = 1
  /** /compact 状态：摘要 + 覆盖到的消息条数（存在会话文件里） */
  let compaction: CompactionState | null = session.compaction ?? null

  // 上下文上下限完全来自模型：contextWindow - maxTokens - safety
  const contextBudget = resolveModelBudget(
    model as { contextWindow?: number; maxTokens?: number },
  )

  const agent = createNovelAgent({
    bookDir,
    bookTitle,
    model,
    budget: contextBudget,
    getCompaction: () => compaction,
    getBudgetScale: () => budgetScale,
    getMode: () => currentMode,
    ...(isOpenCodeModel(model)
      ? { streamFn: withOpenCodeHeaders(defaultStreamFn as never, opencodeSessionId, userAgent) }
      : {}),
    getApiKey: () => runtimeConfig.apiKey,
    nextChapterKey: chapterKey,
    initialMessages: session.messages,
  })

  const persist = (): void => {
    saveSession(
      runtimeConfig.sessionFile,
      agent.state.messages,
      sessionCost,
      chapterCosts,
      opencodeSessionId,
      contextBudget.historyBudgetTokens,
      compaction,
      requests,
    )
  }

  /** 压缩用的单次模型调用（不经过 Agent 循环） */
  const completeOnce = async (prompt: string): Promise<string> => {
    const message = await completeSimple(
      model as never,
      { messages: [{ role: 'user', content: prompt, timestamp: Date.now() }] } as never,
      {
        apiKey: runtimeConfig.apiKey,
        ...(isOpenCodeModel(model)
          ? {
              headers: {
                'x-opencode-session': opencodeSessionId,
                'User-Agent': userAgent,
              },
            }
          : {}),
      } as never,
    )
    const content = (message as { content?: Array<{ type?: string; text?: string }> }).content
    return (content ?? [])
      .filter((block) => block?.type === 'text' && typeof block.text === 'string')
      .map((block) => block.text ?? '')
      .join('')
      .trim()
  }

  let compacting = false
  /** 手动 /compact：把较早的轮次压成摘要，只影响发给模型的上下文 */
  const runCompaction = async (): Promise<void> => {
    if (compacting) return
    compacting = true
    emit({ type: 'compaction_started' })
    try {
      const messages = agent.state.messages as unknown[]
      let systemCount = 0
      while (
        systemCount < messages.length &&
        (messages[systemCount] as { role?: string })?.role === 'system'
      ) {
        systemCount += 1
      }
      const start = Math.max(compaction?.coveredMessages ?? 0, systemCount)
      const keepBudget = Math.min(
        Math.floor(contextBudget.historyBudgetTokens * 0.6),
        8_000,
      )
      const split = selectCompactionSplit(messages.slice(start), keepBudget, estimateTokens)
      if (split < 0) {
        emit({ type: 'error', message: '没有可压缩的历史对话（最近的对话需要保留原文）' })
        return
      }
      const covered = start + split
      const transcript = formatMessagesForSummary(messages.slice(start, covered))
      if (!transcript.trim()) {
        emit({ type: 'error', message: '没有可压缩的历史对话' })
        return
      }
      const tokensBefore = estimateMessagesTokens(messages)
      const summary = await completeOnce(
        buildCompactionPrompt({
          bookTitle,
          transcript,
          previousSummary: compaction?.summary,
        }),
      )
      if (!summary.trim()) throw new Error('模型没有返回摘要，请重试')
      compaction = {
        summary: summary.trim(),
        coveredMessages: covered,
        createdAt: new Date().toISOString(),
      }
      const tokensAfter = estimateMessagesTokens(applyCompaction(messages, compaction))
      persist()
      emit({
        type: 'compaction_done',
        coveredMessages: covered,
        summaryChars: compaction.summary.length,
        tokensBefore,
        tokensAfter,
      })
      emit({ type: 'status', status: 'idle' })
    } catch (err) {
      emit({ type: 'error', message: `压缩失败：${(err as Error).message}` })
      emit({ type: 'status', status: 'error' })
    } finally {
      compacting = false
    }
  }

  /**
   * 发一轮消息；如果遇到上下文超限，自动做一次保底压缩（不调用模型）+ 降低预算 + 重试一次。
   * 这样即使 token 估算偏保守也不会直接报错给作者。
   */
  const promptWithOverflowRecovery = async (text: string): Promise<void> => {
    overflowDetected = false
    overflowRetried = false
    const before = agent.state.messages.length
    await agent.prompt(text)
    if (!overflowDetected) return

    const decision = decideOverflowRecovery({
      overflowDetected,
      alreadyRetried: overflowRetried,
      canCompact: agent.state.messages.length > 1,
    })
    if (decision.action !== 'compact-and-retry') {
      emit({ type: 'context_overflow', stage: 'failed', message: decision.reason })
      throw new Error(decision.reason ?? '上下文超出模型限制')
    }

    overflowRetried = true
    emit({ type: 'context_overflow', stage: 'detected' })
    // 去掉这次失败新增的 user/assistant/toolResult 尾巴，避免重试时重复
    agent.state.messages = agent.state.messages.slice(0, before) as never
    const plan = planFallbackCompaction(agent.state.messages as never, 4)
    if (!plan) {
      const reason = '上下文超限且没有可压缩的历史消息，请缩短输入或更换大上下文模型'
      emit({ type: 'context_overflow', stage: 'failed', message: reason })
      throw new Error(reason)
    }
    compaction = {
      summary: plan.summary,
      coveredMessages: plan.coveredMessages,
      createdAt: new Date().toISOString(),
    }
    budgetScale = 0.7
    persist()
    emit({
      type: 'context_overflow',
      stage: 'retrying',
      message: `已折叠 ${plan.coveredMessages} 条早期消息并缩小上下文预算，正在重试`,
    })

    overflowDetected = false
    await agent.prompt(text)
    if (overflowDetected) {
      const reason = '自动压缩后仍然超出模型上下文，请手动 /compact 或更换更大上下文的模型'
      emit({ type: 'context_overflow', stage: 'failed', message: reason })
      throw new Error(reason)
    }
    emit({ type: 'context_overflow', stage: 'recovered' })
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
            if (isContextOverflow(message as never, contextBudget.contextWindow)) {
              overflowDetected = true
            }
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
                billing,
                requests,
              })
              if (enforceBudget && !blockedSession && isOverBudget(sessionCost, runtimeConfig.budgetUsd)) {
                blockedSession = true
                emit({
                  type: 'budget_exceeded',
                  scope: 'session',
                  cost: sessionCost,
                  budgetUsd: runtimeConfig.budgetUsd,
                })
              } else if (
                enforceBudget &&
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
          if (toolName === 'propose_knowledge' && !isError) {
            emit({ type: 'book_changed', reason: 'proposal' })
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
          if (enforceBudget && blockedSession) {
            emit({
              type: 'error',
              message: `本会话预算已用完（$${sessionCost.toFixed(4)} / $${runtimeConfig.budgetUsd.toFixed(2)}），请在「本机配置」里调高预算或点「重置」开始新会话。`,
            })
            return
          }
          if (
            enforceBudget &&
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
          requests += 1
          currentMode = normalizeAgentMode(data.mode)
          emit({ type: 'status', status: 'thinking' })
          await promptWithOverflowRecovery(buildModePrompt(data.text, currentMode))
          await agent.waitForIdle()
          persist()
        } else if (data.type === 'steer' && data.text) {
          agent.steer({ role: 'user', content: data.text, timestamp: Date.now() })
        } else if (data.type === 'abort') {
          agent.abort()
          persist()
          emit({ type: 'status', status: 'idle' })
        } else if (data.type === 'compact') {
          await runCompaction()
        } else if (data.type === 'reset') {
          agent.reset()
          clearSession(runtimeConfig.sessionFile)
          sessionCost = 0
          chapterCosts = {}
          requests = 0
          activeChapter = undefined
          blockedSession = false
          blockedChapter = undefined
          compaction = null
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
    billing,
    requests,
    ...(compaction && compaction.coveredMessages > 0
      ? { compaction: { coveredMessages: compaction.coveredMessages, summaryChars: compaction.summary.length } }
      : {}),
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

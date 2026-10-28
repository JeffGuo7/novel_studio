/**
 * 知识库初始化 Host：跑在 utilityProcess 里，做分块蒸馏 + 合并 + 写盘。
 * 与主进程协议：
 *   接收：{ type: 'cancel' }
 *   发送：{ type: 'event', event: PipelineEvent } | { type: 'fatal', message }
 */
import { completeSimple } from '@earendil-works/pi-ai/compat'
import type { AssistantMessage } from '@earendil-works/pi-ai'
import crypto from 'node:crypto'
import type { AgentRuntimeConfig } from '../shared/model-config'
import type { PipelineEvent, PipelineReport } from '../shared/pipeline'
import { resolveModel } from '../agent/model-registry'
import { isOpenCodeModel } from '../agent/opencode'
import { applyProxyFromEnv } from '../agent/proxy'
import { loadPipelineChapters, planKnowledgeUpdate, runKnowledgeInit } from './knowledge'
import { runOutline } from './outline'
import { runConsistencyReview, writeReviewReport } from './review'

interface ParentPort {
  postMessage(message: unknown): void
  on(event: 'message', listener: (event: { data: unknown }) => void): void
}

applyProxyFromEnv()

const parentPort = (process as unknown as { parentPort?: ParentPort }).parentPort

function post(message: unknown): void {
  parentPort?.postMessage(message)
}

function emit(event: PipelineEvent): void {
  post({ type: 'event', event })
}

function fatal(message: string): void {
  post({ type: 'fatal', message })
  emit({ type: 'error', message })
}

function parseRuntimeConfig(): AgentRuntimeConfig | null {
  try {
    const raw = process.env.NOVEL_STUDIO_RUNTIME_CONFIG
    if (!raw) return null
    const parsed = JSON.parse(raw) as Partial<AgentRuntimeConfig>
    if (!parsed.selection?.provider || !parsed.selection?.model) return null
    return {
      selection: parsed.selection,
      apiKey: parsed.apiKey ?? '',
      budgetUsd: Number(parsed.budgetUsd ?? 0) || 0,
      chapterBudgetUsd: Number(parsed.chapterBudgetUsd ?? 0) || 0,
      sessionFile: parsed.sessionFile ?? '',
    }
  } catch {
    return null
  }
}

function extractText(message: AssistantMessage): string {
  const content = (message as { content?: Array<{ type?: string; text?: string }> }).content
  if (!Array.isArray(content)) return ''
  return content
    .filter((block) => block?.type === 'text' && typeof block.text === 'string')
    .map((block) => block.text ?? '')
    .join('')
    .trim()
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
    fatal('缺少运行时配置')
    return
  }
  const model = resolveModel(runtimeConfig.selection)
  if (!model) {
    fatal(`模型不可用：${runtimeConfig.selection.provider}/${runtimeConfig.selection.model}`)
    return
  }

  const requestedMode = process.env.NOVEL_STUDIO_PIPELINE_MODE
  const mode =
    requestedMode === 'outline' ? 'outline' : requestedMode === 'review' ? 'review' : 'knowledge'
  if (mode === 'outline') {
    const premise = process.env.NOVEL_STUDIO_OUTLINE_PREMISE ?? ''
    const volumes = Number(process.env.NOVEL_STUDIO_OUTLINE_VOLUMES ?? 3)
    const opencodeSessionId = crypto.randomUUID()
    const opencodeHeaders = isOpenCodeModel(model)
      ? {
          'x-opencode-session': opencodeSessionId,
          'User-Agent': `NovelStudio/${process.env.NOVEL_STUDIO_APP_VERSION ?? 'dev'}`,
        }
      : undefined
    const complete = async (prompt: string): Promise<{ text: string; cost: number; input: number; output: number }> => {
      const message = await completeSimple(
        model as never,
        { messages: [{ role: 'user', content: prompt, timestamp: Date.now() }] } as never,
        {
          apiKey: runtimeConfig.apiKey,
          ...(opencodeHeaders ? { headers: opencodeHeaders } : {}),
        } as never,
      )
      const usage = (message as { usage?: { input?: number; output?: number; cost?: { total?: number } } }).usage
      return {
        text: extractText(message),
        cost: Number(usage?.cost?.total ?? 0),
        input: Number(usage?.input ?? 0),
        output: Number(usage?.output ?? 0),
      }
    }
    const result = await runOutline(
      { bookDir, bookTitle, premise, volumes },
      { complete, onProgress: (message) => emit({ type: 'outline_progress', message }) },
    )
    emit({
      type: 'outline_done',
      proposals: result.proposals.map((proposal) => ({
        id: proposal.id,
        targetPath: proposal.targetPath,
        targetTitle: proposal.targetTitle,
      })),
      cost: result.cost,
      inputTokens: result.inputTokens,
      outputTokens: result.outputTokens,
    })
    return
  }

  if (mode === 'review') {
    const opencodeSessionId = crypto.randomUUID()
    const opencodeHeaders = isOpenCodeModel(model)
      ? {
          'x-opencode-session': opencodeSessionId,
          'User-Agent': `NovelStudio/${process.env.NOVEL_STUDIO_APP_VERSION ?? 'dev'}`,
        }
      : undefined
    const complete = async (prompt: string): Promise<{ text: string; cost: number; input: number; output: number }> => {
      const message = await completeSimple(
        model as never,
        { messages: [{ role: 'user', content: prompt, timestamp: Date.now() }] } as never,
        {
          apiKey: runtimeConfig.apiKey,
          ...(opencodeHeaders ? { headers: opencodeHeaders } : {}),
        } as never,
      )
      const usage = (message as { usage?: { input?: number; output?: number; cost?: { total?: number } } }).usage
      return {
        text: extractText(message),
        cost: Number(usage?.cost?.total ?? 0),
        input: Number(usage?.input ?? 0),
        output: Number(usage?.output ?? 0),
      }
    }
    const fromChapter = Number(process.env.NOVEL_STUDIO_REVIEW_FROM ?? '')
    const toChapter = Number(process.env.NOVEL_STUDIO_REVIEW_TO ?? '')
    const result = await runConsistencyReview(
      {
        bookDir,
        bookTitle,
        ...(Number.isFinite(fromChapter) && fromChapter > 0 ? { fromChapter } : {}),
        ...(Number.isFinite(toChapter) && toChapter > 0 ? { toChapter } : {}),
        focus: process.env.NOVEL_STUDIO_REVIEW_FOCUS ?? '',
      },
      {
        complete,
        onProgress: (message) => emit({ type: 'review_progress', message }),
      },
    )
    const reportPath = writeReviewReport(bookDir, result.reportMarkdown)
    const { reportMarkdown: _reportMarkdown, ...summary } = result
    emit({ type: 'review_done', report: { ...summary, reportPath } })
    return
  }
  const chapters = loadPipelineChapters(bookDir)
  const plan = planKnowledgeUpdate(bookDir)
  emit({ type: 'started', plan })

  // OpenCode 的推理端点要求每次对话带 x-opencode-session：知识库一次运行算一次对话
  const opencodeSessionId = crypto.randomUUID()
  const opencodeHeaders = isOpenCodeModel(model)
    ? {
        'x-opencode-session': opencodeSessionId,
        'User-Agent': `NovelStudio/${process.env.NOVEL_STUDIO_APP_VERSION ?? 'dev'}`,
      }
    : undefined

  let cancelled = false
  parentPort?.on('message', (message) => {
    const data = message.data as { type?: string }
    if (data?.type === 'cancel') cancelled = true
  })

  const complete = async (prompt: string): Promise<{ text: string; cost: number; input: number; output: number }> => {
    if (cancelled) throw new Error('已取消')
    const message = await completeSimple(
      model as never,
      {
        messages: [{ role: 'user', content: prompt, timestamp: Date.now() }],
      } as never,
      {
        apiKey: runtimeConfig.apiKey,
        ...(opencodeHeaders ? { headers: opencodeHeaders } : {}),
      } as never,
    )
    if (cancelled) throw new Error('已取消')
    const usage = (message as { usage?: { input?: number; output?: number; cost?: { total?: number } } }).usage
    return {
      text: extractText(message),
      cost: Number(usage?.cost?.total ?? 0),
      input: Number(usage?.input ?? 0),
      output: Number(usage?.output ?? 0),
    }
  }

  const report: PipelineReport = await runKnowledgeInit({
    bookDir,
    bookTitle,
    chapters,
    complete,
    onProgress: (progress) => emit({ type: 'progress', progress }),
  })

  emit({ type: 'done', report })
}

process.on('uncaughtException', (err) => fatal(`未捕获异常：${err.message}`))
process.on('unhandledRejection', (reason) => fatal(`未处理的 Promise 拒绝：${String(reason)}`))

void main().catch((err: Error) => fatal(err.message))

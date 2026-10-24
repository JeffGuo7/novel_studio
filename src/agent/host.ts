/**
 * Agent Host：跑在 Electron utilityProcess 里的 pi 运行时。
 * 职责：模型调用、工具执行、事件上报。不碰窗口、不碰密钥以外的外部状态。
 *
 * 与主进程的协议（process.parentPort）：
 *   接收：{ type: 'prompt' | 'steer' | 'abort' | 'reset', text? }
 *   发送：{ type: 'ready', info } | { type: 'event', event } | { type: 'fatal', message }
 */
import { createModels } from '@earendil-works/pi-ai/models'
import { deepseekProvider } from '@earendil-works/pi-ai/providers/deepseek'
import { nextChapterKey } from '../core'
import type { AgentEvent, AgentInitInfo, AgentInbound } from '../shared/agent'
import { createNovelAgent } from './create-agent'
import { summarizeToolCall } from './tools'

interface ParentPort {
  postMessage(message: unknown): void
  on(event: 'message', listener: (event: { data: unknown }) => void): void
}

const parentPort = (process as unknown as { parentPort?: ParentPort }).parentPort

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
  const providerId = (process.env.NOVEL_STUDIO_PROVIDER || 'deepseek').trim()
  const modelId = (process.env.NOVEL_STUDIO_MODEL || '').trim()

  if (!bookDir) {
    fatal('缺少 NOVEL_STUDIO_BOOK_DIR')
    return
  }

  const models = createModels()
  if (providerId === 'deepseek') {
    models.setProvider(deepseekProvider())
  } else {
    fatal(`暂不支持的 provider：${providerId}`)
    return
  }

  const available = models.getModels(providerId)
  if (available.length === 0) {
    fatal(`provider ${providerId} 没有可用模型`)
    return
  }
  // 默认用便宜的 flash；需要更强模型时通过 NOVEL_STUDIO_MODEL 显式指定
  const PREFERRED_MODEL = 'deepseek-flash'
  const model =
    (modelId && available.find((item) => item.id === modelId)) ||
    available.find((item) => item.id === PREFERRED_MODEL) ||
    available[0]

  let chapterKey = ''
  try {
    chapterKey = nextChapterKey(bookDir)
  } catch (err) {
    fatal(`读取书库失败：${(err as Error).message}`)
    return
  }

  const agent = createNovelAgent({
    bookDir,
    bookTitle,
    model,
    streamFn: models.streamSimple.bind(models),
    nextChapterKey: chapterKey,
  })

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
            if (usage) emit({ type: 'turn_end', usage })
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
          if (agent.state.isStreaming) {
            agent.steer({ role: 'user', content: data.text, timestamp: Date.now() })
            return
          }
          emit({ type: 'status', status: 'thinking' })
          await agent.prompt(data.text)
          await agent.waitForIdle()
        } else if (data.type === 'steer' && data.text) {
          agent.steer({ role: 'user', content: data.text, timestamp: Date.now() })
        } else if (data.type === 'abort') {
          agent.abort()
          emit({ type: 'status', status: 'idle' })
        } else if (data.type === 'reset') {
          agent.reset()
          emit({ type: 'status', status: 'idle' })
        }
      } catch (err) {
        emit({ type: 'error', message: (err as Error).message })
        emit({ type: 'status', status: 'error' })
      }
    })()
  })

  const info: AgentInitInfo = { model: model.id, provider: providerId, bookTitle }
  post({ type: 'ready', info })
}

process.on('uncaughtException', (err) => {
  fatal(`未捕获异常：${err.message}`)
})
process.on('unhandledRejection', (reason) => {
  fatal(`未处理的 Promise 拒绝：${String(reason)}`)
})

void main().catch((err: Error) => fatal(err.message))

import { Agent } from '@earendil-works/pi-agent-core'
import { applyCompaction, type CompactionState } from './compaction'
import { buildSystemPrompt } from './prompt'
import { createNovelTools } from './tools'
import {
  contextPackLimitsForBudget,
  resolveModelBudget,
  trimMessagesToBudget,
  truncateLongValues,
  type ModelBudget,
} from './context-budget'

export interface NovelAgentOptions {
  bookDir: string
  bookTitle: string
  /** pi-ai 的 model 对象（可序列化数据，含 contextWindow / maxTokens） */
  model: unknown
  /** 可选：注入 streamFn（测试用 faux）；不传则用 pi 的全局默认（setDefaultStreamFn） */
  streamFn?: unknown
  /** 动态取密钥；pi 在每次请求前调用，按 provider 取 */
  getApiKey?: (provider: string) => string | undefined | Promise<string | undefined>
  nextChapterKey?: string
  /** 恢复历史会话（pi 的 AgentMessage[]） */
  initialMessages?: unknown[]
  /** 上下文预算；不传则按 model.contextWindow / maxTokens 推导 */
  budget?: ModelBudget
  /** 对话压缩状态提供者；压缩后旧消息用摘要替代 */
  getCompaction?: () => CompactionState | null
}

export function createNovelAgent(options: NovelAgentOptions): Agent {
  const model = options.model as { contextWindow?: number; maxTokens?: number } | null
  const budget = options.budget ?? resolveModelBudget(model)
  const packLimits = contextPackLimitsForBudget(budget)

  const agentOptions: Record<string, unknown> = {
    initialState: {
      systemPrompt: buildSystemPrompt({
        bookTitle: options.bookTitle,
        nextChapterKey: options.nextChapterKey,
      }),
      model: options.model,
      tools: createNovelTools(options.bookDir, { packLimits }),
      ...(options.initialMessages && options.initialMessages.length > 0
        ? { messages: options.initialMessages }
        : {}),
    },
    /**
     * 输入侧上下文预算：每次请求前按「模型 contextWindow」裁剪历史。
     * 这是 pi 官方给裁剪/压缩预留的钩子（AgentOptions.transformContext），
     * 不改变消息格式；后续做滚动摘要时在这里把旧轮次替换成摘要消息即可。
     */
    transformContext: async (messages: unknown[]) => {
      // /compact：先用摘要替换被覆盖的旧消息，再做 token 预算裁剪
      const compacted = applyCompaction(messages, options.getCompaction?.() ?? null)
      const truncated = truncateLongValues(
        compacted,
        Math.max(2_000, Math.floor(budget.packBudgetTokens * 1.6)),
      )
      return trimMessagesToBudget(truncated, budget.inputBudgetTokens).messages
    },
  }
  // streamFn 不传时，由 host 里的 setDefaultStreamFn(pi compat 的 streamSimple) 提供
  if (options.streamFn) agentOptions.streamFn = options.streamFn
  if (options.getApiKey) agentOptions.getApiKey = options.getApiKey
  return new Agent(agentOptions as never)
}

import { Agent } from '@earendil-works/pi-agent-core'
import { buildSystemPrompt } from './prompt'
import { createNovelTools } from './tools'

export interface NovelAgentOptions {
  bookDir: string
  bookTitle: string
  /** pi-ai 的 model 对象（可序列化数据） */
  model: unknown
  /** 可选：注入 streamFn（测试用 faux）；不传则用 pi 的全局默认（setDefaultStreamFn） */
  streamFn?: unknown
  /** 动态取密钥；pi 在每次请求前调用，按 provider 取 */
  getApiKey?: (provider: string) => string | undefined | Promise<string | undefined>
  nextChapterKey?: string
}

export function createNovelAgent(options: NovelAgentOptions): Agent {
  const agentOptions: Record<string, unknown> = {
    initialState: {
      systemPrompt: buildSystemPrompt({
        bookTitle: options.bookTitle,
        nextChapterKey: options.nextChapterKey,
      }),
      model: options.model,
      tools: createNovelTools(options.bookDir),
    },
  }
  // streamFn 不传时，由 host 里的 setDefaultStreamFn(pi compat 的 streamSimple) 提供
  if (options.streamFn) agentOptions.streamFn = options.streamFn
  if (options.getApiKey) agentOptions.getApiKey = options.getApiKey
  return new Agent(agentOptions as never)
}

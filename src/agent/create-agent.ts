import { Agent } from '@earendil-works/pi-agent-core'
import { buildSystemPrompt } from './prompt'
import { createNovelTools } from './tools'

export interface NovelAgentOptions {
  bookDir: string
  bookTitle: string
  /** pi-ai 的 model 对象（可序列化数据） */
  model: unknown
  /** 通常是 models.streamSimple.bind(models)，测试时可注入 faux */
  streamFn: unknown
  nextChapterKey?: string
}

export function createNovelAgent(options: NovelAgentOptions): Agent {
  return new Agent({
    initialState: {
      systemPrompt: buildSystemPrompt({
        bookTitle: options.bookTitle,
        nextChapterKey: options.nextChapterKey,
      }),
      model: options.model as never,
      tools: createNovelTools(options.bookDir),
    },
    streamFn: options.streamFn as never,
  })
}

/** 知识库管线的 IPC 契约 */

export type PipelineMode = 'full' | 'incremental' | 'noop'

export interface PipelineProgress {
  phase: 'chunk' | 'merge' | 'style' | 'write'
  current: number
  total: number
  message?: string
}

export interface PipelinePlan {
  mode: PipelineMode
  totalChapters: number
  pendingChapters: number
  lastChapterKey?: string
  knowledgeUpdatedAt?: string
}

export interface PipelineReport {
  mode: PipelineMode
  chapters: number
  chunks: number
  cost: number
  inputTokens: number
  outputTokens: number
  files: string[]
  skippedChapters: number
  fromChapter?: string
  toChapter?: string
  pendingChapters: number
}

export type PipelineEvent =
  | { type: 'started'; plan: PipelinePlan }
  | { type: 'progress'; progress: PipelineProgress }
  | { type: 'done'; report: PipelineReport }
  | { type: 'error'; message: string }

export interface PipelineStartInput {
  dir: string
  title: string
}

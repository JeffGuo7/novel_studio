/** 知识库初始化管线的 IPC 契约 */

export interface PipelineProgress {
  phase: 'chunk' | 'merge' | 'write'
  current: number
  total: number
  message?: string
}

export interface PipelineReport {
  chapters: number
  chunks: number
  cost: number
  inputTokens: number
  outputTokens: number
  files: string[]
  skippedChapters: number
}

export type PipelineEvent =
  | { type: 'started'; chapters: number }
  | { type: 'progress'; progress: PipelineProgress }
  | { type: 'done'; report: PipelineReport }
  | { type: 'error'; message: string }

export interface PipelineStartInput {
  dir: string
  title: string
}

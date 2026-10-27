/** 知识库管线的 IPC 契约 */

export type PipelineMode = 'full' | 'incremental' | 'rebuild' | 'noop'

export interface PipelineProgress {
  phase: 'chunk' | 'merge' | 'style' | 'entity' | 'write'
  current: number
  total: number
  message?: string
}

export interface PipelinePlan {
  mode: PipelineMode
  totalChapters: number
  pendingChapters: number
  changedChapters: number
  added: string[]
  modified: string[]
  deleted: string[]
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
  rebuiltBecause?: 'initial' | 'modified' | 'deleted' | 'forced'
  modifiedChapters?: number
  deletedChapters?: number
}

export type PipelineEvent =
  | { type: 'started'; plan: PipelinePlan }
  | { type: 'progress'; progress: PipelineProgress }
  | { type: 'done'; report: PipelineReport }
  | { type: 'error'; message: string }
  | { type: 'outline_progress'; message: string }
  | {
      type: 'outline_done'
      proposals: OutlineProposalSummary[]
      cost: number
      inputTokens: number
      outputTokens: number
    }
  | { type: 'outline_error'; message: string }

export interface PipelineStartInput {
  dir: string
  title: string
}

export type OutlineEvent =
  | { type: 'outline_progress'; message: string }
  | {
      type: 'outline_done'
      proposals: OutlineProposalSummary[]
      cost: number
      inputTokens: number
      outputTokens: number
    }
  | { type: 'outline_error'; message: string }

export interface OutlineProposalSummary {
  id: string
  targetPath: string
  targetTitle: string
}

export interface OutlineStartInput {
  dir: string
  title: string
  /** 作者给的一句话/一段创意 */
  premise: string
  /** 分几卷（1-8，默认 3） */
  volumes?: number
}

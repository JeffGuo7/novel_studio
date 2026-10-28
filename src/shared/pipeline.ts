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
  | { type: 'review_progress'; message: string }
  | { type: 'review_done'; report: ReviewReportSummary }
  | { type: 'review_error'; message: string }

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

export type ReviewSeverity = 'high' | 'medium' | 'low'
export type ReviewCategory = 'character' | 'timeline' | 'setting' | 'plot' | 'other'

export interface ReviewIssue {
  id: string
  severity: ReviewSeverity
  category: ReviewCategory
  title: string
  detail: string
  /** 问题涉及的位置，如 "第 3 章"、"人物卡·林牧" */
  locations: string[]
  suggestion?: string
}

export interface ReviewReportSummary {
  issues: ReviewIssue[]
  checkedChapters: number
  totalChapters: number
  truncated: boolean
  checkedKnowledge: number
  batches: number
  warnings: string[]
  cost: number
  inputTokens: number
  outputTokens: number
  /** 报告 Markdown 相对书目录的路径（.studio/reviews/...） */
  reportPath?: string
  fromChapter?: number
  toChapter?: number
}

export type ReviewEvent =
  | { type: 'review_progress'; message: string }
  | { type: 'review_done'; report: ReviewReportSummary }
  | { type: 'review_error'; message: string }

export interface ReviewStartInput {
  dir: string
  title: string
  fromChapter?: number
  toChapter?: number
  /** 作者指定重点，如「林牧的年龄和身份是否前后一致」 */
  focus?: string
}

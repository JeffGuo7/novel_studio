/** 书库与工作台的共享类型（main / renderer 共用，不含 Node 专有类型） */
import type { AgentEvent, AgentInitInfo, ChatHistoryItem } from './agent'
import type { AppSettings, SettingsSaveInput } from './model-config'
import type { OutlineEvent, PipelineEvent, PipelinePlan } from './pipeline'
import type { TomatoBook, TomatoProgressEvent, TomatoStatus } from './tomato'
import type { StyleDriftWarning, StyleMetrics } from './style'

export interface BookMeta {
  schemaVersion: number
  id: string
  title: string
  author: string
  createdAt: string
  updatedAt: string
}

export interface KnowledgeFileInfo {
  /** 书名根目录下的文件名，如 world_model.md */
  name: string
  /** 中文显示名 */
  title: string
  words: number
}

export interface ChapterInfo {
  /** 4 位补零的章节 key，如 "0001" */
  key: string
  number: number
  title: string
  /** 相对书目录的路径，如 chapters/0001_雾夜渡客.md */
  path: string
  words: number
  /** 是否有对应草稿 */
  hasDraft: boolean
  /** 草稿版本数 */
  draftVersions: number
}

export interface BookSnapshot {
  dir: string
  meta: BookMeta
  chapters: ChapterInfo[]
  knowledge: KnowledgeFileInfo[]
  /** 有草稿但还没有正文章节的 key（纯草稿章） */
  orphanDraftKeys: string[]
  head: string | null
  branch: string | null
}

export interface CommitInfo {
  oid: string
  short: string
  message: string
  /** 去掉前缀标记后的标题行 */
  summary: string
  /** 形如 归档 / 知识 / 导入 / 还原 / 初始化 */
  kind: string
  timestamp: number
  author: string
  parents: string[]
}

export interface FileDiff {
  path: string
  before: string | null
  after: string | null
}

export interface DraftInfo {
  version: number
  createdAt: string
  source: 'ai' | 'human' | 'seed'
  model?: string
  note?: string
  words: number
}

export interface DraftVersion extends DraftInfo {
  content: string
}

export interface ImportReport {
  source: string
  chapters: number
  words: number
  titles: string[]
  encoding: string
  /** 本次导入涉及的文本源数量（粘贴/多文件时 >1） */
  sources?: number
}

export interface ImportResult {
  canceled: boolean
  snapshot?: BookSnapshot
  report?: ImportReport
}

export interface StyleDriftResult {
  hasFingerprint: boolean
  baseline: Partial<StyleMetrics>
  current: StyleMetrics
  warnings: StyleDriftWarning[]
}

export interface AppInfo {
  version: string
  electron: string
  node: string
  chrome: string
  platform: string
  userData: string
  workspace: string
}

export interface ImportBatchResult {
  canceled: boolean
  snapshot?: BookSnapshot
  report?: ImportReport
}

export interface RollbackResult {
  oid: string
  restoredFrom: string
  changedFiles: number
}

export type Result<T> =
  | { ok: true; data: T }
  | { ok: false; error: { code: string; message: string } }

/** preload 通过 contextBridge 暴露给渲染进程的 API 面 */
export interface KnowledgeProposalInfo {
  id: string
  /** 目标知识文件名，如 master_outline.md */
  targetPath: string
  /** 中文显示名，如 主线大纲 */
  targetTitle: string
  /** 建议写入的完整内容 */
  content: string
  /** 当前磁盘上的内容（用于 diff） */
  currentContent: string
  reason: string
  source: 'agent' | 'outline'
  createdAt: string
}

export interface StudioApi {
  listBooks(): Promise<Result<BookSnapshot[]>>
  createBook(input: { title: string; author?: string }): Promise<Result<BookSnapshot>>
  openBook(dir: string): Promise<Result<BookSnapshot>>
  readFile(input: { dir: string; path: string; ref?: string }): Promise<Result<{ content: string; exists: boolean }>>
  saveFile(input: { dir: string; path: string; content: string; message?: string }): Promise<Result<{ oid: string | null; snapshot: BookSnapshot }>>
  listDrafts(input: { dir: string; chapterKey: string }): Promise<Result<DraftInfo[]>>
  saveDraft(input: {
    dir: string
    chapterKey: string
    content: string
    source?: DraftInfo['source']
    model?: string
    note?: string
  }): Promise<Result<DraftInfo>>
  readDraft(input: { dir: string; chapterKey: string; version: number }): Promise<Result<{ content: string; info: DraftInfo }>>
  discardDrafts(input: { dir: string; chapterKey: string }): Promise<Result<{ snapshot: BookSnapshot }>>
  promoteDraft(input: { dir: string; chapterKey: string; title: string; note?: string }): Promise<Result<BookSnapshot>>
  seedDraft(input: { dir: string; chapterKey: string }): Promise<Result<DraftInfo>>
  createChapter(input: { dir: string; title?: string }): Promise<Result<{ chapterKey: string; draft: DraftInfo }>>
  listChapters(input: { dir: string }): Promise<Result<ChapterInfo[]>>
  history(input: { dir: string; depth?: number }): Promise<Result<CommitInfo[]>>
  fileHistory(input: { dir: string; path: string; depth?: number }): Promise<Result<CommitInfo[]>>
  diff(input: { dir: string; from: string; to: string }): Promise<Result<FileDiff[]>>
  rollback(input: { dir: string; oid: string }): Promise<Result<RollbackResult>>
  deleteBook(input: { dir: string }): Promise<Result<{ trashedTo: string }>>
  deleteChapter(input: { dir: string; chapterKey: string }): Promise<
    Result<{ snapshot: BookSnapshot; deletedPath: string; discardedDrafts: number }>
  >
  importFile(input: { dir: string; filePath?: string }): Promise<Result<ImportResult>>
  importFiles(input: { dir: string; filePaths?: string[] }): Promise<Result<ImportBatchResult>>
  importText(input: { dir: string; text: string; title?: string }): Promise<Result<ImportBatchResult>>
  outline: {
    start(input: { dir: string; title: string; premise: string; volumes?: number }): Promise<
      Result<{ started: boolean }>
    >
    cancel(): Promise<Result<{ canceled: boolean }>>
    onEvent(handler: (event: OutlineEvent) => void): () => void
  }
  proposals: {
    list(input: { dir: string }): Promise<Result<KnowledgeProposalInfo[]>>
    accept(input: { dir: string; id: string }): Promise<
      Result<{ oid: string | null; path: string; snapshot: BookSnapshot }>
    >
    reject(input: { dir: string; id: string }): Promise<Result<{ removed: boolean }>>
  }
  tomato: {
    status(): Promise<Result<TomatoStatus>>
    search(input: { query: string; count?: number }): Promise<Result<TomatoBook[]>>
    import(input: { dir: string; bookId: string; title: string }): Promise<
      Result<{ snapshot: BookSnapshot; report: ImportReport }>
    >
    onProgress(handler: (event: TomatoProgressEvent) => void): () => void
  }
  workspaceRoot(): Promise<Result<string>>
  style: {
    drift(input: { dir: string; path: string; content?: string }): Promise<Result<StyleDriftResult>>
  }
  app: {
    info(): Promise<Result<AppInfo>>
    openDir(input: { target: 'userData' | 'workspace' }): Promise<Result<{ opened: boolean }>>
  }
  agent: {
    ensure(input: { dir: string; title: string }): Promise<Result<AgentInitInfo>>
    send(input: { dir: string; title: string; text: string; chapterKey?: string }): Promise<Result<{ accepted: boolean }>>
    steer(input: { text: string }): Promise<Result<{ accepted: boolean }>>
    abort(): Promise<Result<{ accepted: boolean }>>
    reset(): Promise<Result<{ accepted: boolean }>>
    compact(): Promise<Result<{ accepted: boolean }>>
    onEvent(handler: (event: AgentEvent) => void): () => void
    loadSession(input: { dir: string }): Promise<Result<ChatHistoryItem[]>>
    info(): Promise<Result<AgentInitInfo | null>>
  }
  pipeline: {
    plan(input: { dir: string }): Promise<Result<PipelinePlan>>
    start(input: { dir: string; title: string }): Promise<Result<{ started: boolean }>>
    cancel(): Promise<Result<{ canceled: boolean }>>
    onEvent(handler: (event: PipelineEvent) => void): () => void
  }
  settings: {
    get(): Promise<Result<AppSettings>>
    save(input: SettingsSaveInput): Promise<Result<AppSettings>>
  }
}

import { app, utilityProcess, type UtilityProcess } from 'electron'
import path from 'node:path'
import type { ReviewEvent, ReviewStartInput } from '../shared/pipeline'
import { getBudgetUsd, getChapterBudgetUsd, getProviderConfig, getProxyUrl, getSelection, getStoredApiKey } from './settings-store'

function resolveHostPath(): string {
  if (app.isPackaged) return path.join(process.resourcesPath, 'pipeline', 'host.mjs')
  return path.join(__dirname, '../pipeline/host.mjs')
}

/**
 * 一致性检查：复用知识管线 host（mode=review），每次运行一个 utilityProcess，可取消。
 * 只读：不修改书稿 / 知识文件，只在 .studio/reviews 写报告。
 */
export class ReviewManager {
  private child: UtilityProcess | null = null
  private running = false

  constructor(private readonly emit: (event: ReviewEvent) => void) {}

  get isRunning(): boolean {
    return this.running
  }

  start(input: ReviewStartInput): void {
    if (this.running) throw new Error('已有一致性检查在运行')
    const selection = getSelection()
    const providerConfig = selection.providerConfig ?? getProviderConfig(selection.provider)
    const runtimeConfig = JSON.stringify({
      selection: { ...selection, providerConfig },
      apiKey: getStoredApiKey(selection.provider),
      budgetUsd: getBudgetUsd(),
      chapterBudgetUsd: getChapterBudgetUsd(),
      sessionFile: '',
    })

    const child = utilityProcess.fork(resolveHostPath(), [], {
      stdio: 'inherit',
      env: {
        ...process.env,
        NOVEL_STUDIO_RUNTIME_CONFIG: runtimeConfig,
        NOVEL_STUDIO_APP_VERSION: app.getVersion(),
        NOVEL_STUDIO_PROXY: getProxyUrl(),
        NOVEL_STUDIO_BOOK_DIR: input.dir,
        NOVEL_STUDIO_BOOK_TITLE: input.title,
        NOVEL_STUDIO_PIPELINE_MODE: 'review',
        NOVEL_STUDIO_REVIEW_FROM: input.fromChapter ? String(input.fromChapter) : '',
        NOVEL_STUDIO_REVIEW_TO: input.toChapter ? String(input.toChapter) : '',
        NOVEL_STUDIO_REVIEW_FOCUS: input.focus ?? '',
      },
    })

    this.child = child
    this.running = true

    child.on('message', (message: { type?: string; event?: ReviewEvent; message?: string }) => {
      if (!message) return
      if (message.type === 'event' && message.event) {
        this.emit(message.event)
        if (message.event.type === 'review_done' || message.event.type === 'review_error') {
          this.running = false
          this.child = null
        }
        return
      }
      if (message.type === 'fatal') {
        this.running = false
        this.child = null
        this.emit({ type: 'review_error', message: message.message ?? '一致性检查失败' })
      }
    })

    child.on('exit', (code) => {
      if (this.running) {
        this.running = false
        this.emit({ type: 'review_error', message: `一致性检查进程退出（code ${code}）` })
      }
      this.child = null
    })
  }

  cancel(): void {
    this.child?.postMessage({ type: 'cancel' })
  }

  dispose(): void {
    try {
      this.child?.kill()
    } catch {
      // 已退出
    }
    this.child = null
    this.running = false
  }
}

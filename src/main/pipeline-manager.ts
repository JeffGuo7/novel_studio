import { app, utilityProcess, type UtilityProcess } from 'electron'
import path from 'node:path'
import type { PipelineEvent, PipelineStartInput } from '../shared/pipeline'
import { getBudgetUsd, getChapterBudgetUsd, getProviderConfig, getSelection, getStoredApiKey } from './settings-store'

function resolveHostPath(): string {
  if (app.isPackaged) return path.join(process.resourcesPath, 'pipeline', 'host.mjs')
  return path.join(__dirname, '../pipeline/host.mjs')
}

/**
 * 知识库初始化管线：每次运行一个 utilityProcess，可取消。
 */
export class PipelineManager {
  private child: UtilityProcess | null = null
  private running = false

  constructor(private readonly emit: (event: PipelineEvent) => void) {}

  get isRunning(): boolean {
    return this.running
  }

  start(input: PipelineStartInput): void {
    if (this.running) {
      throw new Error('已有初始化任务在运行')
    }
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
        NOVEL_STUDIO_BOOK_DIR: input.dir,
        NOVEL_STUDIO_BOOK_TITLE: input.title,
      },
    })

    this.child = child
    this.running = true

    child.on('message', (message: { type?: string; event?: PipelineEvent; message?: string }) => {
      if (!message) return
      if (message.type === 'event' && message.event) {
        this.emit(message.event)
        if (message.event.type === 'done' || message.event.type === 'error') {
          this.running = false
          this.child = null
        }
        return
      }
      if (message.type === 'fatal') {
        this.running = false
        this.child = null
        this.emit({ type: 'error', message: message.message ?? '初始化失败' })
      }
    })

    child.on('exit', (code) => {
      if (this.running) {
        this.running = false
        this.emit({ type: 'error', message: `初始化进程退出（code ${code}）` })
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

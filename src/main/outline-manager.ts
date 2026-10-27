import { app, utilityProcess, type UtilityProcess } from 'electron'
import path from 'node:path'
import type { OutlineEvent, OutlineStartInput } from '../shared/pipeline'
import { getBudgetUsd, getChapterBudgetUsd, getProviderConfig, getSelection, getStoredApiKey } from './settings-store'

function resolveHostPath(): string {
  if (app.isPackaged) return path.join(process.resourcesPath, 'pipeline', 'host.mjs')
  return path.join(__dirname, '../pipeline/host.mjs')
}

/**
 * 大纲生成：复用知识管线 host（mode=outline），每次运行一个 utilityProcess，可取消。
 * 只产出 KnowledgeProposal，不直接改知识文件。
 */
export class OutlineManager {
  private child: UtilityProcess | null = null
  private running = false

  constructor(private readonly emit: (event: OutlineEvent) => void) {}

  get isRunning(): boolean {
    return this.running
  }

  start(input: OutlineStartInput): void {
    if (this.running) throw new Error('已有大纲任务在运行')
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
        NOVEL_STUDIO_BOOK_DIR: input.dir,
        NOVEL_STUDIO_BOOK_TITLE: input.title,
        NOVEL_STUDIO_PIPELINE_MODE: 'outline',
        NOVEL_STUDIO_OUTLINE_PREMISE: input.premise,
        NOVEL_STUDIO_OUTLINE_VOLUMES: String(input.volumes ?? 3),
      },
    })

    this.child = child
    this.running = true

    child.on('message', (message: { type?: string; event?: OutlineEvent; message?: string }) => {
      if (!message) return
      if (message.type === 'event' && message.event) {
        this.emit(message.event)
        if (message.event.type === 'outline_done' || message.event.type === 'outline_error') {
          this.running = false
          this.child = null
        }
        return
      }
      if (message.type === 'fatal') {
        this.running = false
        this.child = null
        this.emit({ type: 'outline_error', message: message.message ?? '大纲生成失败' })
      }
    })

    child.on('exit', (code) => {
      if (this.running) {
        this.running = false
        this.emit({ type: 'outline_error', message: `大纲生成进程退出（code ${code}）` })
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

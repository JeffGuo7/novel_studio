import { app, utilityProcess, type UtilityProcess } from 'electron'
import path from 'node:path'
import type { AgentEvent, AgentInitInfo } from '../shared/agent'
import { getBudgetUsd, getChapterBudgetUsd, getProviderConfig, getSelection, getStoredApiKey } from './settings-store'

/** 打包后 host 放在 resources/agent（asar 里的文件 utilityProcess 无法直接执行） */
function resolveHostPath(): string {
  if (app.isPackaged) return path.join(process.resourcesPath, 'agent', 'host.mjs')
  return path.join(__dirname, '../agent/host.mjs')
}

interface ReadyMessage {
  type: 'ready'
  info: AgentInitInfo
}

interface EventMessage {
  type: 'event'
  event: AgentEvent
}

interface FatalMessage {
  type: 'fatal'
  message: string
}

type HostMessage = ReadyMessage | EventMessage | FatalMessage

const READY_TIMEOUT_MS = 20_000

/**
 * Agent Host 生命周期管理。
 * 每个书目录一个 utilityProcess；切换书时销毁重建，避免上下文串味。
 */
export class AgentManager {
  private child: UtilityProcess | null = null
  private currentBook: string | null = null
  private currentInfo: AgentInitInfo | null = null
  private pendingReady: {
    resolve: (info: AgentInitInfo) => void
    reject: (err: Error) => void
    timer: NodeJS.Timeout
  } | null = null

  constructor(private readonly emit: (event: AgentEvent) => void) {}

  get info(): AgentInitInfo | null {
    return this.currentInfo
  }

  async ensure(bookDir: string, bookTitle: string): Promise<AgentInitInfo> {
    if (this.child && this.currentBook === bookDir && this.currentInfo) {
      return this.currentInfo
    }
    this.dispose()
    return this.spawn(bookDir, bookTitle)
  }

  private spawn(bookDir: string, bookTitle: string): Promise<AgentInitInfo> {
    return new Promise<AgentInitInfo>((resolve, reject) => {
      const hostPath = resolveHostPath()
      // 模型配置 + 密钥只经子进程 env 传递，渲染进程永远拿不到
      const selection = getSelection()
      const providerConfig = selection.providerConfig ?? getProviderConfig(selection.provider)
      const runtimeConfig = JSON.stringify({
        selection: { ...selection, providerConfig },
        apiKey: getStoredApiKey(selection.provider),
        budgetUsd: getBudgetUsd(),
        chapterBudgetUsd: getChapterBudgetUsd(),
        sessionFile: path.join(bookDir, '.studio', 'agent', 'session.json'),
      })
      let settled = false
      const child = utilityProcess.fork(hostPath, [], {
        stdio: 'inherit',
        env: {
          ...process.env,
          NOVEL_STUDIO_RUNTIME_CONFIG: runtimeConfig,
        NOVEL_STUDIO_APP_VERSION: app.getVersion(),
          NOVEL_STUDIO_BOOK_DIR: bookDir,
          NOVEL_STUDIO_BOOK_TITLE: bookTitle,
        },
      })

      this.child = child
      this.currentBook = bookDir
      this.currentInfo = null

      const timer = setTimeout(() => {
        if (settled) return
        settled = true
        this.pendingReady = null
        reject(new Error('Agent Host 启动超时'))
      }, READY_TIMEOUT_MS)

      this.pendingReady = {
        resolve: (info) => {
          if (settled) return
          settled = true
          clearTimeout(timer)
          this.pendingReady = null
          resolve(info)
        },
        reject: (err) => {
          if (settled) return
          settled = true
          clearTimeout(timer)
          this.pendingReady = null
          reject(err)
        },
        timer,
      }

      child.on('message', (message: HostMessage) => {
        if (!message) return
        if (message.type === 'ready') {
          this.currentInfo = message.info
          this.emit({ type: 'status', status: 'idle' })
          this.pendingReady?.resolve(message.info)
          return
        }
        if (message.type === 'fatal') {
          this.emit({ type: 'error', message: message.message })
          this.pendingReady?.reject(new Error(message.message))
          return
        }
        if (message.type === 'event') {
          this.emit(message.event)
        }
      })

      child.on('exit', (code) => {
        this.emit({ type: 'status', status: 'error', detail: `Agent Host 退出（code ${code}）` })
        this.pendingReady?.reject(new Error(`Agent Host 退出（code ${code}）`))
        this.child = null
        this.currentBook = null
        this.currentInfo = null
      })
    })
  }

  async send(bookDir: string, bookTitle: string, text: string, chapterKey?: string): Promise<void> {
    await this.ensure(bookDir, bookTitle)
    this.child?.postMessage({ type: 'prompt', text, chapterKey })
  }

  steer(text: string): void {
    this.child?.postMessage({ type: 'steer', text })
  }

  abort(): void {
    this.child?.postMessage({ type: 'abort' })
  }

  reset(): void {
    this.child?.postMessage({ type: 'reset' })
  }

  compact(): void {
    if (!this.child) throw new Error('Agent 还没启动')
    this.child.postMessage({ type: 'compact' })
  }

  dispose(): void {
    if (this.child) {
      try {
        this.child.kill()
      } catch {
        // 进程可能已经退出
      }
    }
    this.child = null
    this.currentBook = null
    this.currentInfo = null
  }
}

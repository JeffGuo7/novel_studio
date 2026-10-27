/**
 * 结构化日志（JSONL，按天滚动）。
 *
 * 设计：
 * - 只依赖 node，不依赖 electron，便于单测；
 * - 一行一个 JSON，方便 grep / 后续接入日志面板；
 * - 自动把 Error 转成 message + stack，避免 JSON.stringify 丢信息；
 * - 写失败静默（日志不能拖垮主流程）。
 */
import fs from 'node:fs'
import path from 'node:path'

export type LogLevel = 'debug' | 'info' | 'warn' | 'error'

export interface LogRecord {
  ts: string
  level: LogLevel
  scope: string
  message: string
  data?: unknown
}

function normalizeData(data: unknown): unknown {
  if (data === undefined) return undefined
  if (data instanceof Error) {
    return { name: data.name, message: data.message, stack: data.stack }
  }
  try {
    // 去掉 undefined / 循环引用
    return JSON.parse(JSON.stringify(data))
  } catch {
    return String(data)
  }
}

export class Logger {
  constructor(
    private readonly dir: string,
    private readonly scope = 'app',
    private readonly now: () => Date = () => new Date(),
  ) {}

  child(scope: string): Logger {
    return new Logger(this.dir, `${this.scope}:${scope}`, this.now)
  }

  logPath(date = this.now()): string {
    const day = date.toISOString().slice(0, 10)
    return path.join(this.dir, `main-${day}.log`)
  }

  debug(message: string, data?: unknown): void {
    this.write('debug', message, data)
  }

  info(message: string, data?: unknown): void {
    this.write('info', message, data)
  }

  warn(message: string, data?: unknown): void {
    this.write('warn', message, data)
  }

  error(message: string, data?: unknown): void {
    this.write('error', message, data)
  }

  private write(level: LogLevel, message: string, data?: unknown): void {
    const now = this.now()
    const record: LogRecord = {
      ts: now.toISOString(),
      level,
      scope: this.scope,
      message,
      ...(data === undefined ? {} : { data: normalizeData(data) }),
    }
    try {
      fs.mkdirSync(this.dir, { recursive: true })
      fs.appendFileSync(this.logPath(now), JSON.stringify(record) + '\n', 'utf8')
    } catch {
      // 日志写失败不能影响主流程
    }
  }
}

let logger: Logger | null = null

/** 主进程启动时初始化；未初始化时用内存中的 no-op 目录（不会写文件） */
export function initLogger(userDataDir: string): Logger {
  logger = new Logger(path.join(userDataDir, 'logs'), 'app')
  return logger
}

export function getLogger(): Logger {
  if (!logger) {
    // 还没初始化（例如极早期异常）：写到临时目录，避免抛错
    logger = new Logger(path.join(process.env.TEMP ?? process.cwd(), 'novel-studio-logs'), 'app')
  }
  return logger
}

import fs from 'node:fs'
import path from 'node:path'
import { emptySession, prepareForPersist, type PersistedSession } from './session-state'

/** 会话文件位置：<bookDir>/.studio/agent/session.json（.studio 已在书库 .gitignore 里） */
export function sessionFilePath(bookDir: string): string {
  return path.join(bookDir, '.studio', 'agent', 'session.json')
}

export function loadSession(file: string): PersistedSession {
  try {
    const raw = fs.readFileSync(file, 'utf8')
    const parsed = JSON.parse(raw) as Partial<PersistedSession>
    if (!Array.isArray(parsed.messages)) return emptySession()
    return {
      version: 1,
      updatedAt: parsed.updatedAt ?? '',
      messages: parsed.messages,
      cost: Number(parsed.cost ?? 0) || 0,
    }
  } catch {
    return emptySession()
  }
}

export function saveSession(file: string, messages: unknown[], cost: number): void {
  try {
    const payload = prepareForPersist(messages, cost)
    fs.mkdirSync(path.dirname(file), { recursive: true })
    const tmp = `${file}.tmp-${process.pid}`
    fs.writeFileSync(tmp, JSON.stringify(payload), 'utf8')
    fs.renameSync(tmp, file)
  } catch (err) {
    // 会话落盘失败不应该打断写作
    console.warn('[agent] 会话保存失败：', (err as Error).message)
  }
}

export function clearSession(file: string): void {
  try {
    fs.unlinkSync(file)
  } catch {
    // 本来就不存在
  }
}

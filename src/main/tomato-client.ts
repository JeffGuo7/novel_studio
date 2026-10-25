/**
 * 番茄小说下载器适配（可选在线书源）。
 *
 * 参考项目用的是本地 `Tomato-Novel-Downloader` 的 `--server` 模式（默认 127.0.0.1:18423）：
 *   GET  /api/status          探测
 *   GET  /api/search?q&count  搜索
 *   POST /api/config          设置保存目录/格式
 *   POST /api/jobs {book_id}  提交下载
 *   GET  /api/jobs            轮询进度（items[].state: done / failed ...）
 *
 * 本模块不依赖 electron，方便用本地 stub server 做单测。
 */

import type { TomatoBook, TomatoStatus } from '../shared/tomato'

export const TOMATO_DEFAULT_BASE_URL = 'http://127.0.0.1:18423'

export interface TomatoJobProgress {
  saved: number
  total: number
  state: string
}

interface JsonRecord {
  [key: string]: unknown
}

async function fetchJson(
  url: string,
  init: RequestInit,
  timeoutMs: number,
): Promise<JsonRecord> {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeoutMs)
  try {
    const response = await fetch(url, { ...init, signal: controller.signal })
    if (!response.ok) {
      throw new Error(`HTTP ${response.status} ${response.statusText}`)
    }
    return (await response.json()) as JsonRecord
  } finally {
    clearTimeout(timer)
  }
}

function pickString(value: unknown): string {
  return typeof value === 'string' ? value : typeof value === 'number' ? String(value) : ''
}

/** 探测本地下载器是否可用 */
export async function detectTomato(
  baseUrl: string = TOMATO_DEFAULT_BASE_URL,
  timeoutMs = 1500,
): Promise<TomatoStatus> {
  const normalized = baseUrl.replace(/\/$/, '')
  try {
    const data = await fetchJson(`${normalized}/api/status`, { method: 'GET' }, timeoutMs)
    const saveDir = pickString(data.save_dir) || pickString(data.saveDir) || undefined
    const version = pickString(data.version) || undefined
    return { available: true, baseUrl: normalized, saveDir, version }
  } catch {
    return { available: false, baseUrl: normalized }
  }
}

function normalizeBook(raw: JsonRecord): TomatoBook | null {
  const bookId =
    pickString(raw.book_id) || pickString(raw.bookId) || pickString(raw.id) || pickString(raw.novel_id)
  const title =
    pickString(raw.book_name) || pickString(raw.title) || pickString(raw.name) || pickString(raw.novel_name)
  if (!bookId || !title) return null
  const author =
    pickString(raw.author) || pickString(raw.author_name) || pickString(raw.authorName) || undefined
  return { bookId, title, author }
}

export async function searchTomato(
  query: string,
  options: { baseUrl?: string; count?: number; timeoutMs?: number } = {},
): Promise<TomatoBook[]> {
  const baseUrl = (options.baseUrl ?? TOMATO_DEFAULT_BASE_URL).replace(/\/$/, '')
  const count = options.count ?? 10
  const data = await fetchJson(
    `${baseUrl}/api/search?q=${encodeURIComponent(query)}&count=${count}`,
    { method: 'GET' },
    options.timeoutMs ?? 30_000,
  )
  const items = Array.isArray(data.items) ? (data.items as JsonRecord[]) : []
  return items.map(normalizeBook).filter((item): item is TomatoBook => item !== null)
}

function findOutputTxt(saveDir: string, sinceMs: number, fsModule: typeof import('node:fs')): string | null {
  try {
    const entries = fsModule
      .readdirSync(saveDir, { withFileTypes: true })
      .filter((entry) => entry.isFile() && entry.name.toLowerCase().endsWith('.txt'))
      .map((entry) => {
        const fullPath = `${saveDir}/${entry.name}`.replace(/\\/g, '/')
        try {
          const stat = fsModule.statSync(fullPath)
          return { fullPath, mtimeMs: stat.mtimeMs, size: stat.size }
        } catch {
          return null
        }
      })
      .filter((item): item is { fullPath: string; mtimeMs: number; size: number } => item !== null)
      .filter((item) => item.size > 0 && item.mtimeMs >= sinceMs - 1000)
      .sort((a, b) => b.mtimeMs - a.mtimeMs)
    return entries[0]?.fullPath ?? null
  } catch {
    return null
  }
}

export async function downloadTomatoBook(options: {
  bookId: string
  saveDir: string
  baseUrl?: string
  onProgress?: (progress: TomatoJobProgress) => void
  pollIntervalMs?: number
  timeoutMs?: number
}): Promise<{ txtPath: string }> {
  const fs = await import('node:fs')
  const baseUrl = (options.baseUrl ?? TOMATO_DEFAULT_BASE_URL).replace(/\/$/, '')
  const pollInterval = options.pollIntervalMs ?? 2000
  const deadline = Date.now() + (options.timeoutMs ?? 10 * 60_000)
  const startedAt = Date.now()

  if (!fs.existsSync(options.saveDir)) {
    fs.mkdirSync(options.saveDir, { recursive: true })
  }

  await fetchJson(
    `${baseUrl}/api/config`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        novel_format: 'txt',
        bulk_files: false,
        save_path: options.saveDir,
      }),
    },
    10_000,
  )

  const created = await fetchJson(
    `${baseUrl}/api/jobs`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ book_id: options.bookId }),
    },
    15_000,
  )
  const jobId = created.id ?? created.job_id ?? created.jobId
  if (!jobId) {
    throw new Error('下载器没有返回任务 id')
  }

  while (Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, pollInterval))
    const jobs = await fetchJson(`${baseUrl}/api/jobs`, { method: 'GET' }, 10_000)
    const items = Array.isArray(jobs.items) ? (jobs.items as JsonRecord[]) : []
    const job = items.find((item) => String(item.id ?? item.job_id ?? '') === String(jobId))
    if (!job) continue
    const state = pickString(job.state) || pickString(job.status)
    const progress = (job.progress ?? {}) as JsonRecord
    const saved = Number(progress.saved_chapters ?? 0) || 0
    const total = Number(progress.chapter_total ?? 0) || 0
    options.onProgress?.({ saved, total, state })
    if (state === 'done' || state === 'completed' || state === 'finished' || state === 'success') {
      const status = await fetchJson(`${baseUrl}/api/status`, { method: 'GET' }, 10_000).catch(
        () => ({}) as JsonRecord,
      )
      const saveDir = pickString(status.save_dir) || pickString(status.saveDir) || options.saveDir
      const txtPath = findOutputTxt(saveDir, startedAt, fs)
      if (!txtPath) {
        throw new Error(`下载完成但没找到 txt 文件（目录：${saveDir}）`)
      }
      return { txtPath }
    }
    if (state === 'failed' || state === 'error') {
      throw new Error(`下载失败：${pickString(job.message) || '未知原因'}`)
    }
  }
  throw new Error('下载超时（10 分钟）')
}

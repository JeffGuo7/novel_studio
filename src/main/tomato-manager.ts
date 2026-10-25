/**
 * 番茄在线导入的编排：探测下载器 → 下载 txt → 复用本地导入管线。
 * 如果配置了 NOVEL_STUDIO_TOMATO_EXE / TOMATO_DOWNLOADER_EXE，会尝试自动拉起 `--server`。
 */
import { spawn } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { importFileIntoBook, removeDirRecursive, type ImportReport } from '../core'
import type { BookSnapshot } from '../shared/types'
import type { TomatoProgressEvent, TomatoStatus } from '../shared/tomato'
import { detectTomato, downloadTomatoBook, searchTomato } from './tomato-client'

const EXE_ENV_KEYS = ['NOVEL_STUDIO_TOMATO_EXE', 'TOMATO_DOWNLOADER_EXE']

function configuredExe(): string | null {
  for (const key of EXE_ENV_KEYS) {
    const value = process.env[key]?.trim()
    if (value && fs.existsSync(value)) return value
  }
  return null
}

/** 探测；如果没在跑但配置了 exe，就尝试拉起 server 模式 */
export async function ensureTomatoAvailable(timeoutMs = 15_000): Promise<TomatoStatus> {
  const first = await detectTomato()
  if (first.available) return first

  const exe = configuredExe()
  if (!exe) return first

  try {
    const child = spawn(exe, ['--server'], { stdio: 'ignore', detached: true })
    child.unref()
  } catch {
    return first
  }

  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 500))
    const status = await detectTomato()
    if (status.available) return status
  }
  return first
}

export async function searchTomatoBooks(query: string, count = 10) {
  const status = await ensureTomatoAvailable()
  if (!status.available) {
    throw new Error('没有检测到本地的番茄下载器（Tomato-Novel-Downloader），请先启动它，或改用粘贴/本地文件导入')
  }
  return searchTomato(query, { baseUrl: status.baseUrl, count })
}

export async function importTomatoBook(
  bookDir: string,
  input: { bookId: string; title: string },
  onProgress?: (event: TomatoProgressEvent) => void,
): Promise<{ snapshot: BookSnapshot; report: ImportReport }> {
  const status = await ensureTomatoAvailable()
  if (!status.available) {
    throw new Error('没有检测到本地的番茄下载器（Tomato-Novel-Downloader），请先启动它，或改用粘贴/本地文件导入')
  }

  const downloadDir = path.join(os.tmpdir(), `novel-studio-tomato-${Date.now().toString(36)}`)
  fs.mkdirSync(downloadDir, { recursive: true })
  try {
    onProgress?.({ phase: 'download', saved: 0, total: 0, message: '正在下载…' })
    const { txtPath } = await downloadTomatoBook({
      bookId: input.bookId,
      saveDir: downloadDir,
      baseUrl: status.baseUrl,
      onProgress: (progress) =>
        onProgress?.({
          phase: 'download',
          saved: progress.saved,
          total: progress.total,
          message: `下载中 ${progress.saved}/${progress.total || '?'}`,
        }),
    })
    onProgress?.({ phase: 'import', message: '正在导入章节…' })
    const result = await importFileIntoBook(bookDir, txtPath)
    return result
  } finally {
    removeDirRecursive(downloadDir)
  }
}

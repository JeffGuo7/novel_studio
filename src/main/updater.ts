import { app, net, shell } from 'electron'
import crypto from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import type { LatestRelease, UpdateCheckResult } from './update-logic'
import { buildUpdateCheckResult, parseChecksum } from './update-logic'

const REPO = 'JeffGuo7/novel_studio'
const RELEASES_PAGE = `https://github.com/${REPO}/releases/latest`
const API = `https://api.github.com/repos/${REPO}/releases/latest`

export type UpdateEvent =
  | { type: 'available'; result: UpdateCheckResult }
  | { type: 'progress'; received: number; total: number }
  | { type: 'downloaded'; file: string; verified: boolean }
  | { type: 'error'; message: string }

export class UpdateManager {
  private lastCheck: UpdateCheckResult | null = null
  private downloading = false
  private downloadedFile: string | null = null

  constructor(private readonly emit: (event: UpdateEvent) => void) {}

  /** 检查 GitHub 最新 Release；开发模式直接返回 dev，不联网 */
  async check(): Promise<UpdateCheckResult> {
    const currentVersion = app.getVersion()
    if (!app.isPackaged) {
      return {
        currentVersion,
        latestVersion: currentVersion,
        hasUpdate: false,
        dev: true,
        pageUrl: RELEASES_PAGE,
      }
    }
    try {
      const response = await net.fetch(API, {
        headers: {
          Accept: 'application/vnd.github+json',
          'User-Agent': `NovelStudio/${currentVersion}`,
        },
      })
      if (!response.ok) {
        throw new Error(`GitHub 返回 HTTP ${response.status}`)
      }
      const release = (await response.json()) as LatestRelease
      const result = buildUpdateCheckResult(release, currentVersion)
      this.lastCheck = result
      if (result.hasUpdate) this.emit({ type: 'available', result })
      return result
    } catch (err) {
      const message = `检查更新失败：${(err as Error).message}。可以手动打开 Releases 页面下载。`
      return {
        currentVersion,
        latestVersion: '',
        hasUpdate: false,
        dev: false,
        pageUrl: RELEASES_PAGE,
        error: message,
      }
    }
  }

  /** 下载安装包到临时目录，并按 SHA256SUMS 校验（拿不到校验文件时 verified=false） */
  async download(): Promise<{ file: string; verified: boolean }> {
    if (this.downloading) throw new Error('正在下载更新，请稍候')
    const check = this.lastCheck
    if (!check?.hasUpdate || !check.setup) throw new Error('没有可用的更新，请先检查更新')
    this.downloading = true
    try {
      const dir = path.join(app.getPath('temp'), 'novel-studio-update')
      fs.mkdirSync(dir, { recursive: true })
      const file = path.join(dir, check.setup.name)
      await this.downloadFile(check.setup.url, file, check.setup.size)
      let verified = false
      if (check.checksumsUrl) {
        try {
          const sumsResponse = await net.fetch(check.checksumsUrl, {
            headers: { 'User-Agent': `NovelStudio/${app.getVersion()}` },
          })
          if (sumsResponse.ok) {
            const expected = parseChecksum(await sumsResponse.text(), check.setup.name)
            if (expected) {
              verified = (await sha256File(file)) === expected
              if (!verified) throw new Error('安装包 SHA256 校验失败，可能下载不完整')
            }
          }
        } catch (err) {
          // 校验失败要阻止安装；网络失败则降级为未校验
          if ((err as Error).message.includes('SHA256')) throw err
        }
      }
      this.downloadedFile = file
      this.emit({ type: 'downloaded', file, verified })
      return { file, verified }
    } catch (err) {
      this.emit({ type: 'error', message: (err as Error).message })
      throw err
    } finally {
      this.downloading = false
    }
  }

  /** 打开下载好的安装包并退出应用（不做静默安装，用户仍可取消） */
  async install(): Promise<{ launched: boolean }> {
    if (!this.downloadedFile || !fs.existsSync(this.downloadedFile)) {
      throw new Error('还没有下载好的更新包，请先下载')
    }
    const error = await shell.openPath(this.downloadedFile)
    if (error) throw new Error(`无法启动安装包：${error}`)
    setTimeout(() => app.quit(), 800)
    return { launched: true }
  }

  openPage(): void {
    void shell.openExternal(this.lastCheck?.pageUrl ?? RELEASES_PAGE)
  }

  private async downloadFile(url: string, file: string, expectedSize: number): Promise<void> {
    const response = await net.fetch(url, {
      headers: { 'User-Agent': `NovelStudio/${app.getVersion()}` },
    })
    if (!response.ok || !response.body) throw new Error(`下载失败：HTTP ${response.status}`)
    const total = Number(response.headers.get('content-length') ?? expectedSize ?? 0)
    const reader = response.body.getReader()
    const stream = fs.createWriteStream(file)
    let received = 0
    let lastEmit = 0
    try {
      for (;;) {
        const { done, value } = await reader.read()
        if (done) break
        stream.write(Buffer.from(value))
        received += value.byteLength
        const now = Date.now()
        if (now - lastEmit > 400) {
          lastEmit = now
          this.emit({ type: 'progress', received, total })
        }
      }
    } finally {
      await new Promise<void>((resolve, reject) => {
        stream.end(() => resolve())
        stream.on('error', reject)
      })
    }
    this.emit({ type: 'progress', received, total })
  }
}

function sha256File(file: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const hash = crypto.createHash('sha256')
    const stream = fs.createReadStream(file)
    stream.on('data', (chunk) => hash.update(chunk))
    stream.on('error', reject)
    stream.on('end', () => resolve(hash.digest('hex')))
  })
}

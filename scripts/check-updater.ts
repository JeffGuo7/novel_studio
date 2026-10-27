/**
 * 更新链路演练（真实 GitHub Releases，不经过 UI）：
 *  1) 读取 latest release；
 *  2) 用 update-logic 做版本比较与资产选择（默认模拟当前 0.0.0，保证能走"发现新版本"分支）；
 *  3) 下载 SHA256SUMS，解析安装包 hash；
 *  4) --download 时真正下载安装包并校验 SHA256，然后删除临时文件。
 *
 * 运行：npm run doctor:update -- --download
 */
import crypto from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import {
  buildUpdateCheckResult,
  parseChecksum,
  type LatestRelease,
} from '../src/main/update-logic'

const REPO = 'JeffGuo7/novel_studio'
const API = `https://api.github.com/repos/${REPO}/releases/latest`

async function main(): Promise<void> {
  const download = process.argv.includes('--download')
  const simulatedCurrent = process.env.SIMULATE_CURRENT ?? '0.0.0'
  const token = process.env.GH_TOKEN || process.env.GITHUB_TOKEN
  const response = await fetch(API, {
    headers: {
      Accept: 'application/vnd.github+json',
      'User-Agent': 'NovelStudio-doctor',
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    },
  })
  if (!response.ok) throw new Error(`GitHub API HTTP ${response.status}`)
  const release = (await response.json()) as LatestRelease
  const result = buildUpdateCheckResult(release, simulatedCurrent)
  console.log(
    JSON.stringify(
      {
        latest: result.latestVersion,
        simulatedCurrent,
        hasUpdate: result.hasUpdate,
        setup: result.setup?.name ?? null,
        setupSizeMB: result.setup ? Number((result.setup.size / 1024 / 1024).toFixed(1)) : null,
        checksums: result.checksumsUrl ?? null,
        page: result.pageUrl ?? null,
      },
      null,
      2,
    ),
  )
  if (!result.hasUpdate || !result.setup) throw new Error('没有可用的更新资产')
  if (!result.checksumsUrl) throw new Error('Release 缺少 SHA256SUMS.txt')

  const sums = await (await fetch(result.checksumsUrl, { headers: { 'User-Agent': 'NovelStudio-doctor' } })).text()
  const expected = parseChecksum(sums, result.setup.name)
  if (!expected) throw new Error(`SHA256SUMS 里没有 ${result.setup.name} 的 hash`)
  console.log(`checksum: ${expected.slice(0, 16)}…`)

  if (!download) {
    console.log('未加 --download，只校验资产与校验和索引。')
    return
  }

  const target = path.join(os.tmpdir(), result.setup.name)
  const started = Date.now()
  const downloadResponse = await fetch(result.setup.url, {
    headers: { 'User-Agent': 'NovelStudio-doctor' },
  })
  if (!downloadResponse.ok || !downloadResponse.body) {
    throw new Error(`下载失败 HTTP ${downloadResponse.status}`)
  }
  const hash = crypto.createHash('sha256')
  const stream = fs.createWriteStream(target)
  let received = 0
  for await (const chunk of downloadResponse.body) {
    const buffer = Buffer.from(chunk as Uint8Array)
    hash.update(buffer)
    received += buffer.byteLength
    if (!stream.write(buffer)) {
      await new Promise<void>((resolve) => stream.once('drain', resolve))
    }
  }
  await new Promise<void>((resolve, reject) => {
    stream.end(resolve)
    stream.on('error', reject)
  })
  const actual = hash.digest('hex')
  const verified = actual === expected
  const seconds = Number(((Date.now() - started) / 1000).toFixed(1))
  console.log(
    JSON.stringify(
      {
        downloadedMB: Number((received / 1024 / 1024).toFixed(1)),
        sha256Match: verified,
        seconds,
        speedMBps: Number((received / 1024 / 1024 / Math.max(seconds, 0.1)).toFixed(2)),
      },
      null,
      2,
    ),
  )
  fs.unlinkSync(target)
  if (!verified) throw new Error('SHA256 校验失败')
}

void main().catch((err: Error) => {
  console.error(`更新链路演练失败：${err.message}`)
  process.exit(1)
})

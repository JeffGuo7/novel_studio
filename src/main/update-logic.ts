/**
 * 自定义更新检查（不依赖 electron-updater）：
 * 直接读 GitHub Releases API；下载安装包后可校验 SHA256，再交给系统安装器。
 * 纯逻辑部分放在这里，便于单测（不 import electron）。
 */

export interface ReleaseAsset {
  name: string
  size: number
  browser_download_url: string
}

export interface LatestRelease {
  tag_name: string
  name?: string
  body?: string
  published_at?: string
  html_url?: string
  assets: ReleaseAsset[]
}

export interface SetupAsset {
  name: string
  size: number
  url: string
}

export interface UpdateCheckResult {
  currentVersion: string
  latestVersion: string
  hasUpdate: boolean
  /** 开发模式 / 未打包 */
  dev: boolean
  notes?: string
  publishedAt?: string
  pageUrl?: string
  setup?: SetupAsset
  checksumsUrl?: string
  error?: string
}

/** 解析 "v0.21.0" / "0.21.0-beta.1" 为可比较数字；解析失败返回 null */
export function parseVersion(raw: string): { core: number[]; prerelease: boolean } | null {
  const text = String(raw ?? '').trim().replace(/^v/i, '')
  if (!text) return null
  const [corePart, pre] = text.split('-', 2)
  const core = corePart.split('.')
  if (core.length < 1 || core.length > 4) return null
  const numbers = core.map((item) => {
    if (!/^\d+$/.test(item)) return Number.NaN
    return Number(item)
  })
  if (numbers.some((item) => Number.isNaN(item))) return null
  return { core: numbers, prerelease: Boolean(pre) }
}

/** 语义化比较：a > b 返回 1，相等 0，a < b 返回 -1；无法解析视为相等 */
export function compareVersions(a: string, b: string): number {
  const left = parseVersion(a)
  const right = parseVersion(b)
  if (!left || !right) return 0
  const length = Math.max(left.core.length, right.core.length)
  for (let index = 0; index < length; index += 1) {
    const l = left.core[index] ?? 0
    const r = right.core[index] ?? 0
    if (l > r) return 1
    if (l < r) return -1
  }
  // 同版本号时，正式版 > 预发布版
  if (left.prerelease !== right.prerelease) return left.prerelease ? -1 : 1
  return 0
}

/** 从 release 资产里挑 Windows x64 安装包（优先 Setup，其次 Portable） */
export function pickSetupAsset(assets: ReleaseAsset[]): SetupAsset | null {
  const candidates = assets.filter((asset) => /\.exe$/i.test(asset.name))
  const setup = candidates.find((asset) => /setup/i.test(asset.name))
  const portable = candidates.find((asset) => /portable/i.test(asset.name))
  const chosen = setup ?? portable
  if (!chosen) return null
  return { name: chosen.name, size: chosen.size, url: chosen.browser_download_url }
}

export function findChecksumsAsset(assets: ReleaseAsset[]): string | null {
  const found = assets.find((asset) => /sha256sums\.txt$/i.test(asset.name))
  return found?.browser_download_url ?? null
}

/** 文件名归一化：GitHub 会把空格替换成点（Setup-...），SHA256SUMS 里仍是空格 */
export function normalizeAssetName(name: string): string {
  return String(name ?? '')
    .replace(/[.\s]+/g, ' ')
    .trim()
    .toLowerCase()
}

/** 从 SHA256SUMS 文本里取指定文件名的 hash（兼容空格/点差异） */
export function parseChecksum(text: string, fileName: string): string | null {
  const target = normalizeAssetName(fileName)
  for (const line of String(text ?? '').split(/\r?\n/)) {
    const trimmed = line.trim()
    if (!trimmed) continue
    const match = trimmed.match(/^([a-fA-F0-9]{64})\s+\*?(.+)$/)
    if (match && normalizeAssetName(match[2]) === target) return match[1].toLowerCase()
  }
  return null
}

/** 把 GitHub API 返回的 latest release 归一化成 UI 需要的结果 */
export function buildUpdateCheckResult(
  release: LatestRelease,
  currentVersion: string,
): UpdateCheckResult {
  const latestVersion = String(release.tag_name ?? '').replace(/^v/i, '')
  const setup = pickSetupAsset(release.assets ?? [])
  return {
    currentVersion,
    latestVersion,
    hasUpdate: compareVersions(latestVersion, currentVersion) > 0,
    dev: false,
    notes: String(release.body ?? '').slice(0, 4_000),
    publishedAt: release.published_at,
    pageUrl: release.html_url,
    setup: setup ?? undefined,
    checksumsUrl: findChecksumsAsset(release.assets ?? []) ?? undefined,
  }
}

import { describe, expect, it } from 'vitest'
import {
  buildUpdateCheckResult,
  compareVersions,
  findChecksumsAsset,
  parseChecksum,
  parseVersion,
  pickSetupAsset,
  type LatestRelease,
} from '../src/main/update-logic'

describe('版本比较', () => {
  it('解析 v 前缀与预发布版本', () => {
    expect(parseVersion('v0.21.0')).toEqual({ core: [0, 21, 0], prerelease: false })
    expect(parseVersion('0.21.0-beta.1')?.prerelease).toBe(true)
    expect(parseVersion('abc')).toBeNull()
    expect(parseVersion('1.x.0')).toBeNull()
  })

  it('数字逐段比较，正式版优先于预发布版', () => {
    expect(compareVersions('0.21.0', '0.20.9')).toBe(1)
    expect(compareVersions('0.21.0', '0.21.0')).toBe(0)
    expect(compareVersions('0.21.0', '0.22.0')).toBe(-1)
    expect(compareVersions('v1.0.0', '0.99.0')).toBe(1)
    expect(compareVersions('1.0.0', '1.0.0-beta.1')).toBe(1)
    expect(compareVersions('1.0', '1.0.0')).toBe(0)
    expect(compareVersions('bad', '1.0.0')).toBe(0)
  })
})

describe('Release 资产选择', () => {
  const assets = [
    { name: 'Novel.Studio-Portable-0.21.0-x64.exe', size: 110, browser_download_url: 'https://example.com/p.exe' },
    { name: 'Novel.Studio-Setup-0.21.0-x64.exe', size: 120, browser_download_url: 'https://example.com/s.exe' },
    { name: 'SHA256SUMS.txt', size: 1, browser_download_url: 'https://example.com/sums.txt' },
    { name: 'README.md', size: 2, browser_download_url: 'https://example.com/readme' },
  ]

  it('优先挑 Setup，其次 Portable', () => {
    expect(pickSetupAsset(assets)?.name).toContain('Setup')
    expect(pickSetupAsset(assets.slice(0, 1))?.name).toContain('Portable')
    expect(pickSetupAsset(assets.slice(2))).toBeNull()
  })

  it('找校验文件并解析指定文件的 hash', () => {
    expect(findChecksumsAsset(assets)).toContain('sums.txt')
    const text = [
      'a'.repeat(64) + '  Novel.Studio-Setup-0.21.0-x64.exe',
      'B'.repeat(64) + ' *Novel.Studio-Portable-0.21.0-x64.exe',
    ].join('\n')
    expect(parseChecksum(text, 'Novel.Studio-Setup-0.21.0-x64.exe')).toBe('a'.repeat(64))
    expect(parseChecksum(text, 'Novel.Studio-Portable-0.21.0-x64.exe')).toBe('b'.repeat(64))
    expect(parseChecksum(text, 'missing.exe')).toBeNull()
  })

  it('buildUpdateCheckResult 判断是否有新版本', () => {
    const release: LatestRelease = {
      tag_name: 'v0.21.0',
      body: '更新说明',
      html_url: 'https://github.com/x/y/releases/tag/v0.21.0',
      assets,
    }
    const newer = buildUpdateCheckResult(release, '0.20.0')
    expect(newer.hasUpdate).toBe(true)
    expect(newer.latestVersion).toBe('0.21.0')
    expect(newer.setup?.name).toContain('Setup')
    expect(newer.checksumsUrl).toContain('sums')

    const same = buildUpdateCheckResult(release, '0.21.0')
    expect(same.hasUpdate).toBe(false)
  })
})

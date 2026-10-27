import { describe, expect, it } from 'vitest'
import AdmZip from 'adm-zip'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import {
  assertSafeEntry,
  defaultBackupName,
  exportWorkspace,
  restoreWorkspace,
  scanWorkspaceHealth,
} from '../src/main/backup-core'
import { createBook, createGitPort, removeDirRecursive, saveBookFile } from '../src/core'

const git = createGitPort()

async function makeWorkspace(): Promise<string> {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'novel-backup-'))
  const book = await createBook(root, { title: '备份书甲' }, { git })
  await saveBookFile(book.dir, 'chapters/0001_开篇.md', '# 第 1 章 开篇\n\n雾从水面长出来。\n', 'init', { git })
  const book2 = await createBook(root, { title: '备份书乙' }, { git })
  await saveBookFile(book2.dir, 'chapters/0001_乙章.md', '# 第 1 章 乙章\n\n林牧在渡口。\n', 'init', { git })
  return root
}

describe('书库备份', () => {
  it('导出 zip 包含 manifest 与两本书，可恢复到新工作区', async () => {
    const workspace = await makeWorkspace()
    const restoreTarget = fs.mkdtempSync(path.join(os.tmpdir(), 'novel-restore-'))
    const zipFile = path.join(os.tmpdir(), `novel-backup-${Date.now()}.zip`)
    try {
      const report = exportWorkspace(workspace, zipFile)
      expect(report.books).toBe(2)
      expect(fs.existsSync(zipFile)).toBe(true)

      const zip = new AdmZip(zipFile)
      const manifest = JSON.parse(zip.readAsText('manifest.json')) as {
        format: string
        books: Array<{ title: string }>
      }
      expect(manifest.format).toBe('novel-studio-backup')
      expect(manifest.books.map((item) => item.title).sort()).toEqual(['备份书乙', '备份书甲'])
      // 嵌套 .git 也应在备份里（完整恢复历史）
      expect(zip.getEntries().some((entry) => entry.entryName.includes('.git/'))).toBe(true)

      const restored = restoreWorkspace(zipFile, restoreTarget)
      expect(restored.restored).toHaveLength(2)
      expect(restored.skipped).toHaveLength(0)
      const titles = fs
        .readdirSync(restoreTarget)
        .map((name) => JSON.parse(fs.readFileSync(path.join(restoreTarget, name, 'book.json'), 'utf8')).title)
      expect(titles.sort()).toEqual(['备份书乙', '备份书甲'])

      // 再次恢复：同名书跳过、不覆盖
      const again = restoreWorkspace(zipFile, restoreTarget)
      expect(again.restored).toHaveLength(0)
      expect(again.skipped).toHaveLength(2)
    } finally {
      removeDirRecursive(workspace)
      removeDirRecursive(restoreTarget)
      if (fs.existsSync(zipFile)) fs.unlinkSync(zipFile)
    }
  })

  it('拒绝 zip-slip 路径（../、绝对路径、盘符、反斜杠逃逸）', () => {
    expect(() => assertSafeEntry('../evil.txt')).toThrow(/不安全路径/)
    expect(() => assertSafeEntry('/etc/passwd')).toThrow(/不安全路径/)
    expect(() => assertSafeEntry('C:/Windows/system32')).toThrow(/不安全路径/)
    expect(() => assertSafeEntry('a\\..\\b.txt')).toThrow(/不安全路径/)
    expect(() => assertSafeEntry('书/章节/0001.md')).not.toThrow()
  })

  it('健康检查能发现损坏的 book.json', async () => {
    const workspace = await makeWorkspace()
    try {
      fs.mkdirSync(path.join(workspace, '坏书'), { recursive: true })
      fs.writeFileSync(path.join(workspace, '坏书', 'book.json'), '{ 不是 JSON', 'utf8')
      const health = scanWorkspaceHealth(workspace)
      expect(health.books).toBe(2)
      expect(health.broken).toHaveLength(1)
      expect(health.broken[0].dir).toBe('坏书')
    } finally {
      removeDirRecursive(workspace)
    }
  })

  it('默认备份文件名包含日期与 .zip', () => {
    const name = defaultBackupName(new Date('2026-10-28T09:05:00'))
    expect(name).toMatch(/^Novel-Studio-备份-20261028-0905\.zip$/)
  })
})

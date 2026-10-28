import { describe, expect, it } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createBook, createGitPort, removeDirRecursive } from '../src/core'
import { exportWorkspace, inspectBackup, restoreWorkspace } from '../src/main/backup-core'
import {
  autoBackupStatus,
  isAutoBackupDue,
  listBackupFiles,
  pruneAutoBackups,
  runAutoBackup,
} from '../src/main/backup-scheduler'

const git = createGitPort()

function tempDir(prefix: string): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix))
}

async function makeWorkspace(): Promise<string> {
  const root = tempDir('novel-backup-ws-')
  await createBook(root, { title: '第一本书', author: 'A' }, { git })
  await createBook(root, { title: '第二本书', author: 'B' }, { git })
  return root
}

describe('自动备份调度', () => {
  it('到期判断', () => {
    const day = 24 * 60 * 60 * 1000
    const now = 1_700_000_000_000
    expect(isAutoBackupDue(null, 3, now)).toBe(true)
    expect(isAutoBackupDue(now - day, 3, now)).toBe(false)
    expect(isAutoBackupDue(now - 3 * day, 3, now)).toBe(true)
    expect(isAutoBackupDue(now - 1000, 0, now)).toBe(true)
  })

  it('只清理旧的 auto-*，保留手动备份与最近 N 份', () => {
    const root = tempDir('novel-backup-files-')
    try {
      const files = ['auto-a.zip', 'auto-b.zip', 'auto-c.zip', 'manual-x.zip']
      files.forEach((name, index) => {
        const file = path.join(root, name)
        fs.writeFileSync(file, 'zip')
        const time = new Date(Date.now() - (10 - index) * 1000)
        fs.utimesSync(file, time, time)
      })
      const removed = pruneAutoBackups(root, 2)
      expect(removed.sort()).toEqual(['auto-a.zip'])
      const left = fs.readdirSync(root).sort()
      expect(left).toEqual(['auto-b.zip', 'auto-c.zip', 'manual-x.zip'])
      expect(listBackupFiles(root)[0].auto).toBe(false)
    } finally {
      removeDirRecursive(root)
    }
  })

  it('执行一次自动备份并生成状态', async () => {
    const workspace = await makeWorkspace()
    const root = tempDir('novel-backup-root-')
    try {
      const result = runAutoBackup(workspace, root, 5)
      expect(result.ran).toBe(true)
      expect(result.report?.books).toBe(2)
      expect(fs.existsSync(result.file!)).toBe(true)
      const status = autoBackupStatus(root, { enabled: true, intervalDays: 3, keep: 5 })
      expect(status.backups).toHaveLength(1)
      expect(status.backups[0].auto).toBe(true)
      expect(status.lastBackupAt).toBeTruthy()
      expect(status.due).toBe(false)
    } finally {
      removeDirRecursive(workspace)
      removeDirRecursive(root)
    }
  })
})

describe('备份检查 / 单本恢复', () => {
  it('inspect 返回书单与「当前是否已存在」', async () => {
    const workspace = await makeWorkspace()
    const zip = path.join(tempDir('novel-backup-zip-'), 'backup.zip')
    try {
      exportWorkspace(workspace, zip)
      const inspect = inspectBackup(zip, workspace)
      expect(inspect.books).toHaveLength(2)
      expect(inspect.books.every((book) => book.exists)).toBe(true)
      expect(inspect.books.map((book) => book.title).sort()).toEqual(['第一本书', '第二本书'])
      expect(inspect.exportedAt).toBeTruthy()

      const empty = tempDir('novel-backup-empty-')
      try {
        expect(inspectBackup(zip, empty).books.every((book) => !book.exists)).toBe(true)
      } finally {
        removeDirRecursive(empty)
      }
    } finally {
      removeDirRecursive(workspace)
      removeDirRecursive(path.dirname(zip))
    }
  })

  it('可只恢复选中的书；请求不存在的书会报错', async () => {
    const workspace = await makeWorkspace()
    const zip = path.join(tempDir('novel-backup-zip2-'), 'backup.zip')
    const target = tempDir('novel-backup-target-')
    try {
      exportWorkspace(workspace, zip)
      const inspect = inspectBackup(zip, target)
      const chosen = inspect.books[0].dir
      const report = restoreWorkspace(zip, target, { books: [chosen] })
      expect(report.restored).toEqual([chosen])
      expect(fs.readdirSync(target).filter((name) => name !== '.trash')).toEqual([chosen])

      const missing = restoreWorkspace(zip, target, { books: ['不存在的书'] })
      expect(missing.restored).toEqual([])
      expect(missing.errors[0]).toContain('备份里没有这本书')
    } finally {
      removeDirRecursive(workspace)
      removeDirRecursive(path.dirname(zip))
      removeDirRecursive(target)
    }
  })
})

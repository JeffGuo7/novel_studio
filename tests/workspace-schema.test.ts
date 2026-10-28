import { describe, expect, it } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createBook, createGitPort, removeDirRecursive } from '../src/core'
import {
  CURRENT_STUDIO_SCHEMA,
  CURRENT_WORKSPACE_SCHEMA,
  ensureAllSchemas,
  ensureBookSchema,
  ensureWorkspaceSchema,
  getWorkspaceSchemaVersion,
  runSchemaMigrations,
  studioSchemaPath,
  workspaceSchemaPath,
} from '../src/core/workspace-schema'

const git = createGitPort()

async function makeWorkspace(): Promise<{ root: string; books: string[] }> {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'novel-schema-'))
  const a = await createBook(root, { title: '书A' }, { git })
  const b = await createBook(root, { title: '书B' }, { git })
  return { root, books: [a.dir, b.dir] }
}

describe('工作区 / .studio schema 迁移', () => {
  it('首次启动写入版本文件，二次运行幂等', async () => {
    const { root, books } = await makeWorkspace()
    try {
      const report = ensureAllSchemas(root)
      expect(report.workspace.version).toBe(CURRENT_WORKSPACE_SCHEMA)
      expect(report.books).toBe(2)
      expect(report.migratedBooks).toBe(2)
      expect(fs.existsSync(workspaceSchemaPath(root))).toBe(true)
      for (const bookDir of books) {
        expect(fs.existsSync(studioSchemaPath(bookDir))).toBe(true)
        const parsed = JSON.parse(fs.readFileSync(studioSchemaPath(bookDir), 'utf8'))
        expect(parsed.schemaVersion).toBe(CURRENT_STUDIO_SCHEMA)
      }
      expect(getWorkspaceSchemaVersion(root)).toBe(CURRENT_WORKSPACE_SCHEMA)

      const again = ensureAllSchemas(root)
      expect(again.workspace.migrated).toBe(0)
      expect(again.migratedBooks).toBe(0)
    } finally {
      removeDirRecursive(root)
    }
  })

  it('拒绝比应用更新的数据版本，并给出可读错误', async () => {
    const { root, books } = await makeWorkspace()
    try {
      fs.writeFileSync(workspaceSchemaPath(root), JSON.stringify({ schemaVersion: 99 }), 'utf8')
      expect(() => ensureWorkspaceSchema(root)).toThrow(/更新/)

      const report = ensureAllSchemas(root)
      expect(report.errors.length).toBeGreaterThan(0)
      expect(report.errors[0].error).toContain('更新')

      fs.writeFileSync(studioSchemaPath(books[0]), JSON.stringify({ schemaVersion: 99 }), 'utf8')
      expect(() => ensureBookSchema(books[0])).toThrow(/更新/)
    } finally {
      removeDirRecursive(root)
    }
  })

  it('损坏的版本文件按 0 处理并自动重建', async () => {
    const { root } = await makeWorkspace()
    try {
      fs.mkdirSync(path.dirname(workspaceSchemaPath(root)), { recursive: true })
      fs.writeFileSync(workspaceSchemaPath(root), '{broken', 'utf8')
      const status = ensureWorkspaceSchema(root)
      expect(status.version).toBe(CURRENT_WORKSPACE_SCHEMA)
      expect(status.migrated).toBeGreaterThan(0)
    } finally {
      removeDirRecursive(root)
    }
  })

  it('迁移链按顺序执行，升级前备份原文件，失败时保留备份且不推进版本', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'novel-schema-chain-'))
    try {
      const schemaFile = path.join(root, 'schema.json')
      const dataFile = path.join(root, 'data.json')
      fs.writeFileSync(dataFile, '{"v":0}', 'utf8')
      const order: number[] = []
      const migrations = [
        {
          to: 1,
          description: 'v1',
          run: () => {
            order.push(1)
            fs.writeFileSync(dataFile, '{"v":1}', 'utf8')
          },
        },
        {
          to: 2,
          description: 'v2',
          run: () => {
            order.push(2)
            fs.writeFileSync(dataFile, '{"v":2}', 'utf8')
          },
        },
      ]
      const result = runSchemaMigrations({
        label: 'test',
        schemaFile,
        backupsRoot: path.join(root, 'backups'),
        backupPaths: [{ from: dataFile, to: 'data.json' }],
        migrations,
        currentVersion: 2,
      })
      expect(result.migrated).toBe(2)
      expect(order).toEqual([1, 2])
      expect(JSON.parse(fs.readFileSync(dataFile, 'utf8')).v).toBe(2)
      expect(result.backupDir && fs.existsSync(path.join(result.backupDir, 'data.json'))).toBe(true)

      // 失败迁移：版本不推进、备份保留
      fs.writeFileSync(schemaFile, JSON.stringify({ schemaVersion: 1 }), 'utf8')
      const failing = [
        {
          to: 2,
          description: 'boom',
          run: () => {
            throw new Error('迁移失败')
          },
        },
      ]
      expect(() =>
        runSchemaMigrations({
          label: 'test2',
          schemaFile,
          backupsRoot: path.join(root, 'backups'),
          backupPaths: [{ from: dataFile, to: 'data.json' }],
          migrations: failing,
          currentVersion: 2,
        }),
      ).toThrow('迁移失败')
      expect(JSON.parse(fs.readFileSync(schemaFile, 'utf8')).schemaVersion).toBe(1)
    } finally {
      removeDirRecursive(root)
    }
  })
})

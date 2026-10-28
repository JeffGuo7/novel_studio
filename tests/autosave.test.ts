import { describe, expect, it } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import {
  autosaveFilePath,
  discardAutosave,
  listAutosaves,
  readAutosave,
  removeDirRecursive,
  writeAutosave,
} from '../src/core'

function makeBook(): { root: string; bookDir: string } {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'novel-autosave-'))
  const bookDir = path.join(root, 'book')
  fs.mkdirSync(path.join(bookDir, '.studio'), { recursive: true })
  fs.writeFileSync(path.join(bookDir, 'book.json'), JSON.stringify({ title: '测试' }))
  return { root, bookDir }
}

function entry(id: string, content: string, updatedAt?: string) {
  return {
    id,
    kind: id.startsWith('chapter') ? ('chapter' as const) : ('knowledge' as const),
    chapterKey: id.startsWith('chapter') ? id.split(':')[1] : undefined,
    path: id.startsWith('knowledge') ? id.split(':')[1] : undefined,
    title: '测试',
    content,
    updatedAt: updatedAt ?? new Date().toISOString(),
    words: 0,
  }
}

describe('自动存档', () => {
  it('写入后可读取，并自动计算字数、更新时间', () => {
    const { root, bookDir } = makeBook()
    try {
      expect(listAutosaves(bookDir)).toEqual([])
      const written = writeAutosave(bookDir, entry('chapter:0001', '# 第 1 章\n\n雾从水面长出来。'))
      expect(written.words).toBe('#第1章雾从水面长出来。'.length)
      expect(readAutosave(bookDir, 'chapter:0001')?.content).toContain('雾从水面长出来')
      expect(fs.existsSync(autosaveFilePath(bookDir))).toBe(true)
    } finally {
      removeDirRecursive(root)
    }
  })

  it('同一 id 覆盖写，不同 id 按更新时间倒序', () => {
    const { root, bookDir } = makeBook()
    try {
      writeAutosave(bookDir, entry('chapter:0001', '第一版'))
      writeAutosave(bookDir, entry('knowledge:world_model.md', '世界模型'))
      writeAutosave(bookDir, entry('chapter:0001', '第二版'))
      const list = listAutosaves(bookDir)
      expect(list).toHaveLength(2)
      expect(list.find((item) => item.id === 'chapter:0001')?.content).toBe('第二版')
    } finally {
      removeDirRecursive(root)
    }
  })

  it('discard 删除指定条目，删除不存在返回 false', () => {
    const { root, bookDir } = makeBook()
    try {
      writeAutosave(bookDir, entry('chapter:0002', '草稿'))
      expect(discardAutosave(bookDir, 'chapter:0002')).toBe(true)
      expect(listAutosaves(bookDir)).toEqual([])
      expect(discardAutosave(bookDir, 'chapter:0002')).toBe(false)
    } finally {
      removeDirRecursive(root)
    }
  })

  it('非法 id / 损坏文件 / 过期条目不致命', () => {
    const { root, bookDir } = makeBook()
    try {
      expect(() => writeAutosave(bookDir, entry('chapter:99', 'x'))).toThrow('自动存档 id 非法')
      fs.mkdirSync(path.dirname(autosaveFilePath(bookDir)), { recursive: true })
      fs.writeFileSync(autosaveFilePath(bookDir), '{broken json')
      expect(listAutosaves(bookDir)).toEqual([])
      fs.writeFileSync(autosaveFilePath(bookDir), '{broken json')
      expect(() => writeAutosave(bookDir, entry('chapter:0001', '恢复'))).not.toThrow()
      const old = new Date(Date.now() - 30 * 24 * 3600 * 1000).toISOString()
      fs.writeFileSync(
        autosaveFilePath(bookDir),
        JSON.stringify({ version: 1, entries: [entry('chapter:0001', '旧', old)] }),
      )
      expect(listAutosaves(bookDir)).toEqual([])
    } finally {
      removeDirRecursive(root)
    }
  })
})

import { describe, expect, it } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import {
  createBook,
  createGitPort,
  deleteChapter,
  removeDirRecursive,
  saveBookFile,
  snapshotBook,
  writingStatsPath,
  writingStatsSummary,
} from '../src/core'
import { readWritingStats, recordWritingProgress, setWritingGoal } from '../src/core/stats'

const git = createGitPort()

async function makeBook() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'novel-stats-'))
  const book = await createBook(root, { title: '统计测试' }, { git })
  return { root, book }
}

function localDate(offsetDays = 0): string {
  const date = new Date()
  date.setDate(date.getDate() + offsetDays)
  const pad = (value: number): string => String(value).padStart(2, '0')
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`
}

describe('写作统计', () => {
  it('新增正文章节累加当天字数，重复快照不重复计数', async () => {
    const { root, book } = await makeBook()
    try {
      await saveBookFile(book.dir, 'chapters/0001_一.md', `# 第 1 章\n\n${'雾'.repeat(120)}\n`, 'init', { git })
      const first = await snapshotBook(book.dir, { git })
      expect(first.stats?.todayWords).toBeGreaterThan(100)
      expect(first.stats?.totalWords).toBe(first.chapters[0].words)

      const todayWords = first.stats!.todayWords
      await snapshotBook(book.dir, { git })
      const again = await snapshotBook(book.dir, { git })
      expect(again.stats?.todayWords).toBe(todayWords)

      await saveBookFile(book.dir, 'chapters/0002_二.md', `# 第 2 章\n\n${'雨'.repeat(80)}\n`, 'init', { git })
      const after = await snapshotBook(book.dir, { git })
      expect(after.stats!.todayWords).toBeGreaterThan(todayWords)
    } finally {
      removeDirRecursive(root)
    }
  })

  it('删除章节只更新基线，不把当天字数扣成负数', async () => {
    const { root, book } = await makeBook()
    try {
      await saveBookFile(book.dir, 'chapters/0001_一.md', `# 第 1 章\n\n${'雾'.repeat(100)}\n`, 'init', { git })
      const first = await snapshotBook(book.dir, { git })
      const todayWords = first.stats!.todayWords
      await deleteChapter(book.dir, '0001', { git })
      const after = await snapshotBook(book.dir, { git })
      expect(after.stats?.totalWords).toBe(0)
      expect(after.stats?.todayWords).toBe(todayWords)
    } finally {
      removeDirRecursive(root)
    }
  })

  it('连续写作天数：今天没写从昨天开始算；空档会中断', async () => {
    const { root, book } = await makeBook()
    try {
      const stats = readWritingStats(book.dir)
      stats.daily = {
        [localDate(0)]: 100,
        [localDate(-1)]: 200,
        [localDate(-2)]: 300,
        [localDate(-4)]: 50,
      }
      fs.mkdirSync(path.dirname(writingStatsPath(book.dir)), { recursive: true })
      fs.writeFileSync(
        writingStatsPath(book.dir),
        JSON.stringify({ version: 1, goalWords: 2000, lastTotal: 0, daily: stats.daily, updatedAt: '' }),
        'utf8',
      )
      const summary = writingStatsSummary(book.dir, 0)
      expect(summary.todayWords).toBe(100)
      expect(summary.streakDays).toBe(3)
      expect(summary.daily).toHaveLength(30)
      expect(summary.daily[summary.daily.length - 1].date).toBe(localDate(0))

      // 今天没写：从昨天开始数
      const onlyYesterday = {
        [localDate(-1)]: 200,
        [localDate(-2)]: 300,
      }
      fs.writeFileSync(
        writingStatsPath(book.dir),
        JSON.stringify({ version: 1, goalWords: 2000, lastTotal: 0, daily: onlyYesterday, updatedAt: '' }),
        'utf8',
      )
      expect(writingStatsSummary(book.dir, 0).streakDays).toBe(2)
      expect(writingStatsSummary(book.dir, 0).todayWords).toBe(0)
    } finally {
      removeDirRecursive(root)
    }
  })

  it('目标设置/上限/损坏文件自愈', async () => {
    const { root, book } = await makeBook()
    try {
      expect(readWritingStats(book.dir).goalWords).toBe(2000)
      expect(setWritingGoal(book.dir, 3500).goalWords).toBe(3500)
      expect(setWritingGoal(book.dir, -10).goalWords).toBe(0)
      expect(setWritingGoal(book.dir, 999_999).goalWords).toBe(100_000)

      fs.mkdirSync(path.dirname(writingStatsPath(book.dir)), { recursive: true })
      fs.writeFileSync(writingStatsPath(book.dir), '{broken', 'utf8')
      expect(readWritingStats(book.dir).goalWords).toBe(2000)
      expect(recordWritingProgress(book.dir, 500).lastTotal).toBe(500)
    } finally {
      removeDirRecursive(root)
    }
  })
})

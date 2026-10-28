/**
 * 写作统计：按天记录新增正文字数、总字数、连续写作天数与每日目标。
 *
 * - 数据存 .studio/stats.json（不进 Git），随每次书快照比较总字数自动累计；
 * - 只统计「正文章节」的字数：草稿、知识文件不计入（归档后才算）；
 * - 删除/回滚导致总字数下降时只更新基线，不产生负的每日字数；
 * - 一天内多次增加会累加到同一天。
 */
import path from 'node:path'
import type { WritingStatsDaily, WritingStatsSummary } from '../shared/types'
import { readFileOrNull, writeFileAtomic } from './fsutil'

const STATS_FILE = path.join('.studio', 'stats.json')
const STATS_VERSION = 1
const DEFAULT_GOAL_WORDS = 2_000
const KEEP_DAYS = 400
const HISTORY_DAYS = 30

interface StatsFile {
  version: 1
  goalWords: number
  /** 上一次记录的正文字数（用于算增量） */
  lastTotal: number
  /** YYYY-MM-DD -> 当天新增字数 */
  daily: Record<string, number>
  updatedAt: string
}

function dateKey(now: Date): string {
  const pad = (value: number): string => String(value).padStart(2, '0')
  return `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`
}

function shiftDate(now: Date, days: number): Date {
  const copy = new Date(now.getTime())
  copy.setDate(copy.getDate() + days)
  return copy
}

function defaultStats(): StatsFile {
  return { version: STATS_VERSION, goalWords: DEFAULT_GOAL_WORDS, lastTotal: 0, daily: {}, updatedAt: '' }
}

export function writingStatsPath(bookDir: string): string {
  return path.join(bookDir, STATS_FILE)
}

export function readWritingStats(bookDir: string): StatsFile {
  const raw = readFileOrNull(writingStatsPath(bookDir))
  if (!raw) return defaultStats()
  try {
    const parsed = JSON.parse(raw) as Partial<StatsFile>
    const daily: Record<string, number> = {}
    if (parsed.daily && typeof parsed.daily === 'object') {
      for (const [key, value] of Object.entries(parsed.daily)) {
        if (/^\d{4}-\d{2}-\d{2}$/.test(key) && typeof value === 'number' && value > 0) {
          daily[key] = Math.round(value)
        }
      }
    }
    return {
      version: STATS_VERSION,
      goalWords:
        typeof parsed.goalWords === 'number' && parsed.goalWords >= 0
          ? Math.min(Math.round(parsed.goalWords), 100_000)
          : DEFAULT_GOAL_WORDS,
      lastTotal: typeof parsed.lastTotal === 'number' && parsed.lastTotal >= 0 ? Math.round(parsed.lastTotal) : 0,
      daily,
      updatedAt: typeof parsed.updatedAt === 'string' ? parsed.updatedAt : '',
    }
  } catch {
    return defaultStats()
  }
}


function saveStats(bookDir: string, stats: StatsFile): void {
  stats.updatedAt = new Date().toISOString()
  // 只保留最近 KEEP_DAYS 天，避免文件无限增长
  const keys = Object.keys(stats.daily).sort()
  while (keys.length > KEEP_DAYS) {
    const dropped = keys.shift()
    if (dropped) delete stats.daily[dropped]
  }
  try {
    writeFileAtomic(writingStatsPath(bookDir), JSON.stringify(stats, null, 2))
  } catch {
    // 统计写失败不影响写作
  }
}

/**
 * 记录当前正文字数（快照时调用）：
 * - 增加 → 累加当天字数；
 * - 减少 → 只更新基线；
 * - 不变 → 不写盘。
 */
export function recordWritingProgress(
  bookDir: string,
  totalWords: number,
  now: Date = new Date(),
): StatsFile {
  const stats = readWritingStats(bookDir)
  const safeTotal = Math.max(0, Math.round(totalWords))
  if (safeTotal === stats.lastTotal) return stats
  if (safeTotal > stats.lastTotal) {
    const key = dateKey(now)
    stats.daily[key] = (stats.daily[key] ?? 0) + (safeTotal - stats.lastTotal)
  }
  stats.lastTotal = safeTotal
  saveStats(bookDir, stats)
  return stats
}

export function setWritingGoal(bookDir: string, goalWords: number): StatsFile {
  const stats = readWritingStats(bookDir)
  stats.goalWords = Math.max(0, Math.min(Math.round(goalWords) || 0, 100_000))
  saveStats(bookDir, stats)
  return stats
}

function streakDays(daily: Record<string, number>, now: Date): number {
  let cursor = new Date(now.getTime())
  // 今天还没写不算断：从昨天开始数
  if (!daily[dateKey(cursor)]) cursor = shiftDate(cursor, -1)
  let streak = 0
  while (daily[dateKey(cursor)] && daily[dateKey(cursor)] > 0) {
    streak += 1
    cursor = shiftDate(cursor, -1)
  }
  return streak
}

/** 生成给 UI 的摘要（最近 30 天 + 今日/连续天数/目标） */
export function writingStatsSummary(
  bookDir: string,
  totalWords: number,
  now: Date = new Date(),
): WritingStatsSummary {
  const stats = readWritingStats(bookDir)
  const todayKey = dateKey(now)
  const daily: WritingStatsDaily[] = []
  for (let offset = HISTORY_DAYS - 1; offset >= 0; offset -= 1) {
    const key = dateKey(shiftDate(now, -offset))
    daily.push({ date: key, words: stats.daily[key] ?? 0 })
  }
  return {
    todayWords: stats.daily[todayKey] ?? 0,
    goalWords: stats.goalWords,
    totalWords: Math.max(0, Math.round(totalWords)),
    streakDays: streakDays(stats.daily, now),
    daily,
    updatedAt: stats.updatedAt,
  }
}

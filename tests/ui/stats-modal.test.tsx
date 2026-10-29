// @vitest-environment jsdom
import { beforeAll, beforeEach, afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import type { WritingStatsSummary } from '@shared/types'
import type { ReactElement } from 'react'

const daily = Array.from({ length: 14 }, (_, index) => ({
  date: `2026-10-${String(index + 1).padStart(2, '0')}`,
  words: index === 13 ? 390 : 0,
}))
const summary: WritingStatsSummary = {
  todayWords: 390,
  goalWords: 2000,
  totalWords: 5000,
  streakDays: 3,
  daily,
  updatedAt: '2026-10-14T00:00:00.000Z',
}

const api = {
  stats: {
    get: vi.fn(async () => ({ ok: true, data: summary })),
    setGoal: vi.fn(async () => ({ ok: true, data: { ...summary, goalWords: 1000 } })),
  },
}

let StatsModal: (props: Record<string, unknown>) => ReactElement
const React = await import('react')

beforeAll(async () => {
  ;(window as unknown as { studio: unknown }).studio = api
  StatsModal = (await import('../../src/renderer/src/components/StatsModal')).default
})

beforeEach(() => vi.clearAllMocks())
afterEach(() => cleanup())

describe('写作统计弹窗', () => {
  it('展示今日/总字数/连续天数/进度，并可保存每日目标', async () => {
    const notify = vi.fn()
    render(
      React.createElement(StatsModal, {
        open: true,
        dir: '/library/book',
        bookTitle: '统计测试',
        notify,
        onClose: vi.fn(),
      }),
    )

    expect(await screen.findByText('写作统计 ·《统计测试》')).toBeTruthy()
    expect(screen.getByText('390')).toBeTruthy()
    expect(screen.getByText('5,000')).toBeTruthy()
    expect(screen.getByText('3 天')).toBeTruthy()
    expect(screen.getByText('20%')).toBeTruthy() // 390 / 2000
    expect(api.stats.get).toHaveBeenCalledWith({ dir: '/library/book' })

    const goalInput = document.querySelector('.stats-goal__input') as HTMLInputElement
    fireEvent.change(goalInput, { target: { value: '1000' } })
    fireEvent.click(screen.getByText('保存目标'))

    await waitFor(() => expect(api.stats.setGoal).toHaveBeenCalledWith({ dir: '/library/book', goalWords: 1000 }))
    expect(notify).toHaveBeenCalledWith('每日目标已设为 1000 字')
  })
})

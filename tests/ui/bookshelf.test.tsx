// @vitest-environment jsdom
import { beforeAll, beforeEach, afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import type { BookSnapshot } from '@shared/types'
import type { ReactElement } from 'react'

function makeBook(overrides: Partial<BookSnapshot> & { title: string }): BookSnapshot {
  const now = '2026-10-01T00:00:00.000Z'
  return {
    dir: `/library/${overrides.title}`,
    meta: {
      schemaVersion: 1,
      id: overrides.title,
      title: overrides.title,
      author: '测试作者',
      createdAt: now,
      updatedAt: now,
      ...overrides.meta,
    },
    chapters: [{ key: '0001', number: 1, title: '第一章', path: 'chapters/0001_第一章.md', words: 100, hasDraft: false, draftVersions: 0 }],
    knowledge: [],
    orphanDraftKeys: [],
    head: null,
    branch: 'main',
    stats: { todayWords: 0, goalWords: 2000, totalWords: 100, streakDays: 0, daily: [], updatedAt: '' },
    ...overrides,
  }
}

const books = [
  makeBook({ title: '雾海纪事', meta: { schemaVersion: 1, id: 'a', title: '雾海纪事', author: '甲', createdAt: '2026-10-01T00:00:00.000Z', updatedAt: '2026-10-01T00:00:00.000Z', description: '雾里的渡口' } }),
  makeBook({ title: '临渊行', meta: { schemaVersion: 1, id: 'b', title: '临渊行', author: '乙', createdAt: '2026-10-02T00:00:00.000Z', updatedAt: '2026-10-02T00:00:00.000Z' }, lastOpenedAt: '2026-10-03T00:00:00.000Z' }),
]

type StudioMock = Record<string, ReturnType<typeof vi.fn>>

const api: StudioMock = {
  createBook: vi.fn(),
  deleteBook: vi.fn(async () => ({ ok: true, data: { trashedTo: '/trash' } })),
  updateBookInfo: vi.fn(async () => ({ ok: true, data: books[1] })),
  setBookCover: vi.fn(),
  clearBookCover: vi.fn(),
}

let Bookshelf: (props: Record<string, unknown>) => ReactElement
const React = await import('react')

beforeAll(async () => {
  ;(window as unknown as { studio: unknown }).studio = api
  Bookshelf = (await import('../../src/renderer/src/components/Bookshelf')).default
})

beforeEach(() => {
  vi.clearAllMocks()
})

afterEach(() => cleanup())

describe('书架组件', () => {
  it('渲染书籍卡片，搜索与排序生效（默认最近打开）', async () => {
    render(
      React.createElement(Bookshelf, {
        books,
        loading: false,
        onRefresh: vi.fn(async () => undefined),
        onOpen: vi.fn(),
        onOpenSettings: vi.fn(),
        notify: vi.fn(),
        hasApiKey: true,
      }),
    )
    expect(screen.getByText('雾海纪事')).toBeTruthy()
    expect(screen.getByText('临渊行')).toBeTruthy()
    // 默认最近打开：临渊行在前
    const cards = screen.getAllByRole('heading', { level: 3 })
    expect(cards[0].textContent).toBe('临渊行')

    fireEvent.change(screen.getByPlaceholderText('搜索书名 / 作者 / 简介'), {
      target: { value: '雾海' },
    })
    expect(screen.queryByText('临渊行')).toBeNull()
    expect(screen.getByText('雾海纪事')).toBeTruthy()

    fireEvent.change(screen.getByPlaceholderText('搜索书名 / 作者 / 简介'), { target: { value: '' } })
    fireEvent.change(screen.getByLabelText('书架排序'), { target: { value: 'title' } })
    const sorted = screen.getAllByRole('heading', { level: 3 })
    expect(sorted[0].textContent).toBe('临渊行')
  })

  it('编辑书籍信息：打开弹窗并提交更新', async () => {
    render(
      React.createElement(Bookshelf, {
        books,
        loading: false,
        onRefresh: vi.fn(async () => undefined),
        onOpen: vi.fn(),
        onOpenSettings: vi.fn(),
        notify: vi.fn(),
        hasApiKey: true,
      }),
    )
    fireEvent.click(screen.getByLabelText('编辑《临渊行》'))
    expect(await screen.findByText('编辑书籍信息')).toBeTruthy()

    fireEvent.change(screen.getByLabelText('书名'), { target: { value: '临渊行·改' } })
    fireEvent.change(screen.getByLabelText('作者'), { target: { value: '新作者' } })
    fireEvent.change(screen.getByLabelText('简介'), { target: { value: '新简介' } })
    fireEvent.click(screen.getByText('保存'))

    await waitFor(() => expect(api.updateBookInfo).toHaveBeenCalledTimes(1))
    expect(api.updateBookInfo).toHaveBeenCalledWith({
      dir: books[1].dir,
      title: '临渊行·改',
      author: '新作者',
      description: '新简介',
    })
  })
})

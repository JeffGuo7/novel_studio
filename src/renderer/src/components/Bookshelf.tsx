import { useMemo, useState } from 'react'
import { BookPlus, Library, Pencil, Plus, Search, Settings, Trash2 } from 'lucide-react'
import type { BookSnapshot } from '@shared/types'
import { studio, unwrap, formatWords } from '../lib/api'
import logo from '../assets/logo.png'
import BookInfoModal from './BookInfoModal'

interface Props {
  books: BookSnapshot[]
  loading: boolean
  onRefresh: () => Promise<void>
  onOpen: (dir: string) => void
  onOpenSettings: () => void
  notify: (text: string, error?: boolean) => void
  /** 是否已配置模型；null = 还没读到设置 */
  hasApiKey: boolean | null
}

type SortMode = 'recent' | 'created' | 'title'

export default function Bookshelf({ books, loading, onRefresh, onOpen, onOpenSettings, notify, hasApiKey }: Props) {
  const [title, setTitle] = useState('')
  const [author, setAuthor] = useState('')
  const [busy, setBusy] = useState(false)
  const [search, setSearch] = useState('')
  const [sort, setSort] = useState<SortMode>('recent')
  const [editing, setEditing] = useState<BookSnapshot | null>(null)

  const visibleBooks = useMemo(() => {
    const keyword = search.trim().toLowerCase()
    const filtered = keyword
      ? books.filter((book) => {
          const haystack = `${book.meta.title}\n${book.meta.author}\n${book.meta.description ?? ''}`.toLowerCase()
          return haystack.includes(keyword)
        })
      : books
    return [...filtered].sort((a, b) => {
      if (sort === 'title') return a.meta.title.localeCompare(b.meta.title, 'zh-Hans-CN')
      if (sort === 'created') return Date.parse(b.meta.createdAt) - Date.parse(a.meta.createdAt)
      const recentA = a.lastOpenedAt ? Date.parse(a.lastOpenedAt) : 0
      const recentB = b.lastOpenedAt ? Date.parse(b.lastOpenedAt) : 0
      if (recentA !== recentB) return recentB - recentA
      return Date.parse(b.meta.createdAt) - Date.parse(a.meta.createdAt)
    })
  }, [books, search, sort])

  const remove = async (book: BookSnapshot) => {
    if (busy) return
    const ok = window.confirm(
      `把《${book.meta.title}》移到书库回收站？\n\n目录会被移到 .trash，之后可以手动取回；不会进 Git 历史。`,
    )
    if (!ok) return
    setBusy(true)
    try {
      await unwrap(studio.deleteBook({ dir: book.dir }))
      await onRefresh()
      notify(`《${book.meta.title}》已移到回收站`)
    } catch (err) {
      notify((err as Error).message, true)
    } finally {
      setBusy(false)
    }
  }

  const create = async () => {
    const trimmed = title.trim()
    if (!trimmed || busy) return
    setBusy(true)
    try {
      const book = await unwrap(studio.createBook({ title: trimmed, author: author.trim() || undefined }))
      setTitle('')
      await onRefresh()
      notify(`已创建《${book.meta.title}》`)
      onOpen(book.dir)
    } catch (err) {
      notify((err as Error).message, true)
    } finally {
      setBusy(false)
    }
  }

  const handleSaved = (book: BookSnapshot): void => {
    setEditing(book)
    void onRefresh()
  }

  return (
    <div className="shelf">
      <button className="ghost shelf__settings" onClick={onOpenSettings}>
        <Settings size={15} />
        本机配置
      </button>

      <div className="shelf__brand">
        <img className="shelf__logo" src={logo} alt="Novel Studio" />
        <h1>Novel Studio</h1>
        <p>本地优先的小说创作工作台 · 每一章都有版本</p>
      </div>

      {books.length > 0 && (
        <div className="shelf__toolbar">
          <div className="shelf__search">
            <Search size={14} />
            <input
              placeholder="搜索书名 / 作者 / 简介"
              value={search}
              onChange={(event) => setSearch(event.target.value)}
            />
          </div>
          <select
            className="shelf__sort"
            value={sort}
            onChange={(event) => setSort(event.target.value as SortMode)}
            aria-label="书架排序"
          >
            <option value="recent">最近打开</option>
            <option value="created">最新创建</option>
            <option value="title">书名 A-Z</option>
          </select>
          <span className="shelf__count">{visibleBooks.length} / {books.length} 本</span>
        </div>
      )}

      {visibleBooks.length > 0 && (
        <div className="shelf__grid">
          {visibleBooks.map((book) => {
            const words = book.chapters.reduce((sum, chapter) => sum + chapter.words, 0)
            const monogram = book.meta.title.trim().slice(0, 1) || '书'
            return (
              <div key={book.dir} className="book-card-wrap">
                <button className="book-card" onClick={() => onOpen(book.dir)}>
                  {book.coverDataUrl ? (
                    <img className="book-card__cover" src={book.coverDataUrl} alt="" />
                  ) : (
                    <span className="book-card__monogram">{monogram}</span>
                  )}
                  <span className="book-card__body">
                    <h3>{book.meta.title}</h3>
                    {book.meta.description && (
                      <span className="book-card__desc">{book.meta.description}</span>
                    )}
                    <span className="meta">
                      <span>{book.chapters.length} 章</span>
                      <span>{formatWords(words)}</span>
                      {book.meta.author !== '佚名' && <span>{book.meta.author}</span>}
                    </span>
                  </span>
                </button>
                <button
                  className="ghost icon-btn book-card__edit"
                  title="编辑书籍信息"
                  aria-label={`编辑《${book.meta.title}》`}
                  onClick={(event) => {
                    event.stopPropagation()
                    setEditing(book)
                  }}
                >
                  <Pencil size={14} />
                </button>
                <button
                  className="ghost icon-btn book-card__delete"
                  title="删除本书（移到回收站）"
                  aria-label={`删除《${book.meta.title}》`}
                  onClick={(event) => {
                    event.stopPropagation()
                    void remove(book)
                  }}
                >
                  <Trash2 size={14} />
                </button>
              </div>
            )
          })}
        </div>
      )}

      {books.length > 0 && visibleBooks.length === 0 && (
        <div className="shelf__no-result">没有匹配「{search.trim()}」的书。</div>
      )}

      {!loading && books.length === 0 && (
        <div className="empty">
          <Library size={22} style={{ marginBottom: 10, color: 'var(--faint)' }} />
          {hasApiKey === false ? (
            <>
              <div className="onboarding__title">三步开始你的第一本书</div>
              <ol className="onboarding__steps">
                <li>
                  <span>先配置模型</span>
                  <button className="ghost" onClick={onOpenSettings}>
                    <Settings size={14} />
                    配置模型
                  </button>
                </li>
                <li>
                  <span>在下面输入书名，点「新建书」</span>
                </li>
                <li>
                  <span>打开书 → 在「助手」里让 Agent 续写，或自己写第一章</span>
                </li>
              </ol>
            </>
          ) : hasApiKey ? (
            <div>模型已就绪。在下面输入书名，开始你的第一本。</div>
          ) : (
            <div>还没有书。在下面输入书名，开始你的第一本。</div>
          )}
        </div>
      )}

      <div className="shelf__create">
        <input
          placeholder="书名，例如：临渊行"
          value={title}
          onChange={(event) => setTitle(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === 'Enter') void create()
          }}
        />
        <input
          placeholder="作者（可选）"
          style={{ maxWidth: 170 }}
          value={author}
          onChange={(event) => setAuthor(event.target.value)}
        />
        <button className="primary" disabled={!title.trim() || busy} onClick={() => void create()}>
          {busy ? <BookPlus size={15} /> : <Plus size={15} />}
          新建书
        </button>
      </div>
      <div className="shelf__hint">
        书库位置：系统「文档」文件夹下的 NovelStudio 目录（可用 NOVEL_STUDIO_HOME 覆盖）
      </div>

      <BookInfoModal
        open={Boolean(editing)}
        book={editing}
        notify={notify}
        onSaved={handleSaved}
        onClose={() => setEditing(null)}
      />
    </div>
  )
}

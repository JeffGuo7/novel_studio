import { useState } from 'react'
import { BookPlus, Library, Plus, Settings, Trash2 } from 'lucide-react'
import type { BookSnapshot } from '@shared/types'
import { studio, unwrap, formatWords } from '../lib/api'
import logo from '../assets/logo.png'

interface Props {
  books: BookSnapshot[]
  loading: boolean
  onRefresh: () => Promise<void>
  onOpen: (dir: string) => void
  onOpenSettings: () => void
  notify: (text: string, error?: boolean) => void
}

export default function Bookshelf({ books, loading, onRefresh, onOpen, onOpenSettings, notify }: Props) {
  const [title, setTitle] = useState('')
  const [author, setAuthor] = useState('')
  const [busy, setBusy] = useState(false)

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
        <div className="shelf__grid">
          {books.map((book) => {
            const words = book.chapters.reduce((sum, chapter) => sum + chapter.words, 0)
            const monogram = book.meta.title.trim().slice(0, 1) || '书'
            return (
              <div key={book.dir} className="book-card-wrap">
                <button className="book-card" onClick={() => onOpen(book.dir)}>
                  <span className="book-card__monogram">{monogram}</span>
                  <span className="book-card__body">
                    <h3>{book.meta.title}</h3>
                    <span className="meta">
                      <span>{book.chapters.length} 章</span>
                      <span>{formatWords(words)}</span>
                      {book.meta.author !== '佚名' && <span>{book.meta.author}</span>}
                    </span>
                  </span>
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

      {!loading && books.length === 0 && (
        <div className="empty">
          <Library size={22} style={{ marginBottom: 10, color: 'var(--faint)' }} />
          <div>还没有书。先配置模型，再在下面输入书名，开始你的第一本。</div>
          <button className="ghost" style={{ marginTop: 12 }} onClick={onOpenSettings}>
            <Settings size={14} />
            配置模型
          </button>
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
    </div>
  )
}

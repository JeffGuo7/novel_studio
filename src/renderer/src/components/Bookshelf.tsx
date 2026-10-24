import { useState } from 'react'
import type { BookSnapshot } from '@shared/types'
import { studio, unwrap, formatWords } from '../lib/api'

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
      <button className="shelf__settings" onClick={onOpenSettings}>
        ⚙ 本机配置
      </button>
      <div className="shelf__brand">
        <h1>Novel Studio</h1>
        <p>本地优先的小说创作工作台 · 每一章都有版本</p>
      </div>

      {books.length > 0 && (
        <div className="shelf__grid">
          {books.map((book) => {
            const words = book.chapters.reduce((sum, chapter) => sum + chapter.words, 0)
            return (
              <button key={book.dir} className="book-card" onClick={() => onOpen(book.dir)}>
                <h3>{book.meta.title}</h3>
                <div className="meta">
                  <span>{book.chapters.length} 章</span>
                  <span>{formatWords(words)}</span>
                  {book.meta.author !== '佚名' && <span>{book.meta.author}</span>}
                </div>
              </button>
            )
          })}
        </div>
      )}

      {!loading && books.length === 0 && (
        <div className="empty">还没有书。在下面输入书名，开始你的第一本。</div>
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
          新建书
        </button>
      </div>
      <div className="shelf__hint">书库位置：系统「文档」文件夹下的 NovelStudio 目录（可用 NOVEL_STUDIO_HOME 覆盖）</div>
    </div>
  )
}

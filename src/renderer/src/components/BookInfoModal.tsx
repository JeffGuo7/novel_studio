import { useEffect, useState } from 'react'
import { ImagePlus, Loader2, Pencil, Save, Trash2, X } from 'lucide-react'
import type { BookSnapshot } from '@shared/types'
import { studio, unwrap } from '../lib/api'
import { useDialog } from '../lib/useDialog'

interface Props {
  open: boolean
  book: BookSnapshot | null
  notify: (text: string, error?: boolean) => void
  onSaved: (book: BookSnapshot) => void
  onClose: () => void
}

export default function BookInfoModal({ open, book, notify, onSaved, onClose }: Props) {
  const dialogRef = useDialog(open, onClose)
  const [title, setTitle] = useState('')
  const [author, setAuthor] = useState('')
  const [description, setDescription] = useState('')
  const [busy, setBusy] = useState(false)
  const [local, setLocal] = useState<BookSnapshot | null>(null)

  useEffect(() => {
    if (!open) return
    setLocal(book)
    setTitle(book?.meta.title ?? '')
    setAuthor(book?.meta.author === '佚名' ? '' : book?.meta.author ?? '')
    setDescription(book?.meta.description ?? '')
    setBusy(false)
  }, [open, book])

  if (!open || !book) return null

  const snapshot = local ?? book

  const save = async () => {
    if (busy || !title.trim()) return
    setBusy(true)
    try {
      const next = await unwrap(
        studio.updateBookInfo({
          dir: book.dir,
          title: title.trim(),
          author: author.trim(),
          description: description.trim(),
        }),
      )
      setLocal(next)
      onSaved(next)
      notify('书籍信息已保存')
      onClose()
    } catch (err) {
      notify((err as Error).message, true)
    } finally {
      setBusy(false)
    }
  }

  const chooseCover = async () => {
    if (busy) return
    setBusy(true)
    try {
      const result = await unwrap(studio.setBookCover({ dir: book.dir }))
      if (result.canceled || !result.snapshot) return
      setLocal(result.snapshot)
      onSaved(result.snapshot)
      notify('封面已更新')
    } catch (err) {
      notify((err as Error).message, true)
    } finally {
      setBusy(false)
    }
  }

  const removeCover = async () => {
    if (busy) return
    setBusy(true)
    try {
      const next = await unwrap(studio.clearBookCover({ dir: book.dir }))
      setLocal(next)
      onSaved(next)
      notify('封面已删除')
    } catch (err) {
      notify((err as Error).message, true)
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div
        ref={dialogRef}
        className="modal book-info-modal"
        role="dialog"
        aria-modal="true"
        onClick={(event) => event.stopPropagation()}
      >
        <div className="modal__header">
          <Pencil size={17} style={{ color: 'var(--accent)' }} />
          <div className="modal__title">编辑书籍信息</div>
          <div className="modal__spacer" />
          <button className="ghost icon-btn" onClick={onClose} aria-label="关闭">
            <X size={16} />
          </button>
        </div>

        <div className="modal__body book-info-body">
          <div className="book-info-cover">
            <div className="book-info-cover__preview">
              {snapshot.coverDataUrl ? (
                <img src={snapshot.coverDataUrl} alt="书籍封面" />
              ) : (
                <span>{snapshot.meta.title.trim().slice(0, 1) || '书'}</span>
              )}
            </div>
            <div className="book-info-cover__actions">
              <button onClick={() => void chooseCover()} disabled={busy}>
                <ImagePlus size={14} />
                选择封面
              </button>
              {snapshot.coverDataUrl && (
                <button className="danger" onClick={() => void removeCover()} disabled={busy}>
                  <Trash2 size={14} />
                  删除封面
                </button>
              )}
              <span className="settings-hint">PNG / JPG / WebP，≤ 2.5MB</span>
            </div>
          </div>

          <label className="field-label" htmlFor="book-title">
            书名
          </label>
          <input id="book-title" value={title} onChange={(event) => setTitle(event.target.value)} maxLength={80} />

          <label className="field-label" htmlFor="book-author">
            作者
          </label>
          <input
            id="book-author"
            value={author}
            onChange={(event) => setAuthor(event.target.value)}
            placeholder="佚名"
          />

          <label className="field-label" htmlFor="book-desc">
            简介
          </label>
          <textarea
            id="book-desc"
            className="book-info-desc"
            value={description}
            onChange={(event) => setDescription(event.target.value)}
            placeholder="一句话介绍这本书（可选）"
            maxLength={2000}
          />
          <div className="settings-hint">
            修改书名不会移动书目录（避免破坏书库路径）；目录名保持创建时的样子。
          </div>
        </div>

        <div className="modal__footer">
          <button className="ghost" onClick={onClose} disabled={busy}>
            取消
          </button>
          <button className="primary" onClick={() => void save()} disabled={busy || !title.trim()}>
            {busy ? <Loader2 size={14} className="spin" /> : <Save size={14} />}
            保存
          </button>
        </div>
      </div>
    </div>
  )
}

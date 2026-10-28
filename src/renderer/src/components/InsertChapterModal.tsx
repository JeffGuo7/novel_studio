import { useEffect, useRef, useState } from 'react'
import { FilePlus, X } from 'lucide-react'
import { useDialog } from '../lib/useDialog'

interface Props {
  open: boolean
  position: 'before' | 'after'
  chapterTitle: string
  busy: boolean
  onConfirm: (title: string) => void
  onClose: () => void
}

export default function InsertChapterModal({ open, position, chapterTitle, busy, onConfirm, onClose }: Props) {
  const dialogRef = useDialog(open, onClose)
  const inputRef = useRef<HTMLInputElement | null>(null)
  const [title, setTitle] = useState('')

  useEffect(() => {
    if (!open) return
    setTitle('')
    setTimeout(() => inputRef.current?.focus(), 30)
  }, [open])

  if (!open) return null

  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div
        ref={dialogRef}
        className="modal insert-modal"
        role="dialog"
        aria-modal="true"
        onClick={(event) => event.stopPropagation()}
      >
        <div className="modal__header">
          <FilePlus size={17} style={{ color: 'var(--accent)' }} />
          <div className="modal__title">在「{chapterTitle}」{position === 'before' ? '前面' : '后面'}插入章节</div>
          <div className="modal__spacer" />
          <button className="ghost icon-btn" onClick={onClose} aria-label="关闭">
            <X size={16} />
          </button>
        </div>
        <div className="modal__body">
          <label className="field-label" htmlFor="insert-chapter-title">
            章节标题
          </label>
          <input
            id="insert-chapter-title"
            ref={inputRef}
            value={title}
            placeholder="例如：雾夜来客"
            onChange={(event) => setTitle(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === 'Enter' && !busy && title.trim()) onConfirm(title.trim())
            }}
          />
          <div className="settings-hint">
            插入后，后面的章节会自动顺延编号；文件名和标题编号都会更新，历史仍可从旧提交找回。
          </div>
        </div>
        <div className="modal__footer">
          <button className="ghost" onClick={onClose} disabled={busy}>
            取消
          </button>
          <button className="primary" onClick={() => onConfirm(title.trim())} disabled={busy || !title.trim()}>
            插入章节
          </button>
        </div>
      </div>
    </div>
  )
}

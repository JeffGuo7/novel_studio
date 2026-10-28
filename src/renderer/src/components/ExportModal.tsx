import { useEffect, useState } from 'react'
import { BookOpen, Download, FileText, FolderOpen, Loader2, X } from 'lucide-react'
import type { ExportFormat } from '@shared/types'
import { studio, unwrap } from '../lib/api'
import { useDialog } from '../lib/useDialog'

interface Props {
  open: boolean
  dir: string
  bookTitle: string
  chapters: number
  words: number
  notify: (text: string, error?: boolean) => void
  onClose: () => void
}

const FORMATS: Array<{
  id: ExportFormat
  title: string
  description: string
  icon: typeof BookOpen
}> = [
  {
    id: 'epub',
    title: 'EPUB',
    description: '标准电子书格式，适合阅读器、自出版；自动生成目录与章节。',
    icon: BookOpen,
  },
  {
    id: 'md',
    title: 'Markdown',
    description: '合并成单个 .md 文件，便于备份、二次编辑或导入其他写作工具。',
    icon: FileText,
  },
  {
    id: 'txt',
    title: 'TXT',
    description: '纯文本，适合网文平台发布或直接分享（会去掉 Markdown 标记）。',
    icon: FileText,
  },
]

export default function ExportModal({ open, dir, bookTitle, chapters, words, notify, onClose }: Props) {
  const dialogRef = useDialog(open, onClose)
  const [format, setFormat] = useState<ExportFormat>('epub')
  const [busy, setBusy] = useState(false)
  const [result, setResult] = useState<{ file: string; chapters: number; bytes: number } | null>(null)

  useEffect(() => {
    if (!open) return
    setFormat('epub')
    setBusy(false)
    setResult(null)
  }, [open])

  if (!open) return null

  const runExport = async () => {
    if (busy) return
    setBusy(true)
    try {
      const response = await unwrap(studio.exportBook({ dir, format }))
      if (response.canceled || !response.file) return
      setResult({
        file: response.file,
        chapters: response.chapters ?? chapters,
        bytes: response.bytes ?? 0,
      })
      notify(`已导出 ${response.chapters ?? chapters} 章（${Math.round((response.bytes ?? 0) / 1024)} KB）`)
    } catch (err) {
      notify((err as Error).message, true)
    } finally {
      setBusy(false)
    }
  }

  const reveal = async () => {
    if (!result) return
    try {
      await unwrap(studio.app.revealFile({ path: result.file }))
    } catch (err) {
      notify((err as Error).message, true)
    }
  }

  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div
        ref={dialogRef}
        className="modal export-modal"
        role="dialog"
        aria-modal="true"
        onClick={(event) => event.stopPropagation()}
      >
        <div className="modal__header">
          <Download size={17} style={{ color: 'var(--accent)' }} />
          <div className="modal__title">导出《{bookTitle}》</div>
          <div className="doc-header__sub">
            {chapters} 章 · {words.toLocaleString('zh-CN')} 字 · 仅导出正式章节（不含草稿）
          </div>
          <div className="modal__spacer" />
          <button className="ghost icon-btn" onClick={onClose} aria-label="关闭">
            <X size={16} />
          </button>
        </div>
        <div className="modal__body">
          {!result ? (
            <>
              <div className="export-formats" role="radiogroup" aria-label="导出格式">
                {FORMATS.map((item) => {
                  const Icon = item.icon
                  return (
                    <button
                      key={item.id}
                      role="radio"
                      aria-checked={format === item.id}
                      className={`export-format${format === item.id ? ' is-active' : ''}`}
                      onClick={() => setFormat(item.id)}
                      disabled={busy}
                    >
                      <span className="export-format__icon">
                        <Icon size={18} />
                      </span>
                      <span className="export-format__body">
                        <span className="export-format__title">{item.title}</span>
                        <span className="export-format__desc">{item.description}</span>
                      </span>
                    </button>
                  )
                })}
              </div>
              <div className="settings-hint">
                EPUB 使用纯本地生成（无第三方服务）；Markdown/TXT 会保留章节顺序。导出不会修改书稿或 Git 历史。
              </div>
            </>
          ) : (
            <div className="export-success">
              <div className="export-success__title">导出完成</div>
              <div className="export-success__meta">
                {result.chapters} 章 · {Math.round(result.bytes / 1024)} KB
              </div>
              <code className="export-success__path">{result.file}</code>
              <div className="export-success__actions">
                <button onClick={() => void reveal()}>
                  <FolderOpen size={14} />
                  打开所在文件夹
                </button>
                <button className="ghost" onClick={() => setResult(null)}>
                  再导出一份
                </button>
              </div>
            </div>
          )}
        </div>
        <div className="modal__footer">
          <button className="ghost" onClick={onClose} disabled={busy}>
            关闭
          </button>
          {!result && (
            <button className="primary" onClick={() => void runExport()} disabled={busy}>
              {busy ? <Loader2 size={14} className="spin" /> : <Download size={14} />}
              选择位置并导出
            </button>
          )}
        </div>
      </div>
    </div>
  )
}

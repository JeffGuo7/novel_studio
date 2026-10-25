import { useEffect, useState } from 'react'
import { ClipboardPaste, FolderOpen, Loader2, RefreshCw, Search, Upload, X } from 'lucide-react'
import type { ImportReport } from '@shared/types'
import type { TomatoBook, TomatoStatus } from '@shared/tomato'
import { studio, unwrap } from '../lib/api'

interface Props {
  open: boolean
  dir: string
  onClose: () => void
  onImported: (report: ImportReport) => void
  notify: (text: string, error?: boolean) => void
}

type Tab = 'paste' | 'files' | 'tomato'

export default function ImportModal({ open, dir, onClose, onImported, notify }: Props) {
  const [tab, setTab] = useState<Tab>('paste')
  const [title, setTitle] = useState('')
  const [text, setText] = useState('')
  const [busy, setBusy] = useState(false)

  const [tomatoStatus, setTomatoStatus] = useState<TomatoStatus | null>(null)
  const [tomatoChecking, setTomatoChecking] = useState(false)
  const [query, setQuery] = useState('')
  const [results, setResults] = useState<TomatoBook[]>([])
  const [searching, setSearching] = useState(false)
  const [tomatoImporting, setTomatoImporting] = useState<string | null>(null)
  const [tomatoProgress, setTomatoProgress] = useState('')

  useEffect(() => {
    if (!open) return
    setTab('paste')
    setText('')
    setTitle('')
    setResults([])
    setQuery('')
    setTomatoProgress('')
  }, [open])

  useEffect(() => {
    if (!open) return
    const off = studio.tomato.onProgress((event) => {
      if (event.phase === 'download') {
        setTomatoProgress(event.message ?? '正在下载…')
      } else {
        setTomatoProgress('正在导入章节…')
      }
    })
    return off
  }, [open])

  if (!open) return null

  const refreshTomatoStatus = async () => {
    setTomatoChecking(true)
    try {
      setTomatoStatus(await unwrap(studio.tomato.status()))
    } catch (err) {
      setTomatoStatus({ available: false, baseUrl: 'http://127.0.0.1:18423' })
      notify((err as Error).message, true)
    } finally {
      setTomatoChecking(false)
    }
  }

  const importPaste = async () => {
    if (!text.trim() || busy) return
    setBusy(true)
    try {
      const result = await unwrap(studio.importText({ dir, text, title: title.trim() || undefined }))
      if (result.report) onImported(result.report)
      notify(`已粘贴导入 ${result.report?.chapters ?? 0} 章`)
      onClose()
    } catch (err) {
      notify((err as Error).message, true)
    } finally {
      setBusy(false)
    }
  }

  const importFiles = async () => {
    if (busy) return
    setBusy(true)
    try {
      const result = await unwrap(studio.importFiles({ dir }))
      if (result.canceled) return
      if (result.report) onImported(result.report)
      notify(`已导入 ${result.report?.chapters ?? 0} 章（${result.report?.sources ?? 1} 个文件）`)
      onClose()
    } catch (err) {
      notify((err as Error).message, true)
    } finally {
      setBusy(false)
    }
  }

  const search = async () => {
    const keyword = query.trim()
    if (!keyword || searching) return
    setSearching(true)
    setResults([])
    try {
      const list = await unwrap(studio.tomato.search({ query: keyword }))
      setResults(list)
      if (list.length === 0) notify('没有搜到结果')
    } catch (err) {
      notify((err as Error).message, true)
    } finally {
      setSearching(false)
    }
  }

  const importTomato = async (book: TomatoBook) => {
    if (tomatoImporting) return
    setTomatoImporting(book.bookId)
    setTomatoProgress('准备下载…')
    try {
      const result = await unwrap(
        studio.tomato.import({ dir, bookId: book.bookId, title: book.title }),
      )
      if (result.report) onImported(result.report)
      notify(`已导入《${book.title}》：${result.report?.chapters ?? 0} 章`)
      onClose()
    } catch (err) {
      notify((err as Error).message, true)
    } finally {
      setTomatoImporting(null)
      setTomatoProgress('')
    }
  }

  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div className="modal import-modal" onClick={(event) => event.stopPropagation()}>
        <div className="modal__header">
          <div className="modal__title">导入小说</div>
          <div className="modal__spacer" />
          <button className="ghost icon-btn" aria-label="关闭" onClick={onClose}>
            <X size={16} />
          </button>
        </div>

        <div className="import-tabs">
          <button className={`import-tab ${tab === 'paste' ? 'active' : ''}`} onClick={() => setTab('paste')}>
            <ClipboardPaste size={14} />
            粘贴文本
          </button>
          <button className={`import-tab ${tab === 'files' ? 'active' : ''}`} onClick={() => setTab('files')}>
            <FolderOpen size={14} />
            本地文件
          </button>
          <button
            className={`import-tab ${tab === 'tomato' ? 'active' : ''}`}
            onClick={() => {
              setTab('tomato')
              if (!tomatoStatus) void refreshTomatoStatus()
            }}
          >
            <Search size={14} />
            番茄书源
          </button>
        </div>

        <div className="import-body">
          {tab === 'paste' && (
            <>
              <input
                placeholder="书名 / 来源（可选，例如：临渊行）"
                value={title}
                onChange={(event) => setTitle(event.target.value)}
              />
              <textarea
                rows={12}
                placeholder="把整本书或几章正文粘贴到这里。会按「第 N 章 / 序章 / 楔子 / Chapter N」自动切章。"
                value={text}
                onChange={(event) => setText(event.target.value)}
              />
              <div className="import-actions">
                <span className="import-hint">支持从网页、PDF 复制出来的纯文本；Markdown 也可以。</span>
                <button className="primary" disabled={!text.trim() || busy} onClick={() => void importPaste()}>
                  <Upload size={15} />
                  导入文本
                </button>
              </div>
            </>
          )}

          {tab === 'files' && (
            <>
              <div className="import-empty">
                <FolderOpen size={26} style={{ color: 'var(--faint)' }} />
                <p>选择一个或多个 txt / md 文件，会按文件顺序合成一次导入提交。</p>
                <p className="import-hint">自动识别 UTF-8 / GB18030 编码（番茄下载的 txt 常见 GBK）。</p>
              </div>
              <div className="import-actions">
                <span className="import-hint">多选文件时会按文件名排序。</span>
                <button className="primary" disabled={busy} onClick={() => void importFiles()}>
                  <FolderOpen size={15} />
                  选择文件…
                </button>
              </div>
            </>
          )}

          {tab === 'tomato' && (
            <>
              <div className="tomato-status">
                <span className={`dot ${tomatoStatus?.available ? 'dot-idle' : 'dot-error'}`} />
                <span>
                  {tomatoChecking
                    ? '正在检测本地下载器…'
                    : tomatoStatus?.available
                      ? `已连接下载器${tomatoStatus.version ? `（v${tomatoStatus.version}）` : ''}：${tomatoStatus.baseUrl}`
                      : '未检测到本地的番茄下载器'}
                </span>
                <div className="topbar__spacer" />
                <button className="ghost" onClick={() => void refreshTomatoStatus()} disabled={tomatoChecking}>
                  <RefreshCw size={13} />
                  重新检测
                </button>
              </div>

              {!tomatoStatus?.available && !tomatoChecking && (
                <div className="import-empty">
                  <p>在线导入需要一个本地运行的 Tomato-Novel-Downloader（--server 模式，默认 127.0.0.1:18423）。</p>
                  <p className="import-hint">
                    启动它之后点「重新检测」；也可以在环境变量 NOVEL_STUDIO_TOMATO_EXE 里填它的 exe 路径，应用会尝试自动拉起。
                    没装也没关系，用「粘贴文本」或「本地文件」导入即可。
                  </p>
                </div>
              )}

              {tomatoStatus?.available && (
                <>
                  <div className="tomato-search">
                    <input
                      placeholder="输入书名或作者，回车搜索"
                      value={query}
                      onChange={(event) => setQuery(event.target.value)}
                      onKeyDown={(event) => {
                        if (event.key === 'Enter') void search()
                      }}
                    />
                    <button className="primary" disabled={!query.trim() || searching} onClick={() => void search()}>
                      {searching ? <Loader2 size={14} className="spin" /> : <Search size={14} />}
                      搜索
                    </button>
                  </div>
                  <div className="tomato-results">
                    {results.map((book) => (
                      <div key={book.bookId} className="tomato-result">
                        <div className="tomato-result__main">
                          <div className="tomato-result__title">{book.title}</div>
                          <div className="tomato-result__meta">
                            {book.author ? book.author : '作者未知'} · ID {book.bookId}
                          </div>
                        </div>
                        <button
                          className="primary"
                          disabled={Boolean(tomatoImporting)}
                          onClick={() => void importTomato(book)}
                        >
                          {tomatoImporting === book.bookId ? <Loader2 size={14} className="spin" /> : <Upload size={14} />}
                          导入
                        </button>
                      </div>
                    ))}
                    {results.length === 0 && !searching && (
                      <div className="import-hint" style={{ padding: '12px 4px' }}>
                        搜索结果会显示在这里。
                      </div>
                    )}
                  </div>
                  {tomatoProgress && <div className="tomato-progress">{tomatoProgress}</div>}
                </>
              )}
            </>
          )}
        </div>
      </div>
    </div>
  )
}

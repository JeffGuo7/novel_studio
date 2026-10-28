import { useCallback, useEffect, useRef, useState } from 'react'
import { BookOpen, FileText, Loader2, ReplaceAll, Search, X } from 'lucide-react'
import type { BookSearchReport, ReplaceReport } from '@shared/types'
import { studio, unwrap } from '../lib/api'
import { useDialog } from '../lib/useDialog'

interface Props {
  open: boolean
  dir: string
  canReplace: boolean
  notify: (text: string, error?: boolean) => void
  onNavigate: (file: { path: string; kind: 'chapter' | 'knowledge' }) => void
  onReplaced: (report: ReplaceReport) => void
  onClose: () => void
}

function Highlighted({ text, start, end }: { text: string; start: number; end: number }) {
  return (
    <span className="search-line">
      {text.slice(0, start)}
      <mark>{text.slice(start, end)}</mark>
      {text.slice(end)}
    </span>
  )
}

export default function SearchModal({
  open,
  dir,
  canReplace,
  notify,
  onNavigate,
  onReplaced,
  onClose,
}: Props) {
  const dialogRef = useDialog(open, onClose)
  const inputRef = useRef<HTMLInputElement | null>(null)
  const sequence = useRef(0)
  const [query, setQuery] = useState('')
  const [caseSensitive, setCaseSensitive] = useState(false)
  const [includeKnowledge, setIncludeKnowledge] = useState(true)
  const [replacement, setReplacement] = useState('')
  const [report, setReport] = useState<BookSearchReport | null>(null)
  const [loading, setLoading] = useState(false)
  const [replacing, setReplacing] = useState(false)
  const [error, setError] = useState('')

  useEffect(() => {
    if (!open) return
    setQuery('')
    setReport(null)
    setError('')
    setReplacement('')
    setReplacing(false)
    setTimeout(() => inputRef.current?.focus(), 30)
  }, [open])

  const runSearch = useCallback(
    async (value: string, options: { caseSensitive: boolean; includeKnowledge: boolean }) => {
      const trimmed = value.trim()
      if (!trimmed) {
        setReport(null)
        setLoading(false)
        return
      }
      const current = ++sequence.current
      setLoading(true)
      setError('')
      try {
        const result = await unwrap(
          studio.search.book({
            dir,
            query: trimmed,
            caseSensitive: options.caseSensitive,
            includeKnowledge: options.includeKnowledge,
          }),
        )
        if (current !== sequence.current) return
        setReport(result)
      } catch (err) {
        if (current !== sequence.current) return
        setError((err as Error).message)
        setReport(null)
      } finally {
        if (current === sequence.current) setLoading(false)
      }
    },
    [dir],
  )

  // 输入防抖 250ms
  useEffect(() => {
    if (!open) return
    const timer = window.setTimeout(() => void runSearch(query, { caseSensitive, includeKnowledge }), 250)
    return () => window.clearTimeout(timer)
  }, [open, query, caseSensitive, includeKnowledge, runSearch])

  if (!open) return null

  const total = report?.total ?? 0

  const doReplace = async (paths?: string[]) => {
    if (!report || total === 0 || !canReplace || replacing) return
    const scope = paths?.length ? '当前文件' : '全书（章节 + 知识文件）'
    const ok = window.confirm(`在${scope}替换「${report.query}」为「${replacement}」？\n\n会生成一次 [替换] Git 提交，可从历史找回。`)
    if (!ok) return
    setReplacing(true)
    try {
      const result = await unwrap(
        studio.search.replace({
          dir,
          query: report.query,
          replacement,
          caseSensitive,
          paths,
        }),
      )
      if (result.replacements === 0) {
        notify('没有找到可替换的内容', true)
      } else {
        notify(`已替换 ${result.replacements} 处（${result.changedFiles} 个文件）`)
        onReplaced(result)
        await runSearch(query, { caseSensitive, includeKnowledge })
      }
    } catch (err) {
      notify((err as Error).message, true)
    } finally {
      setReplacing(false)
    }
  }

  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div
        ref={dialogRef}
        className="modal search-modal"
        role="dialog"
        aria-modal="true"
        onClick={(event) => event.stopPropagation()}
      >
        <div className="modal__header">
          <Search size={17} style={{ color: 'var(--accent)' }} />
          <div className="modal__title">全书搜索</div>
          <div className="modal__spacer" />
          <button className="ghost icon-btn" onClick={onClose} aria-label="关闭">
            <X size={16} />
          </button>
        </div>
        <div className="modal__body search-body">
          <div className="search-bar">
            <Search size={15} />
            <input
              ref={inputRef}
              value={query}
              placeholder="搜索章节和知识文件（字面匹配）"
              onChange={(event) => setQuery(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === 'Enter') {
                  event.preventDefault()
                  void runSearch(query, { caseSensitive, includeKnowledge })
                }
              }}
            />
            {loading && <Loader2 size={15} className="spin" />}
          </div>
          <div className="search-options">
            <label className="search-check">
              <input type="checkbox" checked={caseSensitive} onChange={(event) => setCaseSensitive(event.target.checked)} />
              区分大小写
            </label>
            <label className="search-check">
              <input
                type="checkbox"
                checked={includeKnowledge}
                onChange={(event) => setIncludeKnowledge(event.target.checked)}
              />
              包含知识文件
            </label>
            {report && (
              <span className="search-count">
                {total} 处 · {report.files.length} 个文件{report.truncated && '（结果已截断）'}
              </span>
            )}
          </div>

          {error && <div className="panel-hint--error">{error}</div>}

          <div className="search-results">
            {!query.trim() && <div className="search-empty">输入关键词搜索整本书；点击结果跳转到对应位置。</div>}
            {query.trim() && !loading && report && report.files.length === 0 && (
              <div className="search-empty">没有找到「{report.query}」。</div>
            )}
            {report?.files.map((file) => (
              <div key={file.path} className="search-group">
                <div className="search-group__header">
                  <span className="search-group__icon">
                    {file.kind === 'chapter' ? <BookOpen size={14} /> : <FileText size={14} />}
                  </span>
                  <button className="search-group__title" onClick={() => onNavigate(file)}>
                    {file.title}
                  </button>
                  <span className="search-group__count">{file.count} 处</span>
                  {replacement !== report.query && (
                    <button
                      className="ghost search-group__replace"
                      disabled={!canReplace || replacing}
                      onClick={() => void doReplace([file.path])}
                    >
                      替换此文件
                    </button>
                  )}
                </div>
                {file.matches.slice(0, 20).map((match, index) => (
                  <button
                    key={`${file.path}-${match.line}-${index}`}
                    className="search-match"
                    onClick={() => onNavigate(file)}
                  >
                    <span className="search-match__line">{match.line}</span>
                    <Highlighted text={match.text} start={match.start} end={match.end} />
                  </button>
                ))}
                {file.matches.length > 20 && (
                  <div className="search-more">还有 {file.matches.length - 20} 处未显示</div>
                )}
              </div>
            ))}
          </div>

          <div className="search-replace">
            <div className="search-replace__label">替换为</div>
            <input
              value={replacement}
              placeholder="留空表示删除匹配内容"
              onChange={(event) => setReplacement(event.target.value)}
              disabled={replacing}
            />
            <button
              className="primary"
              disabled={!canReplace || replacing || total === 0 || replacement === report?.query}
              onClick={() => void doReplace()}
            >
              {replacing ? <Loader2 size={14} className="spin" /> : <ReplaceAll size={14} />}
              全部替换{total > 0 ? `（${total} 处）` : ''}
            </button>
          </div>
          {!canReplace && (
            <div className="settings-hint">当前文件有未保存修改：请先保存或丢弃，再进行替换，避免覆盖未保存内容。</div>
          )}
          <div className="settings-hint">
            替换会写入书稿并生成一次 Git 提交（历史可找回）；替换不会修改草稿和知识库之外的任何文件。
          </div>
        </div>
      </div>
    </div>
  )
}

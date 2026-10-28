import { useEffect, useRef, useState } from 'react'
import { CheckCircle2, Loader2, ScanSearch, ShieldCheck, X } from 'lucide-react'
import type { ReviewIssue, ReviewReportSummary, ReviewSeverity } from '@shared/pipeline'
import { studio, unwrap } from '../lib/api'
import { useDialog } from '../lib/useDialog'

interface Props {
  open: boolean
  dir: string
  title: string
  chapterCount: number
  notify: (text: string, error?: boolean) => void
  onClose: () => void
}

const SEVERITY_LABELS: Record<ReviewSeverity, string> = {
  high: '高',
  medium: '中',
  low: '低',
}

const CATEGORY_LABELS: Record<ReviewIssue['category'], string> = {
  character: '人物',
  timeline: '时间线',
  setting: '设定',
  plot: '剧情',
  other: '其他',
}

export default function ReviewModal({ open, dir, title, chapterCount, notify, onClose }: Props) {
  const dialogRef = useDialog(open, onClose)
  const lastReportRef = useRef<ReviewReportSummary | null>(null)
  const [from, setFrom] = useState('')
  const [to, setTo] = useState('')
  const [focus, setFocus] = useState('')
  const [running, setRunning] = useState(false)
  const [progress, setProgress] = useState<string[]>([])
  const [report, setReport] = useState<ReviewReportSummary | null>(null)
  const [filter, setFilter] = useState<'all' | ReviewSeverity>('all')

  useEffect(() => {
    if (!open) return
    setReport(null)
    setRunning(false)
    setProgress([])
    setFocus('')
    setFrom('')
    setTo('')
    setFilter('all')
    lastReportRef.current = null
  }, [open])

  useEffect(() => {
    if (!open) return
    const unsubscribe = studio.review.onEvent((event) => {
      if (event.type === 'review_progress') {
        setProgress((prev) => [...prev.slice(-5), event.message])
        return
      }
      if (event.type === 'review_done') {
        setRunning(false)
        setReport(event.report)
        lastReportRef.current = event.report
        notify(
          event.report.issues.length === 0
            ? '一致性检查完成：没有发现明显问题'
            : `一致性检查完成：发现 ${event.report.issues.length} 个问题`,
          event.report.issues.some((issue) => issue.severity === 'high'),
        )
        return
      }
      setRunning(false)
      notify(event.message, true)
    })
    return unsubscribe
  }, [open, notify])

  if (!open) return null

  const start = async () => {
    if (running) return
    const fromNumber = Number(from)
    const toNumber = Number(to)
    setRunning(true)
    setProgress([])
    setReport(null)
    try {
      await unwrap(
        studio.review.start({
          dir,
          title,
          ...(Number.isFinite(fromNumber) && fromNumber > 0 ? { fromChapter: fromNumber } : {}),
          ...(Number.isFinite(toNumber) && toNumber > 0 ? { toChapter: toNumber } : {}),
          focus: focus.trim(),
        }),
      )
    } catch (err) {
      setRunning(false)
      notify((err as Error).message, true)
    }
  }

  const cancel = async () => {
    try {
      await unwrap(studio.review.cancel())
    } catch {
      // 忽略取消错误
    }
  }

  const issues = report?.issues ?? []
  const filtered = filter === 'all' ? issues : issues.filter((issue) => issue.severity === filter)
  const counts = {
    high: issues.filter((issue) => issue.severity === 'high').length,
    medium: issues.filter((issue) => issue.severity === 'medium').length,
    low: issues.filter((issue) => issue.severity === 'low').length,
  }

  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div
        ref={dialogRef}
        className="modal review-modal"
        role="dialog"
        aria-modal="true"
        onClick={(event) => event.stopPropagation()}
      >
        <div className="modal__header">
          <ShieldCheck size={17} style={{ color: 'var(--accent)' }} />
          <div className="modal__title">一致性检查</div>
          <div className="doc-header__sub">只读审稿 · 不会修改书稿</div>
          <div className="modal__spacer" />
          <button className="ghost icon-btn" onClick={onClose} aria-label="关闭">
            <X size={16} />
          </button>
        </div>

        <div className="modal__body review-body">
          {!report && (
            <>
              <div className="settings-row">
                <label>检查范围</label>
                <div className="settings-key">
                  第
                  <input
                    className="review-range-input"
                    value={from}
                    onChange={(event) => setFrom(event.target.value)}
                    placeholder="1"
                  />
                  章 至 第
                  <input
                    className="review-range-input"
                    value={to}
                    onChange={(event) => setTo(event.target.value)}
                    placeholder={String(chapterCount)}
                  />
                  章
                  <span className="settings-inline-hint">
                    留空 = 全书；共 {chapterCount} 章，单次最多检查最近 120 章
                  </span>
                </div>
              </div>
              <div className="settings-row">
                <label>重点关注</label>
                <div className="settings-key">
                  <input
                    value={focus}
                    onChange={(event) => setFocus(event.target.value)}
                    placeholder="可选，例如：林牧的年龄和身份是否前后一致"
                  />
                </div>
              </div>
              <div className="review-note">
                会读取所选章节和知识库设定，请模型逐条找矛盾（人物/时间线/设定/剧情）。依据不足的问题不会被报告；
                检查完成后报告保存在书的 <code>.studio/reviews/</code> 目录，供你回看。
              </div>
              {running && (
                <div className="review-progress">
                  <div className="review-progress__title">
                    <Loader2 size={14} className="spin" />
                    正在检查…
                  </div>
                  {progress.map((message, index) => (
                    <div key={`${index}-${message}`} className="review-progress__line">
                      {message}
                    </div>
                  ))}
                </div>
              )}
            </>
          )}

          {report && (
            <>
              <div className="review-summary">
                <div className="review-summary__item">
                  <span className="review-summary__value">{issues.length}</span>
                  <span>问题</span>
                </div>
                <div className="review-summary__item">
                  <span className="review-summary__value">{report.checkedChapters}</span>
                  <span>检查章节</span>
                </div>
                <div className="review-summary__item">
                  <span className="review-summary__value">{report.checkedKnowledge}</span>
                  <span>设定文件</span>
                </div>
                <div className="review-summary__item">
                  <span className="review-summary__value">${report.cost.toFixed(4)}</span>
                  <span>成本</span>
                </div>
              </div>
              {report.truncated && <div className="settings-hint">章节太多，本次只检查了范围内最近的部分章节。</div>}
              {report.warnings.length > 0 && (
                <div className="settings-hint">有 {report.warnings.length} 批返回格式异常，已跳过。</div>
              )}

              {issues.length === 0 ? (
                <div className="review-empty">
                  <CheckCircle2 size={22} />
                  <div>没有发现明显的一致性问题。</div>
                  <div className="settings-hint">没有命中不代表一定没问题；可指定「重点关注」再查一次。</div>
                </div>
              ) : (
                <>
                  <div className="review-filters">
                    {(['all', 'high', 'medium', 'low'] as const).map((value) => (
                      <button
                        key={value}
                        className={`review-filter${filter === value ? ' is-active' : ''}`}
                        onClick={() => setFilter(value)}
                      >
                        {value === 'all' ? `全部 ${issues.length}` : `${SEVERITY_LABELS[value]} ${counts[value]}`}
                      </button>
                    ))}
                    <span className="review-report-path">报告：{report.reportPath}</span>
                  </div>
                  <div className="review-issues">
                    {filtered.map((issue) => (
                      <div key={issue.id} className={`review-issue severity-${issue.severity}`}>
                        <div className="review-issue__head">
                          <span className={`review-severity severity-${issue.severity}`}>
                            {SEVERITY_LABELS[issue.severity]}
                          </span>
                          <span className="review-category">{CATEGORY_LABELS[issue.category]}</span>
                          <span className="review-issue__title">{issue.title}</span>
                        </div>
                        {issue.locations.length > 0 && (
                          <div className="review-issue__locations">{issue.locations.join(' · ')}</div>
                        )}
                        <div className="review-issue__detail">{issue.detail}</div>
                        {issue.suggestion && <div className="review-issue__suggestion">建议：{issue.suggestion}</div>}
                      </div>
                    ))}
                  </div>
                </>
              )}
            </>
          )}
        </div>

        <div className="modal__footer">
          {running ? (
            <button className="ghost" onClick={() => void cancel()}>
              取消检查
            </button>
          ) : (
            <button className="ghost" onClick={onClose}>
              关闭
            </button>
          )}
          {!report ? (
            <button className="primary" onClick={() => void start()} disabled={running || chapterCount === 0}>
              {running ? <Loader2 size={14} className="spin" /> : <ScanSearch size={14} />}
              开始检查
            </button>
          ) : (
            <button className="primary" onClick={() => void start()}>
              <ScanSearch size={14} />
              重新检查
            </button>
          )}
        </div>
      </div>
    </div>
  )
}
